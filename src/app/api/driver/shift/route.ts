import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { AuthContext } from "@/lib/security/auth-context";
import { LocationTrackingService } from "@/lib/services/location-service";

const ShiftSchema = z.object({ isOnline: z.boolean() }).strict();

export async function GET() {
  const statuses = LocationTrackingService.getAllDriverOnlineStatuses();
  return NextResponse.json({ success: true, statuses });
}

export async function POST(req: NextRequest) {
  const actor = AuthContext.getActor(req);
  if (!actor || actor.role !== "DRIVER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const raw = await req.json();
    const body = ShiftSchema.parse(raw);
    LocationTrackingService.setDriverOnlineStatus(actor.actorId, body.isOnline);
    const statuses = LocationTrackingService.getAllDriverOnlineStatuses();
    return NextResponse.json({
      success: true,
      driverId: actor.actorId,
      isOnline: body.isOnline,
      statuses,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
}
