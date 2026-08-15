#!/usr/bin/env bash
set -euo pipefail

test_database="aeralyth_admin_search_${$}"
scale_rows="${AERALYTH_ADMIN_SCALE:-100000}"
identifier_rows="${AERALYTH_IDENTIFIER_SCALE:-${scale_rows}}"

if (( identifier_rows > 250000 )); then
  identifier_rows=250000
fi

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
  015_collection_hierarchy_performance.sql
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

-- Synthetic scale loading is not the subject of this benchmark. Keep FK and
-- CHECK constraints active, but skip application-maintenance triggers and
-- restore the one directory counter row before any measured query.
ALTER TABLE users DISABLE TRIGGER USER;
ALTER TABLE invitations DISABLE TRIGGER USER;

INSERT INTO users (
  id, username, password_hash, role, status, display_name, created_at, updated_at
)
SELECT
  format('usr_admin_scale_%s', lpad(series::text, 8, '0')),
  CASE WHEN series % 10000 = 0
    THEN format('needle_target_%s', lpad(series::text, 8, '0'))
    ELSE format('scale_user_%s', lpad(series::text, 8, '0'))
  END,
  'not-a-login-hash',
  CASE WHEN series % 20 = 0 THEN 'admin' ELSE 'user' END,
  CASE WHEN series % 10 = 0 THEN 'disabled' ELSE 'active' END,
  CASE WHEN series % 15000 = 0 THEN 'Needle Target Display' ELSE NULL END,
  timestamptz '2025-01-01 00:00:00+00' + series * interval '1 millisecond',
  timestamptz '2025-01-01 00:00:00+00' + series * interval '1 millisecond'
FROM generate_series(1, :scale_rows::integer) AS series;

INSERT INTO invitations (
  id, invited_username, role, token_hash, status, created_by,
  expires_at, created_at
)
SELECT
  format('inv_admin_scale_%s', lpad(series::text, 8, '0')),
  CASE WHEN series % 10000 = 0
    THEN format('needle_target_invite_%s', lpad(series::text, 8, '0'))
    ELSE format('scale_invite_%s', lpad(series::text, 8, '0'))
  END,
  CASE WHEN series % 20 = 0 THEN 'admin' ELSE 'user' END,
  encode(digest(format('admin-scale-token-%s', series), 'sha256'), 'hex'),
  CASE WHEN series % 4 = 0 THEN 'accepted' ELSE 'pending' END,
  'usr_admingod',
  timestamptz '2027-01-01 00:00:00+00',
  timestamptz '2025-01-01 00:00:00+00' + series * interval '1 millisecond'
FROM generate_series(1, :scale_rows::integer) AS series;

ALTER TABLE users ENABLE TRIGGER USER;
ALTER TABLE invitations ENABLE TRIGGER USER;

UPDATE admin_directory_counters
SET total_users = (SELECT count(*) FROM users WHERE status <> 'deleting'),
    active_users = (SELECT count(*) FROM users WHERE status = 'active'),
    active_admins = (
      SELECT count(*) FROM users WHERE status = 'active' AND role = 'admin'
    ),
    pending_invitations = (
      SELECT count(*) FROM invitations WHERE status = 'pending'
    ),
    updated_at = now()
WHERE singleton = TRUE;

ANALYZE users;
ANALYZE invitations;
SQL

old_user_plan=$(docker compose exec -T postgres psql \
  -qAt -v ON_ERROR_STOP=1 -U aeralyth -d "${test_database}" \
  -c "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT id FROM users WHERE status <> 'deleting' AND (username ILIKE '%needle_target%' OR COALESCE(display_name, '') ILIKE '%needle_target%' OR role ILIKE '%needle_target%' OR status ILIKE '%needle_target%') ORDER BY created_at, id LIMIT 51;")

old_invitation_plan=$(docker compose exec -T postgres psql \
  -qAt -v ON_ERROR_STOP=1 -U aeralyth -d "${test_database}" \
  -c "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT invitations.id FROM invitations INNER JOIN users ON users.id = invitations.created_by WHERE invitations.invited_username ILIKE '%needle_target%' OR invitations.role ILIKE '%needle_target%' OR invitations.status ILIKE '%needle_target%' OR users.username ILIKE '%needle_target%' ORDER BY invitations.created_at DESC, invitations.id DESC LIMIT 51;")

formatted_timestamp_plan=$(docker compose exec -T postgres psql \
  -qAt -v ON_ERROR_STOP=1 -U aeralyth -d "${test_database}" \
  -c "EXPLAIN (ANALYZE, FORMAT JSON) SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') FROM users WHERE id LIKE 'usr_admin_scale_%';")

docker compose exec -T postgres psql \
  -q -v ON_ERROR_STOP=1 -U aeralyth -d "${test_database}" \
  -f /docker-entrypoint-initdb.d/016_admin_search_identifier_policy.sql >/dev/null

new_user_plan=$(docker compose exec -T postgres psql \
  -qAt -v ON_ERROR_STOP=1 -U aeralyth -d "${test_database}" \
  -c "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT id FROM users WHERE status <> 'deleting' AND (username ILIKE '%needle_target%' ESCAPE '\\' OR COALESCE(display_name, '') ILIKE '%needle_target%' ESCAPE '\\') ORDER BY created_at, id LIMIT 51;")

new_invitation_plan=$(docker compose exec -T postgres psql \
  -qAt -v ON_ERROR_STOP=1 -U aeralyth -d "${test_database}" \
  -c "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) WITH candidate_ids AS MATERIALIZED (((SELECT id, created_at FROM invitations WHERE invited_username ILIKE '%needle_target%' ESCAPE '\\' ORDER BY created_at DESC, id DESC LIMIT 51)) UNION ((SELECT invitations.id, invitations.created_at FROM users INNER JOIN invitations ON invitations.created_by = users.id WHERE users.status <> 'deleting' AND users.username ILIKE '%needle_target%' ESCAPE '\\' ORDER BY invitations.created_at DESC, invitations.id DESC LIMIT 51))) SELECT invitations.id FROM candidate_ids INNER JOIN invitations ON invitations.id = candidate_ids.id ORDER BY candidate_ids.created_at DESC, candidate_ids.id DESC LIMIT 51;")

typed_timestamp_plan=$(docker compose exec -T postgres psql \
  -qAt -v ON_ERROR_STOP=1 -U aeralyth -d "${test_database}" \
  -c "EXPLAIN (ANALYZE, FORMAT JSON) SELECT created_at FROM users WHERE id LIKE 'usr_admin_scale_%';")

old_user_ms=$(jq -r '.[0].Plan["Actual Total Time"]' <<<"${old_user_plan}")
new_user_ms=$(jq -r '.[0].Plan["Actual Total Time"]' <<<"${new_user_plan}")
old_invitation_ms=$(jq -r '.[0].Plan["Actual Total Time"]' <<<"${old_invitation_plan}")
new_invitation_ms=$(jq -r '.[0].Plan["Actual Total Time"]' <<<"${new_invitation_plan}")
formatted_timestamp_ms=$(jq -r '.[0].Plan["Actual Total Time"]' <<<"${formatted_timestamp_plan}")
typed_timestamp_ms=$(jq -r '.[0].Plan["Actual Total Time"]' <<<"${typed_timestamp_plan}")

old_user_blocks=$(jq '[.. | objects | ((.["Shared Hit Blocks"] // 0) + (.["Shared Read Blocks"] // 0))] | add' <<<"${old_user_plan}")
new_user_blocks=$(jq '[.. | objects | ((.["Shared Hit Blocks"] // 0) + (.["Shared Read Blocks"] // 0))] | add' <<<"${new_user_plan}")
old_invitation_blocks=$(jq '[.. | objects | ((.["Shared Hit Blocks"] // 0) + (.["Shared Read Blocks"] // 0))] | add' <<<"${old_invitation_plan}")
new_invitation_blocks=$(jq '[.. | objects | ((.["Shared Hit Blocks"] // 0) + (.["Shared Read Blocks"] // 0))] | add' <<<"${new_invitation_plan}")

if (( new_user_blocks >= old_user_blocks )); then
  echo "user trigram search did not reduce buffers: ${old_user_blocks} -> ${new_user_blocks}" >&2
  exit 1
fi
if (( new_invitation_blocks >= old_invitation_blocks )); then
  echo "invitation trigram search did not reduce buffers: ${old_invitation_blocks} -> ${new_invitation_blocks}" >&2
  exit 1
fi

identifier_metrics=$(docker compose exec -T postgres psql \
  -qAt \
  -v ON_ERROR_STOP=1 \
  -v identifier_rows="${identifier_rows}" \
  -U aeralyth \
  -d "${test_database}" <<'SQL'
SET synchronous_commit = off;
CREATE TEMP TABLE benchmark_text_ids (
  id TEXT PRIMARY KEY,
  parent_id TEXT NOT NULL
);
CREATE INDEX benchmark_text_parent_idx ON benchmark_text_ids(parent_id);
CREATE TEMP TABLE benchmark_uuid_ids (
  id UUID PRIMARY KEY,
  parent_id UUID NOT NULL
);
CREATE INDEX benchmark_uuid_parent_idx ON benchmark_uuid_ids(parent_id);

INSERT INTO benchmark_text_ids (id, parent_id)
SELECT md5(series::text), md5(GREATEST(series - 1, 1)::text)
FROM generate_series(1, :identifier_rows::integer) AS series;
INSERT INTO benchmark_uuid_ids (id, parent_id)
SELECT md5(series::text)::uuid, md5(GREATEST(series - 1, 1)::text)::uuid
FROM generate_series(1, :identifier_rows::integer) AS series;
ANALYZE benchmark_text_ids;
ANALYZE benchmark_uuid_ids;

SELECT pg_total_relation_size('benchmark_text_ids') || '|' ||
       pg_total_relation_size('benchmark_uuid_ids');
SQL
)

text_identifier_bytes="${identifier_metrics%%|*}"
uuid_identifier_bytes="${identifier_metrics##*|}"
if (( uuid_identifier_bytes >= text_identifier_bytes )); then
  echo "native UUID benchmark was not smaller: ${text_identifier_bytes} -> ${uuid_identifier_bytes}" >&2
  exit 1
fi

docker compose exec -T postgres psql \
  -v ON_ERROR_STOP=1 -U aeralyth -d "${test_database}" \
  < database/tests/admin_search_identifier_performance.sql

docker compose exec -T postgres psql \
  -q -v ON_ERROR_STOP=1 -U aeralyth -d "${test_database}" \
  -f /docker-entrypoint-initdb.d/016_admin_search_identifier_policy.sql >/dev/null

replay_state=$(docker compose exec -T postgres psql \
  -qAt -v ON_ERROR_STOP=1 -U aeralyth -d "${test_database}" \
  -c "SELECT (SELECT count(*) FROM schema_migrations WHERE version = '016-admin-search-identifier-policy') || '|' || (SELECT count(*) FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname IN ('users_username_trgm_idx', 'users_display_name_trgm_idx', 'invitations_username_trgm_idx')) || '|' || (SELECT count(*) FROM legacy_text_identifier_columns);")

if [[ "${replay_state}" != 1\|3\|* ]]; then
  echo "admin search migration replay state is incorrect: ${replay_state}" >&2
  exit 1
fi

echo "user search ms before/after: ${old_user_ms}/${new_user_ms}; buffers: ${old_user_blocks}/${new_user_blocks}"
echo "invitation search ms before/after: ${old_invitation_ms}/${new_invitation_ms}; buffers: ${old_invitation_blocks}/${new_invitation_blocks}"
echo "timestamp query ms formatted/typed: ${formatted_timestamp_ms}/${typed_timestamp_ms}"
echo "TEXT/UUID identifier bytes at ${identifier_rows} rows: ${text_identifier_bytes}/${uuid_identifier_bytes}"
echo "admin search and identifier checks passed at ${scale_rows} users and invitations"
