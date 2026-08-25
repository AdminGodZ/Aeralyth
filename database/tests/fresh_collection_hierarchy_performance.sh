#!/usr/bin/env bash
set -euo pipefail

test_database="aeralyth_collection_hierarchy_${$}"
scale_rows="${AERALYTH_COLLECTION_SCALE:-100000}"

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
  012_vault_query_performance.sql \
  013_migration_identity_performance.sql \
  014_navigation_hot_paths.sql
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
  -v scale_rows="${scale_rows}" \
  -U aeralyth \
  -d "${test_database}" <<'SQL'
SET synchronous_commit = off;

INSERT INTO users (id, username, password_hash, role, status)
VALUES ('usr_collection_owner', 'collection_owner', 'not-a-login-hash', 'user', 'active');

INSERT INTO files (
  id, owner_id, original_name, storage_name, size_bytes, entry_type
) VALUES (
  'fil_collection_root', 'usr_collection_owner', 'collection-root',
  'collection/root', 0, 'folder'
);

INSERT INTO files (
  id, owner_id, original_name, storage_name, size_bytes, entry_type,
  parent_id, favorite, created_at, updated_at
)
SELECT
  format('fil_collection_%s', lpad(series::text, 8, '0')),
  'usr_collection_owner',
  format('file-%s', lpad(series::text, 8, '0')),
  format('collection/file-%s', lpad(series::text, 8, '0')),
  series,
  'file',
  'fil_collection_root',
  series % 10 = 0,
  timestamptz '2025-01-01 00:00:00+00' + series * interval '1 millisecond',
  timestamptz '2025-01-01 00:00:00+00' + series * interval '1 millisecond'
FROM generate_series(1, :scale_rows::integer) AS series;

INSERT INTO repositories (id, owner_id, root_file_id)
VALUES ('rep_collection_root', 'usr_collection_owner', 'fil_collection_root');

ANALYZE files;

-- Recreate the measured legacy index set so the before/after WAL sample is
-- valid even on a fresh schema whose base migration no longer creates it.
CREATE INDEX files_updated_at_idx ON files(updated_at);
CREATE INDEX files_favorite_idx ON files(favorite);
CREATE INDEX files_recent_owner_idx
  ON files (owner_id, updated_at DESC, id)
  WHERE state = 'active';
SQL

before_plan=$(docker compose exec -T postgres psql \
  -qAt \
  -v ON_ERROR_STOP=1 \
  -U aeralyth \
  -d "${test_database}" \
  -c "EXPLAIN (ANALYZE, WAL, FORMAT JSON) UPDATE files SET favorite = NOT favorite, updated_at = updated_at + interval '1 millisecond' WHERE owner_id = 'usr_collection_owner' AND id BETWEEN 'fil_collection_00000001' AND 'fil_collection_00001000';")

docker compose exec -T postgres psql \
  -q \
  -v ON_ERROR_STOP=1 \
  -U aeralyth \
  -d "${test_database}" \
  -f /docker-entrypoint-initdb.d/015_collection_hierarchy_performance.sql >/dev/null

after_plan=$(docker compose exec -T postgres psql \
  -qAt \
  -v ON_ERROR_STOP=1 \
  -U aeralyth \
  -d "${test_database}" \
  -c "EXPLAIN (ANALYZE, WAL, FORMAT JSON) UPDATE files SET favorite = NOT favorite, updated_at = updated_at + interval '1 millisecond' WHERE owner_id = 'usr_collection_owner' AND id BETWEEN 'fil_collection_00000001' AND 'fil_collection_00001000';")

before_wal=$(jq -r '.[0].Plan["WAL Bytes"] // 0' <<<"${before_plan}")
after_wal=$(jq -r '.[0].Plan["WAL Bytes"] // 0' <<<"${after_plan}")
before_ms=$(jq -r '.[0].Plan["Actual Total Time"]' <<<"${before_plan}")
after_ms=$(jq -r '.[0].Plan["Actual Total Time"]' <<<"${after_plan}")

for migration in \
  018_share_link_token_rotation.sql \
  019_share_link_rollout_compatibility.sql \
  020_share_link_legacy_writer_guard.sql \
  021_compact_account_state.sql \
  022_large_share_commitments.sql \
  023_maintenance_coordination.sql
do
  docker compose exec -T postgres psql \
    -q \
    -v ON_ERROR_STOP=1 \
    -U aeralyth \
    -d "${test_database}" \
    -f "/docker-entrypoint-initdb.d/${migration}" >/dev/null
done

if (( after_wal >= before_wal )); then
  echo "index cleanup did not reduce measured WAL bytes: ${before_wal} -> ${after_wal}" >&2
  exit 1
fi

DATABASE_URL="postgres://aeralyth:aeralyth@127.0.0.1:5432/${test_database}" \
  cargo test \
    --quiet \
    --manifest-path backend/Cargo.toml \
    database_query_contracts_prepare \
    -- \
    --ignored

docker compose exec -T postgres psql \
  -v ON_ERROR_STOP=1 \
  -U aeralyth \
  -d "${test_database}" \
  < database/tests/collection_hierarchy_performance.sql

docker compose exec -T postgres psql \
  -q \
  -v ON_ERROR_STOP=1 \
  -U aeralyth \
  -d "${test_database}" \
  -f /docker-entrypoint-initdb.d/015_collection_hierarchy_performance.sql >/dev/null

replay_state=$(docker compose exec -T postgres psql \
  -qAt \
  -v ON_ERROR_STOP=1 \
  -U aeralyth \
  -d "${test_database}" \
  -c "
    SELECT
      (SELECT count(*) FROM schema_migrations
       WHERE version = '015-collection-hierarchy-performance') || '|' ||
      (SELECT count(*) FROM pg_trigger
       WHERE NOT tgisinternal
         AND tgname IN ('files_hierarchy_insert_guard', 'files_hierarchy_update_guard')) || '|' ||
      (SELECT count(*) FROM pg_class
       WHERE relnamespace = 'public'::regnamespace
         AND relname IN ('files_updated_at_idx', 'files_favorite_idx', 'files_recent_owner_idx'));
  ")

if [[ "${replay_state}" != "1|2|0" ]]; then
  echo "collection hierarchy migration replay state is incorrect: ${replay_state}" >&2
  exit 1
fi

echo "write WAL bytes before/after: ${before_wal}/${after_wal}"
echo "write time ms before/after: ${before_ms}/${after_ms}"
echo "collection hierarchy checks passed at ${scale_rows} rows"
