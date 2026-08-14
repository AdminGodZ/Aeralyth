#!/usr/bin/env bash
set -euo pipefail

test_database="aeralyth_migration_identity_perf_${$}"

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
  009_upload_completion.sql \
  010_session_performance.sql \
  011_admin_counter_triggers.sql \
  012_vault_query_performance.sql
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
DROP INDEX users_username_ci_idx;
DROP INDEX files_e2ee_migration_claim_idx;
DROP INDEX vault_migrations_incomplete_owner_idx;
DROP INDEX vault_migrations_cleanup_object_idx;
SQL

docker compose exec -T postgres psql \
  -q \
  -v ON_ERROR_STOP=1 \
  -U aeralyth \
  -d "${test_database}" \
  -f /docker-entrypoint-initdb.d/013_migration_identity_performance.sql >/dev/null

docker compose exec -T postgres psql \
  -q \
  -v ON_ERROR_STOP=1 \
  -U aeralyth \
  -d "${test_database}" \
  < database/tests/migration_identity_performance.sql >/dev/null

for migration in 001_auth.sql 002_e2ee.sql 013_migration_identity_performance.sql
do
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
      (SELECT count(*) FROM schema_migrations
       WHERE version = '013-migration-identity-performance') || '|' ||
      (SELECT count(*) FROM pg_index
       INNER JOIN pg_class AS indexes ON indexes.oid = pg_index.indexrelid
       WHERE indexes.relname IN (
         'users_username_ci_idx',
         'files_e2ee_migration_claim_idx',
         'vault_migrations_incomplete_owner_idx',
         'vault_migrations_cleanup_object_idx'
       )
         AND pg_index.indisvalid) || '|' ||
      (SELECT count(*) FROM pg_index
       INNER JOIN pg_class AS indexes ON indexes.oid = pg_index.indexrelid
       WHERE indexes.relname = 'users_username_ci_idx'
         AND pg_index.indisunique);
  ")

if [[ "${replay_state}" != "1|4|1" ]]; then
  echo "migration/identity performance replay state is incorrect: ${replay_state}" >&2
  exit 1
fi

echo "fresh migration and identity performance checks passed"
