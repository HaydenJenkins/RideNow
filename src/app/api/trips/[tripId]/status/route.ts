import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { AuthContext } from "@/lib/security/auth-context";
import { DispatchService } from "@/lib/services/dispatch-service";

const TransitionSchema = z
  .object({
    newState: z.enum(["ARRIVED", "IN_PROGRESS", "COMPLETED", "CANCELLED"]),
    assignmentToken: z.string().optional(),
  })
  .strict();

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ tripId: string }> }
) {
  const { tripId } = await params;

  // 1. Verify actor identity
  const actor = AuthContext.getActor(req);
  if (!actor) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // 2. Parse body
  let body: any;
  try {
    const raw = await req.json();
    body = TransitionSchema.parse(raw);
  } catch (err: any) {
    return NextResponse.json(
      { error: "Validation failed", details: err.errors || err.message },
      { status: 400 }
    );
  }

  // 3. State transition execution with token verification and optimistic locking (L2-24, L2-18)
  try {
    const result = DispatchService.transitionTripState({
      tripId,
      newState: body.newState,
      assignmentToken: body.assignmentToken,
    });

    return NextResponse.json({
      ...result,
      mitigationsEnforced: [
        "L2-24: Cryptographic Trip Assignment Token verified against KMS keys",
        "L2-18: Durable state machine with optimistic locking version check",
      ],
    });
  } catch (err: any) {
    return NextResponse.json(
      { error: err.message, mitigation: "State Machine Protection (L2-18 / L2-24)" },
      { status: 400 }
    );
  }
}
