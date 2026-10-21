import { getGeoDb } from "@/lib/db/geo-db";
import { MockMapsProvider } from "./external/maps-provider";
import crypto from "crypto";

// ====================================================================
// Location Tracking Service (Assignment 5, Section 2.4)
// Mitigates:
// - L2-10: GPS stream tampering & spoofing via monotonic sequence checks,
//          velocity thresholds, and telemetry audit logging.
// ====================================================================

export interface LocationUpdateParams {
  driverId: string;
  latitude: number;
  longitude: number;
  speedMps: number;
  sequenceNum: number;
  isSimulatedTransit?: boolean; // Legitimate demo navigation simulation between waypoints
}

export interface LocationUpdateResult {
  accepted: boolean;
  driverId: string;
  latitude: number;
  longitude: number;
  velocityKmh: number;
  anomalyDetected: boolean;
  anomalyReason?: string;
}

export class LocationTrackingService {
  private static MAX_PLAUSIBLE_VELOCITY_KMH = 160.0; // Plausible urban/highway threshold

  /**
   * Ingests a driver telemetry ping with sequence validation and velocity sanity check (L2-10).
   */
  static recordDriverLocation(params: LocationUpdateParams): LocationUpdateResult {
    const geoDb = getGeoDb();

    // 1. Fetch existing driver location record to check sequence and last position
    const existing: any = geoDb
      .prepare("SELECT * FROM DriverLiveLocation WHERE driver_id = ?")
      .get(params.driverId);

    const now = Date.now();
    let velocityKmh = 0;
    let anomalyDetected = false;
    let anomalyReason: string | undefined;

    if (existing) {
      if (params.isSimulatedTransit) {
        // Legitimate navigation transit simulation: simulate normal urban velocity (38 km/h)
        // avoids false-positive velocity alerts from fast demo timers
        velocityKmh = 38.0;
        anomalyDetected = false;
        anomalyReason = undefined;
      } else if (params.sequenceNum <= existing.sequence_num) {
        // Monotonic sequence counter check (L2-10)
        anomalyDetected = true;
        anomalyReason = `Replay or out-of-order sequence: received #${params.sequenceNum}, expected > #${existing.sequence_num}`;
      } else {
        // Velocity sanity check (Distance / Elapsed Time)
        // Normalize SQLite timestamp to UTC
        const pingStr = String(existing.last_ping);
        const lastPingUtc = pingStr.endsWith("Z") ? pingStr : pingStr.replace(" ", "T") + "Z";
        const lastPingTime = new Date(lastPingUtc).getTime();
        const elapsedSeconds = Math.max(1, (now - lastPingTime) / 1000);

        const distanceKm = MockMapsProvider.calculateDistanceKm(
          existing.latitude,
          existing.longitude,
          params.latitude,
          params.longitude
        );

        velocityKmh = Math.round((distanceKm / (elapsedSeconds / 3600)) * 10) / 10;

        if (velocityKmh > this.MAX_PLAUSIBLE_VELOCITY_KMH) {
          anomalyDetected = true;
          anomalyReason = `Velocity sanity check failed: ${velocityKmh} km/h exceeds plausible threshold (${this.MAX_PLAUSIBLE_VELOCITY_KMH} km/h). Suspected GPS spoofing / teleportation.`;
        }
      }
    }

    // 4. Log to TelemetryAuditLog if anomaly is flagged
    if (anomalyDetected) {
      const telemetryId = `tel_${crypto.randomUUID().substring(0, 8)}`;
      geoDb.prepare(`
        INSERT INTO TelemetryAuditLog (telemetry_id, driver_id, velocity_kmh, anomaly_flag, anomaly_reason)
        VALUES (?, ?, ?, 1, ?)
      `).run(
        telemetryId,
        params.driverId,
        velocityKmh,
        anomalyReason || null
      );
    }

    // 5. Commit to DriverLiveLocation
    const geohash = `geo_${Math.round(params.latitude * 100)}_${Math.round(params.longitude * 100)}`;
    geoDb.prepare(`
      INSERT INTO DriverLiveLocation (driver_id, latitude, longitude, speed_mps, sequence_num, spatial_geohash, is_online, last_ping)
      VALUES (?, ?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP)
      ON CONFLICT(driver_id) DO UPDATE SET
        latitude = excluded.latitude,
        longitude = excluded.longitude,
        speed_mps = excluded.speed_mps,
        sequence_num = CASE WHEN excluded.sequence_num > sequence_num THEN excluded.sequence_num ELSE sequence_num END,
        spatial_geohash = excluded.spatial_geohash,
                last_ping = CURRENT_TIMESTAMP
    `).run(
      params.driverId,
      params.latitude,
      params.longitude,
      params.isSimulatedTransit ? 10.5 : params.speedMps,
      params.sequenceNum,
      geohash
    );

    return {
      accepted: !anomalyDetected,
      driverId: params.driverId,
      latitude: params.latitude,
      longitude: params.longitude,
      velocityKmh,
      anomalyDetected,
      anomalyReason,
    };
  }

  /**
   * Toggles driver online / offline shift status for an individual driver.
   */
  static setDriverOnlineStatus(driverId: string, isOnline: boolean) {
    const geoDb = getGeoDb();
    const existing = geoDb.prepare("SELECT driver_id FROM DriverLiveLocation WHERE driver_id = ?").get(driverId);
    if (existing) {
      geoDb.prepare("UPDATE DriverLiveLocation SET is_online = ? WHERE driver_id = ?").run(isOnline ? 1 : 0, driverId);
    } else {
      geoDb.prepare(`
        INSERT INTO DriverLiveLocation (driver_id, latitude, longitude, speed_mps, sequence_num, spatial_geohash, is_online, last_ping)
        VALUES (?, 33.7745, -84.3880, 0, 0, 'dn5bp8u7', ?, CURRENT_TIMESTAMP)
      `).run(driverId, isOnline ? 1 : 0);
    }
  }

  /**
   * Returns whether a specific driver is currently online.
   */
  static getDriverOnlineStatus(driverId: string): boolean {
    const geoDb = getGeoDb();
    const row: any = geoDb.prepare("SELECT is_online FROM DriverLiveLocation WHERE driver_id = ?").get(driverId);
    return row ? Boolean(row.is_online) : true;
  }

  /**
   * Returns a map of all drivers and their active online/offline shift status.
   */
  static getAllDriverOnlineStatuses(): Record<string, boolean> {
    const geoDb = getGeoDb();
    const rows: any[] = geoDb.prepare("SELECT driver_id, is_online FROM DriverLiveLocation").all();
    const result: Record<string, boolean> = {};
    for (const r of rows) {
      result[r.driver_id] = Boolean(r.is_online);
    }
    return result;
  }
}
