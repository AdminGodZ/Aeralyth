#!/usr/bin/env bash
set -euo pipefail

test_database="aeralyth_folder_manifest_${$}"

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
  008_folder_manifest.sql
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
  < database/tests/folder_manifest.sql >/dev/null

docker compose exec -T postgres psql \
  -q \
  -v ON_ERROR_STOP=1 \
  -U aeralyth \
  -d "${test_database}" \
  -f /docker-entrypoint-initdb.d/008_folder_manifest.sql >/dev/null

contract_state=$(docker compose exec -T postgres psql \
  -qAt \
  -v ON_ERROR_STOP=1 \
  -U aeralyth \
  -d "${test_database}" \
  -c "
    SELECT
      (SELECT count(*) FROM schema_migrations
       WHERE version = '008-folder-manifest') || '|' ||
      (SELECT count(*) FROM pg_indexes
       WHERE indexname = 'files_active_folder_sibling_name_unique_idx') || '|' ||
      (SELECT count(*) FROM pg_proc
       WHERE proname = 'ensure_legacy_folder_level');
  ")

if [[ "${contract_state}" != "1|1|1" ]]; then
  echo "fresh folder-manifest contract is incomplete: ${contract_state}" >&2
  exit 1
fi

echo "fresh folder manifest migration checks passed"
