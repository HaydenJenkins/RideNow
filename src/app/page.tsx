"use client";

import React, { useState, useEffect, useCallback, useRef } from "react";
import styles from "./page.module.css";

interface ActorContext {
  riders: Array<{ rider_id: string; full_name: string; email: string; customer_payment_token: string }>;
  drivers: Array<{ driver_id: string; full_name: string; onboarding_status: string; make: string; model: string; license_plate: string; is_online?: boolean }>;
  opsStaff: Array<{ staff_id: string; full_name: string; email: string; role: string }>;
  geofences: Array<{ geofence_id: string; zone_name: string; surge_multiplier: number }>;
}

interface TransitModalState {
  isOpen: boolean;
  stage: "TO_PICKUP" | "TO_DROPOFF";
  targetLat: number;
  targetLng: number;
  targetLabel: string;
  currentLat: number;
  currentLng: number;
  progress: number; // 0 to 100
  speedKmh: number;
  isComplete: boolean;
}

const KNOWN_LOCATIONS = [
  { lat: 33.7756, lng: -84.3880, label: "Tech Square, Midtown" },
  { lat: 33.7550, lng: -84.3900, label: "Mercedes-Benz Stadium, Downtown" },
  { lat: 33.6407, lng: -84.4277, label: "Hartsfield-Jackson Airport" },
  { lat: 33.7600, lng: -84.3930, label: "Centennial Olympic Park" },
  { lat: 33.8400, lng: -84.3750, label: "Buckhead Financial Core" },
];

const getLocationLabel = (lat: number, lng: number) => {
  if (lat == null || lng == null) return "Unknown Location";
  const match = KNOWN_LOCATIONS.find(
    (loc) => Math.abs(loc.lat - lat) < 0.008 && Math.abs(loc.lng - lng) < 0.008
  );
  return match ? match.label : `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
};

const formatStaffRole = (role: string) => {
  if (!role) return "Operations Specialist";
  if (role === "SAFETY_INVESTIGATOR") return "Safety & Compliance Specialist";
  if (role === "OPS_ADMIN") return "Operations Administrator";
  return role.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
};

const formatBookingRef = (tripId: string) => {
  if (!tripId) return "";
  const parts = tripId.split("_");
  const suffix = parts.length > 2 ? parts[2].toUpperCase() : parts.pop()?.toUpperCase() || tripId.slice(-4).toUpperCase();
  return `#RN-${suffix}`;
};

export default function RideNowCockpit() {
  const [activeTab, setActiveTab] = useState<"RIDER" | "DRIVER" | "OPS">("RIDER");
  const [actors, setActors] = useState<ActorContext | null>(null);

  // Selected identities for testing
  const [selectedRiderId, setSelectedRiderId] = useState<string>("rider_01");
  const [selectedDriverId, setSelectedDriverId] = useState<string>("driver_01");
  const [selectedStaffId, setSelectedStaffId] = useState<string>("staff_01");

  // --- CENTRALIZED CRYPTOGRAPHIC SESSION AUTH (OWASP A01 / A07) ---
  // Tracks active session tokens per account ID: Record<actorId, token>
  // Accounts only need to log in once per session; switching back and forth is seamless
  const [authenticatedSessions, setAuthenticatedSessions] = useState<Record<string, string>>({});
  const authenticatedSessionsRef = useRef<Record<string, string>>({});

  // Login card form state
  const [loginPassword, setLoginPassword] = useState<string>("");
  const [loginError, setLoginError] = useState<string | null>(null);
  const [isLoggingIn, setIsLoggingIn] = useState<boolean>(false);
  const [showPassword, setShowPassword] = useState<boolean>(false);

  const getAuthHeader = (
    role: "RIDER" | "DRIVER" | "OPS_STAFF",
    customActorId?: string
  ): Record<string, string> => {
    const actorId =
      customActorId ||
      (role === "RIDER" ? selectedRiderId : role === "DRIVER" ? selectedDriverId : selectedStaffId);
    const token = authenticatedSessionsRef.current[actorId] || authenticatedSessions[actorId];
    const headers: Record<string, string> = {};
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }
    return headers;
  };

  const handleLogin = useCallback(
    async (actorId: string, role: "RIDER" | "DRIVER" | "OPS_STAFF", password?: string): Promise<boolean> => {
      const pass = password ?? loginPassword;
      if (!pass || !pass.trim()) {
        setLoginError("Password is required to authenticate.");
        return false;
      }
      setIsLoggingIn(true);
      setLoginError(null);
      try {
        const res = await fetch("/api/auth/session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ actorId, role, password: pass.trim() }),
        });
        const data = await res.json();
        if (!res.ok || !data.success) {
          setLoginError(data.error || "Authentication failed: invalid credentials.");
          setIsLoggingIn(false);
          return false;
        }

        authenticatedSessionsRef.current[actorId] = data.token;
        setAuthenticatedSessions((prev) => ({ ...prev, [actorId]: data.token }));
        setLoginPassword("");
        setLoginError(null);
        showBanner(`🔐 Successfully authenticated as ${data.actor?.name || actorId}!`, "success");
        setIsLoggingIn(false);
        return true;
      } catch (err: any) {
        setLoginError(err.message || "Network error during authentication.");
        setIsLoggingIn(false);
        return false;
      }
    },
    [loginPassword]
  );

  const handleLogout = useCallback(
    async (actorId: string) => {
      try {
        const role =
          activeTab === "RIDER" ? "RIDER" : activeTab === "DRIVER" ? "DRIVER" : "OPS_STAFF";
        const authH = getAuthHeader(role, actorId);
        await fetch("/api/auth/session", {
          method: "DELETE",
          headers: {
            ...authH,
            "Content-Type": "application/json",
          },
        });
      } catch (err) {
        console.error("Logout request error", err);
      }

      delete authenticatedSessionsRef.current[actorId];
      setAuthenticatedSessions((prev) => {
        const next = { ...prev };
        delete next[actorId];
        return next;
      });
      setLoginPassword("");
      setLoginError(null);
      showBanner(`🚪 Logged out of account ${actorId}.`, "success");
    },
    [activeTab, selectedRiderId, selectedDriverId, selectedStaffId]
  );

  // Dispatch preference (Nearest Proximity vs Target Driver for testing)
  const [targetDriverId, setTargetDriverId] = useState<string>("NEAREST");

  // Circuit Breaker state
  const [circuitStatus, setCircuitStatus] = useState<string>("CLOSED");
  const [isSimulatedOutage, setIsSimulatedOutage] = useState<boolean>(false);

  // Global notification banner
  const [banner, setBanner] = useState<{ message: string; type: "success" | "danger" } | null>(null);

  // --- RIDER STATE ---
  const [pickup, setPickup] = useState({ lat: 33.7756, lng: -84.3880, label: "Tech Square, Midtown" });
  const [dropoff, setDropoff] = useState({ lat: 33.7550, lng: -84.3900, label: "Mercedes-Benz Stadium, Downtown" });
  const [estimate, setEstimate] = useState<any>(null);
  const [activeTrip, setActiveTrip] = useState<any>(null);
  const [riderHistory, setRiderHistory] = useState<any[]>([]);
  // Ref to track if we already alerted the rider about this cancelled trip
  const notifiedCancelledRef = useRef<string | null>(null);

  useEffect(() => {
    if (activeTrip && activeTrip.current_state === "CANCELLED") {
      if (notifiedCancelledRef.current !== activeTrip.trip_id) {
        notifiedCancelledRef.current = activeTrip.trip_id;
        if (activeTrip.cancellation_reason === "DRIVER_DECLINED") {
          showBanner("❌ Ride Declined: The driver was unable to accept your ride request.", "danger");
        } else {
          showBanner("Trip cancelled.", "danger");
        }
      }
    } else if (!activeTrip) {
      notifiedCancelledRef.current = null;
    }
  }, [activeTrip]);

  const [requestingRide, setRequestingRide] = useState(false);

  // --- DRIVER STATE ---
  const [driverOnlineMap, setDriverOnlineMap] = useState<Record<string, boolean>>({});
  const isCurrentDriverOnline = driverOnlineMap[selectedDriverId] ??
    actors?.drivers.find((d) => d.driver_id === selectedDriverId)?.is_online ?? true;
  const [driverGps, setDriverGps] = useState({ lat: 33.7745, lng: -84.3880, speed: 28, seq: 110 });
  const [pendingOffer, setPendingOffer] = useState<any>(null);
  const [otherPendingOffers, setOtherPendingOffers] = useState<any[]>([]);
  const [driverActiveTrip, setDriverActiveTrip] = useState<any>(null);
  const [assignmentTokenRecord, setAssignmentTokenRecord] = useState<any>(null);
  const [rawAssignmentToken, setRawAssignmentToken] = useState<string | null>(null);

  // --- TRANSIT SIMULATION MODAL STATE ---
  const [transitModal, setTransitModal] = useState<TransitModalState | null>(null);
  const transitIntervalRef = useRef<NodeJS.Timeout | null>(null);

  // --- OPS STATE ---
  const [anomalies, setAnomalies] = useState<any[]>([]);
  const [onboardingDrivers, setOnboardingDrivers] = useState<any[]>([]);
  const [incidents, setIncidents] = useState<any[]>([]);
  const [opsSubTab, setOpsSubTab] = useState<"ANOMALIES" | "ONBOARDING" | "INCIDENTS">("ANOMALIES");

  const showBanner = (message: string, type: "success" | "danger" = "success") => {
    setBanner({ message, type });
    setTimeout(() => setBanner(null), 7000);
  };

  // 1. Initial Load: Actors & System Info
  const loadActorsAndSystem = useCallback(async () => {
    try {
      const [actorsRes, circuitRes, shiftRes] = await Promise.all([
        fetch("/api/actors"),
        fetch("/api/system/circuit-breaker"),
        fetch("/api/driver/shift"),
      ]);
      const actorsData = await actorsRes.json();
      const circuitData = await circuitRes.json();
      const shiftData = await shiftRes.json();

      setActors(actorsData);
      setCircuitStatus(circuitData.circuitState);
      setIsSimulatedOutage(circuitData.simulatedOutage);

      // Explicit authentication enforced (no auto-login)

      if (shiftData.statuses) {
        setDriverOnlineMap(shiftData.statuses);
      } else if (actorsData?.drivers) {
        const initialMap: Record<string, boolean> = {};
        for (const d of actorsData.drivers) {
          initialMap[d.driver_id] = d.is_online ?? true;
        }
        setDriverOnlineMap(initialMap);
      }
    } catch (e) {
      console.error("Failed to load initial data", e);
    }
  }, []);

  useEffect(() => {
    loadActorsAndSystem();
  }, [loadActorsAndSystem]);

  // 2. Fetch Fare Estimate on coordinates change
  const fetchEstimate = useCallback(async () => {
    try {
      const res = await fetch("/api/pricing/estimate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pickupLat: pickup.lat,
          pickupLng: pickup.lng,
          dropoffLat: dropoff.lat,
          dropoffLng: dropoff.lng,
        }),
      });
      const data = await res.json();
      if (data.success) {
        setEstimate(data);
      }
    } catch (e) {
      console.error(e);
    }
  }, [pickup, dropoff]);

  useEffect(() => {
    fetchEstimate();
  }, [fetchEstimate]);

  // 3. Periodic Poll for Trips & Offers
  const syncState = useCallback(async () => {
    try {
      // Sync Rider Trip only if rider account is authenticated
      if (authenticatedSessionsRef.current[selectedRiderId]) {
        const riderRes = await fetch("/api/trips", {
          headers: {
            ...getAuthHeader("RIDER"),
            "x-actor-role": "RIDER",
            "x-actor-id": selectedRiderId,
          },
        });
        if (riderRes.ok) {
          const riderData = await riderRes.json();
          setActiveTrip(riderData.activeTrip || null);
          setRiderHistory(riderData.history || []);
        }
      } else {
        setActiveTrip(null);
        setRiderHistory([]);
      }

      // Sync Driver Offers & Active Trip only if driver account is authenticated
      if (authenticatedSessionsRef.current[selectedDriverId]) {
        const driverRes = await fetch("/api/trips", {
          headers: {
            ...getAuthHeader("DRIVER"),
            "x-actor-role": "DRIVER",
            "x-actor-id": selectedDriverId,
          },
        });
        if (driverRes.ok) {
          const driverData = await driverRes.json();
          setDriverActiveTrip(driverData.activeTrip || null);

          if (driverData.activeTrip) {
            // Fetch Assignment Token proof (L2-24)
            const tokRes = await fetch(`/api/trips/${driverData.activeTrip.trip_id}/token`);
            if (tokRes.ok) {
              const tokData = await tokRes.json();
              setAssignmentTokenRecord(tokData.tokenRecord);
              if (tokData.token) {
                setRawAssignmentToken(tokData.token);
              }
            }
          } else {
            setAssignmentTokenRecord(null);
            setRawAssignmentToken(null);
          }
        }

        // Check for offers
        const offerRes = await fetch("/api/driver/offers", {
          headers: {
            ...getAuthHeader("DRIVER"),
            "x-actor-role": "DRIVER",
            "x-actor-id": selectedDriverId,
          },
        });
        if (offerRes.ok) {
          const offerData = await offerRes.json();
          setPendingOffer(offerData.offers?.[0] || null);

          // Filter other pending offers not assigned to current driver
          const others = (offerData.allPending || []).filter(
            (o: any) => o.candidate_driver_id !== selectedDriverId
          );
          setOtherPendingOffers(others);
        }
      } else {
        setDriverActiveTrip(null);
        setPendingOffer(null);
        setOtherPendingOffers([]);
        setAssignmentTokenRecord(null);
        setRawAssignmentToken(null);
      }

      // Sync driver shift statuses in real time (public fleet state)
      const shiftRes = await fetch("/api/driver/shift");
      if (shiftRes.ok) {
        const shiftData = await shiftRes.json();
        if (shiftData.statuses) {
          setDriverOnlineMap(shiftData.statuses);
        }
      }
    } catch (e) {
      console.error(e);
    }
  }, [selectedRiderId, selectedDriverId]);

  useEffect(() => {
    syncState();
    const interval = setInterval(syncState, 2000);
    return () => clearInterval(interval);
  }, [syncState]);

  // 4. Poll Ops Data if Ops tab active and staff account is authenticated
  const syncOpsData = useCallback(async () => {
    if (activeTab !== "OPS" || !authenticatedSessionsRef.current[selectedStaffId]) {
      if (activeTab !== "OPS") {
        setAnomalies([]);
        setOnboardingDrivers([]);
        setIncidents([]);
      }
      return;
    }
    try {
      const [anomRes, queueRes, incRes] = await Promise.all([
        fetch("/api/ops/telemetry-anomalies", {
          headers: { ...getAuthHeader("OPS_STAFF"), "x-actor-role": "OPS_STAFF", "x-actor-id": selectedStaffId },
        }),
        fetch("/api/ops/drivers", {
          headers: { ...getAuthHeader("OPS_STAFF"), "x-actor-role": "OPS_STAFF", "x-actor-id": selectedStaffId },
        }),
        fetch("/api/ops/incidents", {
          headers: { ...getAuthHeader("OPS_STAFF"), "x-actor-role": "OPS_STAFF", "x-actor-id": selectedStaffId },
        }),
      ]);

      if (anomRes.ok) {
        const d = await anomRes.json();
        setAnomalies(d.anomalies || []);
      }
      if (queueRes.ok) {
        const d = await queueRes.json();
        setOnboardingDrivers(d.drivers || []);
      }
      if (incRes.ok) {
        const d = await incRes.json();
        setIncidents(d.incidents || []);
      }
    } catch (e) {
      console.error(e);
    }
  }, [activeTab, selectedStaffId]);

  useEffect(() => {
    syncOpsData();
  }, [syncOpsData]);

  // --- ACTIONS ---

  // Request a Ride (Rider)
  const handleRequestRide = async () => {
    if (targetDriverId !== "NEAREST") {
      const isOnline = driverOnlineMap[targetDriverId] ??
        actors?.drivers.find((d) => d.driver_id === targetDriverId)?.is_online ?? true;
      if (!isOnline) {
        const targetDriver = actors?.drivers.find((d) => d.driver_id === targetDriverId);
        showBanner(`Cannot request ride: ${targetDriver?.full_name || "Selected driver"} is currently offline. Please choose an online driver or select Nearest Online Driver.`, "danger");
        return;
      }
    } else {
      const anyOnline = actors?.drivers.some((d) => driverOnlineMap[d.driver_id] ?? d.is_online ?? true);
      if (!anyOnline) {
        showBanner("Cannot request ride: No drivers are currently online. Please toggle a driver online in the Driver App.", "danger");
        return;
      }
    }

    setRequestingRide(true);
    try {
      const idempotencyKey = `idemp_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
      const res = await fetch("/api/trips/request", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...getAuthHeader("RIDER"),
          "x-actor-role": "RIDER",
          "x-actor-id": selectedRiderId,
        },
        body: JSON.stringify({
          pickupLat: pickup.lat,
          pickupLng: pickup.lng,
          dropoffLat: dropoff.lat,
          dropoffLng: dropoff.lng,
          idempotencyKey,
          preferredDriverId: targetDriverId !== "NEAREST" ? targetDriverId : undefined,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        showBanner(`Ride Request Failed: ${data.error}`, "danger");
      } else {
        const matchedName =
          actors?.drivers.find((d) => d.driver_id === data.matchedDriverId)?.full_name ||
          data.matchedDriverId ||
          "nearby driver";
        showBanner(
          `✅ Trip Requested! Matched to ${matchedName}. Offer dispatched and awaiting driver confirmation.`,
          "success"
        );
        syncState();
      }
    } catch (e: any) {
      showBanner(`Error: ${e.message}`, "danger");
    } finally {
      setRequestingRide(false);
    }
  };

  // Cancel Active Trip (Rider)
  const handleCancelTrip = async () => {
    if (!activeTrip) return;
    try {
      const res = await fetch(`/api/trips/${activeTrip.trip_id}/status`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...getAuthHeader("RIDER"),
          "x-actor-role": "RIDER",
          "x-actor-id": selectedRiderId,
        },
        body: JSON.stringify({ newState: "CANCELLED" }),
      });
      if (res.ok) {
        showBanner("Trip cancelled successfully. You can now request a new trip.", "success");
        syncState();
      } else {
        const d = await res.json();
        showBanner(`Failed to cancel: ${d.error}`, "danger");
      }
    } catch (e: any) {
      showBanner(e.message, "danger");
    }
  };

  // Dismiss Cancelled / Declined Trip (Rider)
  const handleDismissCancelledTrip = async () => {
    if (!activeTrip) return;
    const tripIdToDismiss = activeTrip.trip_id;
    setActiveTrip(null);
    try {
      await fetch(`/api/trips?tripId=${tripIdToDismiss}`, {
        method: "DELETE",
        headers: {
          ...getAuthHeader("RIDER"),
          "x-actor-role": "RIDER",
          "x-actor-id": selectedRiderId,
        },
      });
      showBanner("Ride request dismissed. You can now request a new ride.", "success");
      syncState();
    } catch (e: any) {
      console.error("Failed to dismiss trip", e);
    }
  };

  // Respond to Offer (Driver)
  const handleOfferResponse = async (offerId: string, accept: boolean) => {
    try {
      const res = await fetch("/api/driver/offers", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...getAuthHeader("DRIVER"),
          "x-actor-role": "DRIVER",
          "x-actor-id": selectedDriverId,
        },
        body: JSON.stringify({ offerId, accept }),
      });
      const data = await res.json();
      if (res.ok) {
        setPendingOffer(null);
        showBanner(
          accept
            ? "✓ Dispatch Offer Accepted! Heading to pickup."
            : "Offer Rejected.",
          accept ? "success" : "danger"
        );
        syncState();
      } else {
        showBanner(data.error, "danger");
      }
    } catch (e: any) {
      showBanner(e.message, "danger");
    }
  };

  // Transition Active Trip State (Driver)
  const handleTransition = async (newState: "ARRIVED" | "IN_PROGRESS" | "COMPLETED") => {
    if (!driverActiveTrip) return;
    try {
      const res = await fetch(`/api/trips/${driverActiveTrip.trip_id}/status`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...getAuthHeader("DRIVER"),
          "x-actor-role": "DRIVER",
          "x-actor-id": selectedDriverId,
        },
        body: JSON.stringify({
          newState,
          assignmentToken: rawAssignmentToken || (assignmentTokenRecord ? "ASSIGNMENT_TOKEN_ISSUED" : undefined),
        }),
      });
      const data = await res.json();
      if (res.ok) {
        let message = `Trip state updated to ${newState}.`;
        if (newState === "ARRIVED") message = "📍 Driver arrived at pickup location.";
        else if (newState === "IN_PROGRESS") message = "▶️ Trip started! En route to destination.";
        else if (newState === "COMPLETED") message = "🏁 Trip completed successfully! Fare settled.";
        showBanner(message, "success");
        syncState();
      } else {
        showBanner(`Transition blocked: ${data.error}`, "danger");
      }
    } catch (e: any) {
      showBanner(e.message, "danger");
    }
  };

  // --- TRANSIT SIMULATION (DRIVE TO PICKUP / DROPOFF) ---
  const startTransitSimulation = (stage: "TO_PICKUP" | "TO_DROPOFF") => {
    if (!driverActiveTrip) return;

    const targetLat = stage === "TO_PICKUP" ? driverActiveTrip.pickup_lat : driverActiveTrip.dropoff_lat;
    const targetLng = stage === "TO_PICKUP" ? driverActiveTrip.pickup_lng : driverActiveTrip.dropoff_lng;
    const targetLabel = stage === "TO_PICKUP"
      ? getLocationLabel(driverActiveTrip.pickup_lat, driverActiveTrip.pickup_lng)
      : getLocationLabel(driverActiveTrip.dropoff_lat, driverActiveTrip.dropoff_lng);

    const startLat = driverGps.lat;
    const startLng = driverGps.lng;

    if (transitIntervalRef.current) {
      clearInterval(transitIntervalRef.current);
    }

    setTransitModal({
      isOpen: true,
      stage,
      targetLat,
      targetLng,
      targetLabel,
      currentLat: startLat,
      currentLng: startLng,
      progress: 0,
      speedKmh: 36,
      isComplete: false,
    });

    let currentStep = 0;
    const totalSteps = 4;
    let localSeq = driverGps.seq;

    transitIntervalRef.current = setInterval(async () => {
      currentStep++;
      const fraction = currentStep / totalSteps;
      const progressPercent = Math.round(fraction * 100);

      const interpolatedLat = startLat + (targetLat - startLat) * fraction;
      const interpolatedLng = startLng + (targetLng - startLng) * fraction;
      localSeq++;

      setDriverGps((prev) => ({
        ...prev,
        lat: interpolatedLat,
        lng: interpolatedLng,
        speed: 36,
        seq: localSeq,
      }));

      setTransitModal((prev) =>
        prev
          ? {
            ...prev,
            currentLat: interpolatedLat,
            currentLng: interpolatedLng,
            progress: progressPercent,
            isComplete: currentStep >= totalSteps,
          }
          : null
      );

      // Post valid live GPS telemetry to backend
      try {
        await fetch("/api/driver/location", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...getAuthHeader("DRIVER"),
            "x-actor-role": "DRIVER",
            "x-actor-id": selectedDriverId,
          },
          body: JSON.stringify({
            latitude: interpolatedLat,
            longitude: interpolatedLng,
            speedMps: 10.0,
            sequenceNum: localSeq,
            isSimulatedTransit: true,
          }),
        });
      } catch (err) {
        console.error("Telemetry update error during transit simulation", err);
      }

      if (currentStep >= totalSteps) {
        if (transitIntervalRef.current) {
          clearInterval(transitIntervalRef.current);
          transitIntervalRef.current = null;
        }
        showBanner(`📍 Arrived at ${targetLabel}!`, "success");
      }
    }, 700);
  };


  // Driver GPS Ping (Manual Single Ping)
  const handleNormalGpsPing = async () => {
    const nextSeq = driverGps.seq + 1;
    const newLat = driverGps.lat + 0.0003;
    const newLng = driverGps.lng + 0.0002;
    setDriverGps({ lat: newLat, lng: newLng, speed: 32, seq: nextSeq });

    try {
      const res = await fetch("/api/driver/location", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...getAuthHeader("DRIVER"),
          "x-actor-role": "DRIVER",
          "x-actor-id": selectedDriverId,
        },
        body: JSON.stringify({
          latitude: newLat,
          longitude: newLng,
          speedMps: 8.8,
          sequenceNum: nextSeq,
        }),
      });
      const data = await res.json();
      if (res.status === 429) {
        showBanner(`Rate Limited: ${data.error}`, "danger");
      } else if (!res.ok) {
        showBanner(data.error, "danger");
      }
    } catch (e) {
      console.error(e);
    }
  };

  // Driver Spoofed GPS Attack Test (L2-10)
  const handleSpoofedGpsJump = async () => {
    const nextSeq = driverGps.seq + 1;
    const spoofLat = driverGps.lat + 0.35;
    const spoofLng = driverGps.lng + 0.25;

    try {
      const res = await fetch("/api/driver/location", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...getAuthHeader("DRIVER"),
          "x-actor-role": "DRIVER",
          "x-actor-id": selectedDriverId,
        },
        body: JSON.stringify({
          latitude: spoofLat,
          longitude: spoofLng,
          speedMps: 95,
          sequenceNum: nextSeq,
        }),
      });
      const data = await res.json();
      if (data.anomalyDetected) {
        showBanner(
          `🛡️ Spoofing Anomaly Detected & Logged! Velocity: ${data.velocityKmh} km/h`,
          "danger"
        );
        syncOpsData();
      }
    } catch (e: any) {
      showBanner(e.message, "danger");
    }
  };

  // Toggle Circuit Breaker Outage Simulation
  const handleToggleCircuitBreaker = async () => {
    const nextState = !isSimulatedOutage;
    try {
      const res = await fetch("/api/system/circuit-breaker", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: nextState }),
      });
      const data = await res.json();
      setIsSimulatedOutage(data.simulatedOutage);
      setCircuitStatus(data.circuitState);
      showBanner(
        nextState
          ? "⚠️ Maps Outage Simulated! Circuit Breaker tripped; falling back to local cached routing."
          : "✅ Maps Provider restored to normal operation.",
        nextState ? "danger" : "success"
      );
      fetchEstimate();
    } catch (e) {
      console.error(e);
    }
  };

  // Approve Driver Background Check (Ops)
  const handleApproveDriver = async (checkId: string) => {
    try {
      const res = await fetch("/api/ops/drivers", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...getAuthHeader("OPS_STAFF"),
          "x-actor-role": "OPS_STAFF",
          "x-actor-id": selectedStaffId,
        },
        body: JSON.stringify({ checkId }),
      });
      if (res.ok) {
        showBanner("Driver Background Check Approved & Cleared! Status updated in Core Operations DB.", "success");
        syncOpsData();
        loadActorsAndSystem();
      }
    } catch (e: any) {
      showBanner(e.message, "danger");
    }
  };

  // Resolve Safety Incident (Ops)
  const handleResolveIncident = async (incidentId: string) => {
    try {
      const res = await fetch("/api/ops/incidents", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...getAuthHeader("OPS_STAFF"),
          "x-actor-role": "OPS_STAFF",
          "x-actor-id": selectedStaffId,
        },
        body: JSON.stringify({ incidentId, status: "RESOLVED" }),
      });
      if (res.ok) {
        showBanner("Incident marked as RESOLVED.", "success");
        syncOpsData();
      }
    } catch (e: any) {
      showBanner(e.message, "danger");
    }
  };


  // Clear Anomalies (Ops)
  const handleClearAnomalies = async () => {
    try {
      const res = await fetch("/api/ops/telemetry-anomalies", {
        method: "DELETE",
        headers: {
          ...getAuthHeader("OPS_STAFF"),
          "x-actor-role": "OPS_STAFF",
          "x-actor-id": selectedStaffId,
        },
      });
      if (res.ok) {
        setAnomalies([]);
        showBanner("Cleared telemetry anomalies log.", "success");
      }
    } catch (e: any) {
      showBanner(e.message, "danger");
    }
  };

  // Helper to switch directly to the matched driver
  const handleSwitchToMatchedDriver = (driverId: string) => {
    setSelectedDriverId(driverId);
    setActiveTab("DRIVER");
  };

  const matchedDriverProfile = actors?.drivers.find(
    (d) => d.driver_id === (activeTrip?.driver_id || pendingOffer?.candidate_driver_id)
  );

  // Active actor and authorization state
  const currentActorId =
    activeTab === "RIDER"
      ? selectedRiderId
      : activeTab === "DRIVER"
        ? selectedDriverId
        : selectedStaffId;
  const currentRole: "RIDER" | "DRIVER" | "OPS_STAFF" =
    activeTab === "RIDER" ? "RIDER" : activeTab === "DRIVER" ? "DRIVER" : "OPS_STAFF";
  const isCurrentActorAuthenticated = Boolean(authenticatedSessions[currentActorId]);

  // Explicit Login Card Component
  const renderLoginCard = (role: "RIDER" | "DRIVER" | "OPS_STAFF", actorId: string) => {
    let icon = "📱";
    let title = "Rider Account Login";
    let subtitle = "Enter password to establish an authenticated, cryptographically signed session.";
    let profileName = actorId;
    let profileDetail = "";

    if (role === "RIDER") {
      const r = actors?.riders.find((x) => x.rider_id === actorId);
      profileName = r?.full_name || actorId;
      profileDetail = r?.email ? `Email: ${r.email}` : `Account ID: ${actorId}`;
    } else if (role === "DRIVER") {
      icon = "🚗";
      title = "Driver Partner Login";
      subtitle = "Authenticate to access live vehicle telemetry, shift toggles, and dispatch offers.";
      const d = actors?.drivers.find((x) => x.driver_id === actorId);
      profileName = d?.full_name || actorId;
      profileDetail = d
        ? `Vehicle: ${d.make} ${d.model} (${d.license_plate}) • Status: ${d.onboarding_status}`
        : `Account ID: ${actorId}`;
    } else {
      icon = "🛡️";
      title = "Operations & Admin Login";
      subtitle = "Restricted: Cryptographic authentication required for safety investigation & auditing.";
      const s = actors?.opsStaff.find((x) => x.staff_id === actorId);
      profileName = s?.full_name || actorId;
      profileDetail = s
        ? `Role: ${formatStaffRole(s.role)} • ${s.email}`
        : `Account ID: ${actorId}`;
    }

    return (
      <div className={styles.loginWrapper}>
        <div className={styles.loginCard}>
          <div className={styles.loginCardHeader}>
            <div className={styles.loginIconCircle}>{icon}</div>
            <div>
              <div className={styles.loginTitle}>{title}</div>
              <div className={styles.loginSubtitle}>{subtitle}</div>
            </div>
          </div>

          {/* Account Profile Preview & Quick Selector */}
          <div className={styles.accountPreviewBox}>
            <div className={styles.accountPreviewRow}>
              <span className={styles.accountPreviewLabel}>Selected Account</span>
              <span className={styles.badgeInfo}>{role}</span>
            </div>

            <div style={{ marginTop: 8, marginBottom: 8 }}>
              <select
                className={styles.actorSelect}
                style={{ width: "100%", padding: "8px 12px", background: "rgba(0,0,0,0.5)" }}
                value={actorId}
                onChange={(e) => {
                  const newId = e.target.value;
                  setLoginPassword("");
                  setLoginError(null);
                  if (role === "RIDER") setSelectedRiderId(newId);
                  else if (role === "DRIVER") setSelectedDriverId(newId);
                  else setSelectedStaffId(newId);
                }}
              >
                {role === "RIDER" &&
                  actors?.riders.map((r) => (
                    <option key={r.rider_id} value={r.rider_id}>
                      {r.full_name} ({r.rider_id}) {authenticatedSessions[r.rider_id] ? "• (Logged In)" : "• (Locked)"}
                    </option>
                  ))}
                {role === "DRIVER" &&
                  actors?.drivers.map((d) => (
                    <option key={d.driver_id} value={d.driver_id}>
                      {d.full_name} ({d.driver_id}) — {d.make} {d.model} {authenticatedSessions[d.driver_id] ? "• (Logged In)" : "• (Locked)"}
                    </option>
                  ))}
                {role === "OPS_STAFF" &&
                  actors?.opsStaff.map((s) => (
                    <option key={s.staff_id} value={s.staff_id}>
                      {s.full_name} ({s.staff_id}) — {formatStaffRole(s.role)} {authenticatedSessions[s.staff_id] ? "• (Logged In)" : "• (Locked)"}
                    </option>
                  ))}
              </select>
            </div>

            <div style={{ fontSize: "0.78rem", color: "var(--text-dim)", marginTop: 2 }}>
              {profileDetail}
            </div>
          </div>

          {/* Error Alert */}
          {loginError && (
            <div className={styles.loginErrorAlert}>
              <span>⚠️</span>
              <span>{loginError}</span>
            </div>
          )}

          {/* Explicit Password Authentication Form */}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              handleLogin(actorId, role);
            }}
          >
            <div className={styles.formGroup} style={{ marginBottom: "1.25rem" }}>
              <label className={styles.label}>Account Password</label>
              <div className={styles.passwordInputWrapper}>
                <input
                  type={showPassword ? "text" : "password"}
                  className={styles.input}
                  placeholder={`Enter password for ${profileName}...`}
                  value={loginPassword}
                  onChange={(e) => setLoginPassword(e.target.value)}
                  autoFocus
                />
                <button
                  type="button"
                  className={styles.togglePasswordBtn}
                  onClick={() => setShowPassword(!showPassword)}
                  title={showPassword ? "Hide password" : "Show password"}
                >
                  {showPassword ? "🙈" : "👁️"}
                </button>
              </div>
            </div>

            <button
              type="submit"
              className={styles.btnPrimary}
              disabled={isLoggingIn || !loginPassword.trim()}
              style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}
            >
              {isLoggingIn ? "Verifying AES-256 Credentials..." : "🔐 Establish Authenticated Session"}
            </button>
          </form>


        </div>
      </div>
    );
  };

  return (
    <div className={styles.container}>
      {/* Top Cockpit Header */}
      <header className={styles.header}>
        <div className={styles.brand}>
          <div className={styles.logoIcon}>RN</div>
          <div className={styles.brandText}>
            <span className={styles.brandTitle}>RideNow Platform</span>
            <span className={styles.brandSubtitle}>Architecture Blueprint Demo</span>
          </div>
        </div>

        {/* Primary Role Switcher */}
        <nav className={styles.tabNav}>
          <button
            className={`${styles.tabButton} ${activeTab === "RIDER" ? styles.tabActive : ""}`}
            onClick={() => setActiveTab("RIDER")}
          >
            <span>📱</span> Rider App
          </button>
          <button
            className={`${styles.tabButton} ${activeTab === "DRIVER" ? styles.tabActive : ""}`}
            onClick={() => setActiveTab("DRIVER")}
          >
            <span>🚗</span> Driver App
            {(pendingOffer || otherPendingOffers.length > 0) && (
              <span
                style={{
                  background: "#f59e0b",
                  color: "#000",
                  fontSize: "0.68rem",
                  fontWeight: 800,
                  padding: "1px 6px",
                  borderRadius: 10,
                }}
              >
                1 OFFER
              </span>
            )}
          </button>
          <button
            className={`${styles.tabButton} ${activeTab === "OPS" ? styles.tabActive : ""}`}
            onClick={() => setActiveTab("OPS")}
          >
            <span>🛡️</span> Admin & Ops Console
          </button>
        </nav>

        {/* Header Utilities & Actor Selector */}
        <div className={styles.headerUtilities}>
          {/* Circuit Breaker Outage Toggle */}
          <div
            className={`${styles.circuitPill} ${isSimulatedOutage ? styles.circuitOpen : styles.circuitClosed}`}
            onClick={handleToggleCircuitBreaker}
            title="Click to toggle simulated Maps Provider outage"
          >
            <span className={styles.statusDot}></span>
            <span>Maps Breaker: {circuitStatus}</span>
          </div>

          {/* Active Identity Controls & Session Status */}
          <div className={styles.actorBadge} style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <label className={styles.label} style={{ margin: 0 }}>
              {activeTab === "RIDER" ? "Rider:" : activeTab === "DRIVER" ? "Driver:" : "Staff:"}
            </label>
            <select
              className={styles.actorSelect}
              value={
                activeTab === "RIDER"
                  ? selectedRiderId
                  : activeTab === "DRIVER"
                    ? selectedDriverId
                    : selectedStaffId
              }
              onChange={(e) => {
                const newId = e.target.value;
                setLoginPassword("");
                setLoginError(null);
                if (activeTab === "RIDER") {
                  setSelectedRiderId(newId);
                } else if (activeTab === "DRIVER") {
                  setSelectedDriverId(newId);
                } else {
                  setSelectedStaffId(newId);
                }
              }}
            >
              {activeTab === "RIDER" &&
                actors?.riders.map((r) => {
                  const isAuthed = Boolean(authenticatedSessions[r.rider_id]);
                  return (
                    <option key={r.rider_id} value={r.rider_id}>
                      {r.full_name} {isAuthed ? "• Logged In" : "• (Locked)"}
                    </option>
                  );
                })}
              {activeTab === "DRIVER" &&
                actors?.drivers.map((d) => {
                  const isOnline = driverOnlineMap[d.driver_id] ?? d.is_online ?? true;
                  const isAuthed = Boolean(authenticatedSessions[d.driver_id]);
                  return (
                    <option key={d.driver_id} value={d.driver_id}>
                      {d.full_name} ({d.make} {d.model}) — {isOnline ? "🟢 Online" : "🔴 Offline"} {isAuthed ? "• Logged In" : "• (Locked)"}
                    </option>
                  );
                })}
              {activeTab === "OPS" &&
                actors?.opsStaff.map((s) => {
                  const isAuthed = Boolean(authenticatedSessions[s.staff_id]);
                  return (
                    <option key={s.staff_id} value={s.staff_id}>
                      {s.full_name} — {formatStaffRole(s.role)} {isAuthed ? "• Logged In" : "• (Locked)"}
                    </option>
                  );
                })}
            </select>

            {/* Session Indicator & Explicit Logout Button */}
            {isCurrentActorAuthenticated ? (
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span className={styles.sessionActiveBadge} title="Cryptographic HMAC session token active">
                  🟢 Session Active
                </span>
                <button
                  type="button"
                  className={styles.logoutBtn}
                  onClick={() => handleLogout(currentActorId)}
                  title={`Explicitly log out of ${currentActorId}`}
                >
                  🚪 Log Out
                </button>
              </div>
            ) : (
              <span className={styles.sessionLockedBadge} title="Authentication required">
                🔒 Log In Required
              </span>
            )}
          </div>
        </div>
      </header>

      {/* Global Notification Banner */}
      {banner && (
        <div style={{ maxWidth: 1400, margin: "1rem auto 0", padding: "0 2rem", width: "100%" }}>
          <div
            className={`${styles.alertBox} ${banner.type === "danger" ? styles.alertDanger : styles.alertSuccess} fade-in`}
          >
            <span>{banner.type === "danger" ? "⚠️" : "✨"}</span>
            <span>{banner.message}</span>
          </div>
        </div>
      )}

      {/* =======================================================
          TRANSIT SIMULATION MODAL (DRIVE TO PICKUP / DROPOFF)
      ======================================================= */}
      {transitModal && transitModal.isOpen && (
        <div className={styles.modalBackdrop}>
          <div className={styles.modal}>
            <div className={styles.modalTitle}>
              <span>{transitModal.stage === "TO_PICKUP" ? "🚗" : "🏁"}</span>
              <span>
                {transitModal.stage === "TO_PICKUP" ? "Navigating to Pickup Location" : "Navigating to Dropoff Destination"}
              </span>
            </div>

            <p className={styles.modalSubtitle}>
              Simulating driver GPS transit to {transitModal.targetLabel}. Live telemetry streaming to dispatch service.
            </p>

            {/* Live Animated Progress Bar */}
            <div className={styles.progressBarContainer}>
              <div
                className={styles.progressBarFill}
                style={{ width: `${transitModal.progress}%` }}
              ></div>
            </div>

            {/* Live Telemetry Display */}
            <div className={styles.telemetryGrid}>
              <div className={styles.telemetryItem}>
                <span className={styles.telemetryLabel}>Target Coordinates</span>
                <span className={styles.telemetryValue}>
                  {transitModal.targetLat.toFixed(4)}, {transitModal.targetLng.toFixed(4)}
                </span>
              </div>
              <div className={styles.telemetryItem}>
                <span className={styles.telemetryLabel}>Current Live Position</span>
                <span className={styles.telemetryValue} style={{ color: "#38bdf8" }}>
                  {transitModal.currentLat.toFixed(4)}, {transitModal.currentLng.toFixed(4)}
                </span>
              </div>
              <div className={styles.telemetryItem}>
                <span className={styles.telemetryLabel}>Simulated Speed</span>
                <span className={styles.telemetryValue} style={{ color: "#34d399" }}>
                  {transitModal.isComplete ? "0 km/h (Stopped)" : `${transitModal.speedKmh} km/h (Urban Flow)`}
                </span>
              </div>
              <div className={styles.telemetryItem}>
                <span className={styles.telemetryLabel}>Transit Progress</span>
                <span className={styles.telemetryValue} style={{ color: transitModal.isComplete ? "#34d399" : "#fbbf24" }}>
                  {transitModal.progress}% {transitModal.isComplete ? "— Arrived! ✓" : ""}
                </span>
              </div>
            </div>

            {/* Action Buttons */}
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {!transitModal.isComplete ? (
                <button
                  className={styles.btnDanger}
                  onClick={() => {
                    if (transitIntervalRef.current) {
                      clearInterval(transitIntervalRef.current);
                      transitIntervalRef.current = null;
                    }
                    setTransitModal(null);
                  }}
                >
                  Cancel Transit Simulation
                </button>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  {transitModal.stage === "TO_PICKUP" ? (
                    <button
                      className={styles.btnPrimary}
                      style={{ background: "linear-gradient(135deg, #10b981, #059669)", fontSize: "1rem", padding: "14px" }}
                      onClick={async () => {
                        setTransitModal(null);
                        await handleTransition("ARRIVED");
                      }}
                    >
                      🚖 Confirm Arrival at Pickup
                    </button>
                  ) : (
                    <button
                      className={styles.btnPrimary}
                      style={{ background: "linear-gradient(135deg, #10b981, #059669)", fontSize: "1rem", padding: "14px" }}
                      onClick={async () => {
                        setTransitModal(null);
                        await handleTransition("COMPLETED");
                      }}
                    >
                      🏁 Complete Trip & Settle Fare
                    </button>
                  )}

                  <button
                    className={styles.btnSecondary}
                    onClick={() => setTransitModal(null)}
                  >
                    Close Modal
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Main View Area */}
      <main className={styles.mainContent}>
        {/* =======================================================
            VIEW 1: RIDER APP
        ======================================================= */}
        {activeTab === "RIDER" && (
          !authenticatedSessions[selectedRiderId] ? (
            renderLoginCard("RIDER", selectedRiderId)
          ) : (
            <div className={styles.cockpitGrid}>
              {/* Booking Column */}
              <div className={styles.card}>
                <div className={styles.cardHeader}>
                  <div className={styles.cardTitle}>
                    <span>📍</span> Request a Ride
                  </div>
                </div>

                {/* Pickup & Dropoff Selection */}
                <div className={styles.formGroup}>
                  <label className={styles.label}>Pickup Location</label>
                  <input className={styles.input} value={pickup.label} readOnly />
                </div>

                <div className={styles.formGroup}>
                  <label className={styles.label}>Dropoff Destination</label>
                  <input className={styles.input} value={dropoff.label} readOnly />
                  <div className={styles.quickSelectButtons}>
                    <button
                      className={styles.quickButton}
                      onClick={() => {
                        setPickup({ lat: 33.7756, lng: -84.3880, label: "Tech Square, Midtown" });
                        setDropoff({ lat: 33.7550, lng: -84.3900, label: "Mercedes-Benz Stadium, Downtown" });
                      }}
                    >
                      Midtown ➔ Downtown (Surge Zone)
                    </button>
                    <button
                      className={styles.quickButton}
                      onClick={() => {
                        setPickup({ lat: 33.7756, lng: -84.3880, label: "Tech Square, Midtown" });
                        setDropoff({ lat: 33.6407, lng: -84.4277, label: "Hartsfield-Jackson Airport" });
                      }}
                    >
                      Midtown ➔ Airport
                    </button>
                    <button
                      className={styles.quickButton}
                      onClick={() => {
                        setPickup({ lat: 33.7600, lng: -84.3930, label: "Centennial Olympic Park" });
                        setDropoff({ lat: 33.8400, lng: -84.3750, label: "Buckhead Financial Core" });
                      }}
                    >
                      Centennial ➔ Buckhead
                    </button>
                  </div>
                </div>

                {/* Dispatch Mode / Target Driver for Testing */}
                <div className={styles.formGroup}>
                  <label className={styles.label}>Dispatch Match Target (Testing Control)</label>
                  <select
                    className={styles.input}
                    value={targetDriverId}
                    onChange={(e) => setTargetDriverId(e.target.value)}
                  >
                    <option value="NEAREST">Nearest Online Driver (Real-Time Proximity Filter)</option>
                    {actors?.drivers.map((d) => {
                      const isOnline = driverOnlineMap[d.driver_id] ?? d.is_online ?? true;
                      return (
                        <option key={d.driver_id} value={d.driver_id} disabled={!isOnline}>
                          Direct Test: {d.full_name} ({d.make} {d.model}) — {isOnline ? "🟢 Online" : "🔴 Offline (Unavailable)"}
                        </option>
                      );
                    })}
                  </select>
                  {targetDriverId !== "NEAREST" && !(driverOnlineMap[targetDriverId] ?? actors?.drivers.find((d) => d.driver_id === targetDriverId)?.is_online ?? true) && (
                    <p style={{ color: "#ef4444", fontSize: "0.82rem", marginTop: 6, fontWeight: 500 }}>
                      ⚠️ {actors?.drivers.find((d) => d.driver_id === targetDriverId)?.full_name || "Selected driver"} is currently offline and cannot accept ride requests.
                    </p>
                  )}
                </div>

                {/* Live Fare Breakdown */}
                {estimate && (
                  <div className={styles.pricingBox}>
                    <div className={styles.priceRow}>
                      <span>Estimated Distance:</span>
                      <strong>{estimate.route.distanceKm} km</strong>
                    </div>
                    <div className={styles.priceRow}>
                      <span>Est. Travel Time:</span>
                      <strong>{estimate.route.durationMinutes} mins</strong>
                    </div>
                    <div className={styles.priceRow}>
                      <span>Route Source:</span>
                      <span style={{ color: estimate.route.source === "FALLBACK_CACHE" ? "#fbbf24" : "#34d399" }}>
                        {estimate.route.source}
                      </span>
                    </div>
                    <div className={styles.priceRow}>
                      <span>Dynamic Surge Multiplier:</span>
                      <strong style={{ color: estimate.fare.surgeMultiplier > 1 ? "#fbbf24" : "#34d399" }}>
                        {estimate.fare.surgeMultiplier}x {estimate.fare.surgeZoneName ? `(${estimate.fare.surgeZoneName})` : ""}
                      </strong>
                    </div>
                    <div className={styles.priceTotal}>
                      <span>Authoritative Total:</span>
                      <span>${estimate.fare.totalFare.toFixed(2)}</span>
                    </div>
                  </div>
                )}

                {/* Payment Method Badge */}
                <div className={styles.formGroup}>
                  <label className={styles.label}>Saved Payment Method</label>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: "0.85rem", color: "var(--text-muted)" }}>
                    <span>💳 Visa •••• 4821</span>
                    <span className={`${styles.badge} ${styles.badgeSuccess}`}>Default</span>
                  </div>
                </div>

                {/* Request Button */}
                <button
                  className={styles.btnPrimary}
                  onClick={handleRequestRide}
                  disabled={requestingRide || (activeTrip !== null && activeTrip.current_state !== "CANCELLED")}
                >
                  {requestingRide
                    ? "Dispatching..."
                    : activeTrip
                      ? activeTrip.current_state === "CANCELLED"
                        ? "Trip Declined — Dismiss to Re-book"
                        : `Active Trip (${activeTrip.current_state})`
                      : "Request RideNow"}
                </button>
              </div>

              {/* Active Trip & History Column */}
              <div style={{ display: "flex", flexDirection: "column", gap: "1.5rem" }}>
                {/* Active Trip Monitor */}
                <div
                  className={styles.card}
                  style={
                    activeTrip && activeTrip.current_state === "CANCELLED"
                      ? { borderColor: "#ef4444", boxShadow: "0 0 20px rgba(239, 68, 68, 0.25)" }
                      : undefined
                  }
                >
                  <div className={styles.cardHeader}>
                    <div className={styles.cardTitle}>
                      <span>🚗</span> Active Trip Status
                    </div>
                    {activeTrip ? (
                      <span
                        className={`${styles.badge} ${activeTrip.current_state === "CANCELLED" ? styles.badgeDanger : styles.badgeWarning
                          }`}
                      >
                        {activeTrip.current_state === "CANCELLED" ? "DECLINED" : activeTrip.current_state}
                      </span>
                    ) : (
                      <span className={`${styles.badge} ${styles.badgeSuccess}`}>No Active Ride</span>
                    )}
                  </div>

                  {activeTrip ? (
                    activeTrip.current_state === "CANCELLED" ? (
                      <div
                        style={{
                          background: "rgba(239, 68, 68, 0.12)",
                          border: "1.5px solid #ef4444",
                          borderRadius: 10,
                          padding: "1.25rem",
                          display: "flex",
                          flexDirection: "column",
                          gap: "1rem",
                        }}
                      >
                        <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
                          <span style={{ fontSize: "2rem", lineHeight: 1 }}>🚫</span>
                          <div>
                            <h4 style={{ margin: "0 0 4px", color: "#f87171", fontSize: "1.05rem", fontWeight: 700 }}>
                              {activeTrip.cancellation_reason === "DRIVER_DECLINED"
                                ? "Ride Request Declined by Driver"
                                : "Ride Request Cancelled"}
                            </h4>
                            <p style={{ margin: 0, color: "#fca5a5", fontSize: "0.88rem", lineHeight: 1.4 }}>
                              {activeTrip.cancellation_reason === "DRIVER_DECLINED"
                                ? "The assigned driver was unable to accept your ride request at this time. Please confirm below to dismiss and request another driver or route."
                                : "This trip request has been cancelled."}
                            </p>
                          </div>
                        </div>

                        <div style={{ background: "rgba(0, 0, 0, 0.3)", padding: "10px 14px", borderRadius: 8 }}>
                          <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.85rem", marginBottom: 4 }}>
                            <span style={{ color: "var(--text-muted)" }}>Booking Ref:</span>
                            <strong style={{ color: "#38bdf8" }}>{formatBookingRef(activeTrip.trip_id)}</strong>
                          </div>
                          {activeTrip.driver_id && (
                            <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.85rem" }}>
                              <span style={{ color: "var(--text-muted)" }}>Declining Driver:</span>
                              <span style={{ color: "#fca5a5", fontWeight: 600 }}>
                                {matchedDriverProfile ? `${matchedDriverProfile.full_name} (${matchedDriverProfile.make} ${matchedDriverProfile.model})` : activeTrip.driver_id}
                              </span>
                            </div>
                          )}
                        </div>

                        <button
                          className={styles.btnDanger}
                          style={{
                            width: "100%",
                            padding: "12px",
                            fontSize: "0.95rem",
                            fontWeight: 700,
                            background: "linear-gradient(135deg, #ef4444, #dc2626)",
                            boxShadow: "0 4px 12px rgba(239, 68, 68, 0.3)",
                          }}
                          onClick={handleDismissCancelledTrip}
                        >
                          ✕ Confirm & Dismiss
                        </button>
                      </div>
                    ) : (
                      <div>
                        {/* Visual State Progression */}
                        <div className={styles.stateProgression}>
                          {["REQUESTED", "MATCHED", "ARRIVED", "IN_PROGRESS", "COMPLETED"].map((step, idx) => {
                            const stepStates = ["REQUESTED", "MATCHED", "ARRIVED", "IN_PROGRESS", "COMPLETED"];
                            const currentIdx = stepStates.indexOf(activeTrip.current_state);
                            const isDone = currentIdx > idx;
                            const isCurrent = currentIdx === idx;
                            return (
                              <div
                                key={step}
                                className={`${styles.stateStep} ${isDone ? styles.stepCompleted : isCurrent ? styles.stepActive : ""
                                  }`}
                              >
                                <div className={styles.stepIcon}>{isDone ? "✓" : idx + 1}</div>
                                <span className={styles.stepLabel}>{step}</span>
                              </div>
                            );
                          })}
                        </div>

                        <div style={{ background: "rgba(0,0,0,0.25)", padding: "1rem", borderRadius: 8, marginBottom: 12 }}>
                          <p style={{ fontSize: "0.85rem", marginBottom: 6 }}>
                            <strong>Booking Ref:</strong> <code style={{ color: "#38bdf8", fontWeight: 700 }}>{formatBookingRef(activeTrip.trip_id)}</code>
                          </p>
                          <p style={{ fontSize: "0.85rem", marginBottom: 6 }}>
                            <strong>Matched Driver:</strong>{" "}
                            <span style={{ color: "#34d399", fontWeight: 700 }}>
                              {matchedDriverProfile ? `${matchedDriverProfile.full_name} (${matchedDriverProfile.make} ${matchedDriverProfile.model} • ${matchedDriverProfile.license_plate})` : activeTrip.driver_id || "Awaiting Driver Confirmation"}
                            </span>
                          </p>
                        </div>

                        {/* Quick helper buttons for testing */}
                        <div style={{ display: "flex", gap: 10 }}>
                          {activeTrip.driver_id && (
                            <button
                              className={styles.btnPrimary}
                              style={{ fontSize: "0.82rem", padding: "8px 12px" }}
                              onClick={() => handleSwitchToMatchedDriver(activeTrip.driver_id)}
                            >
                              👉 Switch to Driver App (as {matchedDriverProfile?.full_name || activeTrip.driver_id}) to Accept/Drive
                            </button>
                          )}

                          <button
                            className={styles.btnDanger}
                            style={{ fontSize: "0.82rem", padding: "8px 12px" }}
                            onClick={handleCancelTrip}
                          >
                            ✕ Cancel Trip
                          </button>
                        </div>
                      </div>
                    )
                  ) : (
                    <p style={{ color: "var(--text-muted)", fontSize: "0.9rem" }}>
                      Select a route and press <strong>Request RideNow</strong> to trigger the 5-stage dispatch pipeline.
                    </p>
                  )}
                </div>

                {/* Past Completed Trips */}
                <div className={styles.card}>
                  <div className={styles.cardHeader}>
                    <div className={styles.cardTitle}>
                      <span>📜</span> Completed Trip History
                    </div>
                  </div>

                  {riderHistory.length > 0 ? (
                    <div className={styles.tableContainer}>
                      <table className={styles.table}>
                        <thead>
                          <tr>
                            <th>Booking Ref</th>
                            <th>Status</th>
                            <th>Fare</th>
                            <th>Payment</th>
                          </tr>
                        </thead>
                        <tbody>
                          {riderHistory.map((t) => (
                            <tr key={t.trip_id}>
                              <td style={{ fontFamily: "monospace", fontWeight: 600, color: "#38bdf8" }}>{formatBookingRef(t.trip_id)}</td>
                              <td>
                                <span className={`${styles.badge} ${t.status === "COMPLETED" ? styles.badgeSuccess : t.status === "CANCELLED" ? styles.badgeDanger : styles.badgeWarning}`}>{t.status}</span>
                              </td>
                              <td>${t.total_fare ? t.total_fare.toFixed(2) : "--"}</td>
                              <td>{t.payment_status || "SETTLED"}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <p style={{ color: "var(--text-muted)", fontSize: "0.85rem" }}>No completed trips recorded yet.</p>
                  )}
                </div>
              </div>
            </div>
          )
        )}

        {/* =======================================================
            VIEW 2: DRIVER APP
        ======================================================= */}
        {activeTab === "DRIVER" && (
          !authenticatedSessions[selectedDriverId] ? (
            renderLoginCard("DRIVER", selectedDriverId)
          ) : (
            <div className={styles.cockpitGrid}>
              {/* Shift & Telemetry Simulator */}
              <div className={styles.card}>
                <div className={styles.cardHeader}>
                  <div className={styles.cardTitle}>
                    <span>🚗</span> Driver Telemetry Stream
                  </div>
                  <div style={{ display: "flex", gap: 8 }}>
                    <span className={`${styles.badge} ${isCurrentDriverOnline ? styles.badgeSuccess : styles.badgeDanger}`}>
                      {isCurrentDriverOnline ? "ONLINE" : "OFFLINE"}
                    </span>
                  </div>
                </div>

                {/* Alert if another driver has an offer */}
                {otherPendingOffers.length > 0 && !pendingOffer && (
                  <div
                    className={styles.alertBox}
                    style={{ background: "rgba(245, 158, 11, 0.15)", border: "1px solid rgba(245, 158, 11, 0.3)" }}
                  >
                    <span>📢</span>
                    <div>
                      <strong style={{ color: "#fbbf24" }}>Dispatch Offer Dispatched!</strong>
                      <p style={{ fontSize: "0.82rem", margin: "4px 0" }}>
                        Trip offer is currently pending for: <strong>{otherPendingOffers[0].candidateDriverName}</strong> ({otherPendingOffers[0].candidate_driver_id}).
                      </p>
                      <button
                        className={styles.btnSecondary}
                        style={{ fontSize: "0.78rem", padding: "4px 8px", marginTop: 4 }}
                        onClick={() => setSelectedDriverId(otherPendingOffers[0].candidate_driver_id)}
                      >
                        👉 Switch to {otherPendingOffers[0].candidateDriverName} to Review & Accept
                      </button>
                    </div>
                  </div>
                )}

                {/* Telemetry Status Monitor */}
                <div className={styles.pricingBox}>
                  <div className={styles.priceRow}>
                    <span>Active Driver:</span>
                    <strong>
                      {actors?.drivers.find((d) => d.driver_id === selectedDriverId)?.full_name || selectedDriverId}
                    </strong>
                  </div>
                  <div className={styles.priceRow}>
                    <span>Current Location:</span>
                    <strong>
                      {getLocationLabel(driverGps.lat, driverGps.lng)}
                    </strong>
                  </div>
                  <div className={styles.priceRow}>
                    <span>Coordinates:</span>
                    <span style={{ color: "#38bdf8" }}>
                      {driverGps.lat.toFixed(4)}, {driverGps.lng.toFixed(4)}
                    </span>
                  </div>
                  <div className={styles.priceRow}>
                    <span>Current Speed:</span>
                    <strong>{driverGps.speed} km/h</strong>
                  </div>
                  <div className={styles.priceRow}>
                    <span>GPS Stream Status:</span>
                    <span style={{ color: "#34d399", fontWeight: 600 }}>Active • Connected</span>
                  </div>
                </div>

                {/* Telemetry Action Controls */}
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  <button className={styles.btnPrimary} onClick={handleNormalGpsPing}>
                    📡 Send GPS Telemetry Update
                  </button>

                  <button className={styles.btnDanger} onClick={handleSpoofedGpsJump}>
                    ⚡ Simulate Spoofed GPS Jump (350 km/h)
                  </button>
                </div>

                <div style={{ marginTop: "1.5rem" }}>
                  <label className={styles.label}>Shift Status</label>
                  <button
                    className={styles.btnSecondary}
                    style={{
                      width: "100%",
                      borderColor: isCurrentDriverOnline ? "rgba(239, 68, 68, 0.4)" : "rgba(16, 185, 129, 0.4)",
                      color: isCurrentDriverOnline ? "#f87171" : "#34d399",
                    }}
                    onClick={async () => {
                      const next = !isCurrentDriverOnline;
                      setDriverOnlineMap((prev) => ({ ...prev, [selectedDriverId]: next }));
                      try {
                        const res = await fetch("/api/driver/shift", {
                          method: "POST",
                          headers: {
                            "Content-Type": "application/json",
                            ...getAuthHeader("DRIVER"),
                            "x-actor-role": "DRIVER",
                            "x-actor-id": selectedDriverId,
                          },
                          body: JSON.stringify({ isOnline: next }),
                        });
                        const data = await res.json();
                        if (data.statuses) {
                          setDriverOnlineMap(data.statuses);
                        }
                        const driverName = actors?.drivers.find((d) => d.driver_id === selectedDriverId)?.full_name || selectedDriverId;
                        showBanner(`${driverName}'s shift is now ${next ? "ONLINE" : "OFFLINE"}`);
                      } catch (err: any) {
                        showBanner(`Failed to update shift: ${err.message}`, "danger");
                      }
                    }}
                  >
                    Toggle Shift: {isCurrentDriverOnline ? "Go Offline" : "Go Online"}
                  </button>
                </div>
              </div>

              {/* Offers & Active Trip Execution */}
              <div style={{ display: "flex", flexDirection: "column", gap: "1.5rem" }}>
                {/* Incoming Dispatch Offer Alert Modal/Card */}
                {pendingOffer && (
                  <div
                    className={styles.card}
                    style={{ border: "2px solid var(--accent-amber)", background: "rgba(245, 158, 11, 0.08)" }}
                  >
                    <div className={styles.cardHeader}>
                      <div className={styles.cardTitle} style={{ color: "#fbbf24" }}>
                        <span>🔔</span> Incoming Ride Dispatch Offer!
                      </div>
                      <span className={`${styles.badge} ${styles.badgeWarning}`}>Pending Driver Acceptance</span>
                    </div>

                    <p style={{ fontSize: "0.9rem", marginBottom: 12 }}>
                      A rider has requested a trip within your dispatch radius!
                    </p>
                    <div style={{ background: "rgba(0,0,0,0.3)", padding: 12, borderRadius: 8, marginBottom: 16 }}>
                      <p style={{ fontSize: "0.85rem", marginBottom: 6 }}>
                        <strong>Booking Ref:</strong> <code style={{ color: "#38bdf8", fontWeight: 700 }}>{formatBookingRef(pendingOffer.trip_id)}</code>
                      </p>
                      <p style={{ fontSize: "0.85rem", marginBottom: 6 }}>
                        <strong>Pickup:</strong> <span style={{ color: "#34d399", fontWeight: 600 }}>{getLocationLabel(pendingOffer.pickup_lat, pendingOffer.pickup_lng)}</span>
                      </p>
                      <p style={{ fontSize: "0.85rem", margin: 0 }}>
                        <strong>Dropoff:</strong> <span style={{ color: "#38bdf8", fontWeight: 600 }}>{getLocationLabel(pendingOffer.dropoff_lat, pendingOffer.dropoff_lng)}</span>
                      </p>
                    </div>

                    <div style={{ display: "flex", gap: 12 }}>
                      <button
                        className={styles.btnPrimary}
                        style={{ background: "linear-gradient(135deg, #10b981, #059669)" }}
                        onClick={() => handleOfferResponse(pendingOffer.offer_id, true)}
                      >
                        ✓ Accept Dispatch
                      </button>
                      <button
                        className={styles.btnDanger}
                        onClick={() => handleOfferResponse(pendingOffer.offer_id, false)}
                      >
                        ✕ Decline
                      </button>
                    </div>
                  </div>
                )}

                {/* Active Trip Execution & State Controls */}
                <div className={styles.card}>
                  <div className={styles.cardHeader}>
                    <div className={styles.cardTitle}>
                      <span>📋</span> Active Dispatch Workflow
                    </div>
                    {driverActiveTrip ? (
                      <span className={`${styles.badge} ${styles.badgeInfo}`}>{driverActiveTrip.current_state}</span>
                    ) : (
                      <span className={`${styles.badge} ${styles.badgeSuccess}`}>Available for Dispatch</span>
                    )}
                  </div>

                  {driverActiveTrip ? (
                    <div>
                      <div style={{ background: "rgba(0,0,0,0.25)", padding: "0.85rem 1rem", borderRadius: 8, marginBottom: "1rem" }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                          <span style={{ fontSize: "0.85rem", color: "var(--text-muted)" }}>
                            Booking Ref: <strong style={{ color: "#38bdf8" }}>{formatBookingRef(driverActiveTrip.trip_id)}</strong>
                          </span>
                          <span className={`${styles.badge} ${styles.badgeSuccess}`}>
                            Verified Rider
                          </span>
                        </div>
                      </div>

                      {/* Step-by-Step Simulation & Workflow Progression */}
                      <div style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: "1rem" }}>
                        {/* STATE 1: MATCHED -> En route to pickup */}
                        {driverActiveTrip.current_state === "MATCHED" && (
                          <div style={{ background: "rgba(0,0,0,0.3)", padding: "1rem", borderRadius: 8 }}>
                            <div style={{ marginBottom: 12, fontSize: "0.88rem" }}>
                              <span style={{ color: "var(--text-muted)" }}>Heading to Pickup: </span>
                              <strong style={{ color: "#34d399" }}>
                                {getLocationLabel(driverActiveTrip.pickup_lat, driverActiveTrip.pickup_lng)}
                              </strong>
                            </div>

                            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                              <button
                                className={styles.btnPrimary}
                                style={{ background: "linear-gradient(135deg, var(--accent-blue), var(--accent-cyan))" }}
                                onClick={() => startTransitSimulation("TO_PICKUP")}
                              >
                                🚗 Start Drive to Pickup (Simulation)
                              </button>

                              <button
                                className={styles.btnPrimary}
                                style={{ background: "linear-gradient(135deg, #10b981, #059669)" }}
                                onClick={() => handleTransition("ARRIVED")}
                              >
                                🚖 Confirm Arrival at Pickup
                              </button>
                            </div>
                          </div>
                        )}

                        {/* STATE 2: ARRIVED -> Rider boarding */}
                        {driverActiveTrip.current_state === "ARRIVED" && (
                          <div style={{ background: "rgba(0,0,0,0.3)", padding: "1rem", borderRadius: 8 }}>
                            <p style={{ fontSize: "0.88rem", marginBottom: 12, color: "#34d399" }}>
                              📍 Arrived at pickup location. Waiting for rider to board vehicle.
                            </p>
                            <button className={styles.btnPrimary} onClick={() => handleTransition("IN_PROGRESS")}>
                              ▶️ Rider Boarded — Start Trip
                            </button>
                          </div>
                        )}

                        {/* STATE 3: IN_PROGRESS -> En route to dropoff */}
                        {driverActiveTrip.current_state === "IN_PROGRESS" && (
                          <div style={{ background: "rgba(0,0,0,0.3)", padding: "1rem", borderRadius: 8 }}>
                            <div style={{ marginBottom: 12, fontSize: "0.88rem" }}>
                              <span style={{ color: "var(--text-muted)" }}>Heading to Destination: </span>
                              <strong style={{ color: "#38bdf8" }}>
                                {getLocationLabel(driverActiveTrip.dropoff_lat, driverActiveTrip.dropoff_lng)}
                              </strong>
                            </div>

                            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                              <button
                                className={styles.btnPrimary}
                                style={{ background: "linear-gradient(135deg, var(--accent-blue), var(--accent-indigo))" }}
                                onClick={() => startTransitSimulation("TO_DROPOFF")}
                              >
                                🏁 Start Drive to Destination (Simulation)
                              </button>

                              <button
                                className={styles.btnPrimary}
                                style={{ background: "linear-gradient(135deg, #10b981, #059669)" }}
                                onClick={() => handleTransition("COMPLETED")}
                              >
                                🏁 Complete Trip & Settle Fare
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  ) : (
                    <p style={{ color: "var(--text-muted)", fontSize: "0.85rem" }}>
                      No active trip currently dispatched to this driver. Switch to the Rider tab to request a trip!
                    </p>
                  )}
                </div>
              </div>
            </div>
          )
        )}

        {/* =======================================================
            VIEW 3: ADMIN & OPERATIONS CONSOLE
        ======================================================= */}
        {activeTab === "OPS" && (
          !authenticatedSessions[selectedStaffId] ? (
            renderLoginCard("OPS_STAFF", selectedStaffId)
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: "1.5rem" }}>
              {/* Staff Header Badge */}
              <div className={styles.card} style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <div>
                  <h2 style={{ fontSize: "1.2rem", fontWeight: 700 }}>Internal Operations & Safety Console</h2>
                  <p style={{ fontSize: "0.85rem", color: "var(--text-muted)", marginTop: 4 }}>
                    Active Officer: <strong>{actors?.opsStaff.find((s) => s.staff_id === selectedStaffId)?.full_name || "Marcus Vance"}</strong> • Role:{" "}
                    <span className={`${styles.badge} ${styles.badgeInfo}`} style={{ fontWeight: 600 }}>
                      {formatStaffRole(actors?.opsStaff.find((s) => s.staff_id === selectedStaffId)?.role || "SAFETY_INVESTIGATOR")}
                    </span>{" "}
                    • <span style={{ color: "#34d399", fontWeight: 600 }}>FIDO2 Authenticated</span>
                  </p>
                </div>

                {/* Sub-nav tabs */}
                <div className={styles.tabNav}>
                  <button
                    className={`${styles.tabButton} ${opsSubTab === "ANOMALIES" ? styles.tabActive : ""}`}
                    onClick={() => setOpsSubTab("ANOMALIES")}
                  >
                    ⚡ Telemetry Anomalies ({anomalies.length})
                  </button>
                  <button
                    className={`${styles.tabButton} ${opsSubTab === "ONBOARDING" ? styles.tabActive : ""}`}
                    onClick={() => setOpsSubTab("ONBOARDING")}
                  >
                    🪪 Driver Onboarding & PII ({onboardingDrivers.length})
                  </button>
                  <button
                    className={`${styles.tabButton} ${opsSubTab === "INCIDENTS" ? styles.tabActive : ""}`}
                    onClick={() => setOpsSubTab("INCIDENTS")}
                  >
                    🎫 Safety Incidents ({incidents.length})
                  </button>
                </div>
              </div>

              {/* Panel A: Telemetry Anomalies */}
              {opsSubTab === "ANOMALIES" && (
                <div className={styles.card}>
                  <div className={styles.cardHeader}>
                    <div className={styles.cardTitle}>
                      <span>🛰️</span> GPS Telemetry Anomaly Audit Log
                    </div>
                    <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                      <span className={`${styles.badge} ${styles.badgeDanger}`}>Kalman Velocity Filter</span>
                      {anomalies.length > 0 && (
                        <button
                          className={styles.btnSecondary}
                          style={{ fontSize: "0.75rem", padding: "4px 8px" }}
                          onClick={handleClearAnomalies}
                        >
                          🗑️ Clear Anomaly Log
                        </button>
                      )}
                    </div>
                  </div>

                  {anomalies.length > 0 ? (
                    <div className={styles.tableContainer}>
                      <table className={styles.table}>
                        <thead>
                          <tr>
                            <th>Telemetry ID</th>
                            <th>Driver</th>
                            <th>Calculated Velocity</th>
                            <th>Recorded Time</th>
                            <th>Reason / Flagged Trigger</th>
                          </tr>
                        </thead>
                        <tbody>
                          {anomalies.map((a) => {
                            const driver = actors?.drivers.find((d) => d.driver_id === a.driver_id);
                            return (
                              <tr key={a.telemetry_id}>
                                <td style={{ fontFamily: "monospace", fontSize: "0.78rem" }}>{a.telemetry_id}</td>
                                <td>
                                  <strong>{driver ? driver.full_name : a.driver_id}</strong>
                                  <div style={{ fontSize: "0.74rem", color: "var(--text-muted)" }}>
                                    {driver ? `${driver.make} ${driver.model} • ${driver.license_plate}` : a.driver_id}
                                  </div>
                                </td>
                                <td style={{ color: "#fb7185", fontWeight: 700 }}>{a.velocity_kmh} km/h</td>
                                <td style={{ fontSize: "0.78rem", color: "var(--text-muted)" }}>{a.recorded_at}</td>
                                <td style={{ fontSize: "0.8rem", color: "#fda4af" }}>{a.anomaly_reason}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <p style={{ color: "var(--text-muted)", fontSize: "0.85rem" }}>
                      No telemetry anomalies logged. Go to the Driver tab and click &quot;Simulate Spoofed GPS Jump&quot; to test!
                    </p>
                  )}
                </div>
              )}

              {/* Panel B: Driver Onboarding & PII */}
              {opsSubTab === "ONBOARDING" && (
                <div className={styles.card}>
                  <div className={styles.cardHeader}>
                    <div className={styles.cardTitle}>
                      <span>🪪</span> Driver Background-Check Queue & Encrypted PII
                    </div>
                    <span className={`${styles.badge} ${styles.badgeSuccess}`}>KMS AES-256-GCM Enclave</span>
                  </div>

                  <div className={styles.tableContainer}>
                    <table className={styles.table}>
                      <thead>
                        <tr>
                          <th>Driver</th>
                          <th>License</th>
                          <th>Vehicle</th>
                          <th>Status</th>
                          <th>Encrypted SSN (KMS Enclave)</th>
                          <th>Action</th>
                        </tr>
                      </thead>
                      <tbody>
                        {onboardingDrivers.map((d) => (
                          <tr key={d.driver_id}>
                            <td>
                              <strong>{d.full_name}</strong>
                              <div style={{ fontSize: "0.72rem", color: "var(--text-dim)" }}>{d.contact_phone}</div>
                            </td>
                            <td>{d.license_number}</td>
                            <td>{d.make} {d.model}</td>
                            <td>
                              <span
                                className={`${styles.badge} ${d.onboarding_status === "APPROVED" ? styles.badgeSuccess : styles.badgeWarning
                                  }`}
                              >
                                {d.onboarding_status}
                              </span>
                            </td>
                            <td style={{ fontFamily: "monospace", fontSize: "0.7rem", color: "#a5b4fc" }}>
                              {d.encrypted_ssn ? d.encrypted_ssn.substring(0, 32) + "..." : "--"}
                            </td>
                            <td>
                              {d.onboarding_status !== "APPROVED" ? (
                                <button
                                  className={styles.btnSecondary}
                                  style={{ background: "rgba(16, 185, 129, 0.2)", color: "#34d399" }}
                                  onClick={() => handleApproveDriver(d.check_id)}
                                >
                                  Approve & Clear
                                </button>
                              ) : (
                                <span style={{ color: "#34d399", fontSize: "0.8rem" }}>Cleared ✓</span>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* Panel C: Safety Incidents */}
              {opsSubTab === "INCIDENTS" && (
                <div className={styles.card}>
                  <div className={styles.cardHeader}>
                    <div className={styles.cardTitle}>
                      <span>🎫</span> Disputed Trips & Safety Investigations
                    </div>
                    <span className={`${styles.badge} ${styles.badgeWarning}`}>Internal Support Tooling</span>
                  </div>

                  <div className={styles.tableContainer}>
                    <table className={styles.table}>
                      <thead>
                        <tr>
                          <th>Incident ID</th>
                          <th>Booking Ref</th>
                          <th>Category</th>
                          <th>Status</th>
                          <th>Details</th>
                          <th>Assigned Investigator</th>
                          <th>Action</th>
                        </tr>
                      </thead>
                      <tbody>
                        {incidents.map((inc) => (
                          <tr key={inc.incident_id}>
                            <td style={{ fontFamily: "monospace" }}>{inc.incident_id}</td>
                            <td style={{ fontFamily: "monospace", fontWeight: 600, color: "#38bdf8" }}>{formatBookingRef(inc.trip_id)}</td>
                            <td>
                              <span className={`${styles.badge} ${styles.badgeDanger}`}>{inc.category}</span>
                            </td>
                            <td>
                              <span
                                className={`${styles.badge} ${inc.status === "RESOLVED" ? styles.badgeSuccess : styles.badgeWarning
                                  }`}
                              >
                                {inc.status}
                              </span>
                            </td>
                            <td style={{ fontSize: "0.8rem", maxWidth: 320 }}>{inc.details}</td>
                            <td>{inc.assigned_staff_name || "Marcus Vance"}</td>
                            <td>
                              {inc.status !== "RESOLVED" && (
                                <button
                                  className={styles.btnSecondary}
                                  onClick={() => handleResolveIncident(inc.incident_id)}
                                >
                                  Mark Resolved
                                </button>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          )
        )}
      </main>
    </div>
  );
}
