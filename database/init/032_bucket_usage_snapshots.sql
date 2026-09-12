\set ON_ERROR_STOP on

BEGIN;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

SELECT pg_advisory_xact_lock(hashtextextended('aeralyth:migration:032-bucket-usage-snapshots', 0));

SELECT NOT EXISTS (
  SELECT 1 FROM schema_migrations
  WHERE version = '032-bucket-usage-snapshots'
) AS apply_migration \gset

\if :apply_migration

-- Complete physical samples survive API restarts and are shared across replicas.
-- In-progress totals are separate and can never replace a complete sample until
-- the final provider page has been checkpointed by the current fenced worker.
CREATE TABLE bucket_usage_snapshots (
  namespace TEXT PRIMARY KEY,
  used_bytes BIGINT NOT NULL DEFAULT 0 CHECK (used_bytes >= 0),
  object_count BIGINT NOT NULL DEFAULT 0 CHECK (object_count >= 0),
  measured_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  scan_token TEXT,
  scan_used_bytes BIGINT NOT NULL DEFAULT 0 CHECK (scan_used_bytes >= 0),
  scan_object_count BIGINT NOT NULL DEFAULT 0 CHECK (scan_object_count >= 0),
  scan_pages BIGINT NOT NULL DEFAULT 0 CHECK (scan_pages >= 0),
  scan_token_hashes TEXT[] NOT NULL DEFAULT '{}' CHECK (cardinality(scan_token_hashes) <= 64),
  scan_started_at TIMESTAMPTZ,
  lease_token TEXT,
  lease_until TIMESTAMPTZ,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  failed BOOLEAN NOT NULL DEFAULT false,
  CHECK ((lease_token IS NULL) = (lease_until IS NULL)),
  CHECK ((measured_at IS NULL) = (completed_at IS NULL))
);

INSERT INTO schema_migrations (version) VALUES ('032-bucket-usage-snapshots');

\else
\echo 'Skipping already-applied migration 032-bucket-usage-snapshots'
\endif

COMMIT;
