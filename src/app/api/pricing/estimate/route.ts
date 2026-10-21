import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { MockMapsProvider } from "@/lib/services/external/maps-provider";
import { PricingService } from "@/lib/services/pricing-service";

const EstimateSchema = z
  .object({
    pickupLat: z.number().min(-90).max(90),
    pickupLng: z.number().min(-180).max(180),
    dropoffLat: z.number().min(-90).max(90),
    dropoffLng: z.number().min(-180).max(180),
  })
  .strict();

export async function POST(req: NextRequest) {
  try {
    const raw = await req.json();
    const body = EstimateSchema.parse(raw);

    const route = await MockMapsProvider.getRouteEstimate(
      body.pickupLat,
      body.pickupLng,
      body.dropoffLat,
      body.dropoffLng
    );

    const fare = PricingService.computeFare(
      route.distanceKm,
      route.durationMinutes,
      body.pickupLat,
      body.pickupLng
    );

    return NextResponse.json({
      success: true,
      route,
      fare,
      mitigation: "L2-02: Server-side authoritative pricing computation",
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
}
