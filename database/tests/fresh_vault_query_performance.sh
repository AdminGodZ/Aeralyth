#!/usr/bin/env bash
set -euo pipefail

test_database="aeralyth_vault_query_perf_${$}"

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
  011_admin_counter_triggers.sql
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
DROP INDEX file_uploads_global_expiry_idx;
DROP INDEX vault_uploads_global_expiry_idx;
DROP INDEX vault_share_envelopes_recipient_latest_idx;

DROP TRIGGER vault_share_envelope_epoch_guard_insert ON vault_share_envelopes;
DROP TRIGGER vault_share_envelope_epoch_guard_update ON vault_share_envelopes;
DROP TRIGGER vault_share_wrapper_epoch_guard_insert ON vault_share_wrappers;
DROP TRIGGER vault_share_wrapper_epoch_guard_update ON vault_share_wrappers;

CREATE OR REPLACE FUNCTION enforce_vault_share_epoch_write()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  share_row vault_shares%ROWTYPE;
BEGIN
  SELECT * INTO share_row
  FROM vault_shares
  WHERE id = NEW.share_id
  FOR SHARE;

  IF NOT FOUND OR share_row.status = 'revoked' THEN
    RAISE EXCEPTION 'share is not writable';
  END IF;
  IF share_row.publication_fenced AND NEW.epoch = share_row.active_epoch THEN
    RAISE EXCEPTION 'old share epoch is fenced';
  END IF;
  IF NEW.epoch <> share_row.active_epoch
     AND NEW.epoch IS DISTINCT FROM share_row.pending_epoch THEN
    RAISE EXCEPTION 'share epoch is not active or pending';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER vault_share_envelope_epoch_guard
BEFORE INSERT OR UPDATE ON vault_share_envelopes
FOR EACH ROW EXECUTE FUNCTION enforce_vault_share_epoch_write();

CREATE TRIGGER vault_share_wrapper_epoch_guard
BEFORE INSERT OR UPDATE ON vault_share_wrappers
FOR EACH ROW EXECUTE FUNCTION enforce_vault_share_epoch_write();
SQL

docker compose exec -T postgres psql \
  -q \
  -v ON_ERROR_STOP=1 \
  -U aeralyth \
  -d "${test_database}" \
  -f /docker-entrypoint-initdb.d/012_vault_query_performance.sql >/dev/null

docker compose exec -T postgres psql \
  -q \
  -v ON_ERROR_STOP=1 \
  -U aeralyth \
  -d "${test_database}" \
  < database/tests/vault_query_performance.sql >/dev/null

docker compose exec -T postgres psql \
  -q \
  -v ON_ERROR_STOP=1 \
  -U aeralyth \
  -d "${test_database}" \
  -f /docker-entrypoint-initdb.d/002_e2ee.sql >/dev/null

docker compose exec -T postgres psql \
  -q \
  -v ON_ERROR_STOP=1 \
  -U aeralyth \
  -d "${test_database}" \
  -f /docker-entrypoint-initdb.d/012_vault_query_performance.sql >/dev/null

replay_state=$(docker compose exec -T postgres psql \
  -qAt \
  -v ON_ERROR_STOP=1 \
  -U aeralyth \
  -d "${test_database}" \
  -c "
    SELECT
      (SELECT count(*) FROM schema_migrations
       WHERE version = '012-vault-query-performance') || '|' ||
      (SELECT count(*) FROM pg_trigger
       WHERE NOT tgisinternal
         AND tgname IN (
           'vault_share_envelope_epoch_guard',
           'vault_share_wrapper_epoch_guard'
         )) || '|' ||
      (SELECT count(*) FROM pg_trigger
       WHERE NOT tgisinternal
         AND tgname IN (
           'vault_share_envelope_epoch_guard_insert',
           'vault_share_envelope_epoch_guard_update',
           'vault_share_wrapper_epoch_guard_insert',
           'vault_share_wrapper_epoch_guard_update'
         )
         AND (tgtype & 1) = 0) || '|' ||
      (SELECT count(*) FROM pg_index
       INNER JOIN pg_class AS indexes ON indexes.oid = pg_index.indexrelid
       WHERE indexes.relname IN (
         'file_uploads_global_expiry_idx',
         'vault_uploads_global_expiry_idx',
         'vault_share_envelopes_recipient_latest_idx'
       )
         AND pg_index.indisvalid);
  ")

if [[ "${replay_state}" != "1|0|4|3" ]]; then
  echo "vault query-performance migration replay state is incorrect: ${replay_state}" >&2
  exit 1
fi

echo "fresh vault query-performance checks passed"
