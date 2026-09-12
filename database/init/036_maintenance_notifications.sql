\set ON_ERROR_STOP on
BEGIN;
CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
SELECT pg_advisory_xact_lock(hashtextextended('aeralyth:migration:036-maintenance-notifications', 0));
SELECT NOT EXISTS (
  SELECT 1 FROM schema_migrations WHERE version = '036-maintenance-notifications'
) AS apply_migration \gset
\if :apply_migration

-- Statement triggers also run for empty UPDATE/INSERT statements. Empty worker
-- claims must not notify the worker again and cancel its idle backoff forever.
-- Each trigger supplies a narrow scheduling projection, including the row key,
-- so no-op updates and unrelated metadata changes are silent as well. EXCEPT
-- compares the transition sets without joining their unindexed row identities.
CREATE OR REPLACE FUNCTION notify_aeralyth_maintenance()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE scheduling_changed BOOLEAN;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM maintenance_new) THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    -- TG_ARGV comes only from the trigger declarations below, never a request.
    EXECUTE format(
      'SELECT EXISTS (SELECT %s FROM maintenance_new EXCEPT SELECT %s FROM maintenance_old)',
      TG_ARGV[0], TG_ARGV[0]
    ) INTO scheduling_changed;
    IF NOT scheduling_changed THEN
      RETURN NULL;
    END IF;
  END IF;
  PERFORM pg_notify('aeralyth_maintenance', TG_TABLE_NAME);
  RETURN NULL;
END;
$$;

DO $$
DECLARE target RECORD;
BEGIN
  FOR target IN SELECT * FROM (VALUES
    ('user_deletion_jobs', 'user_id, phase, available_at, locked_until, dead_lettered_at'),
    ('storage_deletion_jobs', 'id, available_at, locked_until, dead_lettered_at'),
    ('file_uploads', 'id, status, expires_at, completion_available_at, completion_locked_until, completion_dead_lettered_at'),
    ('vault_uploads', 'id, status, expires_at'),
    ('invitations', 'id, status, expires_at'),
    ('sessions', 'id, expires_at')
  ) AS targets(table_name, projection)
  LOOP
    EXECUTE format('DROP TRIGGER notify_aeralyth_maintenance ON %I', target.table_name);
    EXECUTE format('CREATE TRIGGER notify_aeralyth_maintenance_insert AFTER INSERT ON %I
      REFERENCING NEW TABLE AS maintenance_new FOR EACH STATEMENT
      EXECUTE FUNCTION notify_aeralyth_maintenance()', target.table_name);
    EXECUTE format('CREATE TRIGGER notify_aeralyth_maintenance_update AFTER UPDATE ON %I
      REFERENCING OLD TABLE AS maintenance_old NEW TABLE AS maintenance_new FOR EACH STATEMENT
      EXECUTE FUNCTION notify_aeralyth_maintenance(%L)', target.table_name, target.projection);
  END LOOP;
END;
$$;

DROP TRIGGER notify_aeralyth_trash_retention_file_insert ON files;
CREATE TRIGGER notify_aeralyth_trash_retention_file_insert AFTER INSERT ON files
REFERENCING NEW TABLE AS maintenance_new FOR EACH STATEMENT
EXECUTE FUNCTION notify_aeralyth_maintenance();
DROP TRIGGER notify_aeralyth_trash_retention_file_update ON files;
CREATE TRIGGER notify_aeralyth_trash_retention_file_update AFTER UPDATE ON files
REFERENCING OLD TABLE AS maintenance_old NEW TABLE AS maintenance_new FOR EACH STATEMENT
EXECUTE FUNCTION notify_aeralyth_maintenance('id, owner_id, state, trashed_at, trash_child_count = 0');

DROP TRIGGER notify_aeralyth_trash_retention_users ON users;
CREATE TRIGGER notify_aeralyth_trash_retention_users AFTER UPDATE ON users
REFERENCING OLD TABLE AS maintenance_old NEW TABLE AS maintenance_new FOR EACH STATEMENT
EXECUTE FUNCTION notify_aeralyth_maintenance('id, trash_retention_minutes');

DROP TRIGGER notify_aeralyth_maintenance ON tree_operation_jobs;
CREATE TRIGGER notify_aeralyth_maintenance AFTER INSERT ON tree_operation_jobs
REFERENCING NEW TABLE AS maintenance_new FOR EACH STATEMENT
EXECUTE FUNCTION notify_aeralyth_maintenance();

INSERT INTO schema_migrations (version) VALUES ('036-maintenance-notifications');
\else
\echo 'Skipping already-applied migration 036-maintenance-notifications'
\endif
COMMIT;
