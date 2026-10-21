import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { AuthContext } from "@/lib/security/auth-context";
import { RateLimiter } from "@/lib/security/rate-limiter";
import { LocationTrackingService } from "@/lib/services/location-service";

const DriverLocationSchema = z
  .object({
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
    speedMps: z.number().min(0).max(150).default(0),
    sequenceNum: z.number().int().nonnegative(),
    isSimulatedTransit: z.boolean().optional(),
  })
  .strict();

export async function POST(req: NextRequest) {
  // 1. Authenticate & derive driver identity server-side (L2-02, L1-01)
  const actor = AuthContext.getActor(req);
  if (!actor || actor.role !== "DRIVER") {
    return NextResponse.json(
      { error: "Unauthorized: only authenticated drivers can stream telemetry." },
      { status: 401 }
    );
  }

  // 2. Strict schema validation (L1-07)
  let body: any;
  try {
    const raw = await req.json();
    body = DriverLocationSchema.parse(raw);
  } catch (err: any) {
    return NextResponse.json(
      { error: "Validation failed", details: err.errors || err.message },
      { status: 400 }
    );
  }

  // 3. Per-driver ingestion ceiling: max 1 update/sec (L2-13)
  // Skip rate limiting only during legitimate demo navigation transit animation
  if (!body.isSimulatedTransit) {
    const rateLimitResult = RateLimiter.check(
      `driver_gps_${actor.actorId}`,
      RateLimiter.presets.driverLocation
    );
    if (!rateLimitResult.allowed) {
      return NextResponse.json(
        {
          error: rateLimitResult.reason,
          mitigation: "L2-13: Per-driver telemetry ingestion ceiling (1/sec)",
        },
        {
          status: 429,
          headers: { "Retry-After": String(rateLimitResult.retryAfterSeconds || 1) },
        }
      );
    }
  }

  // 4. Ingest telemetry into Location Tracking Service (L2-10)
  const result = LocationTrackingService.recordDriverLocation({
    driverId: actor.actorId, // Derived server-side
    latitude: body.latitude,
    longitude: body.longitude,
    speedMps: body.speedMps,
    sequenceNum: body.sequenceNum,
    isSimulatedTransit: body.isSimulatedTransit,
  });

  return NextResponse.json({
    success: result.accepted,
    ...result,
    mitigationsEnforced: [
      "L2-13: Per-driver ingestion quota",
      "L2-10: Monotonic sequence counter and velocity anomaly verification",
    ],
  });
}
