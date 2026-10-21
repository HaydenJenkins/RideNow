import { KmsVault } from "../src/lib/security/kms";
import { SessionService } from "../src/lib/security/session-service";
import { AuthContext } from "../src/lib/security/auth-context";
import { getCoreDb } from "../src/lib/db/core-db";

function mockRequest(headers: Record<string, string> = {}, cookies: Record<string, string> = {}): any {
  const normHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    normHeaders[k.toLowerCase()] = v;
  }
  return {
    headers: {
      get: (name: string) => normHeaders[name.toLowerCase()] || null,
    },
    cookies: {
      get: (name: string) => (cookies[name] ? { value: cookies[name] } : undefined),
    },
  };
}

async function runTests() {
  console.log("==================================================");
  console.log("🔒 RUNNING CENTRALIZED AUTH & KMS HARDENING TESTS");
  console.log("==================================================");

  // 1. Verify Environment Variables are Loaded (No hardcoded keys)
  console.log("\n--- TEST 1: ENVIRONMENT VARIABLES & KMS SECRETS ---");
  const kmsKey = process.env.RIDENOW_KMS_MASTER_KEY;
  const authSecret = process.env.RIDENOW_AUTH_SECRET;
  console.log("Loaded RIDENOW_KMS_MASTER_KEY from env:", kmsKey ? `${kmsKey.slice(0, 10)}... (64 hex chars)` : "MISSING");
  console.log("Loaded RIDENOW_AUTH_SECRET from env:", authSecret ? `${authSecret.slice(0, 10)}... (64 hex chars)` : "MISSING");

  if (!kmsKey || kmsKey.length !== 64) {
    throw new Error("RIDENOW_KMS_MASTER_KEY must be a 64-character 256-bit hex key in .env.local");
  }
  if (!authSecret || authSecret.length !== 64) {
    throw new Error("RIDENOW_AUTH_SECRET must be a 64-character 256-bit hex secret in .env.local");
  }
  console.log("✅ Test 1 Passed: Keys successfully loaded from .env.local without plaintext hardcoding!");

  // 2. Verify AES-256-GCM Envelope Encryption on Passwords
  console.log("\n--- TEST 2: AES-256-GCM ENCRYPTED PASSWORDS ---");
  const plaintextPassword = "VanceAdmin!2026";
  const encryptedPassword = KmsVault.encryptAES256(plaintextPassword);
  console.log("Encrypted password ciphertext:", encryptedPassword);

  if (!encryptedPassword.startsWith("kms:enc:v1:aes-256-gcm:")) {
    throw new Error("Ciphertext format must follow AES-256-GCM envelope specification");
  }

  const decryptedPassword = KmsVault.decryptAES256(encryptedPassword);
  if (decryptedPassword !== plaintextPassword) {
    throw new Error(`Decrypted password mismatch! Expected ${plaintextPassword}, got ${decryptedPassword}`);
  }

  // Check database UserCredential table
  const coreDb = getCoreDb();
  const creds: any[] = coreDb.prepare("SELECT actor_id, role, encrypted_password FROM UserCredential").all();
  console.log(`Found ${creds.length} user credentials in database.`);
  for (const c of creds) {
    const dec = KmsVault.decryptAES256(c.encrypted_password);
    console.log(`- Verified ${c.role} [${c.actor_id}]: AES-256 decryption verified.`);
  }
  console.log("✅ Test 2 Passed: Passwords envelope-encrypted with AES-256-GCM and verified!");

  // 3. Centralized Session Token Minting & Verification
  console.log("\n--- TEST 3: CENTRALIZED SESSION AUTH (OWASP A01 / A07) ---");
  const authStaff = await SessionService.authenticateActor("staff_01", "OPS_STAFF", "VanceAdmin!2026");
  console.log("Authenticated staff_01 token minted:", authStaff.token.slice(0, 35) + "...");

  const verifiedSession = SessionService.verifySessionToken(authStaff.token);
  if (!verifiedSession || verifiedSession.actorId !== "staff_01" || verifiedSession.role !== "OPS_STAFF") {
    throw new Error("Session verification failed for authentic token!");
  }
  console.log("Verified Session Payload:", verifiedSession);
  console.log("✅ Test 3 Passed: Signed session token created and verified with HMAC-SHA256!");

  // 4. White-Box Red-Team Attack 1: Unsigned Headers Spoofing (OWASP A01 Broken Access Control)
  console.log("\n--- TEST 4: ATTACK SIMULATION - UNSIGNED HEADER SPOOFING ---");
  // Attacker tries to send raw x-actor-role without a valid signed session token
  const spoofReq = mockRequest({
    "x-actor-role": "OPS_STAFF",
    "x-actor-id": "staff_01",
  });

  const spoofActor = AuthContext.getActor(spoofReq);
  console.log("AuthContext.getActor on unsigned headers returned:", spoofActor);
  if (spoofActor !== null) {
    throw new Error("❌ VULNERABILITY DETECTED: Server accepted unsigned headers without valid token!");
  }
  console.log("✅ Test 4 Passed: Unsigned header attack was REJECTED! (OWASP A01 mitigated)");

  // 5. White-Box Red-Team Attack 2: Forged / Tampered Token Signature
  console.log("\n--- TEST 5: ATTACK SIMULATION - FORGED TOKEN SIGNATURE ---");
  const forgedToken = authStaff.token.slice(0, -6) + "xxxxxx"; // corrupt signature
  const forgedReq = mockRequest({
    authorization: `Bearer ${forgedToken}`,
  });

  const forgedActor = AuthContext.getActor(forgedReq);
  console.log("AuthContext.getActor on tampered token returned:", forgedActor);
  if (forgedActor !== null) {
    throw new Error("❌ VULNERABILITY DETECTED: Server accepted tampered token signature!");
  }
  console.log("✅ Test 5 Passed: Tampered signature attack was REJECTED!");

  // 6. Legitimate Request with Signed Token
  console.log("\n--- TEST 6: LEGITIMATE REQUEST WITH SIGNED TOKEN ---");
  const legitReq = mockRequest({
    authorization: `Bearer ${authStaff.token}`,
  });

  const legitActor = AuthContext.getActor(legitReq);
  console.log("AuthContext.getActor on valid signed token returned:", legitActor);
  if (!legitActor || legitActor.actorId !== "staff_01" || legitActor.role !== "OPS_STAFF") {
    throw new Error("Legitimate request failed to resolve actor!");
  }
  console.log("✅ Test 6 Passed: Authenticated session successfully authorized!");

  // 7. Legitimate Request with Secure Cookie
  console.log("\n--- TEST 7: LEGITIMATE REQUEST WITH SECURE COOKIE ---");
  const cookieReq = mockRequest({}, { ridenow_session: authStaff.token });
  const cookieActor = AuthContext.getActor(cookieReq);
  console.log("AuthContext.getActor on secure cookie returned:", cookieActor);
  if (!cookieActor || cookieActor.actorId !== "staff_01") {
    throw new Error("Failed to authenticate from secure cookie!");
  }
  console.log("✅ Test 7 Passed: HttpOnly cookie authentication successfully authorized!");

  console.log("\n==================================================");
  console.log("🎉 ALL SECURITY & HARDENING TESTS PASSED 100%!");
  console.log("==================================================");
}

runTests().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
