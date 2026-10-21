import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { AuthContext } from "@/lib/security/auth-context";
import { OpsService } from "@/lib/services/ops-service";
import { OnboardingService } from "@/lib/services/onboarding-service";

const ApproveDriverSchema = z.object({ checkId: z.string() }).strict();

export async function GET(req: NextRequest) {
  const actor = AuthContext.getActor(req);
  if (!actor || actor.role !== "OPS_STAFF") {
    return NextResponse.json({ error: "Unauthorized: Ops staff access required." }, { status: 403 });
  }

  const drivers = OpsService.listOnboardingQueue();
  return NextResponse.json({ drivers });
}

export async function POST(req: NextRequest) {
  const actor = AuthContext.getActor(req);
  if (!actor || actor.role !== "OPS_STAFF") {
    return NextResponse.json({ error: "Unauthorized: Ops staff access required." }, { status: 403 });
  }

  try {
    const raw = await req.json();
    const body = ApproveDriverSchema.parse(raw);
    OnboardingService.approveDriver(body.checkId);
    return NextResponse.json({ success: true, checkId: body.checkId, status: "APPROVED" });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
}
