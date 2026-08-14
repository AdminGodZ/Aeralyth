-- Durable, single-claimant reconciliation state for legacy object completion.

\set ON_ERROR_STOP on

BEGIN;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

SELECT pg_advisory_xact_lock(hashtextextended('aeralyth:migration:009-upload-completion', 0));

SELECT NOT EXISTS (
  SELECT 1 FROM schema_migrations WHERE version = '009-upload-completion'
) AS apply_migration \gset

\if :apply_migration

ALTER TABLE file_uploads
  ADD COLUMN completion_attempts INTEGER NOT NULL DEFAULT 0
    CHECK (completion_attempts >= 0),
  ADD COLUMN completion_available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN completion_locked_until TIMESTAMPTZ,
  ADD COLUMN completion_last_error TEXT,
  ADD COLUMN completion_checksum_sha256 TEXT,
  ADD COLUMN completion_etag TEXT,
  ADD COLUMN completion_verified_at TIMESTAMPTZ;

CREATE INDEX file_uploads_completion_jobs_idx
  ON file_uploads (completion_available_at, id)
  WHERE status = 'completing';

INSERT INTO schema_migrations (version)
VALUES ('009-upload-completion');

\else
\echo 'Skipping already-applied migration 009-upload-completion'
\endif

COMMIT;
