\set ON_ERROR_STOP on

BEGIN;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

SELECT pg_advisory_xact_lock(hashtextextended('aeralyth:migration:025-trash-retention', 0));

SELECT NOT EXISTS (
  SELECT 1 FROM schema_migrations WHERE version = '025-trash-retention'
) AS apply_migration \gset

\if :apply_migration

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS trash_retention_days INTEGER NOT NULL DEFAULT 30;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'users_trash_retention_days_check'
      AND conrelid = 'users'::regclass
  ) THEN
    ALTER TABLE users
      ADD CONSTRAINT users_trash_retention_days_check
      CHECK (trash_retention_days IN (1, 7, 30, 60));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS files_trashed_retention_idx
  ON files (trashed_at, id)
  WHERE state = 'trashed' AND trashed_at IS NOT NULL;

DROP TRIGGER IF EXISTS notify_aeralyth_trash_retention_file_insert ON files;
CREATE TRIGGER notify_aeralyth_trash_retention_file_insert
AFTER INSERT ON files
FOR EACH STATEMENT EXECUTE FUNCTION notify_aeralyth_maintenance();

DROP TRIGGER IF EXISTS notify_aeralyth_trash_retention_file_update ON files;
CREATE TRIGGER notify_aeralyth_trash_retention_file_update
AFTER UPDATE OF state, trashed_at ON files
FOR EACH STATEMENT EXECUTE FUNCTION notify_aeralyth_maintenance();

DROP TRIGGER IF EXISTS notify_aeralyth_trash_retention_users ON users;
CREATE TRIGGER notify_aeralyth_trash_retention_users
AFTER UPDATE OF trash_retention_days ON users
FOR EACH STATEMENT EXECUTE FUNCTION notify_aeralyth_maintenance();

INSERT INTO schema_migrations (version)
VALUES ('025-trash-retention');

\else
\echo 'Skipping already-applied migration 025-trash-retention'
\endif

COMMIT;
