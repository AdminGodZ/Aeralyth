\set ON_ERROR_STOP on
BEGIN;
CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
SELECT pg_advisory_xact_lock(hashtextextended('aeralyth:migration:027-flexible-retention-and-vault-lock', 0));
SELECT NOT EXISTS (
  SELECT 1 FROM schema_migrations WHERE version = '027-flexible-retention-and-vault-lock'
) AS apply_migration \gset
\if :apply_migration

ALTER TABLE users ADD COLUMN trash_retention_minutes INTEGER;
UPDATE users SET trash_retention_minutes = trash_retention_days * 1440;
ALTER TABLE users
  ALTER COLUMN trash_retention_minutes SET DEFAULT 43200,
  ALTER COLUMN trash_retention_minutes SET NOT NULL,
  ADD CONSTRAINT users_trash_retention_minutes_check CHECK (trash_retention_minutes BETWEEN 1 AND 525600),
  DROP CONSTRAINT users_trash_retention_days_check,
  ADD CONSTRAINT users_trash_retention_days_check CHECK (trash_retention_days BETWEEN 1 AND 365),
  DROP CONSTRAINT users_vault_auto_lock_minutes_check,
  ADD CONSTRAINT users_vault_auto_lock_minutes_check CHECK (vault_auto_lock_minutes IN (0, 5, 15, 30, 60));

-- Keep older writers compatible during pre-deploy. Rounding up prevents an old
-- expiry worker from deleting an item earlier than its minute-based deadline.
CREATE FUNCTION sync_trash_retention_units() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.trash_retention_minutes = 43200 AND NEW.trash_retention_days <> 30 THEN
      NEW.trash_retention_minutes := NEW.trash_retention_days * 1440;
    ELSE
      NEW.trash_retention_days := CEIL(NEW.trash_retention_minutes / 1440.0)::integer;
    END IF;
  ELSIF NEW.trash_retention_minutes IS DISTINCT FROM OLD.trash_retention_minutes THEN
    NEW.trash_retention_days := CEIL(NEW.trash_retention_minutes / 1440.0)::integer;
  ELSIF NEW.trash_retention_days IS DISTINCT FROM OLD.trash_retention_days THEN
    NEW.trash_retention_minutes := NEW.trash_retention_days * 1440;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER sync_trash_retention_units BEFORE INSERT OR UPDATE OF trash_retention_days, trash_retention_minutes
ON users FOR EACH ROW EXECUTE FUNCTION sync_trash_retention_units();

DROP TRIGGER notify_aeralyth_trash_retention_users ON users;
CREATE TRIGGER notify_aeralyth_trash_retention_users
AFTER UPDATE OF trash_retention_days, trash_retention_minutes ON users
FOR EACH STATEMENT EXECUTE FUNCTION notify_aeralyth_maintenance();

INSERT INTO schema_migrations (version) VALUES ('027-flexible-retention-and-vault-lock');
\else
\echo 'Skipping already-applied migration 027-flexible-retention-and-vault-lock'
\endif
COMMIT;
