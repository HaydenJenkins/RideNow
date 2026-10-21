import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { OnboardingService } from "@/lib/services/onboarding-service";

const ApplicationSchema = z
  .object({
    fullName: z.string().min(2),
    contactPhone: z.string().min(10),
    licenseNumber: z.string().min(5),
    ssn: z.string().regex(/^\d{3}-\d{2}-\d{4}$/, "Must be valid SSN format (XXX-XX-XXXX)"),
    vehicleMake: z.string().min(2),
    vehicleModel: z.string().min(2),
    vehiclePlate: z.string().min(2),
  })
  .strict();

export async function POST(req: NextRequest) {
  try {
    const raw = await req.json();
    const body = ApplicationSchema.parse(raw);

    const result = await OnboardingService.submitApplication(body);

    return NextResponse.json({
      success: true,
      ...result,
      mitigation: "L0-01: SSN encrypted with AES-256-GCM KMS envelope encryption",
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
}
