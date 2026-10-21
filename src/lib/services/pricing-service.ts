import { getGeoDb } from "@/lib/db/geo-db";
import { MockMapsProvider } from "./external/maps-provider";

// ====================================================================
// Pricing & Surge Engine (Assignment 5, Section 2.4)
// Mitigates:
// - L2-02: Client-side fare tampering (authoritative server-side fare calculation)
// Dynamically adjusts fare based on zone surge geofences.
// ====================================================================

export interface FareCalculation {
  baseFare: number;
  distanceKm: number;
  durationMinutes: number;
  surgeMultiplier: number;
  surgeZoneName: string | null;
  totalFare: number;
  driverPayout: number;
  calculatedAt: string;
}

export class PricingService {
  private static BASE_FARE = 3.5;
  private static PER_KM_RATE = 1.65;
  private static PER_MINUTE_RATE = 0.35;
  private static DRIVER_PAYOUT_RATIO = 0.8; // 80% to driver

  /**
   * Resolves the active surge multiplier for a given coordinate by querying SurgeGeofence.
   */
  static getSurgeForLocation(lat: number, lng: number): { multiplier: number; zoneName: string | null } {
    const geoDb = getGeoDb();
    const geofences: any[] = geoDb.prepare("SELECT * FROM SurgeGeofence").all();

    for (const fence of geofences) {
      const distKm = MockMapsProvider.calculateDistanceKm(lat, lng, fence.center_lat, fence.center_lng);
      const radiusKm = fence.radius_meters / 1000;
      if (distKm <= radiusKm) {
        return {
          multiplier: fence.surge_multiplier,
          zoneName: fence.zone_name,
        };
      }
    }

    return { multiplier: 1.0, zoneName: null };
  }

  /**
   * Authoritatively computes total fare and driver payout on the server (L2-02).
   */
  static computeFare(distanceKm: number, durationMinutes: number, pickupLat: number, pickupLng: number): FareCalculation {
    const { multiplier, zoneName } = this.getSurgeForLocation(pickupLat, pickupLng);

    const distanceCost = distanceKm * this.PER_KM_RATE;
    const timeCost = durationMinutes * this.PER_MINUTE_RATE;
    const subtotal = this.BASE_FARE + distanceCost + timeCost;
    const totalFare = Math.round(subtotal * multiplier * 100) / 100;
    const driverPayout = Math.round(totalFare * this.DRIVER_PAYOUT_RATIO * 100) / 100;

    return {
      baseFare: this.BASE_FARE,
      distanceKm,
      durationMinutes,
      surgeMultiplier: multiplier,
      surgeZoneName: zoneName,
      totalFare,
      driverPayout,
      calculatedAt: new Date().toISOString(),
    };
  }
}
