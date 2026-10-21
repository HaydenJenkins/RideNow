import { NextRequest } from "next/server";
import { getCoreDb } from "@/lib/db/core-db";
import { SessionService } from "@/lib/security/session-service";

// ====================================================================
// Auth Middleware & Server-Side Identity Derivation (Assignment 5, Section 2.3)
// Mitigates:
// - L2-02: User ID & trip state spoofing (derive rider_id / driver_id server-side)
// - L1-01: App spoofing & unauthorized role elevation (OWASP A01 Broken Access Control)
// - L1-06: Strict declarative identity boundaries
// - L1-12: User Apps compromised / Rule 2 safety override (cryptographic device session attestation)
// ====================================================================

export interface AuthenticatedActor {
  actorId: string;
  role: "RIDER" | "DRIVER" | "OPS_STAFF";
  email?: string;
  name?: string;
}

export class AuthContext {
  /**
   * Resolves and verifies the authenticated actor server-side (OWASP A01 & A07).
   * Verifies the cryptographic HMAC-SHA256 signature on signed session cookies
   * ('ridenow_session') or 'Authorization: Bearer <signed_token>' headers.
   *
   * Unsigned, raw headers (such as raw 'x-actor-role' without a valid token)
   * are STRICTLY REJECTED to prevent Broken Access Control privilege escalation.
   */
  static getActor(request: NextRequest): AuthenticatedActor | null {
    // Resolve token by order of precedence (Bearer Header > HttpOnly Cookie > Custom Header):
    const authHeader = request.headers.get("authorization");
    const bearerToken = authHeader?.startsWith("Bearer ") ? authHeader.substring(7).trim() : undefined;
    const cookieToken = request.cookies.get("ridenow_session")?.value;
    const customHeaderToken = request.headers.get("x-session-token") || undefined;

    const token = bearerToken || cookieToken || customHeaderToken;

    // Unsigned / token-less requests are strictly rejected (OWASP A01)
    if (!token) {
      return null;
    }

    // 4. Verify cryptographic HMAC signature & expiration
    const session = SessionService.verifySessionToken(token);
    if (!session) {
      return null;
    }

    // 5. Authoritatively verify actor existence & current authorization in core_operations.db
    const coreDb = getCoreDb();

    if (session.role === "RIDER") {
      const rider: any = coreDb
        .prepare("SELECT rider_id, full_name, email FROM Rider WHERE rider_id = ?")
        .get(session.actorId);
      if (!rider) return null;
      return {
        actorId: rider.rider_id,
        role: "RIDER",
        name: rider.full_name,
        email: rider.email,
      };
    }

    if (session.role === "DRIVER") {
      const driver: any = coreDb
        .prepare("SELECT driver_id, full_name, onboarding_status FROM Driver WHERE driver_id = ?")
        .get(session.actorId);
      if (!driver || driver.onboarding_status !== "APPROVED") return null;
      return {
        actorId: driver.driver_id,
        role: "DRIVER",
        name: driver.full_name,
      };
    }

    if (session.role === "OPS_STAFF") {
      const staff: any = coreDb
        .prepare("SELECT staff_id, full_name, email, role FROM OpsStaff WHERE staff_id = ?")
        .get(session.actorId);
      if (!staff) return null;
      return {
        actorId: staff.staff_id,
        role: "OPS_STAFF",
        name: staff.full_name,
        email: staff.email,
      };
    }

    return null;
  }
}
