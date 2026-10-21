import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { SessionService } from "@/lib/security/session-service";
import { AuthContext } from "@/lib/security/auth-context";

// Declarative Strict Input Validation (L1-07)
const SwitchAuthSchema = z
  .object({
    actorId: z.string().min(1).max(64),
    role: z.enum(["RIDER", "DRIVER", "OPS_STAFF"]),
    password: z.string().min(1, "Password is required"),
  })
  .strict();

/**
 * GET /api/auth/session
 * Verifies and returns the currently authenticated session actor.
 */
export async function GET(req: NextRequest) {
  const actor = AuthContext.getActor(req);
  if (!actor) {
    return NextResponse.json(
      { authenticated: false, error: "No active authenticated session." },
      { status: 401 }
    );
  }
  return NextResponse.json({ authenticated: true, actor });
}

/**
 * POST /api/auth/session
 * Centralized authentication & account switching endpoint (OWASP A01).
 * Verifies credentials, mints an HMAC-SHA256 signed session token, and
 * issues an HttpOnly, SameSite=Lax cookie.
 */
export async function POST(req: NextRequest) {
  try {
    const raw = await req.json();
    const body = SwitchAuthSchema.parse(raw);

    const { actor, token } = await SessionService.authenticateActor(
      body.actorId,
      body.role,
      body.password
    );

    const response = NextResponse.json({
      success: true,
      actor,
      token,
      message: `Authenticated as ${actor.name || actor.actorId} (${actor.role})`,
    });

    // Set secure HttpOnly cookie for browser sessions
    response.cookies.set("ridenow_session", token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: 86400, // 24 hours
    });

    return response;
  } catch (err: any) {
    return NextResponse.json(
      { error: err.message || "Authentication failed" },
      { status: 401 }
    );
  }
}

/**
 * DELETE /api/auth/session
 * Clears the session cookie on logout.
 */
export async function DELETE() {
  const response = NextResponse.json({ success: true, message: "Logged out successfully" });
  response.cookies.set("ridenow_session", "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
  return response;
}
