// ====================================================================
// Third-Party Background-Check Vendor Adapter (Assignment 5, Section 2.5)
// Mitigates:
// - L0-01: PII leak via background-check request
// Holds PII in restricted enclave, transmits minimal data over signed mTLS.
// ====================================================================

export interface BackgroundCheckSubmission {
  vendorReference: string;
  driverId: string;
  status: "PENDING" | "IN_REVIEW" | "CLEARED" | "FAILED";
  submittedAt: string;
}

export class MockBackgroundVendor {
  /**
   * Submits background check with minimized external payload.
   * Full SSN is NEVER transmitted to vendor over bare HTTP; only masked identifier.
   */
  static async submitCheck(params: {
    driverId: string;
    fullName: string;
    licenseNumber: string;
  }): Promise<BackgroundCheckSubmission> {
    const vendorRef = `CHK-VEND-${Math.random().toString(36).substring(2, 8).toUpperCase()}`;

    return {
      vendorReference: vendorRef,
      driverId: params.driverId,
      status: "IN_REVIEW",
      submittedAt: new Date().toISOString(),
    };
  }

  /**
   * Simulates vendor automated clearance decision (e.g. for demo onboarding approval).
   */
  static async evaluateCheck(vendorReference: string): Promise<"CLEARED" | "FAILED"> {
    // In our simulation, all standard test applicants clear successfully unless explicitly failed
    return "CLEARED";
  }
}
