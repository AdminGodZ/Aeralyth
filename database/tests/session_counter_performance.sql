\set ON_ERROR_STOP on

BEGIN;

DO $schema_assertions$
BEGIN
  IF (
    SELECT data_type
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'sessions'
      AND column_name = 'token_hash'
  ) <> 'bytea' THEN
    RAISE EXCEPTION 'sessions.token_hash is not BYTEA';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'sessions_token_hash_length'
      AND conrelid = 'sessions'::regclass
      AND convalidated
  ) THEN
    RAISE EXCEPTION 'fixed-width session-token constraint is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_indexes
    WHERE schemaname = current_schema()
      AND tablename = 'sessions'
      AND indexname = 'sessions_expiry_cleanup_idx'
      AND indexdef LIKE '%(expires_at, id)%'
  ) THEN
    RAISE EXCEPTION 'session expiry keyset index is missing';
  END IF;
END
$schema_assertions$;

INSERT INTO sessions (id, user_id, token_hash, csrf_token, expires_at)
VALUES (
  'ses_perf_active_' || pg_backend_pid()::text,
  'usr_admingod',
  digest('active-session-' || pg_backend_pid()::text, 'sha256'),
  'active-csrf',
  now() + interval '1 hour'
);

INSERT INTO sessions (id, user_id, token_hash, expires_at)
SELECT
  'ses_perf_expired_' || pg_backend_pid()::text || '_' || value,
  'usr_admingod',
  digest('expired-session-' || pg_backend_pid()::text || '-' || value, 'sha256'),
  now() - interval '1 day' - (value * interval '1 microsecond')
FROM generate_series(1, 1000000) AS value;

ANALYZE sessions;

DO $plan_assertion$
DECLARE
  cleanup_plan JSON;
BEGIN
  EXECUTE $explain$
    EXPLAIN (FORMAT JSON, COSTS OFF)
    SELECT id
    FROM sessions
    WHERE expires_at <= now()
    ORDER BY expires_at, id
    LIMIT 1000
    FOR UPDATE SKIP LOCKED
  $explain$
  INTO cleanup_plan;

  IF cleanup_plan::text NOT LIKE '%sessions_expiry_cleanup_idx%' THEN
    RAISE EXCEPTION 'expiry batch does not use the cleanup index: %', cleanup_plan;
  END IF;
END
$plan_assertion$;

CREATE TEMP TABLE session_cleanup_result (
  deleted_sessions BIGINT NOT NULL
) ON COMMIT DROP;

WITH expired AS (
  SELECT id
  FROM sessions
  WHERE expires_at <= now()
  ORDER BY expires_at, id
  LIMIT 1000
  FOR UPDATE SKIP LOCKED
), deleted AS (
  DELETE FROM sessions
  USING expired
  WHERE sessions.id = expired.id
  RETURNING sessions.id
)
INSERT INTO session_cleanup_result (deleted_sessions)
SELECT count(*) FROM deleted;

DO $batch_assertions$
BEGIN
  IF (SELECT deleted_sessions FROM session_cleanup_result) <> 1000 THEN
    RAISE EXCEPTION 'expiry cleanup did not delete exactly 1000 rows';
  END IF;
  IF (SELECT count(*) FROM sessions WHERE expires_at <= now()) <> 999000 THEN
    RAISE EXCEPTION 'expiry cleanup was not bounded to one keyset batch';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM sessions
    WHERE id = 'ses_perf_active_' || pg_backend_pid()::text
  ) THEN
    RAISE EXCEPTION 'expiry cleanup removed an active session';
  END IF;
END
$batch_assertions$;

CREATE TEMP TABLE admin_counter_writes (
  captured_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
) ON COMMIT DROP;

CREATE FUNCTION pg_temp.capture_admin_counter_write()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $capture$
BEGIN
  INSERT INTO admin_counter_writes DEFAULT VALUES;
  RETURN NULL;
END
$capture$;

CREATE TRIGGER test_admin_counter_writes
AFTER UPDATE ON admin_directory_counters
FOR EACH ROW EXECUTE FUNCTION pg_temp.capture_admin_counter_write();

SELECT
  'usr_counter_perf_' || pg_backend_pid()::text AS counter_user_id,
  'counter_perf_' || pg_backend_pid()::text AS counter_username,
  'inv_counter_perf_' || pg_backend_pid()::text AS counter_invitation_id
\gset

INSERT INTO users (id, username, password_hash, role, status)
VALUES (:'counter_user_id', :'counter_username', 'not-a-login-hash', 'user', 'active');
TRUNCATE admin_counter_writes;

UPDATE users
SET display_name = 'Profile-only update',
    theme_preference = 'dark',
    accent_color = '#112233',
    updated_at = now()
WHERE id = :'counter_user_id';

DO $profile_assertion$
BEGIN
  IF EXISTS (SELECT 1 FROM admin_counter_writes) THEN
    RAISE EXCEPTION 'profile-only update rewrote admin_directory_counters';
  END IF;
END
$profile_assertion$;

UPDATE users SET role = 'admin' WHERE id = :'counter_user_id';
DO $role_assertion$
BEGIN
  IF (SELECT count(*) FROM admin_counter_writes) <> 1 THEN
    RAISE EXCEPTION 'active role contribution change did not write exactly once';
  END IF;
END
$role_assertion$;
TRUNCATE admin_counter_writes;

UPDATE users
SET role = role, status = status
WHERE id = :'counter_user_id';
DO $unchanged_role_assertion$
BEGIN
  IF EXISTS (SELECT 1 FROM admin_counter_writes) THEN
    RAISE EXCEPTION 'unchanged role/status rewrote admin_directory_counters';
  END IF;
END
$unchanged_role_assertion$;

UPDATE users SET status = 'disabled' WHERE id = :'counter_user_id';
DO $status_assertion$
BEGIN
  IF (SELECT count(*) FROM admin_counter_writes) <> 1 THEN
    RAISE EXCEPTION 'status contribution change did not write exactly once';
  END IF;
END
$status_assertion$;
TRUNCATE admin_counter_writes;

UPDATE users SET role = 'user' WHERE id = :'counter_user_id';
DO $disabled_role_assertion$
BEGIN
  IF EXISTS (SELECT 1 FROM admin_counter_writes) THEN
    RAISE EXCEPTION 'disabled-user role update rewrote admin_directory_counters';
  END IF;
END
$disabled_role_assertion$;

INSERT INTO invitations (
  id, invited_username, role, token_hash, status, created_by, expires_at
) VALUES (
  :'counter_invitation_id',
  :'counter_username' || '_invite',
  'user',
  encode(digest(:'counter_invitation_id', 'sha256'), 'hex'),
  'pending',
  'usr_admingod',
  now() + interval '1 day'
);
TRUNCATE admin_counter_writes;

UPDATE invitations
SET expires_at = expires_at + interval '1 hour'
WHERE id = :'counter_invitation_id';
UPDATE invitations
SET status = status
WHERE id = :'counter_invitation_id';

DO $pending_unchanged_assertion$
BEGIN
  IF EXISTS (SELECT 1 FROM admin_counter_writes) THEN
    RAISE EXCEPTION 'pending-to-pending invitation update rewrote admin_directory_counters';
  END IF;
END
$pending_unchanged_assertion$;

UPDATE invitations SET status = 'revoked' WHERE id = :'counter_invitation_id';
DO $pending_exit_assertion$
BEGIN
  IF (SELECT count(*) FROM admin_counter_writes) <> 1 THEN
    RAISE EXCEPTION 'pending invitation exit did not write exactly once';
  END IF;
END
$pending_exit_assertion$;
TRUNCATE admin_counter_writes;

UPDATE invitations SET status = 'accepted' WHERE id = :'counter_invitation_id';
DO $nonpending_assertion$
BEGIN
  IF EXISTS (SELECT 1 FROM admin_counter_writes) THEN
    RAISE EXCEPTION 'nonpending invitation transition rewrote admin_directory_counters';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM admin_directory_counters AS counters
    WHERE counters.total_users <> (SELECT count(*) FROM users WHERE status <> 'deleting')
       OR counters.active_users <> (SELECT count(*) FROM users WHERE status = 'active')
       OR counters.active_admins <> (
         SELECT count(*) FROM users WHERE status = 'active' AND role = 'admin'
       )
       OR counters.pending_invitations <> (
         SELECT count(*) FROM invitations WHERE status = 'pending'
       )
  ) THEN
    RAISE EXCEPTION 'admin directory counters drifted from source rows';
  END IF;
END
$nonpending_assertion$;

ROLLBACK;
