#!/usr/bin/env bash
set -euo pipefail

test_database="aeralyth_migration_progress_bulk_${$}"
pg_exec() {
  if [[ -n "${PG_CONTAINER:-}" ]]; then
    docker exec -i "${PG_CONTAINER}" "$@"
  else
    docker compose exec -T postgres "$@"
  fi
}
psql_test() {
  pg_exec psql -X -q -v ON_ERROR_STOP=1 -U aeralyth -d "${test_database}" "$@"
}
cleanup() {
  pg_exec dropdb -U aeralyth --if-exists --force "${test_database}" >/dev/null
}
trap cleanup EXIT

# An optional immutable 001-027 template only shortens setup. Every current
# migration from 028 onward is still applied, including interacting triggers.
if [[ -n "${MIGRATION_TEST_TEMPLATE:-}" ]]; then
  pg_exec createdb -U aeralyth -T "${MIGRATION_TEST_TEMPLATE}" "${test_database}"
else
  pg_exec createdb -U aeralyth "${test_database}"
fi
for migration in database/init/[0-9][0-9][0-9]_*.sql; do
  if [[ -n "${MIGRATION_TEST_TEMPLATE:-}" && "${migration##*/}" < '028_' ]]; then
    continue
  fi
  echo "Applying ${migration##*/}"
  psql_test < "${migration}" >/dev/null
done
psql_test < database/tests/hierarchy_updates.sql
psql_test < database/tests/migration_progress_bulk.sql
echo 'fresh full-chain migration progress bulk regression passed'
