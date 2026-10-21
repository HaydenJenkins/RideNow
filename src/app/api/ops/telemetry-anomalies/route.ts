import { NextRequest, NextResponse } from "next/server";
import { AuthContext } from "@/lib/security/auth-context";
import { OpsService } from "@/lib/services/ops-service";

export async function GET(req: NextRequest) {
  const actor = AuthContext.getActor(req);
  if (!actor || actor.role !== "OPS_STAFF") {
    return NextResponse.json({ error: "Unauthorized: Ops staff access required." }, { status: 403 });
  }

  const anomalies = OpsService.listTelemetryAnomalies();
  return NextResponse.json({
    anomalies,
    mitigation: "L2-10: Kalman & spatial velocity sanity check logs",
  });
}

export async function DELETE(req: NextRequest) {
  const actor = AuthContext.getActor(req);
  if (!actor || actor.role !== "OPS_STAFF") {
    return NextResponse.json({ error: "Unauthorized: Ops staff access required." }, { status: 403 });
  }

  OpsService.clearTelemetryAnomalies();
  return NextResponse.json({ success: true, message: "Cleared telemetry anomaly audit log." });
}
