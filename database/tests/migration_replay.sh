#!/usr/bin/env bash
set -euo pipefail

test_database="aeralyth_migration_replay_${$}"

cleanup() {
  docker compose exec -T postgres dropdb -U aeralyth --if-exists "${test_database}" >/dev/null
}

trap cleanup EXIT

docker compose exec -T postgres createdb -U aeralyth "${test_database}"

for migration in 001_auth.sql 002_e2ee.sql; do
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
CREATE TABLE migration_replay_writes (
  relation_name TEXT NOT NULL,
  operation TEXT NOT NULL
);

CREATE FUNCTION record_migration_replay_write()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO migration_replay_writes (relation_name, operation)
  VALUES (TG_TABLE_NAME, TG_OP);
  RETURN NULL;
END;
$$;

DO $audit$
DECLARE
  relation_name TEXT;
BEGIN
  FOREACH relation_name IN ARRAY ARRAY[
    'users',
    'files',
    'file_shares',
    'file_uploads',
    'invitations',
    'user_file_counters',
    'admin_directory_counters',
    'storage_deletion_jobs'
  ]
  LOOP
    EXECUTE format(
      'CREATE TRIGGER migration_replay_write_audit '
      'AFTER INSERT OR UPDATE OR DELETE ON %I '
      'FOR EACH STATEMENT EXECUTE FUNCTION record_migration_replay_write()',
      relation_name
    );
  END LOOP;
END
$audit$;
SQL

for migration in 001_auth.sql 002_e2ee.sql; do
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
      (SELECT count(*) FROM migration_replay_writes) || '|' ||
      (SELECT count(*) FROM schema_migrations
       WHERE version IN ('001-auth', '002-e2ee'));
  ")

if [[ "${replay_state}" != "0|2" ]]; then
  echo "migration replay changed application rows or lost ledger state: ${replay_state}" >&2
  exit 1
fi

echo "migration replay regression checks passed"
