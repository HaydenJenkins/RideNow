import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { AuthContext } from "@/lib/security/auth-context";
import { getGeoDb } from "@/lib/db/geo-db";
import { getCoreDb } from "@/lib/db/core-db";
import { DispatchService } from "@/lib/services/dispatch-service";

const RespondOfferSchema = z
  .object({
    offerId: z.string(),
    accept: z.boolean(),
  })
  .strict();

export async function GET(req: NextRequest) {
  const actor = AuthContext.getActor(req);
  if (!actor || actor.role !== "DRIVER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const geoDb = getGeoDb();
  const coreDb = getCoreDb();

  // 1. Fetch pending offer for this specific driver
  const offers = geoDb
    .prepare(`
      SELECT o.*, t.pickup_lat, t.pickup_lng, t.dropoff_lat, t.dropoff_lng, t.rider_id
      FROM ActiveDispatchOffer o
      JOIN ActiveTripState t ON o.trip_id = t.trip_id
      WHERE o.candidate_driver_id = ? AND o.status = 'PENDING'
      ORDER BY o.offered_at DESC
    `)
    .all(actor.actorId);

  // 2. Fetch all system pending offers so the demo UI can notify the presenter if another driver was matched
  const allSystemPending: any[] = geoDb
    .prepare(`
      SELECT o.*, t.pickup_lat, t.pickup_lng, t.dropoff_lat, t.dropoff_lng, t.rider_id
      FROM ActiveDispatchOffer o
      JOIN ActiveTripState t ON o.trip_id = t.trip_id
      WHERE o.status = 'PENDING'
      ORDER BY o.offered_at DESC
    `)
    .all();

  const driversList: any[] = coreDb.prepare("SELECT driver_id, full_name FROM Driver").all();
  const driverMap = new Map(driversList.map((d) => [d.driver_id, d.full_name]));

  const enrichedAllPending = allSystemPending.map((o) => ({
    ...o,
    candidateDriverName: driverMap.get(o.candidate_driver_id) || o.candidate_driver_id,
  }));

  return NextResponse.json({
    offers,
    allPending: enrichedAllPending,
  });
}

export async function POST(req: NextRequest) {
  const actor = AuthContext.getActor(req);
  if (!actor || actor.role !== "DRIVER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: any;
  try {
    const raw = await req.json();
    body = RespondOfferSchema.parse(raw);
  } catch (err: any) {
    return NextResponse.json({ error: "Validation failed", details: err.message }, { status: 400 });
  }

  try {
    const result = DispatchService.respondToOffer(body.offerId, actor.actorId, body.accept);
    return NextResponse.json(result);
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
}
