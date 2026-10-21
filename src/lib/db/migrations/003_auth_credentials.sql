-- ====================================================================
-- RideNow - User Authentication & Credential Storage Schema
-- Passwords encrypted via AES-256-GCM envelope encryption (L0-01)
-- ====================================================================

CREATE TABLE IF NOT EXISTS UserCredential (
    credential_id TEXT PRIMARY KEY,
    actor_id TEXT NOT NULL UNIQUE,
    role TEXT NOT NULL CHECK(role IN ('RIDER', 'DRIVER', 'OPS_STAFF')),
    encrypted_password TEXT NOT NULL, -- Field-level AES-256-GCM envelope encrypted
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_login DATETIME
);

CREATE INDEX IF NOT EXISTS idx_credential_actor ON UserCredential(actor_id, role);
