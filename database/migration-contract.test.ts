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
  ["024_one_password_auth.sql", "024-one-password-auth"],
  ["025_trash_retention.sql", "025-trash-retention"],
  ["026_realtime_changes.sql", "026-realtime-changes"],
  [
    "027_flexible_retention_and_vault_lock.sql",
    "027-flexible-retention-and-vault-lock",
  ],
  ["037_bounded_hierarchy_updates.sql", "037-bounded-hierarchy-updates"],
  [
    "038_quiet_maintenance_notifications.sql",
    "038-quiet-maintenance-notifications",
  ],
  ["039_trashed_parent_child_counts.sql", "039-trashed-parent-child-counts"],
  [
    "041_incremental_repository_counts.sql",
    "041-incremental-repository-counts",
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

describe("one-password authentication migration", () => {
  it("keeps legacy users valid while requiring a fixed salt for migrated users", () => {
    const migration = readFileSync(
      resolve(migrationRoot, "024_one_password_auth.sql"),
      "utf8",
    );

    expect(migration).toContain(
      "ADD COLUMN IF NOT EXISTS auth_version SMALLINT NOT NULL DEFAULT 0",
    );
    expect(migration).toContain("auth_version = 0 AND auth_kdf_salt IS NULL");
    expect(migration).toContain(
      "auth_version = 1 AND octet_length(auth_kdf_salt) = 16",
    );
  });

  it.each([
    "fresh_navigation_hot_paths.sh",
    "fresh_collection_hierarchy_performance.sh",
    "fresh_bounded_tree_operations.sh",
  ])(
    "updates the schema used by current backend query contracts in %s",
    (fileName) => {
      const fixture = readFileSync(
        resolve(import.meta.dirname, "tests", fileName),
        "utf8",
      );
      const migration = fixture.indexOf("024_one_password_auth.sql");
      const queryContracts = fixture.indexOf(
        "database_query_contracts_prepare",
      );

      expect(migration).toBeGreaterThan(-1);
      expect(queryContracts).toBeGreaterThan(migration);
    },
  );
});

describe("trash retention migration", () => {
  it("limits the preference and wakes bounded background cleanup", () => {
    const migration = readFileSync(
      resolve(migrationRoot, "025_trash_retention.sql"),
      "utf8",
    );

    expect(migration).toContain(
      "trash_retention_days INTEGER NOT NULL DEFAULT 30",
    );
    expect(migration).toContain("trash_retention_days IN (1, 7, 30, 60)");
    expect(migration).toContain("files_trashed_retention_idx");
    expect(migration).toContain("notify_aeralyth_maintenance()");
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
