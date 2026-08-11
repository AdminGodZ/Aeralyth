#!/usr/bin/env bash
set -euo pipefail

test_database="aeralyth_perf_ledger_${$}"

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
  006_performance_ledger.sql
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
  -d "${test_database}" \
  < database/tests/performance_ledger.sql >/dev/null

docker compose exec -T postgres psql \
  -q \
  -v ON_ERROR_STOP=1 \
  -U aeralyth \
  -d "${test_database}" \
  -f /docker-entrypoint-initdb.d/001_auth.sql >/dev/null

base_replay_trigger_state=$(docker compose exec -T postgres psql \
  -qAt \
  -v ON_ERROR_STOP=1 \
  -U aeralyth \
  -d "${test_database}" \
  -c "
    SELECT
      count(*) FILTER (WHERE tgname = 'files_counter_change') || '|' ||
      count(*) FILTER (WHERE tgname LIKE 'files_counter_%_statement')
    FROM pg_trigger
    WHERE tgrelid = 'files'::regclass AND NOT tgisinternal;
  ")

if [[ "${base_replay_trigger_state}" != "0|3" ]]; then
  echo "base migration replay reintroduced row accounting: ${base_replay_trigger_state}" >&2
  exit 1
fi

for migration in \
  002_e2ee.sql \
  003_share_links.sql \
  004_repositories.sql \
  005_repository_metadata.sql \
  006_performance_ledger.sql
do
  docker compose exec -T postgres psql \
    -q \
    -v ON_ERROR_STOP=1 \
    -U aeralyth \
    -d "${test_database}" \
    -f "/docker-entrypoint-initdb.d/${migration}" >/dev/null
done

trigger_state=$(docker compose exec -T postgres psql \
  -qAt \
  -v ON_ERROR_STOP=1 \
  -U aeralyth \
  -d "${test_database}" \
  -c "
    SELECT
      count(*) FILTER (WHERE tgname = 'files_counter_change') || '|' ||
      count(*) FILTER (WHERE tgname LIKE 'files_counter_%_statement') || '|' ||
      (SELECT count(*) FROM schema_migrations WHERE version = '006-performance-ledger')
    FROM pg_trigger
    WHERE tgrelid = 'files'::regclass AND NOT tgisinternal;
  ")

if [[ "${trigger_state}" != "0|3|1" ]]; then
  echo "migration replay did not preserve the statement-level accounting triggers: ${trigger_state}" >&2
  exit 1
fi

docker compose exec -T postgres psql \
  -q \
  -v ON_ERROR_STOP=1 \
  -U aeralyth \
  -d "${test_database}" \
  < database/tests/performance_ledger.sql >/dev/null

echo "fresh performance ledger migration checks passed"
