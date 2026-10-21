import { getCoreDb } from "@/lib/db/core-db";
import { KmsVault } from "@/lib/security/kms";
import { MockBackgroundVendor } from "./external/background-vendor";
import crypto from "crypto";

// ====================================================================
// Driver Onboarding & Verification Service (Assignment 5, Section 2.4)
// Mitigates:
// - L0-01: Sensitive PII leak via field-level KMS envelope encryption
// ====================================================================

export interface DriverApplicationParams {
  fullName: string;
  contactPhone: string;
  licenseNumber: string;
  ssn: string;
  vehicleMake: string;
  vehicleModel: string;
  vehiclePlate: string;
}

export class OnboardingService {
  /**
   * Processes a driver onboarding application with field-level KMS envelope encryption (L0-01).
   */
  static async submitApplication(params: DriverApplicationParams) {
    const coreDb = getCoreDb();
    const driverId = `drv_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const checkId = `chk_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const vehicleId = `veh_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;

    // 1. Field-level KMS envelope encryption of SSN (L0-01)
    const encryptedSsn = KmsVault.encryptPII(params.ssn);

    // 2. Submit minimized verification to Mock Vendor
    const vendorSubmission = await MockBackgroundVendor.submitCheck({
      driverId,
      fullName: params.fullName,
      licenseNumber: params.licenseNumber,
    });

    // 3. Persist to Core DB inside atomic transaction
    coreDb.transaction(() => {
      // Driver profile
      coreDb.prepare(`
        INSERT INTO Driver (driver_id, full_name, contact_phone, license_number, onboarding_status, background_check_id)
        VALUES (?, ?, ?, ?, 'BACKGROUND_CHECK_SUBMITTED', ?)
      `).run(driverId, params.fullName, params.contactPhone, params.licenseNumber, checkId);

      // Background check record (holds encrypted PII only)
      coreDb.prepare(`
        INSERT INTO DriverBackgroundCheck (check_id, driver_id, vendor_reference, encrypted_ssn, status)
        VALUES (?, ?, ?, ?, 'IN_REVIEW')
      `).run(checkId, driverId, vendorSubmission.vendorReference, encryptedSsn);

      // Vehicle
      coreDb.prepare(`
        INSERT INTO Vehicle (vehicle_id, driver_id, make, model, license_plate, inspection_status)
        VALUES (?, ?, ?, ?, ?, 'PASSED')
      `).run(vehicleId, driverId, params.vehicleMake, params.vehicleModel, params.vehiclePlate);
    })();

    return {
      driverId,
      checkId,
      status: "BACKGROUND_CHECK_SUBMITTED",
      vendorReference: vendorSubmission.vendorReference,
      kmsEncrypted: true,
    };
  }

  /**
   * Approves background check and transitions driver to APPROVED.
   */
  static approveDriver(checkId: string) {
    const coreDb = getCoreDb();

    coreDb.transaction(() => {
      const check: any = coreDb.prepare("SELECT driver_id FROM DriverBackgroundCheck WHERE check_id = ?").get(checkId);
      if (!check) throw new Error("Check not found");

      coreDb.prepare(`
        UPDATE DriverBackgroundCheck
        SET status = 'CLEARED', cleared_at = CURRENT_TIMESTAMP
        WHERE check_id = ?
      `).run(checkId);

      coreDb.prepare(`
        UPDATE Driver
        SET onboarding_status = 'APPROVED'
        WHERE driver_id = ?
      `).run(check.driver_id);
    })();
  }
}
