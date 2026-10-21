import { NextRequest, NextResponse } from "next/server";
import { MockMapsProvider } from "@/lib/services/external/maps-provider";

export async function GET() {
  return NextResponse.json({
    circuitState: MockMapsProvider.getCircuitStatus(),
    simulatedOutage: MockMapsProvider.isOutageSimulated(),
    mitigation: "L0-08 & L1-05: Service-level circuit breaker and fallback routing",
  });
}

export async function POST(req: NextRequest) {
  try {
    const { enabled } = await req.json();
    MockMapsProvider.setSimulatedOutage(Boolean(enabled));
    return NextResponse.json({
      success: true,
      circuitState: MockMapsProvider.getCircuitStatus(),
      simulatedOutage: MockMapsProvider.isOutageSimulated(),
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
}
