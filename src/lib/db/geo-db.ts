import Database from "better-sqlite3";
import path from "path";
import fs from "fs";

const DATA_DIR = path.resolve(process.cwd(), "data");
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const DB_PATH = path.join(DATA_DIR, "geo_dispatch.db");

// Singleton connection to Real-Time Geo-Index & In-Flight Dispatch Store
let geoDbInstance: Database.Database | null = null;

export function getGeoDb(): Database.Database {
  if (!geoDbInstance) {
    geoDbInstance = new Database(DB_PATH);
    geoDbInstance.pragma("journal_mode = WAL");
    geoDbInstance.pragma("synchronous = NORMAL");
    geoDbInstance.pragma("busy_timeout = 5000");
  }
  return geoDbInstance;
}

export default getGeoDb;
