#!/usr/bin/env bash
set -euo pipefail

test_database="aeralyth_session_counter_perf_${$}"

cleanup() {
  docker compose exec -T postgres dropdb -U aeralyth --if-exists "${test_database}" >/dev/null
}

trap cleanup EXIT

docker compose exec -T postgres createdb -U aeralyth "${test_database}"

for migration in \
  001_auth.sql \
  002_e2ee.sql \
  003_share_links.sql \
  004_repositories.sql \
  005_repository_metadata.sql \
  006_performance_ledger.sql \
  007_observability.sql \
  008_folder_manifest.sql \
  009_upload_completion.sql
do
  docker compose exec -T postgres psql \
    -q \
    -v ON_ERROR_STOP=1 \
    -U aeralyth \
    -d "${test_database}" \
    -f "/docker-entrypoint-initdb.d/${migration}" >/dev/null
done

docker compose exec -T postgres psql \
  -q \
  -v ON_ERROR_STOP=1 \
  -U aeralyth \
  -d "${test_database}" <<'SQL'
ALTER TABLE sessions DROP CONSTRAINT sessions_token_hash_length;
ALTER TABLE sessions
  ALTER COLUMN token_hash TYPE TEXT
  USING encode(token_hash, 'hex');

INSERT INTO sessions (id, user_id, token_hash, csrf_token, expires_at)
VALUES (
  'ses_legacy_hex',
  'usr_admingod',
  encode(digest('legacy-session-token', 'sha256'), 'hex'),
  'legacy-csrf',
  now() + interval '1 hour'
);

INSERT INTO sessions (id, user_id, token_hash, expires_at)
SELECT
  'ses_legacy_bulk_' || value,
  'usr_admingod',
  encode(digest('legacy-bulk-token-' || value, 'sha256'), 'hex'),
  now() + interval '1 hour'
FROM generate_series(1, 100000) AS value;

ANALYZE sessions;

CREATE TABLE session_migration_metrics (
  metric TEXT PRIMARY KEY,
  value BIGINT NOT NULL
);

INSERT INTO session_migration_metrics (metric, value)
VALUES ('text_index_bytes', pg_relation_size('sessions_token_hash_key'));

DO $benchmark$
DECLARE
  iteration INTEGER;
  started_at TIMESTAMPTZ;
BEGIN
  FOR iteration IN 1..2000 LOOP
    PERFORM id FROM sessions
    WHERE token_hash = encode(digest('legacy-session-token', 'sha256'), 'hex');
  END LOOP;

  started_at := clock_timestamp();
  FOR iteration IN 1..20000 LOOP
    PERFORM id FROM sessions
    WHERE token_hash = encode(digest('legacy-session-token', 'sha256'), 'hex');
  END LOOP;
  INSERT INTO session_migration_metrics (metric, value)
  VALUES (
    'postgres_hash_lookup_microseconds',
    round(extract(epoch FROM clock_timestamp() - started_at) * 1000000)
  );
END
$benchmark$;

DROP TRIGGER users_admin_counter_insert ON users;
DROP TRIGGER users_admin_counter_delete ON users;
DROP TRIGGER users_admin_counter_update ON users;
CREATE TRIGGER users_admin_counter_change
AFTER INSERT OR UPDATE OR DELETE ON users
FOR EACH ROW EXECUTE FUNCTION update_admin_user_counters();

DROP TRIGGER invitations_admin_counter_insert ON invitations;
DROP TRIGGER invitations_admin_counter_delete ON invitations;
DROP TRIGGER invitations_admin_counter_update ON invitations;
CREATE TRIGGER invitations_admin_counter_change
AFTER INSERT OR UPDATE OR DELETE ON invitations
FOR EACH ROW EXECUTE FUNCTION update_admin_invitation_counters();
SQL

for migration in 010_session_performance.sql 011_admin_counter_triggers.sql; do
  docker compose exec -T postgres psql \
    -q \
    -v ON_ERROR_STOP=1 \
    -U aeralyth \
    -d "${test_database}" \
    -f "/docker-entrypoint-initdb.d/${migration}" >/dev/null
done

docker compose exec -T postgres psql \
  -q \
  -v ON_ERROR_STOP=1 \
  -U aeralyth \
  -d "${test_database}" <<'SQL'
ANALYZE sessions;

INSERT INTO session_migration_metrics (metric, value)
VALUES ('bytea_index_bytes', pg_relation_size('sessions_token_hash_key'));

DO $benchmark$
DECLARE
  iteration INTEGER;
  started_at TIMESTAMPTZ;
BEGIN
  FOR iteration IN 1..2000 LOOP
    PERFORM id FROM sessions
    WHERE token_hash = '\x2643f7be36cdfb283688b1a18c0b923661046fee4f997c75b8003ddec10d8c97'::bytea;
  END LOOP;

  started_at := clock_timestamp();
  FOR iteration IN 1..20000 LOOP
    PERFORM id FROM sessions
    WHERE token_hash = '\x2643f7be36cdfb283688b1a18c0b923661046fee4f997c75b8003ddec10d8c97'::bytea;
  END LOOP;
  INSERT INTO session_migration_metrics (metric, value)
  VALUES (
    'rust_hash_lookup_microseconds',
    round(extract(epoch FROM clock_timestamp() - started_at) * 1000000)
  );
END
$benchmark$;
SQL

metrics_state=$(docker compose exec -T postgres psql \
  -qAt \
  -v ON_ERROR_STOP=1 \
  -U aeralyth \
  -d "${test_database}" \
  -c "
    SELECT
      max(value) FILTER (WHERE metric = 'text_index_bytes') || '|' ||
      max(value) FILTER (WHERE metric = 'bytea_index_bytes') || '|' ||
      max(value) FILTER (WHERE metric = 'postgres_hash_lookup_microseconds') || '|' ||
      max(value) FILTER (WHERE metric = 'rust_hash_lookup_microseconds')
    FROM session_migration_metrics;
  ")

IFS='|' read -r text_index_bytes bytea_index_bytes postgres_hash_us rust_hash_us \
  <<< "${metrics_state}"

if (( bytea_index_bytes >= text_index_bytes )); then
  echo "BYTEA token index was not smaller: ${text_index_bytes} -> ${bytea_index_bytes}" >&2
  exit 1
fi

echo "session token benchmark: index ${text_index_bytes} -> ${bytea_index_bytes} bytes; 20k lookups ${postgres_hash_us} -> ${rust_hash_us} us"

legacy_state=$(docker compose exec -T postgres psql \
  -qAt \
  -v ON_ERROR_STOP=1 \
  -U aeralyth \
  -d "${test_database}" \
  -c "
    SELECT count(*)
    FROM sessions
    WHERE id = 'ses_legacy_hex'
      AND token_hash = digest('legacy-session-token', 'sha256');
  ")

if [[ "${legacy_state}" != "1" ]]; then
  echo "legacy hexadecimal session hash was not preserved: ${legacy_state}" >&2
  exit 1
fi

docker compose exec -T postgres psql \
  -q \
  -v ON_ERROR_STOP=1 \
  -U aeralyth \
  -d "${test_database}" \
  < database/tests/session_counter_performance.sql >/dev/null

for migration in 010_session_performance.sql 011_admin_counter_triggers.sql; do
  docker compose exec -T postgres psql \
    -q \
    -v ON_ERROR_STOP=1 \
    -U aeralyth \
    -d "${test_database}" \
    -f "/docker-entrypoint-initdb.d/${migration}" >/dev/null
done

replay_state=$(docker compose exec -T postgres psql \
  -qAt \
  -v ON_ERROR_STOP=1 \
  -U aeralyth \
  -d "${test_database}" \
  -c "
    SELECT
      (SELECT count(*) FROM pg_trigger
       WHERE tgrelid = 'users'::regclass
         AND NOT tgisinternal
         AND tgname = 'users_admin_counter_change') || '|' ||
      (SELECT count(*) FROM pg_trigger
       WHERE tgrelid = 'users'::regclass
         AND NOT tgisinternal
         AND tgname LIKE 'users_admin_counter_%') || '|' ||
      (SELECT count(*) FROM pg_trigger
       WHERE tgrelid = 'invitations'::regclass
         AND NOT tgisinternal
         AND tgname = 'invitations_admin_counter_change') || '|' ||
      (SELECT count(*) FROM pg_trigger
       WHERE tgrelid = 'invitations'::regclass
         AND NOT tgisinternal
         AND tgname LIKE 'invitations_admin_counter_%') || '|' ||
      (SELECT count(*) FROM schema_migrations
       WHERE version IN ('010-session-performance', '011-admin-counter-triggers')) || '|' ||
      (SELECT data_type FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND table_name = 'sessions' AND column_name = 'token_hash') || '|' ||
      (SELECT count(*) FROM pg_indexes
       WHERE schemaname = current_schema()
         AND tablename = 'sessions'
         AND indexname = 'sessions_expiry_cleanup_idx') || '|' ||
      (SELECT count(*) FROM pg_constraint
       WHERE conrelid = 'sessions'::regclass
         AND conname = 'sessions_token_hash_length');
  ")

if [[ "${replay_state}" != "0|3|0|3|2|bytea|1|1" ]]; then
  echo "session/counter migration replay state is incorrect: ${replay_state}" >&2
  exit 1
fi

echo "fresh session and admin-counter performance checks passed"
