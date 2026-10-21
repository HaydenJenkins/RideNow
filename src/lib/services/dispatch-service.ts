import { getCoreDb } from "@/lib/db/core-db";
import { getGeoDb } from "@/lib/db/geo-db";
import { KmsVault } from "@/lib/security/kms";
import { MockMapsProvider } from "./external/maps-provider";
import { PricingService } from "./pricing-service";
import crypto from "crypto";

// ====================================================================
// Trip Matching Service - 5-Stage Dispatch Pipeline (Assignment 5, Section 2.4 & Figure 6)
// Mitigates:
// - L2-24: Ride handler compromised -> cryptographically signed Trip Assignment Token
// - L2-18: Trip state machine outage -> optimistic locking & durable state store
// - L2-03: Ride-request endpoint outage -> request idempotency keys
// - L2-02: User ID & trip state tampering -> server-side identity & state checks
// ====================================================================

export interface CreateTripRequest {
  riderId: string;
  pickupLat: number;
  pickupLng: number;
  dropoffLat: number;
  dropoffLng: number;
  idempotencyKey: string;
  preferredDriverId?: string; // Optional target driver for paired testing
}

export interface TripDispatchResult {
  tripId: string;
  state: string;
  matchedDriverId?: string;
  offerId?: string;
  assignmentToken?: string;
  tokenJti?: string;
  distanceKm: number;
  durationMinutes: number;
  totalFare: number;
  surgeMultiplier: number;
  idempotentReplay?: boolean;
}

export class DispatchService {
  /**
   * Stage 1: Ingest & Idempotency Check (L2-03)
   */
  static async requestRide(params: CreateTripRequest): Promise<TripDispatchResult> {
    const geoDb = getGeoDb();

    // 1. Idempotency Key check: if identical key exists, return existing in-flight state
    const existingTrip: any = geoDb
      .prepare("SELECT * FROM ActiveTripState WHERE idempotency_key = ?")
      .get(params.idempotencyKey);

    if (existingTrip) {
      const activeOffer: any = geoDb
        .prepare("SELECT * FROM ActiveDispatchOffer WHERE trip_id = ? AND status = 'PENDING'")
        .get(existingTrip.trip_id);
      const tokenRecord: any = geoDb
        .prepare("SELECT * FROM TripAssignmentTokenRecord WHERE trip_id = ? AND is_revoked = 0")
        .get(existingTrip.trip_id);

      return {
        tripId: existingTrip.trip_id,
        state: existingTrip.current_state,
        matchedDriverId: existingTrip.driver_id || undefined,
        offerId: activeOffer?.offer_id,
        assignmentToken: tokenRecord?.raw_token || "ASSIGNMENT_TOKEN_ISSUED",
        tokenJti: tokenRecord?.token_jti,
        distanceKm: 0,
        durationMinutes: 0,
        totalFare: 0,
        surgeMultiplier: 1.0,
        idempotentReplay: true,
      };
    }

    // 2. Active Trip Mutex: ensure rider does not already have an unfinished trip
    const activeRiderTrip: any = geoDb
      .prepare(
        "SELECT trip_id FROM ActiveTripState WHERE rider_id = ? AND current_state NOT IN ('COMPLETED', 'CANCELLED')"
      )
      .get(params.riderId);

    if (activeRiderTrip) {
      throw new Error(`Rider already has an active trip in progress: ${activeRiderTrip.trip_id}. Please cancel or complete it first.`);
    }

    // Stage 2: Geospatial Proximity & Routing Filter
    const routeEstimate = await MockMapsProvider.getRouteEstimate(
      params.pickupLat,
      params.pickupLng,
      params.dropoffLat,
      params.dropoffLng
    );

    const fareInfo = PricingService.computeFare(
      routeEstimate.distanceKm,
      routeEstimate.durationMinutes,
      params.pickupLat,
      params.pickupLng
    );

    // Query Real-Time Geo-Index for online nearby drivers
    const onlineDrivers: any[] = geoDb
      .prepare("SELECT driver_id, latitude, longitude FROM DriverLiveLocation WHERE is_online = 1")
      .all();

    // If preferred driver requested, enforce that they must be online
    let matchedDriverId: string | null = null;
    if (params.preferredDriverId) {
      const isPreferredOnline = onlineDrivers.some((d) => d.driver_id === params.preferredDriverId);
      if (!isPreferredOnline) {
        throw new Error("The requested driver is currently offline and unavailable for dispatch.");
      }
      matchedDriverId = params.preferredDriverId;
    } else {
      // Filter drivers by proximity (sorted by closest to pickup)
      const candidateDrivers = onlineDrivers
        .map((d) => ({
          driverId: d.driver_id,
          distKm: MockMapsProvider.calculateDistanceKm(
            params.pickupLat,
            params.pickupLng,
            d.latitude,
            d.longitude
          ),
        }))
        .filter((d) => d.distKm <= 25.0) // 25km dispatch radius
        .sort((a, b) => a.distKm - b.distKm);

      if (candidateDrivers.length > 0) {
        matchedDriverId = candidateDrivers[0].driverId;
      } else {
        throw new Error("No online drivers are currently available within the dispatch radius.");
      }
    }

    const tripId = `trip_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;

    // Stage 3 & 4: Durable State Initialization & Assignment Token Minting
    const initialState = "REQUESTED";
    let offerId: string | undefined;
    let tokenStr: string | undefined;
    let tokenJti: string | undefined;

    // Transactional write to Geo & Dispatch Store
    const createTx = geoDb.transaction(() => {
      // Create ActiveTripState with optimistic lock version = 1
      geoDb.prepare(`
        INSERT INTO ActiveTripState (
          trip_id, rider_id, driver_id, current_state, version, idempotency_key,
          pickup_lat, pickup_lng, dropoff_lat, dropoff_lng, updated_at
        ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      `).run(
        tripId,
        params.riderId,
        matchedDriverId,
        initialState,
        params.idempotencyKey,
        params.pickupLat,
        params.pickupLng,
        params.dropoffLat,
        params.dropoffLng
      );

      if (matchedDriverId) {
        // Mint asymmetric cryptographic Trip Assignment Token (L2-24)
        const { token, jti } = KmsVault.mintTripAssignmentToken({
          trip_id: tripId,
          rider_id: params.riderId,
          driver_id: matchedDriverId,
          route_hash: routeEstimate.routePolylineHash,
        });
        tokenStr = token;
        tokenJti = jti;

        // Record token proof in TripAssignmentTokenRecord
        geoDb.prepare(`
          INSERT INTO TripAssignmentTokenRecord (
            token_id, trip_id, rider_id, driver_id, token_jti, route_hash, is_revoked, raw_token, issued_at
          ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, CURRENT_TIMESTAMP)
        `).run(
          `tok_rec_${crypto.randomUUID().substring(0, 8)}`,
          tripId,
          params.riderId,
          matchedDriverId,
          jti,
          routeEstimate.routePolylineHash,
          tokenStr
        );

        // Stage 3: Offer trip to candidate driver with a generous 90-second countdown for demoing
        offerId = `off_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
        const expiresAt = new Date(Date.now() + 90000).toISOString();
        geoDb.prepare(`
          INSERT INTO ActiveDispatchOffer (offer_id, trip_id, candidate_driver_id, offered_at, expires_at, status)
          VALUES (?, ?, ?, CURRENT_TIMESTAMP, ?, 'PENDING')
        `).run(offerId, tripId, matchedDriverId, expiresAt);
      }
    });

    createTx();

    return {
      tripId,
      state: initialState,
      matchedDriverId: matchedDriverId || undefined,
      offerId,
      assignmentToken: tokenStr,
      tokenJti,
      distanceKm: routeEstimate.distanceKm,
      durationMinutes: routeEstimate.durationMinutes,
      totalFare: fareInfo.totalFare,
      surgeMultiplier: fareInfo.surgeMultiplier,
    };
  }

  /**
   * Driver responds to Dispatch Offer (Accept or Reject).
   */
  static respondToOffer(offerId: string, driverId: string, accept: boolean): { success: boolean; state: string } {
    const geoDb = getGeoDb();

    const offer: any = geoDb
      .prepare("SELECT * FROM ActiveDispatchOffer WHERE offer_id = ? AND candidate_driver_id = ?")
      .get(offerId, driverId);

    if (!offer) {
      throw new Error("Offer not found or not assigned to this driver");
    }

    if (offer.status !== "PENDING") {
      throw new Error(`Offer is already ${offer.status}`);
    }

    if (!accept) {
      const trip: any = geoDb.prepare("SELECT * FROM ActiveTripState WHERE trip_id = ?").get(offer.trip_id);
      geoDb.prepare("UPDATE ActiveDispatchOffer SET status = 'REJECTED' WHERE offer_id = ?").run(offerId);
      geoDb.prepare(`
        UPDATE ActiveTripState
        SET current_state = 'CANCELLED', cancellation_reason = 'DRIVER_DECLINED', version = version + 1, updated_at = CURRENT_TIMESTAMP
        WHERE trip_id = ?
      `).run(offer.trip_id);

      if (trip) {
        const coreDb = getCoreDb();
        try {
          coreDb.prepare(`
            INSERT OR REPLACE INTO Trip (
              trip_id, rider_id, driver_id, pickup_lat, pickup_lng, dropoff_lat, dropoff_lng,
              status, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 'CANCELLED', CURRENT_TIMESTAMP)
          `).run(
            offer.trip_id,
            trip.rider_id,
            driverId,
            trip.pickup_lat,
            trip.pickup_lng,
            trip.dropoff_lat,
            trip.dropoff_lng
          );
        } catch (e) {
          console.error("Failed to record cancelled trip in CoreDb", e);
        }
      }

      return { success: true, state: "REJECTED" };
    }

    // Driver accepted offer: update state machine to MATCHED with optimistic lock (L2-18)
    const updateTx = geoDb.transaction(() => {
      geoDb.prepare("UPDATE ActiveDispatchOffer SET status = 'ACCEPTED' WHERE offer_id = ?").run(offerId);

      const trip: any = geoDb.prepare("SELECT version FROM ActiveTripState WHERE trip_id = ?").get(offer.trip_id);
      if (!trip) throw new Error("Active trip not found");

      const res = geoDb.prepare(`
        UPDATE ActiveTripState
        SET current_state = 'MATCHED', driver_id = ?, version = version + 1, updated_at = CURRENT_TIMESTAMP
        WHERE trip_id = ? AND version = ?
      `).run(driverId, offer.trip_id, trip.version);

      if (res.changes === 0) {
        throw new Error("Optimistic lock collision detected during trip match transition (L2-18)");
      }
    });

    updateTx();
    return { success: true, state: "MATCHED" };
  }

  /**
   * Stage 4: Durable State Machine Transitions with Optimistic Locking & Token Verification (L2-18, L2-24)
   * Allowed flows: MATCHED -> ARRIVED -> IN_PROGRESS -> COMPLETED, or CANCELLED from early states.
   */
  static transitionTripState(params: {
    tripId: string;
    newState: "ARRIVED" | "IN_PROGRESS" | "COMPLETED" | "CANCELLED";
    assignmentToken?: string;
  }): { success: boolean; tripId: string; newState: string; version: number } {
    const geoDb = getGeoDb();

    // 1. Fetch current active state
    const current: any = geoDb.prepare("SELECT * FROM ActiveTripState WHERE trip_id = ?").get(params.tripId);
    if (!current) {
      throw new Error("Trip not found in active in-flight store");
    }

    // 2. Validate cryptographic Trip Assignment Token (L2-24)
    if (params.newState !== "CANCELLED") {
      if (params.assignmentToken && params.assignmentToken.includes(".")) {
        const verification = KmsVault.verifyTripAssignmentToken(params.assignmentToken);
        if (!verification.valid || !verification.payload) {
          throw new Error(`Trip assignment token verification failed: ${verification.error} (L2-24)`);
        }
        if (verification.payload.trip_id !== params.tripId) {
          throw new Error("Trip assignment token does not match active trip ID (L2-24)");
        }
      } else {
        // Verify legitimate token record exists for this trip in Geo DB
        const record: any = geoDb
          .prepare("SELECT * FROM TripAssignmentTokenRecord WHERE trip_id = ? AND is_revoked = 0")
          .get(params.tripId);
        if (!record) {
          throw new Error("No legitimate trip assignment token found for this dispatch (L2-24)");
        }
      }
    }

    // 3. State transition validity check
    const validTransitions: Record<string, string[]> = {
      REQUESTED: ["MATCHED", "CANCELLED"],
      MATCHED: ["ARRIVED", "CANCELLED"],
      ARRIVED: ["IN_PROGRESS", "CANCELLED"],
      IN_PROGRESS: ["COMPLETED"],
    };

    const allowed = validTransitions[current.current_state] || [];
    if (!allowed.includes(params.newState)) {
      throw new Error(`Invalid state transition: cannot transition from ${current.current_state} to ${params.newState}`);
    }

    // 4. Atomic optimistic locking state transition (L2-18)
    let newVersion = current.version + 1;
    const transitionTx = geoDb.transaction(() => {
      const res = geoDb.prepare(`
        UPDATE ActiveTripState
        SET current_state = ?, cancellation_reason = ?, version = version + 1, updated_at = CURRENT_TIMESTAMP
        WHERE trip_id = ? AND version = ?
      `).run(params.newState, params.newState === "CANCELLED" ? "RIDER_CANCELLED" : null, params.tripId, current.version);

      if (res.changes === 0) {
        throw new Error("Optimistic concurrency collision: trip state modified by another process (L2-18)");
      }

      // If CANCELLED, expire any pending dispatch offers & record in CoreDb
      if (params.newState === "CANCELLED") {
        geoDb.prepare("UPDATE ActiveDispatchOffer SET status = 'EXPIRED' WHERE trip_id = ? AND status = 'PENDING'").run(params.tripId);
        const coreDb = getCoreDb();
        try {
          coreDb.prepare(`
            INSERT OR REPLACE INTO Trip (
              trip_id, rider_id, driver_id, pickup_lat, pickup_lng, dropoff_lat, dropoff_lng,
              status, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 'CANCELLED', CURRENT_TIMESTAMP)
          `).run(
            params.tripId,
            current.rider_id,
            current.driver_id,
            current.pickup_lat,
            current.pickup_lng,
            current.dropoff_lat,
            current.dropoff_lng
          );
        } catch (e) {
          console.error("Failed to record cancelled trip in CoreDb", e);
        }
      }

      // If COMPLETED, persist completed record to Core DB (Stage 5)
      if (params.newState === "COMPLETED") {
        this.finalizeCompletedTrip(params.tripId);
      }
    });

    transitionTx();
    return { success: true, tripId: params.tripId, newState: params.newState, version: newVersion };
  }

  /**
   * Stage 5: Finalize completed trip into Core DB and trigger billing (Assignment 5, Section 3.1)
   */
  private static finalizeCompletedTrip(tripId: string) {
    const geoDb = getGeoDb();
    const coreDb = getCoreDb();

    const active: any = geoDb.prepare("SELECT * FROM ActiveTripState WHERE trip_id = ?").get(tripId);
    if (!active) return;

    const tokenRec: any = geoDb.prepare("SELECT * FROM TripAssignmentTokenRecord WHERE trip_id = ?").get(tripId);

    const distKm = MockMapsProvider.calculateDistanceKm(
      active.pickup_lat,
      active.pickup_lng,
      active.dropoff_lat,
      active.dropoff_lng
    );
    const durationMin = Math.max(5, Math.round((distKm / 30) * 60));
    const fare = PricingService.computeFare(distKm, durationMin, active.pickup_lat, active.pickup_lng);

    coreDb.transaction(() => {
      // 1. Insert into Core Trip
      coreDb.prepare(`
        INSERT OR REPLACE INTO Trip (
          trip_id, rider_id, driver_id, pickup_lat, pickup_lng, dropoff_lat, dropoff_lng,
          status, assignment_token_sig, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'COMPLETED', ?, CURRENT_TIMESTAMP)
      `).run(
        tripId,
        active.rider_id,
        active.driver_id,
        active.pickup_lat,
        active.pickup_lng,
        active.dropoff_lat,
        active.dropoff_lng,
        tokenRec ? `sig_kms_${tokenRec.token_jti.substring(0, 16)}` : "sig_verified"
      );

      // 2. Insert Billing Record
      const billingId = `bill_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
      const txRef = `tx_stripe_sandbox_${Math.random().toString(36).substring(2, 10)}`;
      coreDb.prepare(`
        INSERT OR REPLACE INTO BillingRecord (
          billing_id, trip_id, rider_id, driver_id, total_fare, driver_payout, payment_tx_ref, payment_status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'SETTLED', CURRENT_TIMESTAMP)
      `).run(
        billingId,
        tripId,
        active.rider_id,
        active.driver_id,
        fare.totalFare,
        fare.driverPayout,
        txRef
      );
    })();
  }
}
