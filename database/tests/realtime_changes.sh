#!/usr/bin/env bash
set -euo pipefail

test_database="aeralyth_realtime_${$}"
test_log="$(mktemp)"
cleanup() {
  docker compose exec -T postgres dropdb -U aeralyth --if-exists "${test_database}" >/dev/null
  rm -f "${test_log}"
}
trap cleanup EXIT
docker compose exec -T postgres createdb -U aeralyth "${test_database}"
sql() {
  docker compose exec -T postgres psql -X -qAt -v ON_ERROR_STOP=1 -U aeralyth -d "${test_database}" "$@"
}
for migration in database/init/[0-9][0-9][0-9]_*.sql; do
  if ! sql -f "/docker-entrypoint-initdb.d/$(basename "${migration}")" >"${test_log}" 2>&1; then
    cat "${test_log}"
    exit 1
  fi
done

sql <<'SQL'
CREATE FUNCTION realtime_test_expand() RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  WHILE EXISTS (SELECT 1 FROM realtime_audience_jobs WHERE NOT complete) LOOP
    PERFORM realtime_expand_audiences();
  END LOOP;
END $$;
CREATE FUNCTION realtime_test_dispatch() RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  WHILE realtime_dispatch() = 512 LOOP NULL; END LOOP;
END $$;
INSERT INTO users (id, username, password_hash, role) VALUES
  ('usr_rt_owner', 'rt_owner', 'test-only', 'user'),
  ('usr_rt_recipient', 'rt_recipient', 'test-only', 'user'),
  ('usr_rt_other', 'rt_other', 'test-only', 'user');
INSERT INTO files (id, owner_id, original_name, storage_name, size_bytes, entry_type)
VALUES ('fil_rt_folder', 'usr_rt_owner', 'Private folder name', 'rt/folder', 0, 'folder');
INSERT INTO file_shares (id, file_id, owner_id, recipient_id)
VALUES ('fsh_rt', 'fil_rt_folder', 'usr_rt_owner', 'usr_rt_recipient');
TRUNCATE realtime_outbox, realtime_events, realtime_audience_jobs, realtime_audience_deliveries;

-- One bulk statement produces one invalidation per affected audience, with no
-- plaintext names or per-file payload explosion.
INSERT INTO files (id, owner_id, original_name, storage_name, size_bytes, parent_id)
SELECT 'fil_rt_' || n, 'usr_rt_owner', 'secret-' || n, 'rt/file-' || n, 1, 'fil_rt_folder'
FROM generate_series(1, 1000) n;
DO $$ BEGIN
  IF (SELECT count(*) FROM realtime_audience_jobs) <> 1
    OR EXISTS (SELECT 1 FROM realtime_outbox WHERE scope = 'shared')
  THEN RAISE EXCEPTION 'bulk foreground work expanded recipients instead of storing one seed'; END IF;
END $$;
SELECT realtime_test_expand();
DO $$ BEGIN
  IF (SELECT count(*) FROM realtime_outbox WHERE user_id = 'usr_rt_owner' AND scope = 'files') <> 1
    OR (SELECT count(*) FROM realtime_outbox WHERE user_id = 'usr_rt_recipient' AND scope = 'shared') <> 1
    OR EXISTS (SELECT 1 FROM realtime_outbox WHERE user_id = 'usr_rt_other')
    OR EXISTS (SELECT 1 FROM realtime_outbox WHERE scope = 'shared' AND cardinality(folder_ids) <> 0)
    OR NOT EXISTS (SELECT 1 FROM realtime_outbox WHERE user_id = 'usr_rt_owner' AND scope = 'files'
      AND folder_ids = ARRAY['fil_rt_folder'])
  THEN RAISE EXCEPTION 'bulk event coalescing or recipient isolation failed'; END IF;
END $$;
SELECT realtime_test_dispatch();

-- A rollback leaves neither an event nor an outbox entry.
BEGIN;
UPDATE files SET favorite = TRUE WHERE id = 'fil_rt_1';
ROLLBACK;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM realtime_outbox) OR EXISTS (SELECT 1 FROM realtime_audience_jobs)
  THEN RAISE EXCEPTION 'rolled-back event escaped'; END IF;
END $$;

-- Same-transaction changes merge folders and deduplicate audiences.
BEGIN;
UPDATE files SET favorite = TRUE WHERE id = 'fil_rt_1';
UPDATE files SET original_name = 'new secret name' WHERE id = 'fil_rt_2';
COMMIT;
SELECT realtime_test_expand();
DO $$ BEGIN
  IF (SELECT count(*) FROM realtime_outbox) <> 2 THEN RAISE EXCEPTION 'transaction deduplication failed'; END IF;
  IF NOT EXISTS (SELECT 1 FROM realtime_outbox WHERE user_id = 'usr_rt_owner' AND 'fil_rt_folder' = ANY(folder_ids))
  THEN RAISE EXCEPTION 'affected folder missing'; END IF;
END $$;
SELECT realtime_test_dispatch();

-- Cascade deletion must still notify the former recipient after grants vanish.
DELETE FROM files WHERE id = 'fil_rt_folder';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM realtime_outbox WHERE user_id = 'usr_rt_recipient' AND scope = 'shared')
  THEN RAISE EXCEPTION 'cascade revocation did not notify recipient'; END IF;
END $$;
SELECT realtime_test_dispatch();

-- Staged encrypted uploads are invisible until publication. Encrypted head
-- publication and recipient revocation use the same generic shared scope.
TRUNCATE realtime_outbox, realtime_audience_jobs, realtime_audience_deliveries;
INSERT INTO files (id, owner_id, original_name, storage_name, size_bytes, entry_type, e2ee_state)
VALUES ('fil_rt_encrypted', 'usr_rt_owner', 'opaque', 'rt/encrypted', 0, 'folder', 'staged');
UPDATE files SET updated_at = clock_timestamp() WHERE id = 'fil_rt_encrypted';
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM realtime_outbox) OR EXISTS (SELECT 1 FROM realtime_audience_jobs)
  THEN RAISE EXCEPTION 'staged upload was published'; END IF;
END $$;
UPDATE files SET e2ee_state = 'encrypted' WHERE id = 'fil_rt_encrypted';
INSERT INTO vault_identity_keys (user_id, key_version, x25519_public_key, ed25519_public_key, fingerprint_sha256)
SELECT id, 1, decode(repeat('01', 32), 'hex'), decode(repeat('02', 32), 'hex'), digest(id, 'sha256')
FROM users WHERE id IN ('usr_rt_owner', 'usr_rt_recipient');
INSERT INTO vault_node_records (node_id, owner_id, record_version, record_hash, bootstrap_cbor,
  bootstrap_signature, encrypted_manifest, manifest_hash, signer_key_version)
VALUES ('fil_rt_encrypted', 'usr_rt_owner', 1, decode(repeat('03', 32), 'hex'),
  decode(repeat('04', 128), 'hex'), decode(repeat('05', 64), 'hex'),
  decode(repeat('06', 16), 'hex'), decode(repeat('07', 32), 'hex'), 1);
INSERT INTO vault_shares (id, owner_id, root_node_id)
VALUES ('vsh_rt', 'usr_rt_owner', 'fil_rt_encrypted');
INSERT INTO vault_share_recipients (share_id, recipient_id, recipient_key_version)
VALUES ('vsh_rt', 'usr_rt_recipient', 1);
TRUNCATE realtime_outbox, realtime_audience_jobs, realtime_audience_deliveries;
INSERT INTO vault_node_heads (node_id, owner_id, record_version, record_hash)
VALUES ('fil_rt_encrypted', 'usr_rt_owner', 1, decode(repeat('03', 32), 'hex'));
SELECT realtime_test_expand();
DO $$ BEGIN
  IF (SELECT count(*) FROM realtime_outbox) <> 3
    OR NOT EXISTS (SELECT 1 FROM realtime_outbox WHERE user_id = 'usr_rt_owner'
      AND scope = 'paths' AND folder_ids = ARRAY['fil_rt_encrypted'])
    OR NOT EXISTS (SELECT 1 FROM realtime_outbox WHERE user_id = 'usr_rt_recipient'
      AND scope = 'shared' AND folder_ids = '{}'::text[])
  THEN RAISE EXCEPTION 'encrypted head publication missed an audience'; END IF;
END $$;
SELECT realtime_test_dispatch();
UPDATE vault_share_recipients SET status = 'revoked' WHERE share_id = 'vsh_rt';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM realtime_outbox WHERE user_id = 'usr_rt_recipient' AND scope = 'shared')
  THEN RAISE EXCEPTION 'encrypted revocation was not published'; END IF;
END $$;
SELECT realtime_test_dispatch();
UPDATE files SET favorite = TRUE WHERE id = 'fil_rt_encrypted';
SELECT realtime_test_expand();
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM realtime_outbox WHERE user_id = 'usr_rt_recipient')
  THEN RAISE EXCEPTION 'revoked encrypted recipient received a later change'; END IF;
END $$;
SELECT realtime_test_dispatch();

-- Migration replay is inert, including event publication.
TRUNCATE realtime_outbox, realtime_audience_jobs, realtime_audience_deliveries;
SQL
sql < database/tests/realtime_background_audiences.sql
sql < database/tests/realtime_path_scopes.sql
sql -f /docker-entrypoint-initdb.d/026_realtime_changes.sql >"${test_log}" 2>&1
sql -f /docker-entrypoint-initdb.d/031_realtime_background_audiences.sql >"${test_log}" 2>&1
test "$(sql -c 'SELECT count(*) FROM realtime_outbox')" = "0"

# Reproduce the out-of-order commit case: the lower outbox ID stays uncommitted
# while a later transaction is published. Its eventual delivery ID must be newer.
sql >"${test_log}" <<'SQL' &
BEGIN;
SELECT realtime_enqueue('usr_rt_owner', 'profile');
UPDATE files SET favorite = FALSE WHERE id = 'fil_rt_deep_80';
SELECT pg_sleep(2);
COMMIT;
SQL
slow_writer=$!
sleep 0.5
sql -c "SELECT realtime_enqueue('usr_rt_other', 'profile'); SELECT realtime_test_dispatch();" >/dev/null
first_cursor="$(sql -c 'SELECT head FROM realtime_stream_state')"
wait "${slow_writer}"
sql -c 'SELECT realtime_test_dispatch()' >/dev/null
test "$(sql -c "SELECT count(*) FROM realtime_events WHERE user_id = 'usr_rt_owner' AND scope = 'profile' AND id > ${first_cursor}")" = "1"
test "$(sql -c "SELECT count(*) FROM realtime_events WHERE user_id = 'usr_rt_other' AND scope = 'shared' AND id > ${first_cursor}")" = "1"

sql <<'SQL'
UPDATE realtime_events SET created_at = now() - interval '25 hours';
SELECT realtime_prune();
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM realtime_events)
    OR NOT EXISTS (SELECT 1 FROM realtime_stream_state WHERE floor = head AND head > 0)
  THEN RAISE EXCEPTION 'retention or replay floor failed'; END IF;
END $$;
SQL
echo "Realtime database checks passed: bounded foreground and background work, deep ancestry, delayed moves, isolation, rollback, cascade revocation, encrypted publication and revocation, replay, commit ordering, retention."
