import { NextRequest, NextResponse } from "next/server";
import { KmsVault } from "@/lib/security/kms";
import { getCoreDb } from "@/lib/db/core-db";

// Mitigates:
// - L0-03: Payment processor webhook spoofing / tampering
// - L1-02: Inter-process forgery prevention via cryptographic HMAC
export async function POST(req: NextRequest) {
  const signatureHeader = req.headers.get("x-signature-sha256") || "";
  const rawBody = await req.text();

  // 1. Verify HMAC-SHA256 signature against KMS shared secret (L0-03)
  const isValid = KmsVault.verifyWebhookSignature(rawBody, signatureHeader);
  if (!isValid) {
    return NextResponse.json(
      {
        error: "Invalid webhook signature: HMAC-SHA256 verification failed (L0-03).",
        mitigation: "HMAC signature verification",
      },
      { status: 401 }
    );
  }

  // 2. Process verified payment event
  try {
    const event = JSON.parse(rawBody);
    if (event.event === "payment_intent.succeeded" && event.trip_id) {
      const coreDb = getCoreDb();
      coreDb.prepare(`
        UPDATE BillingRecord
        SET payment_status = 'SETTLED', payment_tx_ref = ?
        WHERE trip_id = ?
      `).run(event.transaction_id, event.trip_id);
    }

    return NextResponse.json({
      received: true,
      event: event.event,
      verifiedWithHmac: true,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
}
