\set ON_ERROR_STOP on

BEGIN;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

SELECT pg_advisory_xact_lock(hashtextextended('aeralyth:migration:023-maintenance-coordination', 0));

SELECT NOT EXISTS (
  SELECT 1 FROM schema_migrations
  WHERE version = '023-maintenance-coordination'
) AS apply_migration \gset

\if :apply_migration

ALTER TABLE storage_deletion_jobs
  ADD COLUMN IF NOT EXISTS lease_token TEXT,
  ADD COLUMN IF NOT EXISTS dead_lettered_at TIMESTAMPTZ;

ALTER TABLE user_deletion_jobs
  ADD COLUMN IF NOT EXISTS lease_token TEXT,
  ADD COLUMN IF NOT EXISTS dead_lettered_at TIMESTAMPTZ;

ALTER TABLE file_uploads
  ADD COLUMN IF NOT EXISTS completion_lease_token TEXT,
  ADD COLUMN IF NOT EXISTS completion_dead_lettered_at TIMESTAMPTZ;

DROP INDEX IF EXISTS storage_deletion_jobs_available_idx;
CREATE INDEX storage_deletion_jobs_available_idx
  ON storage_deletion_jobs (available_at, locked_until, id)
  WHERE dead_lettered_at IS NULL;

DROP INDEX IF EXISTS user_deletion_jobs_available_idx;
CREATE INDEX user_deletion_jobs_available_idx
  ON user_deletion_jobs (available_at, locked_until, created_at)
  WHERE dead_lettered_at IS NULL;

DROP INDEX IF EXISTS file_uploads_completion_jobs_idx;
CREATE INDEX file_uploads_completion_jobs_idx
  ON file_uploads (completion_available_at, completion_locked_until, id)
  WHERE status = 'completing' AND completion_dead_lettered_at IS NULL;

CREATE OR REPLACE FUNCTION notify_aeralyth_maintenance()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM pg_notify('aeralyth_maintenance', TG_TABLE_NAME);
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS notify_aeralyth_maintenance ON user_deletion_jobs;
CREATE TRIGGER notify_aeralyth_maintenance
AFTER INSERT OR UPDATE ON user_deletion_jobs
FOR EACH STATEMENT EXECUTE FUNCTION notify_aeralyth_maintenance();

DROP TRIGGER IF EXISTS notify_aeralyth_maintenance ON storage_deletion_jobs;
CREATE TRIGGER notify_aeralyth_maintenance
AFTER INSERT OR UPDATE ON storage_deletion_jobs
FOR EACH STATEMENT EXECUTE FUNCTION notify_aeralyth_maintenance();

DROP TRIGGER IF EXISTS notify_aeralyth_maintenance ON file_uploads;
CREATE TRIGGER notify_aeralyth_maintenance
AFTER INSERT OR UPDATE ON file_uploads
FOR EACH STATEMENT EXECUTE FUNCTION notify_aeralyth_maintenance();

DROP TRIGGER IF EXISTS notify_aeralyth_maintenance ON vault_uploads;
CREATE TRIGGER notify_aeralyth_maintenance
AFTER INSERT OR UPDATE ON vault_uploads
FOR EACH STATEMENT EXECUTE FUNCTION notify_aeralyth_maintenance();

DROP TRIGGER IF EXISTS notify_aeralyth_maintenance ON invitations;
CREATE TRIGGER notify_aeralyth_maintenance
AFTER INSERT OR UPDATE ON invitations
FOR EACH STATEMENT EXECUTE FUNCTION notify_aeralyth_maintenance();

DROP TRIGGER IF EXISTS notify_aeralyth_maintenance ON sessions;
CREATE TRIGGER notify_aeralyth_maintenance
AFTER INSERT OR UPDATE ON sessions
FOR EACH STATEMENT EXECUTE FUNCTION notify_aeralyth_maintenance();

INSERT INTO schema_migrations (version)
VALUES ('023-maintenance-coordination');

\else
\echo 'Skipping already-applied migration 023-maintenance-coordination'
\endif

COMMIT;
