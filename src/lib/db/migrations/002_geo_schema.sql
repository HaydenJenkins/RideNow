-- ====================================================================
-- RideNow - Real-Time Geo-Index & In-Flight Dispatch Store Schema
-- Architecture Blueprint Assignment 5 (Section 3.2)
-- Owned exclusively by Location Tracking and Trip Matching services.
-- Uses isolated logical references only (NO cross-database foreign keys).
-- ====================================================================

-- 1. DriverLiveLocation (High-frequency telemetry cache)
CREATE TABLE IF NOT EXISTS DriverLiveLocation (
    driver_id TEXT PRIMARY KEY, -- Logical reference to Driver
    latitude REAL NOT NULL,
    longitude REAL NOT NULL,
    speed_mps REAL NOT NULL DEFAULT 0.0,
    sequence_num INTEGER NOT NULL DEFAULT 0, -- Monotonic sequence counter to reject replay/tampering (L2-10)
    spatial_geohash TEXT NOT NULL,
    is_online INTEGER NOT NULL DEFAULT 1, -- 1=online, 0=offline
    last_ping DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 2. ActiveDispatchOffer (In-flight candidate driver dispatch offers)
CREATE TABLE IF NOT EXISTS ActiveDispatchOffer (
    offer_id TEXT PRIMARY KEY,
    trip_id TEXT NOT NULL, -- Logical reference to Trip
    candidate_driver_id TEXT NOT NULL, -- Logical reference to Driver
    offered_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at DATETIME NOT NULL, -- Countdown threshold for driver acceptance
    status TEXT NOT NULL CHECK(status IN ('PENDING', 'ACCEPTED', 'REJECTED', 'EXPIRED'))
);

-- 3. TripAssignmentTokenRecord (Cryptographically minted proof of legitimate dispatch - L2-24)
CREATE TABLE IF NOT EXISTS TripAssignmentTokenRecord (
    token_id TEXT PRIMARY KEY,
    trip_id TEXT NOT NULL, -- Logical reference to Trip
    rider_id TEXT NOT NULL, -- Logical reference to Rider
    driver_id TEXT NOT NULL, -- Logical reference to Driver
    token_jti TEXT NOT NULL UNIQUE, -- Cryptographic nonce/JWT ID
    route_hash TEXT NOT NULL,
    is_revoked INTEGER NOT NULL DEFAULT 0, -- 0=valid, 1=revoked
    raw_token TEXT,
    issued_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 4. ActiveTripState (Durable state machine with optimistic locking & idempotency - L2-18, L2-02)
CREATE TABLE IF NOT EXISTS ActiveTripState (
    trip_id TEXT PRIMARY KEY, -- Logical reference to Trip
    rider_id TEXT NOT NULL, -- Logical reference to Rider
    driver_id TEXT, -- Logical reference to matched Driver
    current_state TEXT NOT NULL CHECK(current_state IN ('REQUESTED', 'MATCHED', 'ARRIVED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED')),
    version INTEGER NOT NULL DEFAULT 1, -- Optimistic concurrency control lock
    idempotency_key TEXT NOT NULL UNIQUE, -- Client idempotency key to prevent double-dispatch (L2-03)
    pickup_lat REAL NOT NULL,
    pickup_lng REAL NOT NULL,
    dropoff_lat REAL NOT NULL,
    dropoff_lng REAL NOT NULL,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    cancellation_reason TEXT
);

-- 5. SurgeGeofence (Dynamic pricing multiplier cache per zone)
CREATE TABLE IF NOT EXISTS SurgeGeofence (
    geofence_id TEXT PRIMARY KEY,
    zone_name TEXT NOT NULL,
    center_lat REAL NOT NULL,
    center_lng REAL NOT NULL,
    radius_meters REAL NOT NULL DEFAULT 3000.0,
    surge_multiplier REAL NOT NULL DEFAULT 1.0,
    active_drivers_count INTEGER NOT NULL DEFAULT 0,
    open_requests_count INTEGER NOT NULL DEFAULT 0,
    calculated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 6. TelemetryAuditLog (GPS anomaly & Kalman velocity sanity checks - L2-10)
CREATE TABLE IF NOT EXISTS TelemetryAuditLog (
    telemetry_id TEXT PRIMARY KEY,
    driver_id TEXT NOT NULL,
    recorded_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    velocity_kmh REAL NOT NULL,
    anomaly_flag INTEGER NOT NULL DEFAULT 0, -- 1=spoofing/teleportation anomaly flagged
    anomaly_reason TEXT
);

-- High-performance query indexes
CREATE INDEX IF NOT EXISTS idx_driver_geohash ON DriverLiveLocation(spatial_geohash, is_online);
CREATE INDEX IF NOT EXISTS idx_offer_trip ON ActiveDispatchOffer(trip_id);
CREATE INDEX IF NOT EXISTS idx_offer_driver ON ActiveDispatchOffer(candidate_driver_id, status);
CREATE INDEX IF NOT EXISTS idx_active_trip_state ON ActiveTripState(current_state);
CREATE INDEX IF NOT EXISTS idx_telemetry_driver ON TelemetryAuditLog(driver_id, recorded_at);
