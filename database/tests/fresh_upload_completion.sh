#!/usr/bin/env bash
set -euo pipefail

test_database="aeralyth_upload_completion_${$}"

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
  -d "${test_database}" \
  -f /docker-entrypoint-initdb.d/009_upload_completion.sql >/dev/null

contract_state=$(docker compose exec -T postgres psql \
  -qAt \
  -v ON_ERROR_STOP=1 \
  -U aeralyth \
  -d "${test_database}" \
  -c "
    SELECT
      (SELECT count(*) FROM schema_migrations
       WHERE version = '009-upload-completion') || '|' ||
      (SELECT count(*) FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'file_uploads'
         AND column_name IN (
           'completion_attempts',
           'completion_available_at',
           'completion_locked_until',
           'completion_last_error',
           'completion_checksum_sha256',
           'completion_etag',
           'completion_verified_at'
         )) || '|' ||
      (SELECT count(*) FROM pg_indexes
       WHERE schemaname = 'public'
         AND indexname = 'file_uploads_completion_jobs_idx');
  ")

if [[ "${contract_state}" != "1|7|1" ]]; then
  echo "fresh upload-completion contract is incomplete: ${contract_state}" >&2
  exit 1
fi

echo "fresh upload completion migration checks passed"
