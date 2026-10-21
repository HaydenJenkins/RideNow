import Database from "better-sqlite3";
import path from "path";
import fs from "fs";

const DATA_DIR = path.resolve(process.cwd(), "data");
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const DB_PATH = path.join(DATA_DIR, "core_operations.db");

// Singleton connection to Trip History & Core Operations Database
let coreDbInstance: Database.Database | null = null;

export function getCoreDb(): Database.Database {
  if (!coreDbInstance) {
    coreDbInstance = new Database(DB_PATH);
    coreDbInstance.pragma("journal_mode = WAL");
    coreDbInstance.pragma("foreign_keys = ON");
    coreDbInstance.pragma("busy_timeout = 5000");
  }
  return coreDbInstance;
}

export default getCoreDb;
