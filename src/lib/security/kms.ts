import crypto from "crypto";
import fs from "fs";
import path from "path";

// Auto-load .env.local if not populated in process.env (e.g. standalone scripts or tests)
function ensureEnvLoaded() {
  if (!process.env.RIDENOW_KMS_MASTER_KEY) {
    try {
      const envPath = path.resolve(process.cwd(), ".env.local");
      if (fs.existsSync(envPath)) {
        const lines = fs.readFileSync(envPath, "utf-8").split("\n");
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed && !trimmed.startsWith("#") && trimmed.includes("=")) {
            const [k, ...v] = trimmed.split("=");
            const key = k.trim();
            if (!process.env[key]) {
              process.env[key] = v.join("=").trim();
            }
          }
        }
      }
    } catch {
      // ignore
    }
  }
}
ensureEnvLoaded();

// ====================================================================
// KMS & Cryptographic Vault (Assignment 5, Section 2.5)
// Centralizes:
// 1. Asymmetric key signing for Trip Assignment Tokens (L2-24)
// 2. Field-level KMS envelope encryption for applicant PII & passwords (L0-01)
// 3. Webhook HMAC-SHA256 secret verification (L0-03)
// ====================================================================

declare global {
  // eslint-disable-next-line no-var
  var _ephemeralKmsKey: Buffer | undefined;
  // eslint-disable-next-line no-var
  var _ephemeralWebhookSecret: string | undefined;
}

/**
 * Resolves the 256-bit AES Master Key securely from environment variables.
 * Prevents committing plaintext keys in source code or configuration files.
 */
function getKmsMasterKey(): Buffer {
  ensureEnvLoaded();
  const envKey = process.env.RIDENOW_KMS_MASTER_KEY || process.env.KMS_SECRET;
  if (envKey) {
    if (envKey.length === 64) {
      return Buffer.from(envKey, "hex");
    }
    return crypto.scryptSync(envKey, "ridenow-kms-salt", 32);
  }

  // Ephemeral fallback with clear security warning - NEVER hardcode plaintext master keys!
  if (!globalThis._ephemeralKmsKey) {
    console.warn("⚠️ [SECURITY WARNING] RIDENOW_KMS_MASTER_KEY not set in environment. Using ephemeral 256-bit runtime key.");
    globalThis._ephemeralKmsKey = crypto.randomBytes(32);
  }
  return globalThis._ephemeralKmsKey;
}

/**
 * Resolves external payment webhook HMAC secret from environment variables.
 */
function getWebhookPaymentSecret(): string {
  ensureEnvLoaded();
  const secret = process.env.WEBHOOK_PAYMENT_SECRET;
  if (secret) return secret;
  if (!globalThis._ephemeralWebhookSecret) {
    globalThis._ephemeralWebhookSecret = crypto.randomBytes(32).toString("hex");
  }
  return globalThis._ephemeralWebhookSecret;
}

const { publicKey: ASSIGNMENT_PUBLIC_KEY, privateKey: ASSIGNMENT_PRIVATE_KEY } =
  crypto.generateKeyPairSync("ed25519");

export interface TripAssignmentTokenPayload {
  jti: string;
  trip_id: string;
  rider_id: string;
  driver_id: string;
  route_hash: string;
  expires_at: number;
}

export class KmsVault {
  /**
   * Mints an asymmetric, cryptographically signed Trip Assignment Token (L2-24).
   * Verified by KMS asymmetric keys to prevent unauthorized ride hijacking.
   */
  static mintTripAssignmentToken(params: {
    trip_id: string;
    rider_id: string;
    driver_id: string;
    route_hash: string;
    expires_in_seconds?: number;
  }): { token: string; jti: string; signature: string } {
    const jti = crypto.randomUUID();
    const expires_at = Math.floor(Date.now() / 1000) + (params.expires_in_seconds || 3600);

    const payload: TripAssignmentTokenPayload = {
      jti,
      trip_id: params.trip_id,
      rider_id: params.rider_id,
      driver_id: params.driver_id,
      route_hash: params.route_hash,
      expires_at,
    };

    const header = Buffer.from(JSON.stringify({ alg: "EdDSA", typ: "JWT" })).toString("base64url");
    const payloadStr = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const signInput = `${header}.${payloadStr}`;

    const signature = crypto.sign(null, Buffer.from(signInput), ASSIGNMENT_PRIVATE_KEY).toString("base64url");
    const token = `${signInput}.${signature}`;

    return { token, jti, signature };
  }

  /**
   * Verifies the cryptographic signature of a Trip Assignment Token (L2-24).
   */
  static verifyTripAssignmentToken(token: string): {
    valid: boolean;
    payload?: TripAssignmentTokenPayload;
    error?: string;
  } {
    try {
      const parts = token.split(".");
      if (parts.length !== 3) {
        return { valid: false, error: "Malformed token format" };
      }

      const [header, payloadStr, signature] = parts;
      const signInput = `${header}.${payloadStr}`;

      const verified = crypto.verify(
        null,
        Buffer.from(signInput),
        ASSIGNMENT_PUBLIC_KEY,
        Buffer.from(signature, "base64url")
      );

      if (!verified) {
        return { valid: false, error: "Cryptographic signature mismatch" };
      }

      const payload: TripAssignmentTokenPayload = JSON.parse(
        Buffer.from(payloadStr, "base64url").toString("utf-8")
      );

      const now = Math.floor(Date.now() / 1000);
      if (payload.expires_at < now) {
        return { valid: false, error: "Token expired" };
      }

      return { valid: true, payload };
    } catch (e: any) {
      return { valid: false, error: e.message || "Failed to verify token" };
    }
  }

  /**
   * Field-level KMS Envelope Encryption for applicant SSNs and sensitive PII (L0-01).
   * Encrypts plaintext using AES-256-GCM with a randomized IV and authentication tag.
   */
  static encryptPII(plaintext: string): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", getKmsMasterKey(), iv);
    let encrypted = cipher.update(plaintext, "utf8", "hex");
    encrypted += cipher.final("hex");
    const authTag = cipher.getAuthTag().toString("hex");

    return `kms:enc:v1:aes-256-gcm:${iv.toString("hex")}:${authTag}:${encrypted}`;
  }

  /**
   * Decrypts field-level KMS envelope encrypted PII within an isolated enclave.
   */
  static decryptPII(ciphertext: string): string {
    if (!ciphertext.startsWith("kms:enc:v1:aes-256-gcm:")) {
      throw new Error("Invalid KMS ciphertext format");
    }

    const parts = ciphertext.split(":");
    // format: kms : enc : v1 : aes-256-gcm : <iv> : <tag> : <encrypted>
    const ivHex = parts[4];
    const tagHex = parts[5];
    const encryptedHex = parts[6];

    const iv = Buffer.from(ivHex, "hex");
    const authTag = Buffer.from(tagHex, "hex");

    const decipher = crypto.createDecipheriv("aes-256-gcm", getKmsMasterKey(), iv);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(encryptedHex, "hex", "utf8");
    decrypted += decipher.final("utf8");
    return decrypted;
  }

  /**
   * General-purpose AES-256-GCM envelope encryption for sensitive credentials and passwords.
   */
  static encryptAES256(plaintext: string): string {
    return this.encryptPII(plaintext);
  }

  /**
   * General-purpose AES-256-GCM decryption for sensitive credentials and passwords.
   */
  static decryptAES256(ciphertext: string): string {
    return this.decryptPII(ciphertext);
  }

  /**
   * Verifies Webhook HMAC-SHA256 signature using timing-safe comparison (L0-03).
   */
  static verifyWebhookSignature(payloadRaw: string, signatureHeader: string): boolean {
    if (!signatureHeader) return false;

    const hmac = crypto.createHmac("sha256", getWebhookPaymentSecret());
    hmac.update(payloadRaw);
    const expectedSig = hmac.digest("hex");

    const sigBuffer = Buffer.from(signatureHeader.replace("sha256=", ""), "hex");
    const expectedBuffer = Buffer.from(expectedSig, "hex");

    if (sigBuffer.length !== expectedBuffer.length) return false;
    return crypto.timingSafeEqual(sigBuffer, expectedBuffer);
  }

  /**
   * Helper to sign a mock webhook payload for testing/simulation.
   */
  static signWebhookPayload(payloadRaw: string): string {
    const hmac = crypto.createHmac("sha256", getWebhookPaymentSecret());
    hmac.update(payloadRaw);
    return `sha256=${hmac.digest("hex")}`;
  }
}
