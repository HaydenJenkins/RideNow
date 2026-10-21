import { KmsVault } from "@/lib/security/kms";

// ====================================================================
// Third-Party Payment Processor Adapter (Assignment 5, Section 2.5)
// Mitigates:
// - L0-03: User payment info leak via third-party boundary (PCI isolation)
// - L1-02: Webhook forgery prevention via HMAC-SHA256 signatures
// ====================================================================

export interface PaymentCaptureResult {
  transactionId: string;
  status: "SETTLED" | "PENDING" | "FAILED";
  amount: number;
  tokenUsed: string;
}

export class MockPaymentProcessor {
  /**
   * Simulates the client-side SDK tokenization process (PCI isolation - L0-03).
   * Raw card number and CVV NEVER cross the RideNow boundary.
   */
  static tokenizeCardClientSide(fakeCardLast4: string): string {
    const randomHex = Math.random().toString(16).substring(2, 10);
    return `tok_pci_vault_${fakeCardLast4}_${randomHex}`;
  }

  /**
   * Charges rider's tokenized payment method.
   */
  static async captureCharge(params: {
    customerToken: string;
    amount: number;
    tripId: string;
  }): Promise<PaymentCaptureResult> {
    // Simulate payment processor processing
    await new Promise((res) => setTimeout(res, 50));

    const txId = `tx_stripe_sandbox_${Math.random().toString(36).substring(2, 11)}`;
    return {
      transactionId: txId,
      status: "SETTLED",
      amount: params.amount,
      tokenUsed: params.customerToken,
    };
  }

  /**
   * Generates a signed webhook payload from the payment processor to RideNow.
   */
  static generateSettlementWebhook(params: {
    tripId: string;
    transactionId: string;
    amount: number;
  }): { payloadRaw: string; signatureHeader: string } {
    const payload = {
      event: "payment_intent.succeeded",
      trip_id: params.tripId,
      transaction_id: params.transactionId,
      amount: params.amount,
      currency: "usd",
      timestamp: new Date().toISOString(),
    };

    const payloadRaw = JSON.stringify(payload);
    const signatureHeader = KmsVault.signWebhookPayload(payloadRaw);

    return { payloadRaw, signatureHeader };
  }
}
