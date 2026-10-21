import { getCoreDb } from "../src/lib/db/core-db";
import { KmsVault } from "../src/lib/security/kms";

function displayCredentials() {
  console.log("\n==========================================================================================");
  console.log("🔐 RIDENOW SECURE CREDENTIAL VAULT (AES-256-GCM DECRYPTOR CLI)");
  console.log("==========================================================================================");
  console.log("• Master Key Source : process.env.RIDENOW_KMS_MASTER_KEY (.env.local)");
  console.log("• Database Store    : core_operations.db -> Table: UserCredential");
  console.log("• Encryption Cipher : AES-256-GCM (12-byte IV, 16-byte Auth Tag, Envelope Encrypted)");
  console.log("------------------------------------------------------------------------------------------\n");

  const coreDb = getCoreDb();
  const targetFilter = process.argv[2]?.trim() || null;

  // 100% Static Parameterized Query (No SQL template interpolation or string concatenation)
  const statement = coreDb.prepare(`
    SELECT 
      c.actor_id,
      c.role,
      c.encrypted_password,
      COALESCE(r.full_name, d.full_name, s.full_name, 'Unknown') as full_name,
      COALESCE(r.email, s.email, 'driver@ridenow.internal') as email
    FROM UserCredential c
    LEFT JOIN Rider r ON c.actor_id = r.rider_id AND c.role = 'RIDER'
    LEFT JOIN Driver d ON c.actor_id = d.driver_id AND c.role = 'DRIVER'
    LEFT JOIN OpsStaff s ON c.actor_id = s.staff_id AND c.role = 'OPS_STAFF'
    WHERE (@filter IS NULL OR c.actor_id = @filter OR LOWER(c.role) = LOWER(@filter))
    ORDER BY 
      CASE c.role 
        WHEN 'OPS_STAFF' THEN 1 
        WHEN 'DRIVER' THEN 2 
        WHEN 'RIDER' THEN 3 
        ELSE 4 
      END, 
      c.actor_id ASC;
  `);

  // Strictly bind parameters using named object binding
  const rows: any[] = statement.all({ filter: targetFilter });

  console.log(
    `| ${"ROLE".padEnd(10)} | ${"ACTOR ID".padEnd(12)} | ${"NAME".padEnd(20)} | ${"DECRYPTED PASSWORD".padEnd(18)} | ${"STORED AES-256 CIPHERTEXT (AT REST)".padEnd(36)} |`
  );
  console.log(`|${"-".repeat(12)}|${"-".repeat(14)}|${"-".repeat(22)}|${"-".repeat(20)}|${"-".repeat(38)}|`);

  for (const row of rows) {
    let decryptedPassword = "[DECRYPTION FAILED]";
    try {
      decryptedPassword = KmsVault.decryptAES256(row.encrypted_password);
    } catch (e: any) {
      decryptedPassword = `ERR: ${e.message}`;
    }

    const shortCipher = row.encrypted_password.length > 36 
      ? row.encrypted_password.substring(0, 33) + "..." 
      : row.encrypted_password;

    console.log(
      `| ${row.role.padEnd(10)} | ${row.actor_id.padEnd(12)} | ${row.full_name.padEnd(20)} | \x1b[32m${decryptedPassword.padEnd(18)}\x1b[0m | \x1b[90m${shortCipher.padEnd(36)}\x1b[0m |`
    );
  }

  console.log("\n------------------------------------------------------------------------------------------");
  console.log("💡 For white-box red-teaming & testing, copy any password above to authenticate in the UI.");
  console.log("==========================================================================================\n");
}

displayCredentials();
