import fs from "fs";
import path from "path";
import { getCoreDb } from "./core-db";
import { getGeoDb } from "./geo-db";

export function runMigrations() {
  console.log("🚀 Starting database schema migrations for RideNow...");

  const migrationsDir = path.resolve(process.cwd(), "src/lib/db/migrations");
  const coreDb = getCoreDb();
  const geoDb = getGeoDb();

  // 1. Ensure migrations tracking table exists in Core DB
  coreDb.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // 2. Ensure migrations tracking table exists in Geo DB
  geoDb.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // 3. Apply Core Migrations
  const coreMigrationFile = path.join(migrationsDir, "001_core_schema.sql");
  const coreMigrationName = "001_core_schema.sql";
  const coreAlreadyApplied = coreDb
    .prepare("SELECT 1 FROM _migrations WHERE name = ?")
    .get(coreMigrationName);

  if (!coreAlreadyApplied) {
    console.log(`📦 Applying Core migration: ${coreMigrationName}...`);
    const sql = fs.readFileSync(coreMigrationFile, "utf-8");
    coreDb.exec(sql);
    coreDb
      .prepare("INSERT INTO _migrations (name) VALUES (?)")
      .run(coreMigrationName);
    console.log(`✅ Applied ${coreMigrationName} to Core Operations DB`);
  } else {
    console.log(`⏭️ Core migration ${coreMigrationName} already applied.`);
  }

  // 3b. Apply Auth Credentials Migration to Core DB
  const authMigrationFile = path.join(migrationsDir, "003_auth_credentials.sql");
  const authMigrationName = "003_auth_credentials.sql";
  const authAlreadyApplied = coreDb
    .prepare("SELECT 1 FROM _migrations WHERE name = ?")
    .get(authMigrationName);

  if (!authAlreadyApplied) {
    console.log(`📦 Applying Auth Credentials migration: ${authMigrationName}...`);
    const sql = fs.readFileSync(authMigrationFile, "utf-8");
    coreDb.exec(sql);
    coreDb
      .prepare("INSERT INTO _migrations (name) VALUES (?)")
      .run(authMigrationName);
    console.log(`✅ Applied ${authMigrationName} to Core Operations DB`);
  } else {
    console.log(`⏭️ Core migration ${authMigrationName} already applied.`);
  }

  // 4. Apply Geo Migrations
  const geoMigrationFile = path.join(migrationsDir, "002_geo_schema.sql");
  const geoMigrationName = "002_geo_schema.sql";
  const geoAlreadyApplied = geoDb
    .prepare("SELECT 1 FROM _migrations WHERE name = ?")
    .get(geoMigrationName);

  if (!geoAlreadyApplied) {
    console.log(`📦 Applying Geo migration: ${geoMigrationName}...`);
    const sql = fs.readFileSync(geoMigrationFile, "utf-8");
    geoDb.exec(sql);
    geoDb
      .prepare("INSERT INTO _migrations (name) VALUES (?)")
      .run(geoMigrationName);
    console.log(`✅ Applied ${geoMigrationName} to Real-Time Geo-Index DB`);
  } else {
    console.log(`⏭️ Geo migration ${geoMigrationName} already applied.`);
  }

  console.log("✨ All migrations completed successfully!");
}

if (require.main === module || process.argv[1]?.endsWith("migrate.ts")) {
  try {
    runMigrations();
    process.exit(0);
  } catch (error) {
    console.error("❌ Migration failed:", error);
    process.exit(1);
  }
}
