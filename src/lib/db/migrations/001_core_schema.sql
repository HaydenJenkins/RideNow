-- ====================================================================
-- RideNow - Trip History & Core Operations Database Schema
-- Architecture Blueprint Assignment 5 (Section 3.1)
-- Holds Rider, Driver, Vehicle, Trip, Billing, and Support records.
-- ====================================================================

PRAGMA foreign_keys = ON;

-- 1. Rider Entity
CREATE TABLE IF NOT EXISTS Rider (
    rider_id TEXT PRIMARY KEY,
    full_name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    contact_phone TEXT NOT NULL,
    customer_payment_token TEXT, -- PCI isolation: tokenized reference only
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 2. OpsStaff Entity (Internal Admin/Operations Specialists)
CREATE TABLE IF NOT EXISTS OpsStaff (
    staff_id TEXT PRIMARY KEY,
    full_name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    role TEXT NOT NULL CHECK(role IN ('SAFETY_INVESTIGATOR', 'SUPPORT_AGENT', 'OPS_ADMIN')),
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 3. Driver Entity
CREATE TABLE IF NOT EXISTS Driver (
    driver_id TEXT PRIMARY KEY,
    full_name TEXT NOT NULL,
    contact_phone TEXT NOT NULL,
    license_number TEXT NOT NULL,
    onboarding_status TEXT NOT NULL CHECK(onboarding_status IN ('PENDING', 'BACKGROUND_CHECK_SUBMITTED', 'APPROVED', 'REJECTED', 'SUSPENDED')),
    background_check_id TEXT, -- Logical / FK link to DriverBackgroundCheck
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 4. DriverBackgroundCheck Entity (PII Protected with KMS Envelope Encryption)
CREATE TABLE IF NOT EXISTS DriverBackgroundCheck (
    check_id TEXT PRIMARY KEY,
    driver_id TEXT NOT NULL REFERENCES Driver(driver_id) ON DELETE RESTRICT,
    vendor_reference TEXT NOT NULL,
    encrypted_ssn TEXT NOT NULL, -- Field-level KMS envelope encrypted
    status TEXT NOT NULL CHECK(status IN ('PENDING', 'IN_REVIEW', 'CLEARED', 'FAILED')),
    cleared_at DATETIME,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 5. Vehicle Entity
CREATE TABLE IF NOT EXISTS Vehicle (
    vehicle_id TEXT PRIMARY KEY,
    driver_id TEXT NOT NULL REFERENCES Driver(driver_id) ON DELETE RESTRICT,
    make TEXT NOT NULL,
    model TEXT NOT NULL,
    license_plate TEXT NOT NULL UNIQUE,
    inspection_status TEXT NOT NULL CHECK(inspection_status IN ('PASSED', 'PENDING', 'FAILED')),
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 6. Trip Entity
CREATE TABLE IF NOT EXISTS Trip (
    trip_id TEXT PRIMARY KEY,
    rider_id TEXT NOT NULL REFERENCES Rider(rider_id) ON DELETE RESTRICT,
    driver_id TEXT REFERENCES Driver(driver_id) ON DELETE RESTRICT,
    pickup_lat REAL NOT NULL,
    pickup_lng REAL NOT NULL,
    dropoff_lat REAL NOT NULL,
    dropoff_lng REAL NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('REQUESTED', 'MATCHED', 'ARRIVED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED')),
    assignment_token_sig TEXT, -- Cryptographically signed Trip Assignment Token (HMAC/Sig)
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 7. BillingRecord Entity
CREATE TABLE IF NOT EXISTS BillingRecord (
    billing_id TEXT PRIMARY KEY,
    trip_id TEXT NOT NULL UNIQUE REFERENCES Trip(trip_id) ON DELETE RESTRICT,
    rider_id TEXT NOT NULL REFERENCES Rider(rider_id) ON DELETE RESTRICT,
    driver_id TEXT REFERENCES Driver(driver_id) ON DELETE RESTRICT,
    total_fare REAL NOT NULL,
    driver_payout REAL NOT NULL,
    payment_tx_ref TEXT, -- External payment processor transaction identifier
    payment_status TEXT NOT NULL CHECK(payment_status IN ('PENDING', 'SETTLED', 'FAILED', 'REFUNDED')),
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 8. SupportIncident Entity
CREATE TABLE IF NOT EXISTS SupportIncident (
    incident_id TEXT PRIMARY KEY,
    trip_id TEXT NOT NULL REFERENCES Trip(trip_id) ON DELETE RESTRICT,
    reporter_id TEXT NOT NULL, -- Rider or Driver ID
    assigned_staff_id TEXT REFERENCES OpsStaff(staff_id) ON DELETE SET NULL,
    category TEXT NOT NULL CHECK(category IN ('SAFETY_VIOLATION', 'FARE_DISPUTE', 'ROUTE_ANOMALY', 'PROPERTY_DAMAGE', 'HARASSMENT', 'OTHER')),
    status TEXT NOT NULL CHECK(status IN ('OPEN', 'INVESTIGATING', 'RESOLVED', 'DISMISSED')),
    details TEXT,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    resolved_at DATETIME
);

-- Helpful query indexes
CREATE INDEX IF NOT EXISTS idx_trip_rider ON Trip(rider_id);
CREATE INDEX IF NOT EXISTS idx_trip_driver ON Trip(driver_id);
CREATE INDEX IF NOT EXISTS idx_trip_status ON Trip(status);
CREATE INDEX IF NOT EXISTS idx_billing_trip ON BillingRecord(trip_id);
CREATE INDEX IF NOT EXISTS idx_incident_trip ON SupportIncident(trip_id);
CREATE INDEX IF NOT EXISTS idx_incident_status ON SupportIncident(status);
