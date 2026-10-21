import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { AuthContext } from "@/lib/security/auth-context";
import { OpsService } from "@/lib/services/ops-service";

const UpdateIncidentSchema = z
  .object({
    incidentId: z.string(),
    status: z.enum(["OPEN", "INVESTIGATING", "RESOLVED", "DISMISSED"]),
  })
  .strict();

export async function GET(req: NextRequest) {
  const actor = AuthContext.getActor(req);
  if (!actor || actor.role !== "OPS_STAFF") {
    return NextResponse.json({ error: "Unauthorized: Ops staff access required." }, { status: 403 });
  }

  const incidents = OpsService.listIncidents();
  return NextResponse.json({ incidents });
}

export async function POST(req: NextRequest) {
  const actor = AuthContext.getActor(req);
  if (!actor || actor.role !== "OPS_STAFF") {
    return NextResponse.json({ error: "Unauthorized: Ops staff access required." }, { status: 403 });
  }

  try {
    const raw = await req.json();
    const body = UpdateIncidentSchema.parse(raw);
    OpsService.updateIncidentStatus(body.incidentId, body.status);
    return NextResponse.json({ success: true, incidentId: body.incidentId, status: body.status });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
}
