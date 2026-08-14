-- Prevent unrelated user and invitation updates from touching the global counter row.

\set ON_ERROR_STOP on

BEGIN;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

SELECT pg_advisory_xact_lock(hashtextextended('aeralyth:migration:011-admin-counter-triggers', 0));

SELECT NOT EXISTS (
  SELECT 1 FROM schema_migrations WHERE version = '011-admin-counter-triggers'
) AS apply_migration \gset

\if :apply_migration

CREATE OR REPLACE FUNCTION update_admin_user_counters()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  old_total BIGINT := 0;
  new_total BIGINT := 0;
  old_active BIGINT := 0;
  new_active BIGINT := 0;
  old_admin BIGINT := 0;
  new_admin BIGINT := 0;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    old_total := CASE WHEN OLD.status <> 'deleting' THEN 1 ELSE 0 END;
    old_active := CASE WHEN OLD.status = 'active' THEN 1 ELSE 0 END;
    old_admin := CASE WHEN OLD.status = 'active' AND OLD.role = 'admin' THEN 1 ELSE 0 END;
  END IF;

  IF TG_OP <> 'DELETE' THEN
    new_total := CASE WHEN NEW.status <> 'deleting' THEN 1 ELSE 0 END;
    new_active := CASE WHEN NEW.status = 'active' THEN 1 ELSE 0 END;
    new_admin := CASE WHEN NEW.status = 'active' AND NEW.role = 'admin' THEN 1 ELSE 0 END;
  END IF;

  IF old_total = new_total
     AND old_active = new_active
     AND old_admin = new_admin THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  UPDATE admin_directory_counters
  SET total_users = GREATEST(0, total_users + new_total - old_total),
      active_users = GREATEST(0, active_users + new_active - old_active),
      active_admins = GREATEST(0, active_admins + new_admin - old_admin),
      updated_at = now()
  WHERE singleton = TRUE;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS users_admin_counter_change ON users;
DROP TRIGGER IF EXISTS users_admin_counter_insert ON users;
DROP TRIGGER IF EXISTS users_admin_counter_delete ON users;
DROP TRIGGER IF EXISTS users_admin_counter_update ON users;
CREATE TRIGGER users_admin_counter_insert
AFTER INSERT ON users
FOR EACH ROW EXECUTE FUNCTION update_admin_user_counters();
CREATE TRIGGER users_admin_counter_delete
AFTER DELETE ON users
FOR EACH ROW EXECUTE FUNCTION update_admin_user_counters();
CREATE TRIGGER users_admin_counter_update
AFTER UPDATE OF role, status ON users
FOR EACH ROW
WHEN (
  ROW(
    OLD.status <> 'deleting',
    OLD.status = 'active',
    OLD.status = 'active' AND OLD.role = 'admin'
  ) IS DISTINCT FROM ROW(
    NEW.status <> 'deleting',
    NEW.status = 'active',
    NEW.status = 'active' AND NEW.role = 'admin'
  )
)
EXECUTE FUNCTION update_admin_user_counters();

CREATE OR REPLACE FUNCTION update_admin_invitation_counters()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  old_pending BIGINT := 0;
  new_pending BIGINT := 0;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    old_pending := CASE WHEN OLD.status = 'pending' THEN 1 ELSE 0 END;
  END IF;

  IF TG_OP <> 'DELETE' THEN
    new_pending := CASE WHEN NEW.status = 'pending' THEN 1 ELSE 0 END;
  END IF;

  IF old_pending = new_pending THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  UPDATE admin_directory_counters
  SET pending_invitations = GREATEST(
        0,
        pending_invitations + new_pending - old_pending
      ),
      updated_at = now()
  WHERE singleton = TRUE;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS invitations_admin_counter_change ON invitations;
DROP TRIGGER IF EXISTS invitations_admin_counter_insert ON invitations;
DROP TRIGGER IF EXISTS invitations_admin_counter_delete ON invitations;
DROP TRIGGER IF EXISTS invitations_admin_counter_update ON invitations;
CREATE TRIGGER invitations_admin_counter_insert
AFTER INSERT ON invitations
FOR EACH ROW EXECUTE FUNCTION update_admin_invitation_counters();
CREATE TRIGGER invitations_admin_counter_delete
AFTER DELETE ON invitations
FOR EACH ROW EXECUTE FUNCTION update_admin_invitation_counters();
CREATE TRIGGER invitations_admin_counter_update
AFTER UPDATE OF status ON invitations
FOR EACH ROW
WHEN ((OLD.status = 'pending') IS DISTINCT FROM (NEW.status = 'pending'))
EXECUTE FUNCTION update_admin_invitation_counters();

INSERT INTO schema_migrations (version)
VALUES ('011-admin-counter-triggers');

\else
\echo 'Skipping already-applied migration 011-admin-counter-triggers'
\endif

COMMIT;
