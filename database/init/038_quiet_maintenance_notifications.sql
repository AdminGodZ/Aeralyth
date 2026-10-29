\set ON_ERROR_STOP on
BEGIN;
CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
SELECT pg_advisory_xact_lock(hashtextextended('aeralyth:migration:038-quiet-maintenance-notifications', 0));
SELECT NOT EXISTS (
  SELECT 1 FROM schema_migrations WHERE version = '038-quiet-maintenance-notifications'
) AS apply_migration \gset
\if :apply_migration

-- Each notifying commit takes PostgreSQL's cluster-wide notify lock. Workers
-- also wake at the earliest stored deadline, so a notification only matters
-- when a change can make work due sooner than the worker already plans.
-- Pushing a deadline later cannot, and lease renewals do it on every presign.
-- An optional second argument names that deadline column. The first argument
-- then excludes it. EXCEPT still avoids joining unindexed transition tables.
-- Every changed deadline moved later exactly when the earliest new value is no
-- earlier than the latest old one. That bound is exact for single-row
-- renewals and conservative for larger statements.
CREATE OR REPLACE FUNCTION notify_aeralyth_maintenance()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE scheduling_changed BOOLEAN;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM maintenance_new) THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    -- TG_ARGV comes only from the trigger declarations, never a request.
    EXECUTE format(
      'SELECT EXISTS (SELECT %s FROM maintenance_new EXCEPT SELECT %s FROM maintenance_old)',
      TG_ARGV[0], TG_ARGV[0]
    ) INTO scheduling_changed;
    IF NOT scheduling_changed AND TG_NARGS > 1 THEN
      -- The rest of the projection, including id, is unchanged, so both
      -- difference sets cover the same rows. NULL deadlines always notify.
      EXECUTE format(
        'WITH moved AS MATERIALIZED (
           SELECT id, %1$I AS deadline FROM maintenance_new
           EXCEPT SELECT id, %1$I FROM maintenance_old
         ), previous AS MATERIALIZED (
           SELECT id, %1$I AS deadline FROM maintenance_old
           EXCEPT SELECT id, %1$I FROM maintenance_new
         )
         SELECT NOT coalesce(
           (SELECT count(*) = count(deadline) FROM moved)
           AND (SELECT count(*) = count(deadline) FROM previous)
           AND (SELECT min(deadline) FROM moved) >= (SELECT max(deadline) FROM previous),
           NOT EXISTS (SELECT 1 FROM moved)
         )',
        TG_ARGV[1]
      ) INTO scheduling_changed;
    END IF;
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
    ('file_uploads', 'id, status, completion_available_at, completion_locked_until, completion_dead_lettered_at'),
    ('vault_uploads', 'id, status'),
    ('invitations', 'id, status'),
    ('sessions', 'id')
  ) AS targets(table_name, projection)
  LOOP
    EXECUTE format('DROP TRIGGER notify_aeralyth_maintenance_update ON %I', target.table_name);
    EXECUTE format('CREATE TRIGGER notify_aeralyth_maintenance_update AFTER UPDATE ON %I
      REFERENCING OLD TABLE AS maintenance_old NEW TABLE AS maintenance_new FOR EACH STATEMENT
      EXECUTE FUNCTION notify_aeralyth_maintenance(%L, %L)',
      target.table_name, target.projection, 'expires_at');
  END LOOP;
END;
$$;

-- No maintenance worker consumes tree operation notifications. A new job only
-- adds fences, so it can never make maintenance work due sooner.
DROP TRIGGER notify_aeralyth_maintenance ON tree_operation_jobs;

INSERT INTO schema_migrations (version) VALUES ('038-quiet-maintenance-notifications');
\else
\echo 'Skipping already-applied migration 038-quiet-maintenance-notifications'
\endif
COMMIT;
