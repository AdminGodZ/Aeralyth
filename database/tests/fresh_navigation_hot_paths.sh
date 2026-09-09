#!/usr/bin/env bash
set -euo pipefail

test_database="aeralyth_navigation_hot_paths_${$}"
scale_nodes="${AERALYTH_NAVIGATION_SCALE:-50000}"

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
  013_migration_identity_performance.sql
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
INSERT INTO users (id, username, password_hash, role, status)
VALUES
  ('usr_nav_pre_owner', 'nav_pre_owner', 'not-a-login-hash', 'user', 'active'),
  ('usr_nav_pre_recipient', 'nav_pre_recipient', 'not-a-login-hash', 'user', 'active');

INSERT INTO files (
  id, owner_id, original_name, storage_name, size_bytes, entry_type
) VALUES (
  'fil_nav_pre', 'usr_nav_pre_owner', 'pre-migration',
  'navigation-hot-paths/pre-migration', 0, 'folder'
);

INSERT INTO file_shares (id, file_id, owner_id, recipient_id)
VALUES ('fsh_nav_pre', 'fil_nav_pre', 'usr_nav_pre_owner', 'usr_nav_pre_recipient');

INSERT INTO vault_shares (id, owner_id, root_node_id, status)
VALUES ('vsh_nav_pre', 'usr_nav_pre_owner', 'fil_nav_pre', 'active');

INSERT INTO share_links (
  id, token_hash, owner_id, root_file_id, access_scope, permission, expires_at
) VALUES
  (
    'lnk_nav_pre_permanent', repeat('a', 64), 'usr_nav_pre_owner', 'fil_nav_pre',
    'public', 'viewer', NULL
  ),
  (
    'lnk_nav_pre_future', repeat('b', 64), 'usr_nav_pre_owner', 'fil_nav_pre',
    'public', 'viewer', now() + interval '30 days'
  );
SQL

docker compose exec -T postgres psql \
  -q \
  -v ON_ERROR_STOP=1 \
  -U aeralyth \
  -d "${test_database}" \
  -f /docker-entrypoint-initdb.d/014_navigation_hot_paths.sql >/dev/null

# Query-contract tests exercise the current backend, so apply schema-only
# migrations added after the migration under measurement before compiling its
# prepared statements.
for migration in \
  018_share_link_token_rotation.sql \
  019_share_link_rollout_compatibility.sql \
  020_share_link_legacy_writer_guard.sql \
  021_compact_account_state.sql \
  022_large_share_commitments.sql \
  023_maintenance_coordination.sql \
  024_one_password_auth.sql \
  025_trash_retention.sql \
  026_realtime_changes.sql \
  027_flexible_retention_and_vault_lock.sql
do
  docker compose exec -T postgres psql \
    -q \
    -v ON_ERROR_STOP=1 \
    -U aeralyth \
    -d "${test_database}" \
    -f "/docker-entrypoint-initdb.d/${migration}" >/dev/null
done

DATABASE_URL="postgres://aeralyth:aeralyth@127.0.0.1:5432/${test_database}" \
  cargo test \
    --quiet \
    --manifest-path backend/Cargo.toml \
    database_query_contracts_prepare \
    -- \
    --ignored

docker compose exec -T postgres psql \
  -v ON_ERROR_STOP=1 \
  -v scale_nodes="${scale_nodes}" \
  -U aeralyth \
  -d "${test_database}" \
  < database/tests/navigation_hot_paths.sql

docker compose exec -T postgres psql \
  -q \
  -v ON_ERROR_STOP=1 \
  -U aeralyth \
  -d "${test_database}" \
  -f /docker-entrypoint-initdb.d/014_navigation_hot_paths.sql >/dev/null

replay_state=$(docker compose exec -T postgres psql \
  -qAt \
  -v ON_ERROR_STOP=1 \
  -U aeralyth \
  -d "${test_database}" \
  -c "
    SELECT
      (SELECT count(*) FROM schema_migrations
       WHERE version = '014-navigation-hot-paths') || '|' ||
      (SELECT count(*) FROM pg_trigger
       WHERE NOT tgisinternal
         AND tgname IN (
           'file_shares_file_state_insert',
           'file_shares_file_state_update',
           'file_shares_file_state_delete',
           'vault_shares_file_state_insert',
           'vault_shares_file_state_update',
           'vault_shares_file_state_delete',
           'share_links_file_state_insert',
           'share_links_file_state_update',
           'share_links_file_state_delete',
           'files_repository_counts_insert',
           'files_repository_counts_update',
           'files_repository_counts_delete'
         )
         AND (tgtype & 1) = 0) || '|' ||
      (SELECT legacy_share_count || ',' || vault_share_count || ',' ||
              permanent_share_link_count
       FROM files WHERE id = 'fil_nav_pre');
  ")

if [[ "${replay_state}" != "1|12|1,1,1" ]]; then
  echo "navigation migration replay state is incorrect: ${replay_state}" >&2
  exit 1
fi

echo "navigation hot-path regression checks passed at ${scale_nodes} repository nodes"
