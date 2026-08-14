import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migrationRoot = resolve(import.meta.dirname, "init");

describe.each([
  ["001_auth.sql", "001-auth"],
  ["002_e2ee.sql", "002-e2ee"],
  ["008_folder_manifest.sql", "008-folder-manifest"],
])("%s", (fileName, version) => {
  const migration = readFileSync(resolve(migrationRoot, fileName), "utf8");

  it("is guarded by the immutable migration ledger", () => {
    const guardStart = migration.indexOf("\\if :apply_migration");
    const guardEnd = migration.indexOf("\\endif");

    expect(migration).toContain("BEGIN;");
    expect(migration).toContain("pg_advisory_xact_lock");
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS schema_migrations");
    expect(migration).toContain(`WHERE version = '${version}'`);
    expect(migration).toContain(`VALUES ('${version}')`);
    expect(guardStart).toBeGreaterThan(-1);
    expect(guardEnd).toBeGreaterThan(guardStart);
    expect(migration.trimEnd().endsWith("COMMIT;")).toBe(true);
  });
});
