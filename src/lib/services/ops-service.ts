import { getCoreDb } from "@/lib/db/core-db";
import { getGeoDb } from "@/lib/db/geo-db";

// ====================================================================
// Admin & Operations Service (Assignment 5, Section 2.1 & 3.1)
// Mitigates:
// - L1-06: API Gateway & private administrative interfaces isolation
// - L1-12: Mandatory role-based authorization for safety investigators
// Tooling for support staff and safety investigators.
// ====================================================================

export class OpsService {
  /**
   * Fetches support incidents with trip and reporter context.
   */
  static listIncidents() {
    const coreDb = getCoreDb();
    return coreDb.prepare(`
      SELECT 
        i.incident_id, i.trip_id, i.reporter_id, i.category, i.status, i.details, i.created_at,
        s.full_name as assigned_staff_name
      FROM SupportIncident i
      LEFT JOIN OpsStaff s ON i.assigned_staff_id = s.staff_id
      ORDER BY i.created_at DESC
    `).all();
  }

  /**
   * Updates support incident status.
   */
  static updateIncidentStatus(incidentId: string, status: "OPEN" | "INVESTIGATING" | "RESOLVED" | "DISMISSED") {
    const coreDb = getCoreDb();
    coreDb.prepare(`
      UPDATE SupportIncident
      SET status = ?, resolved_at = CASE WHEN ? IN ('RESOLVED', 'DISMISSED') THEN CURRENT_TIMESTAMP ELSE NULL END
      WHERE incident_id = ?
    `).run(status, status, incidentId);
  }

  /**
   * Fetches flagged GPS spoofing and velocity anomalies from Geo DB (L2-10).
   */
  static listTelemetryAnomalies() {
    const geoDb = getGeoDb();
    return geoDb.prepare(`
      SELECT * FROM TelemetryAuditLog
      WHERE anomaly_flag = 1
      ORDER BY recorded_at DESC
      LIMIT 50
    `).all();
  }

  /**
   * Clears telemetry anomaly audit log for clean demo runs.
   */
  static clearTelemetryAnomalies() {
    const geoDb = getGeoDb();
    geoDb.prepare("DELETE FROM TelemetryAuditLog WHERE anomaly_flag = 1").run();
  }

  /**
   * Fetches drivers in onboarding queue with background check status.
   */
  static listOnboardingQueue() {
    const coreDb = getCoreDb();
    return coreDb.prepare(`
      SELECT 
        d.driver_id, d.full_name, d.contact_phone, d.license_number, d.onboarding_status,
        c.check_id, c.vendor_reference, c.encrypted_ssn, c.status as check_status, c.cleared_at,
        v.make, v.model, v.license_plate
      FROM Driver d
      LEFT JOIN DriverBackgroundCheck c ON d.background_check_id = c.check_id
      LEFT JOIN Vehicle v ON d.driver_id = v.driver_id
      ORDER BY d.created_at DESC
    `).all();
  }
}
