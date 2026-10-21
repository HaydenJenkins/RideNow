import { NextResponse } from "next/server";
import { getCoreDb } from "@/lib/db/core-db";
import { getGeoDb } from "@/lib/db/geo-db";

export async function GET() {
  const coreDb = getCoreDb();
  const geoDb = getGeoDb();

  const riders = coreDb.prepare("SELECT rider_id, full_name, email, contact_phone, customer_payment_token FROM Rider").all();
  const rawDrivers: any[] = coreDb.prepare(`
    SELECT d.driver_id, d.full_name, d.onboarding_status, d.contact_phone, v.make, v.model, v.license_plate
    FROM Driver d
    LEFT JOIN Vehicle v ON d.driver_id = v.driver_id
    WHERE d.onboarding_status = 'APPROVED'
  `).all();

  const liveLocations: any[] = geoDb.prepare("SELECT driver_id, is_online FROM DriverLiveLocation").all();
  const onlineMap = new Map<string, boolean>();
  for (const loc of liveLocations) {
    onlineMap.set(loc.driver_id, Boolean(loc.is_online));
  }

  const drivers = rawDrivers.map((d) => ({
    ...d,
    is_online: onlineMap.has(d.driver_id) ? onlineMap.get(d.driver_id)! : true,
  }));

  const opsStaff = coreDb.prepare("SELECT staff_id, full_name, email, role FROM OpsStaff").all();
  const geofences = geoDb.prepare("SELECT * FROM SurgeGeofence").all();

  return NextResponse.json({
    riders,
    drivers,
    opsStaff,
    geofences,
  });
}
