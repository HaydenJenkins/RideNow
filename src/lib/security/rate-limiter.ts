// ====================================================================
// Distributed Rate Limiter & Concurrency Governor (Assignment 5, Section 2.2)
// Mitigates:
// - L1-05: API Gateway outage / volumetric flooding
// - L2-03: Ride-request endpoint outage (per-rider quota)
// - L2-13: High-frequency location-update endpoint outage (per-driver ceiling)
// ====================================================================

interface RateLimitRecord {
  timestamps: number[];
  lastRequestAt: number;
}

const rateLimitStore = new Map<string, RateLimitRecord>();

export interface RateLimitOptions {
  windowMs: number;       // Window duration in ms
  maxRequests: number;    // Allowed requests in window
  minIntervalMs?: number; // Minimum interval between individual requests (e.g. 1 update/sec ceiling)
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetMs: number;
  retryAfterSeconds?: number;
  reason?: string;
}

export class RateLimiter {
  /**
   * Evaluates whether a request should be allowed or throttled (HTTP 429).
   */
  static check(key: string, options: RateLimitOptions): RateLimitResult {
    const now = Date.now();
    let record = rateLimitStore.get(key);

    if (!record) {
      record = { timestamps: [], lastRequestAt: 0 };
      rateLimitStore.set(key, record);
    }

    // Check minimum interval ceiling (e.g. max 1 ping per second for GPS telemetry - L2-13)
    if (options.minIntervalMs && record.lastRequestAt > 0) {
      const elapsed = now - record.lastRequestAt;
      if (elapsed < options.minIntervalMs) {
        const retryAfter = Math.ceil((options.minIntervalMs - elapsed) / 1000);
        return {
          allowed: false,
          remaining: 0,
          resetMs: options.minIntervalMs - elapsed,
          retryAfterSeconds: Math.max(1, retryAfter),
          reason: `Rate limit ceiling exceeded. Minimum interval is ${options.minIntervalMs}ms.`,
        };
      }
    }

    // Filter timestamps within current sliding window
    const windowStart = now - options.windowMs;
    record.timestamps = record.timestamps.filter((ts) => ts > windowStart);

    if (record.timestamps.length >= options.maxRequests) {
      const oldest = record.timestamps[0];
      const resetMs = oldest + options.windowMs - now;
      const retryAfter = Math.ceil(resetMs / 1000);
      return {
        allowed: false,
        remaining: 0,
        resetMs,
        retryAfterSeconds: Math.max(1, retryAfter),
        reason: `Maximum quota of ${options.maxRequests} requests per ${Math.round(options.windowMs / 1000)}s exceeded.`,
      };
    }

    // Record this request
    record.timestamps.push(now);
    record.lastRequestAt = now;

    const remaining = options.maxRequests - record.timestamps.length;
    return {
      allowed: true,
      remaining,
      resetMs: options.windowMs,
    };
  }

  /**
   * Preset configurations tailored for RideNow threat boundaries:
   */
  static presets = {
    // L2-03: Max 5 ride requests per 60 seconds per rider to prevent dispatch starvation
    rideRequest: {
      windowMs: 60 * 1000,
      maxRequests: 5,
      minIntervalMs: 2000,
    },
    // L2-13: Per-driver GPS ceiling: at most 1 update per second
    driverLocation: {
      windowMs: 10 * 1000,
      maxRequests: 10,
      minIntervalMs: 1000,
    },
    // L1-05: Standard API route throttle per IP
    standardApi: {
      windowMs: 60 * 1000,
      maxRequests: 120,
    },
  };
}
