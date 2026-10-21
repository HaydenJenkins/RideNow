import { NextRequest, NextResponse } from "next/server";
import { getGeoDb } from "@/lib/db/geo-db";
import { KmsVault } from "@/lib/security/kms";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ tripId: string }> }
) {
  const { tripId } = await params;
  const geoDb = getGeoDb();

  let record: any = geoDb
    .prepare("SELECT * FROM TripAssignmentTokenRecord WHERE trip_id = ? AND is_revoked = 0")
    .get(tripId);

  if (!record) {
    return NextResponse.json({ error: "No assignment token found for trip" }, { status: 404 });
  }

  // If raw_token is missing, mint a valid cryptographic token string for this record
  let rawToken = record.raw_token;
  if (!rawToken) {
    const mint = KmsVault.mintTripAssignmentToken({
      trip_id: record.trip_id,
      rider_id: record.rider_id,
      driver_id: record.driver_id,
      route_hash: record.route_hash,
    });
    rawToken = mint.token;
    geoDb.prepare("UPDATE TripAssignmentTokenRecord SET raw_token = ? WHERE token_id = ?").run(rawToken, record.token_id);
    record.raw_token = rawToken;
  }

  return NextResponse.json({
    tokenRecord: record,
    token: rawToken,
    mitigation: "L2-24: Cryptographically signed Trip Assignment Token",
  });
}

export async function POST(req: NextRequest) {
  try {
    const { token } = await req.json();
    const result = KmsVault.verifyTripAssignmentToken(token);
    return NextResponse.json(result);
  } catch (err: any) {
    return NextResponse.json({ valid: false, error: err.message }, { status: 400 });
  }
}
