\set ON_ERROR_STOP on

DO $production_preflight$
DECLARE
  active_admin_count BIGINT;
BEGIN
  SELECT count(*)
  INTO active_admin_count
  FROM users
  WHERE status = 'active'
    AND role = 'admin';

  IF active_admin_count = 0 THEN
    RAISE EXCEPTION 'production requires a restored active administrator account';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM users
    WHERE status = 'active'
      AND password_hash = crypt('admingod', password_hash)
  ) THEN
    RAISE EXCEPTION 'production refuses to start while an account uses the local seed password';
  END IF;
END
$production_preflight$;
