import { NextRequest, NextResponse } from "next/server";
import { AuthContext } from "@/lib/security/auth-context";
import { getGeoDb } from "@/lib/db/geo-db";
import { getCoreDb } from "@/lib/db/core-db";

export async function GET(req: NextRequest) {
  const actor = AuthContext.getActor(req);
  if (!actor) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const geoDb = getGeoDb();
  const coreDb = getCoreDb();

  // 1. Fetch any in-flight active trip for this actor
  let activeTrip: any = null;
  if (actor.role === "RIDER") {
    // Return active in-flight trip, including CANCELLED until the rider explicitly confirms and dismisses
    activeTrip = geoDb
      .prepare("SELECT * FROM ActiveTripState WHERE rider_id = ? AND current_state != 'COMPLETED' ORDER BY updated_at DESC LIMIT 1")
      .get(actor.actorId);
  } else if (actor.role === "DRIVER") {
    activeTrip = geoDb
      .prepare("SELECT * FROM ActiveTripState WHERE driver_id = ? AND current_state NOT IN ('COMPLETED', 'CANCELLED') ORDER BY updated_at DESC LIMIT 1")
      .get(actor.actorId);
  }

  // 2. Fetch past completed trips
  let history: any[] = [];
  if (actor.role === "RIDER") {
    history = coreDb
      .prepare(`
        SELECT t.*, b.total_fare, b.payment_status
        FROM Trip t
        LEFT JOIN BillingRecord b ON t.trip_id = b.trip_id
        WHERE t.rider_id = ?
        ORDER BY t.created_at DESC
        LIMIT 10
      `)
      .all(actor.actorId);
  } else if (actor.role === "DRIVER") {
    history = coreDb
      .prepare(`
        SELECT t.*, b.driver_payout, b.payment_status
        FROM Trip t
        LEFT JOIN BillingRecord b ON t.trip_id = b.trip_id
        WHERE t.driver_id = ?
        ORDER BY t.created_at DESC
        LIMIT 10
      `)
      .all(actor.actorId);
  }

  return NextResponse.json({
    actor,
    activeTrip: activeTrip || null,
    history,
  });
}

// 3. Dismiss cancelled in-flight trip (Rider confirmation)
export async function DELETE(req: NextRequest) {
  const actor = AuthContext.getActor(req);
  if (!actor || actor.role !== "RIDER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const tripId = searchParams.get("tripId");
  if (!tripId) {
    return NextResponse.json({ error: "tripId is required" }, { status: 400 });
  }

  const geoDb = getGeoDb();
  geoDb.prepare("DELETE FROM ActiveTripState WHERE trip_id = ? AND rider_id = ?").run(tripId, actor.actorId);
  return NextResponse.json({ success: true });
}
