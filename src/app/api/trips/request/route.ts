import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { AuthContext } from "@/lib/security/auth-context";
import { RateLimiter } from "@/lib/security/rate-limiter";
import { DispatchService } from "@/lib/services/dispatch-service";

// Strict input schema validation (L1-07)
// Note: rider_id is explicitly NOT allowed in the request body (L2-02)
const RequestRideSchema = z
  .object({
    pickupLat: z.number().min(-90).max(90),
    pickupLng: z.number().min(-180).max(180),
    dropoffLat: z.number().min(-90).max(90),
    dropoffLng: z.number().min(-180).max(180),
    idempotencyKey: z.string().min(6).max(128),
    preferredDriverId: z.string().optional(),
  })
  .strict();

export async function POST(req: NextRequest) {
  // 1. Authenticate & derive rider identity server-side (L2-02, L1-01)
  const actor = AuthContext.getActor(req);
  if (!actor || actor.role !== "RIDER") {
    return NextResponse.json(
      { error: "Unauthorized: only authenticated riders can request a trip." },
      { status: 401 }
    );
  }

  // 2. Distributed route-specific rate limiting (L2-03, L1-05)
  const rateLimitResult = RateLimiter.check(
    `ride_req_${actor.actorId}`,
    RateLimiter.presets.rideRequest
  );
  if (!rateLimitResult.allowed) {
    return NextResponse.json(
      {
        error: rateLimitResult.reason,
        retryAfter: rateLimitResult.retryAfterSeconds,
        mitigation: "Rate Limiter (L2-03)",
      },
      {
        status: 429,
        headers: { "Retry-After": String(rateLimitResult.retryAfterSeconds || 1) },
      }
    );
  }

  // 3. Strict schema validation (L1-07)
  let body: any;
  try {
    const raw = await req.json();
    body = RequestRideSchema.parse(raw);
  } catch (err: any) {
    return NextResponse.json(
      { error: "Validation failed", details: err.errors || err.message },
      { status: 400 }
    );
  }

  // 4. Ingest into 5-stage dispatch pipeline
  try {
    const result = await DispatchService.requestRide({
      riderId: actor.actorId, // Injected server-side (L2-02)
      pickupLat: body.pickupLat,
      pickupLng: body.pickupLng,
      dropoffLat: body.dropoffLat,
      dropoffLng: body.dropoffLng,
      idempotencyKey: body.idempotencyKey,
      preferredDriverId: body.preferredDriverId,
    });

    return NextResponse.json({
      success: true,
      ...result,
      mitigationsEnforced: [
        "L2-02: Server-derived rider identity",
        "L2-03: Route rate limiter & client idempotency check",
        "L2-24: Cryptographically signed assignment token minted",
      ],
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || "Dispatch failed" }, { status: 409 });
  }
}
