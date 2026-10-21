# RideNow Platform — Architecture Blueprint Sandbox

RideNow is a secure, cloud-native ride-hailing architecture simulation built with Next.js 16 (Turbopack), React 19, SQLite, and custom security middleware adhering to **OWASP Top 10 (2025)** and safety blueprint specifications.

---

## 🚀 Quick Start

### 1. Clone & Install Dependencies
```bash
git clone <repository-url>
cd RideNow
npm install
```

### 2. Copy Seed Data Into Project

- `seed.ts` MUST be located in `src/lib/db/seed.ts`

### 3. Configure Environment Secrets
Ensure `.env.local` exists in the project root. A template is available in `.env.example`:
```bash
cp .env.example .env.local
```
Key secrets configured in `.env.local`:
- `RIDENOW_KMS_MASTER_KEY`: 256-bit AES Master Key for envelope encryption.
- `RIDENOW_AUTH_SECRET`: 256-bit HMAC secret for cryptographic session tokens.
- `WEBHOOK_PAYMENT_SECRET`: Shared secret for payment webhooks.

### 4. Database Migration & Seeding
If setting up a fresh environment:
```bash
npm run db:migrate
npm run db:seed
```

### 5. Run Development Server
```bash
npm run dev
```
Open [http://localhost:3000] in your browser.

---

## 🔐 White-Box Red-Teaming & Peer Pen-Testing

For peer red-teamers and evaluators conducting white-box penetration testing, RideNow includes an internal terminal decryptor CLI tool to inspect test credentials:

### Inspect All Passwords:
```bash
npm run creds
```
This utility loads `RIDENOW_KMS_MASTER_KEY` from `.env.local`, connects to `core_operations.db`, decrypts the AES-256-GCM envelope-encrypted passwords, and outputs a formatted table showing decrypted credentials alongside their encrypted ciphertexts at rest.

### Inspect a Specific Account:
```bash
npm run creds rider_01
npm run creds driver_01
npm run creds staff_01
```

---

## 🛡️ Security Architecture & Authentication Model

### 1. Explicit Login & Session Persistence
- **Zero Auto-Login**: When the app starts, no accounts are pre-authenticated. Users must authenticate with their encrypted password.
- **Session-Level Caching**: Once an account is logged into during a browser session, its cryptographic HMAC-SHA256 token is cached in memory (`authenticatedSessions`). Switching between already-authenticated accounts does **not** prompt for a password repeatedly.
- **Explicit Logout**: Clicking **"🚪 Log Out"** in the top navigation revokes the account token (`DELETE /api/auth/session`), clears it from memory, and requires password entry to sign back in.

### 2. OWASP A01: Broken Access Control & Header Spoofing Mitigation
- **Rejection of Unsigned Headers**: In previous versions, arbitrary clients could send `x-actor-role: OPS_STAFF` or `x-actor-id: staff_01` without cryptographic proof.
- **Strict Verification (`AuthContext.getActor`)**: All protected API routes (`/api/trips`, `/api/driver/*`, `/api/ops/*`) strictly verify `Authorization: Bearer <token>` or signed HttpOnly cookies (`ridenow_session`). Requests with missing, tampered, or unsigned tokens return `401 Unauthorized` / `403 Forbidden`.
- **Timing-Safe Password Verification**: Password comparison uses `crypto.timingSafeEqual()` to mitigate side-channel timing attacks.

### 3. KMS Master Key Protection
- The 256-bit AES master key is loaded strictly from `process.env.RIDENOW_KMS_MASTER_KEY`.
- Plaintext keys are stripped from source code and `.gitignore` protects `.env*.local`.

---

## 🧪 Security Test Suite

Run the automated security and KMS test suite:
```bash
npm run test:security
```
*(Or directly via: `npx tsx --env-file=.env.local scripts/test-security.ts`)*
Verifies:
1. Environment variable loading & key length enforcement.
2. AES-256-GCM envelope encryption & database decryption.
3. Centralized session minting & HMAC-SHA256 signature verification.
4. Attack simulation: Unsigned header spoofing rejection (OWASP A01).
5. Attack simulation: Tampered token signature rejection.
6. Legitimate Bearer token authorization.
7. HttpOnly session cookie authorization.


---


## Drift From Initial Architecture
- The only notable drift from the orignal proposed architecture from Assignment 5 is the Authorization and Login/Logout flow. 
- This change was included to guard against OWASP A01:2025-Broken Access Control
- Without this inclusion, an user could access an account, unauthenticated and provide unsigned headers to gain access to restricted functionality.
- Also, someone could provide an invalid token or no token at all, and access an account with no auth at all. Or provide headers with incorrect data and gain access to restricted functionality (i.e x-actor-id, x-actor-role, x-actor-name headers)



## 🎯 Prioritized Threat Model & Code Implementation Matrix (15 Mitigated Threats)

The RideNow architecture explicitly addresses and enforces mitigations for **all 15 prioritized threats** across system tiers (L0 Foundation, L1 Gateway & Platform, L2 Service Logic & Dispatch). Every threat is implemented, verified, and commented directly in the codebase:

| Threat ID | Severity | Threat Description | Architectural Mitigation | Primary File(s) |
|---|---|---|---|---|
| **L0-01** | Critical | Sensitive PII, SSN & password leak at rest | Field-level KMS AES-256-GCM envelope encryption & timing-safe verification | [`kms.ts`](src/lib/security/kms.ts), [`apply/route.ts`](src/app/api/onboarding/apply/route.ts), [`003_auth_credentials.sql`](src/lib/db/migrations/003_auth_credentials.sql) |
| **L0-03** | Critical | Payment data leak via 3rd-party trust boundary | Client-side PCI tokenization via gateway SDK & webhook HMAC signing | [`payment-processor.ts`](src/lib/services/external/payment-processor.ts), [`payment/route.ts`](src/app/api/webhooks/payment/route.ts) |
| **L0-08** | High | System outage via external routing dependency | Maps Circuit Breaker with cached distance matrix fallback routing | [`maps-provider.ts`](src/lib/services/external/maps-provider.ts), [`circuit-breaker/route.ts`](src/app/api/system/circuit-breaker/route.ts) |
| **L1-01** | High | User apps spoofed & unauthorized role elevation | Signed session tokens (HMAC-SHA256) & unsigned header rejection | [`auth-context.ts`](src/lib/security/auth-context.ts), [`session-service.ts`](src/lib/security/session-service.ts), [`session/route.ts`](src/app/api/auth/session/route.ts) |
| **L1-02** | High | Payment webhook forgery & replay attacks | Timing-safe HMAC-SHA256 signature verification computed over raw body | [`kms.ts`](src/lib/security/kms.ts), [`payment/route.ts`](src/app/api/webhooks/payment/route.ts) |
| **L1-05** | Critical | API gateway volumetric flooding & outage | Distributed sliding-window rate limiting per IP & endpoint throttling | [`rate-limiter.ts`](src/lib/security/rate-limiter.ts), [`maps-provider.ts`](src/lib/services/external/maps-provider.ts) |
| **L1-06** | High | Administrative interface & internal API exposure | Strict RBAC isolating private operations endpoints to OPS_STAFF | [`auth-context.ts`](src/lib/security/auth-context.ts), [`ops-service.ts`](src/lib/services/ops-service.ts), [`ops/drivers/route.ts`](src/app/api/ops/drivers/route.ts) |
| **L1-07** | Critical | Input schema tampering & parameter injection | Strict declarative input validation using Zod schemas (`.strict()`) | [`request/route.ts`](src/app/api/trips/request/route.ts), [`location/route.ts`](src/app/api/driver/location/route.ts), [`status/route.ts`](src/app/api/trips/[tripId]/status/route.ts) |
| **L1-12** | Critical | Compromised client device & safety rule override | Cryptographic session attestation & immutable incident state machine | [`auth-context.ts`](src/lib/security/auth-context.ts), [`ops-service.ts`](src/lib/services/ops-service.ts), [`001_core_schema.sql`](src/lib/db/migrations/001_core_schema.sql) |
| **L2-02** | High | Ride request spoofing & client-side fare tampering | Server-derived authoritative identity & dynamic server-side pricing | [`pricing-service.ts`](src/lib/services/pricing-service.ts), [`request/route.ts`](src/app/api/trips/request/route.ts) |
| **L2-03** | High | Ride-request outage & duplicate dispatching | Client idempotency key cache (`UNIQUE`) & per-rider rate limits | [`dispatch-service.ts`](src/lib/services/dispatch-service.ts), [`rate-limiter.ts`](src/lib/security/rate-limiter.ts), [`002_geo_schema.sql`](src/lib/db/migrations/002_geo_schema.sql) |
| **L2-10** | High | GPS telemetry spoofing & route replay attacks | Monotonic sequence counters (`seq + 1`) & physical velocity sanity checks | [`location-service.ts`](src/lib/services/location-service.ts), [`002_geo_schema.sql`](src/lib/db/migrations/002_geo_schema.sql), [`page.tsx`](src/app/page.tsx) |
| **L2-13** | High | High-frequency location-update endpoint flooding | Per-driver sliding window ceiling enforcing maximum 1 ping per second | [`rate-limiter.ts`](src/lib/security/rate-limiter.ts), [`location/route.ts`](src/app/api/driver/location/route.ts) |
| **L2-18** | High | Trip state machine outage & race conditions | Durable state store with atomic optimistic locking (`version_id` increment) | [`dispatch-service.ts`](src/lib/services/dispatch-service.ts), [`status/route.ts`](src/app/api/trips/[tripId]/status/route.ts), [`002_geo_schema.sql`](src/lib/db/migrations/002_geo_schema.sql) |
| **L2-24** | Critical | Rogue driver / fake dispatch impersonation | Cryptographically signed Trip Assignment Tokens verified prior to pickup | [`kms.ts`](src/lib/security/kms.ts), [`dispatch-service.ts`](src/lib/services/dispatch-service.ts), [`token/route.ts`](src/app/api/trips/[tripId]/token/route.ts) |
