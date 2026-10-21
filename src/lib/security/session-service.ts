import crypto from "crypto";
import fs from "fs";
import path from "path";
import { getCoreDb } from "@/lib/db/core-db";
import { KmsVault } from "@/lib/security/kms";

// ====================================================================
// Centralized Session & Identity Service (OWASP A01 & A07 Mitigations)
// Eliminates Broken Access Control by issuing & validating cryptographically
// signed HMAC-SHA256 session tokens. Raw, unsigned headers are rejected.
// ====================================================================

function ensureEnvLoaded() {
  if (!process.env.RIDENOW_AUTH_SECRET) {
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

declare global {
  // eslint-disable-next-line no-var
  var _ephemeralAuthSecret: string | undefined;
}

/**
 * Resolves the 256-bit authentication signing secret from environment variables.
 */
function getAuthSecret(): string {
  ensureEnvLoaded();
  const secret = process.env.RIDENOW_AUTH_SECRET;
  if (secret) return secret;
  if (!globalThis._ephemeralAuthSecret) {
    console.warn("⚠️ [SECURITY WARNING] RIDENOW_AUTH_SECRET not set in environment. Using ephemeral 256-bit runtime key.");
    globalThis._ephemeralAuthSecret = crypto.randomBytes(32).toString("hex");
  }
  return globalThis._ephemeralAuthSecret;
}

export interface SessionPayload {
  actorId: string;
  role: "RIDER" | "DRIVER" | "OPS_STAFF";
  name?: string;
  email?: string;
  iat: number;
  exp: number;
}

export class SessionService {
  /**
   * Mints a cryptographically signed HMAC-SHA256 session token.
   */
  static mintSessionToken(actor: {
    actorId: string;
    role: "RIDER" | "DRIVER" | "OPS_STAFF";
    name?: string;
    email?: string;
    expiresInSeconds?: number;
  }): string {
    const now = Math.floor(Date.now() / 1000);
    const exp = now + (actor.expiresInSeconds || 86400); // 24 hours default validity

    const payload: SessionPayload = {
      actorId: actor.actorId,
      role: actor.role,
      name: actor.name,
      email: actor.email,
      iat: now,
      exp,
    };

    const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
    const payloadStr = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const signInput = `${header}.${payloadStr}`;

    const signature = crypto
      .createHmac("sha256", getAuthSecret())
      .update(signInput)
      .digest("base64url");

    return `${signInput}.${signature}`;
  }

  /**
   * Cryptographically verifies session token signature, expiration, and payload (OWASP A01).
   * Returns verified SessionPayload or null if tampered with or expired.
   */
  static verifySessionToken(token: string): SessionPayload | null {
    if (!token) return null;
    const parts = token.split(".");
    if (parts.length !== 3) return null;

    const [header, payloadStr, signature] = parts;
    const signInput = `${header}.${payloadStr}`;

    const expectedSignature = crypto
      .createHmac("sha256", getAuthSecret())
      .update(signInput)
      .digest("base64url");

    const sigBuf = Buffer.from(signature);
    const expectedBuf = Buffer.from(expectedSignature);

    if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
      return null;
    }

    try {
      const payload: SessionPayload = JSON.parse(
        Buffer.from(payloadStr, "base64url").toString("utf-8")
      );
      const now = Math.floor(Date.now() / 1000);
      if (payload.exp < now) {
        return null; // Expired token
      }
      return payload;
    } catch {
      return null;
    }
  }

  /**
   * Centralized actor authentication against core_operations.db.
   * If a password is provided, verifies against the AES-256-GCM encrypted credential.
   */
  static async authenticateActor(
    actorId: string,
    role: "RIDER" | "DRIVER" | "OPS_STAFF",
    password?: string
  ): Promise<{ actor: SessionPayload; token: string }> {
    if (!password || !password.trim()) {
      throw new Error("Authentication failed: Password is required.");
    }

    const coreDb = getCoreDb();
    let name: string = actorId;
    let email: string | undefined;

    if (role === "RIDER") {
      const r: any = coreDb.prepare("SELECT rider_id, full_name, email FROM Rider WHERE rider_id = ?").get(actorId);
      if (!r) throw new Error(`Rider account '${actorId}' not found.`);
      name = r.full_name;
      email = r.email;
    } else if (role === "DRIVER") {
      const d: any = coreDb.prepare("SELECT driver_id, full_name, onboarding_status FROM Driver WHERE driver_id = ?").get(actorId);
      if (!d) throw new Error(`Driver account '${actorId}' not found.`);
      if (d.onboarding_status !== "APPROVED") {
        throw new Error(`Driver account '${actorId}' is not approved for dispatch (Status: ${d.onboarding_status}).`);
      }
      name = d.full_name;
    } else if (role === "OPS_STAFF") {
      const s: any = coreDb.prepare("SELECT staff_id, full_name, email, role FROM OpsStaff WHERE staff_id = ?").get(actorId);
      if (!s) throw new Error(`Ops Staff account '${actorId}' not found.`);
      name = s.full_name;
      email = s.email;
    } else {
      throw new Error(`Invalid role '${role}'.`);
    }

    // Enforce AES-256-GCM encrypted credential verification
    const cred: any = coreDb
      .prepare("SELECT encrypted_password FROM UserCredential WHERE actor_id = ?")
      .get(actorId);

    if (!cred || !cred.encrypted_password) {
      throw new Error(`Authentication failed: No credentials registered for account '${actorId}'.`);
    }

    const decrypted = KmsVault.decryptAES256(cred.encrypted_password);
    const inputBuf = Buffer.from(password, "utf8");
    const decBuf = Buffer.from(decrypted, "utf8");

    if (inputBuf.length !== decBuf.length || !crypto.timingSafeEqual(inputBuf, decBuf)) {
      throw new Error("Invalid credentials: Password verification failed.");
    }

    // Update last_login timestamp
    try {
      coreDb.prepare("UPDATE UserCredential SET last_login = CURRENT_TIMESTAMP WHERE actor_id = ?").run(actorId);
    } catch {
      // Table exists from migration
    }

    const token = this.mintSessionToken({ actorId, role, name, email });
    const verified = this.verifySessionToken(token)!;

    return { actor: verified, token };
  }
}
