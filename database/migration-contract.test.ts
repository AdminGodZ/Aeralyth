import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migrationRoot = resolve(import.meta.dirname, "init");

describe.each([
  ["001_auth.sql", "001-auth"],
  ["002_e2ee.sql", "002-e2ee"],
  ["008_folder_manifest.sql", "008-folder-manifest"],
  ["009_upload_completion.sql", "009-upload-completion"],
  ["018_share_link_token_rotation.sql", "018-share-link-token-rotation"],
  [
    "019_share_link_rollout_compatibility.sql",
    "019-share-link-rollout-compatibility",
  ],
  [
    "020_share_link_legacy_writer_guard.sql",
    "020-share-link-legacy-writer-guard",
  ],
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

describe("share-token rolling-deployment compatibility", () => {
  it("keeps omitted legacy-writer versions at zero throughout the migration chain", () => {
    const rotation = readFileSync(
      resolve(migrationRoot, "018_share_link_token_rotation.sql"),
      "utf8",
    );
    const compatibility = readFileSync(
      resolve(migrationRoot, "019_share_link_rollout_compatibility.sql"),
      "utf8",
    );

    expect(rotation).toContain("ALTER COLUMN token_version SET DEFAULT 0");
    expect(rotation).not.toContain("ALTER COLUMN token_version SET DEFAULT 1");
    expect(compatibility).toContain("ALTER COLUMN token_version SET DEFAULT 0");
  });

  it("blocks an old writer from changing a versioned token without advancing it", () => {
    const guard = readFileSync(
      resolve(migrationRoot, "020_share_link_legacy_writer_guard.sql"),
      "utf8",
    );

    expect(guard).toContain("OLD.token_version >= 1");
    expect(guard).toContain("NEW.token_hash IS DISTINCT FROM OLD.token_hash");
    expect(guard).toContain("NEW.token_version = OLD.token_version");
    expect(guard).toContain(
      "BEFORE UPDATE OF token_hash, token_version ON share_links",
    );
  });
});
