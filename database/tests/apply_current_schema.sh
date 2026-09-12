#!/usr/bin/env bash
set -euo pipefail

# Historical migration benchmarks keep their original schemas until measurements
# finish. Current backend query-contract tests then need every current migration.
test_database="${1:?test database is required}"
case "${test_database}" in
  aeralyth_*) ;;
  *) echo 'Current-schema contract setup requires a dedicated test database' >&2; exit 1 ;;
esac
for migration in database/init/[0-9][0-9][0-9]_*.sql; do
  docker compose exec -T postgres psql -Xq -v ON_ERROR_STOP=1 -U aeralyth \
    -d "${test_database}" -f "/docker-entrypoint-initdb.d/$(basename "${migration}")" >/dev/null
done
