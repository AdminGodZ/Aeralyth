#!/usr/bin/env bash
set -euo pipefail

test_database="aeralyth_bounded_tree_${$}"
scale_rows="${AERALYTH_TREE_SCALE:-100000}"

if (( scale_rows < 1 || scale_rows > 999999 )); then
  echo "AERALYTH_TREE_SCALE must be between 1 and 999999 children" >&2
  exit 1
fi

expected_nodes=$((scale_rows + 1))

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
  014_navigation_hot_paths.sql \
  015_collection_hierarchy_performance.sql \
  016_admin_search_identifier_policy.sql
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
VALUES ('usr_tree_scale', 'tree_scale_owner', 'not-a-login-hash', 'user', 'active');

INSERT INTO files (
  id, owner_id, original_name, storage_name, size_bytes, entry_type
) VALUES (
  'fil_tree_scale_root', 'usr_tree_scale', 'tree-scale-root',
  'tree-scale/root', 0, 'folder'
);

-- The fixture is a known-valid flat tree. Disable only application triggers
-- while bulk-loading so fixture setup does not dominate the measured walk.
ALTER TABLE files DISABLE TRIGGER USER;
INSERT INTO files (
  id, owner_id, original_name, storage_name, size_bytes, entry_type,
  parent_id, created_at, updated_at
)
SELECT
  format('fil_tree_scale_%s', lpad(series::text, 8, '0')),
  'usr_tree_scale',
  format('scale-file-%s', lpad(series::text, 8, '0')),
  format('tree-scale/file-%s', lpad(series::text, 8, '0')),
  series,
  'file',
  'fil_tree_scale_root',
  timestamptz '2025-01-01 00:00:00+00' + series * interval '1 millisecond',
  timestamptz '2025-01-01 00:00:00+00' + series * interval '1 millisecond'
FROM generate_series(1, :scale_rows::integer) AS series;
ALTER TABLE files ENABLE TRIGGER USER;

ANALYZE files;
SQL

docker compose exec -T postgres psql \
  -q \
  -v ON_ERROR_STOP=1 \
  -U aeralyth \
  -d "${test_database}" \
  -f /docker-entrypoint-initdb.d/017_bounded_tree_operations.sql >/dev/null

for migration in \
  018_share_link_token_rotation.sql \
  019_share_link_rollout_compatibility.sql \
  020_share_link_legacy_writer_guard.sql
do
  docker compose exec -T postgres psql \
    -q \
    -v ON_ERROR_STOP=1 \
    -U aeralyth \
    -d "${test_database}" \
    -f "/docker-entrypoint-initdb.d/${migration}" >/dev/null
done

page_plan=$(docker compose exec -T postgres psql \
  -qAt \
  -v ON_ERROR_STOP=1 \
  -U aeralyth \
  -d "${test_database}" \
  -c "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT id, parent_id, entry_type FROM files WHERE owner_id = 'usr_tree_scale' AND parent_id = ANY(ARRAY['fil_tree_scale_root']::text[]) AND state = 'active' AND ('fil_tree_scale_root', '') > ('', '') ORDER BY parent_id, id LIMIT 16384;")

page_rows=$(jq -r '.[0].Plan["Actual Rows"] | floor' <<<"${page_plan}")
page_ms=$(jq -r '.[0].Plan["Actual Total Time"]' <<<"${page_plan}")
walk_index=$(jq -r '[.. | objects | .["Index Name"]? // empty] | any(. == "files_owner_parent_walk_idx")' <<<"${page_plan}")

if (( page_rows > 16384 )); then
  echo "bounded child page returned too many rows: ${page_rows}" >&2
  exit 1
fi
if [[ "${walk_index}" != "true" ]]; then
  echo "bounded child page did not use files_owner_parent_walk_idx" >&2
  jq '.[0].Plan' <<<"${page_plan}" >&2
  exit 1
fi

DATABASE_URL="postgres://aeralyth:aeralyth@127.0.0.1:5432/${test_database}" \
  AERALYTH_TREE_EXPECTED_NODES="${expected_nodes}" \
  cargo test \
    --quiet \
    --manifest-path backend/Cargo.toml \
    bounded_tree_walk_reaches_scale_fixture \
    -- \
    --ignored \
    --nocapture

DATABASE_URL="postgres://aeralyth:aeralyth@127.0.0.1:5432/${test_database}" \
  cargo test \
    --quiet \
    --manifest-path backend/Cargo.toml \
    database_query_contracts_prepare \
    -- \
    --ignored

DATABASE_URL="postgres://aeralyth:aeralyth@127.0.0.1:5432/${test_database}" \
  cargo test \
    --quiet \
    --manifest-path backend/Cargo.toml \
    database_optimized_queries_execute \
    -- \
    --ignored \
    --nocapture

docker compose exec -T postgres psql \
  -q \
  -v ON_ERROR_STOP=1 \
  -U aeralyth \
  -d "${test_database}" \
  -f /docker-entrypoint-initdb.d/017_bounded_tree_operations.sql >/dev/null

replay_state=$(docker compose exec -T postgres psql \
  -qAt \
  -v ON_ERROR_STOP=1 \
  -U aeralyth \
  -d "${test_database}" \
  -c "SELECT (SELECT count(*) FROM schema_migrations WHERE version = '017-bounded-tree-operations') || '|' || (SELECT count(*) FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname = 'files_owner_parent_walk_idx') || '|' || (SELECT indisvalid FROM pg_index WHERE indexrelid = 'files_owner_parent_walk_idx'::regclass);")

if [[ "${replay_state}" != "1|1|true" ]]; then
  echo "bounded tree migration replay state is incorrect: ${replay_state}" >&2
  exit 1
fi

echo "bounded child page: ${page_rows} rows in ${page_ms} ms using files_owner_parent_walk_idx"
echo "bounded tree checks passed at ${expected_nodes} total nodes"
