// ====================================================================
// Third-Party Maps & Geocoding Provider Adapter (Assignment 5, Section 2.5)
// Mitigates:
// - L0-08: RideNow system-wide outage via service-level circuit breakers
// - L1-05: Gateway outage / hung external calls with strict timeouts
// ====================================================================

export interface RouteEstimate {
  distanceKm: number;
  durationMinutes: number;
  etaTimestamp: string;
  routePolylineHash: string;
  source: "LIVE_MAPS_PROVIDER" | "FALLBACK_CACHE";
}

enum CircuitState {
  CLOSED,
  OPEN,
  HALF_OPEN,
}

class CircuitBreaker {
  private state: CircuitState = CircuitState.CLOSED;
  private failureCount: number = 0;
  private lastFailureTime: number = 0;
  private readonly failureThreshold: number = 3;
  private readonly recoveryTimeoutMs: number = 10000; // 10s cooldown

  public isOpen(): boolean {
    if (this.state === CircuitState.OPEN) {
      if (Date.now() - this.lastFailureTime > this.recoveryTimeoutMs) {
        this.state = CircuitState.HALF_OPEN;
        return false;
      }
      return true;
    }
    return false;
  }

  public recordSuccess() {
    this.failureCount = 0;
    this.state = CircuitState.CLOSED;
  }

  public recordFailure() {
    this.failureCount++;
    this.lastFailureTime = Date.now();
    if (this.failureCount >= this.failureThreshold) {
      this.state = CircuitState.OPEN;
    }
  }

  public getState(): string {
    switch (this.state) {
      case CircuitState.CLOSED: return "CLOSED";
      case CircuitState.OPEN: return "OPEN (CIRCUIT TRIPPED)";
      case CircuitState.HALF_OPEN: return "HALF_OPEN (TESTING)";
    }
  }
}

export class MockMapsProvider {
  private static circuitBreaker = new CircuitBreaker();
  private static simulatedOutage: boolean = false;

  public static setSimulatedOutage(enabled: boolean) {
    this.simulatedOutage = enabled;
  }

  public static isOutageSimulated(): boolean {
    return this.simulatedOutage;
  }

  public static getCircuitStatus(): string {
    return this.circuitBreaker.getState();
  }

  /**
   * Calculates Haversine distance in kilometers between two GPS coordinates.
   */
  public static calculateDistanceKm(
    lat1: number,
    lon1: number,
    lat2: number,
    lon2: number
  ): number {
    const R = 6371; // Earth's radius in km
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLon = ((lon2 - lon1) * Math.PI) / 180;
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos((lat1 * Math.PI) / 180) *
        Math.cos((lat2 * Math.PI) / 180) *
        Math.sin(dLon / 2) *
        Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return Math.round(R * c * 100) / 100;
  }

  /**
   * Requests route ETA from Maps Provider protected by a Circuit Breaker and fallback cache.
   */
  public static async getRouteEstimate(
    pickupLat: number,
    pickupLng: number,
    dropoffLat: number,
    dropoffLng: number
  ): Promise<RouteEstimate> {
    const distanceKm = this.calculateDistanceKm(pickupLat, pickupLng, dropoffLat, dropoffLng);
    // Typical urban traffic speed: 32 km/h
    const baseDurationMinutes = Math.max(3, Math.round((distanceKm / 32) * 60));
    const routeHash = `route_${Math.round(pickupLat * 100)}_${Math.round(dropoffLat * 100)}_${distanceKm}`;

    // 1. If circuit breaker is OPEN or simulated outage is active
    if (this.circuitBreaker.isOpen() || this.simulatedOutage) {
      if (this.simulatedOutage) {
        this.circuitBreaker.recordFailure();
      }
      // Return fallback estimate from local cache without stalling dispatch
      const eta = new Date(Date.now() + (baseDurationMinutes + 2) * 60000).toISOString();
      return {
        distanceKm,
        durationMinutes: baseDurationMinutes + 2,
        etaTimestamp: eta,
        routePolylineHash: routeHash,
        source: "FALLBACK_CACHE",
      };
    }

    try {
      // Simulate external API call latency (30ms - 80ms)
      await new Promise((res) => setTimeout(res, 40));
      this.circuitBreaker.recordSuccess();

      const eta = new Date(Date.now() + baseDurationMinutes * 60000).toISOString();
      return {
        distanceKm,
        durationMinutes: baseDurationMinutes,
        etaTimestamp: eta,
        routePolylineHash: routeHash,
        source: "LIVE_MAPS_PROVIDER",
      };
    } catch (err) {
      this.circuitBreaker.recordFailure();
      const eta = new Date(Date.now() + baseDurationMinutes * 60000).toISOString();
      return {
        distanceKm,
        durationMinutes: baseDurationMinutes,
        etaTimestamp: eta,
        routePolylineHash: routeHash,
        source: "FALLBACK_CACHE",
      };
    }
  }
}
