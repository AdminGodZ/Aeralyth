#!/usr/bin/env bash
set -euo pipefail

test_database="aeralyth_trash_index_${$}"
test_log="$(mktemp)"
db_exec() {
  if [[ -n "${AERALYTH_TEST_CONTAINER:-}" ]]; then
    docker exec -i "${AERALYTH_TEST_CONTAINER}" "$@"
  else
    docker compose exec -T postgres "$@"
  fi
}
cleanup() {
  db_exec dropdb -U aeralyth --if-exists "${test_database}" >/dev/null
  rm -f "${test_log}"
}
trap cleanup EXIT
if [[ -n "${AERALYTH_TEST_TEMPLATE:-}" ]]; then
  db_exec createdb -U aeralyth -T "${AERALYTH_TEST_TEMPLATE}" "${test_database}"
else
  db_exec createdb -U aeralyth "${test_database}"
fi
sql() {
  db_exec psql -XqAt -v ON_ERROR_STOP=1 -U aeralyth -d "${test_database}" "$@"
}
for migration in database/init/[0-9][0-9][0-9]_*.sql; do
  if [[ -n "${AERALYTH_TEST_TEMPLATE:-}" && "${migration}" != *029_* && "${migration}" != *030_* && "${migration}" != *031_* && "${migration}" != *034_* ]]; then continue; fi
  if ! sql <"${migration}" >"${test_log}" 2>&1; then
    cat "${test_log}"
    exit 1
  fi
done
sql <<'SQL'
INSERT INTO users (id, username, password_hash, role, trash_retention_minutes)
VALUES ('usr_expiry', 'expiry_test', 'test-only', 'user', 1);
INSERT INTO files (id, owner_id, original_name, storage_name, size_bytes, entry_type, state, trashed_at, parent_id)
VALUES ('fil_parent', 'usr_expiry', 'parent', 'expiry/parent', 0, 'folder', 'trashed', now() - interval '2 minutes', NULL),
       ('fil_child', 'usr_expiry', 'child', 'expiry/child', 1, 'file', 'trashed', now() - interval '2 minutes', 'fil_parent'),
       ('fil_blocked', 'usr_expiry', 'blocked', 'expiry/blocked', 0, 'folder', 'active', NULL, NULL),
       ('fil_active', 'usr_expiry', 'active', 'expiry/active', 1, 'file', 'active', NULL, 'fil_blocked');
-- Preserve legacy mixed-state coverage without publishing an active child into trash.
UPDATE files SET state = 'trashed', trashed_at = now() - interval '2 minutes' WHERE id = 'fil_blocked';
DO $$ DECLARE deleted_count BIGINT; BEGIN
  IF (SELECT trash_child_count FROM files WHERE id = 'fil_parent') <> 1
  THEN RAISE EXCEPTION 'direct child counter failed'; END IF;
  deleted_count := expire_trash_batch(500);
  IF deleted_count <> 1 OR NOT EXISTS (SELECT 1 FROM files WHERE id = 'fil_parent')
  THEN RAISE EXCEPTION 'first expiry pass must delete the leaf only'; END IF;
  deleted_count := expire_trash_batch(500);
  IF deleted_count <> 1 OR EXISTS (SELECT 1 FROM files WHERE id = 'fil_parent')
  THEN RAISE EXCEPTION 'last-child removal must schedule its parent'; END IF;
  deleted_count := expire_trash_batch(500);
  IF deleted_count <> 0 OR EXISTS (SELECT 1 FROM trash_expiry_owners WHERE next_due_at <= now())
  THEN RAISE EXCEPTION 'expired nonleaf causes a busy loop'; END IF;
  IF NOT EXISTS (SELECT 1 FROM storage_deletion_jobs WHERE object_key = 'expiry/child')
  THEN RAISE EXCEPTION 'file object cleanup was not queued'; END IF;
END $$;
UPDATE files SET parent_id = NULL WHERE id = 'fil_active';
DO $$ BEGIN
  IF expire_trash_batch(500) <> 1 THEN RAISE EXCEPTION 'moving last child did not promote parent'; END IF;
END $$;
INSERT INTO files (id, owner_id, original_name, storage_name, size_bytes, state, trashed_at)
VALUES ('fil_policy', 'usr_expiry', 'policy', 'expiry/policy', 1, 'trashed', now() - interval '2 minutes');
UPDATE users SET trash_retention_minutes = 10 WHERE id = 'usr_expiry';
-- Even a stale materialized deadline must not override the authoritative policy.
UPDATE trash_expiry_owners SET next_due_at = now() - interval '1 hour' WHERE owner_id = 'usr_expiry';
DO $$ BEGIN
  IF expire_trash_batch(500) <> 0 OR NOT EXISTS (SELECT 1 FROM files WHERE id = 'fil_policy')
  THEN RAISE EXCEPTION 'retention extension caused premature deletion'; END IF;
END $$;
UPDATE users SET trash_retention_minutes = 1 WHERE id = 'usr_expiry';
DO $$ BEGIN
  IF expire_trash_batch(500) <> 1 THEN RAISE EXCEPTION 'retention shortening did not reschedule existing trash'; END IF;
END $$;
INSERT INTO files (id, owner_id, original_name, storage_name, size_bytes, entry_type, state, trashed_at, parent_id)
VALUES ('fil_concurrent_parent', 'usr_expiry', 'concurrent', 'expiry/concurrent-parent', 0, 'folder', 'active', NULL, NULL),
       ('fil_concurrent_a', 'usr_expiry', 'a', 'expiry/concurrent-a', 1, 'file', 'active', NULL, 'fil_concurrent_parent'),
       ('fil_concurrent_b', 'usr_expiry', 'b', 'expiry/concurrent-b', 1, 'file', 'active', NULL, 'fil_concurrent_parent');
UPDATE files SET state = 'trashed', trashed_at = now() - interval '2 minutes' WHERE id = 'fil_concurrent_parent';
SQL
# Two child-removal transactions overlap. The counter updates must serialize,
# with the last committed child removal publishing the empty parent deadline.
sql >"${test_log}" <<'SQL' &
BEGIN;
DELETE FROM files WHERE id = 'fil_concurrent_a';
SELECT pg_sleep(1);
COMMIT;
SQL
first_writer=$!
sleep 0.2
sql -c "DELETE FROM files WHERE id = 'fil_concurrent_b'" >/dev/null
wait "${first_writer}"
sql <<'SQL'
DO $$ BEGIN
  IF (SELECT trash_child_count FROM files WHERE id = 'fil_concurrent_parent') <> 0
    OR expire_trash_batch(500) <> 1
  THEN RAISE EXCEPTION 'concurrent final-child removal lost parent promotion'; END IF;
END $$;
INSERT INTO files (id, owner_id, original_name, storage_name, size_bytes, state, trashed_at)
VALUES ('fil_policy_race', 'usr_expiry', 'policy-race', 'expiry/policy-race', 1, 'trashed', now() - interval '2 minutes');
SQL
# An in-flight policy extension locks users. Cleanup must skip that owner until
# it can read the new policy under a SHARE lock, then retain the file.
sql >"${test_log}" <<'SQL' &
BEGIN;
UPDATE users SET trash_retention_minutes = 10 WHERE id = 'usr_expiry';
SELECT pg_sleep(1);
COMMIT;
SQL
policy_writer=$!
sleep 0.2
test "$(sql -c 'SELECT expire_trash_batch(500)')" = '0'
wait "${policy_writer}"
test "$(sql -c 'SELECT expire_trash_batch(500)')" = '0'
test "$(sql -c "SELECT count(*) FROM files WHERE id = 'fil_policy_race'")" = '1'
sql <<'SQL'
INSERT INTO files (id, owner_id, original_name, storage_name, size_bytes, entry_type, state, trashed_at, parent_id)
VALUES ('fil_cascade_root', 'usr_expiry', 'root', 'expiry/cascade-root', 0, 'folder', 'active', NULL, NULL),
       ('fil_cascade_folder', 'usr_expiry', 'folder', 'expiry/cascade-folder', 0, 'folder', 'active', NULL, 'fil_cascade_root'),
       ('fil_cascade_leaf', 'usr_expiry', 'leaf', 'expiry/cascade-leaf', 1, 'file', 'active', NULL, 'fil_cascade_folder');
DELETE FROM files WHERE id = 'fil_cascade_root';
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM files WHERE id LIKE 'fil_cascade_%')
  THEN RAISE EXCEPTION 'cascade delete left child rows'; END IF;
END $$;
UPDATE files SET state = 'active', trashed_at = NULL WHERE id = 'fil_policy_race';
DO $$ BEGIN
  IF (SELECT next_due_at FROM trash_expiry_owners WHERE owner_id = 'usr_expiry') IS NOT NULL
  THEN RAISE EXCEPTION 'restoring last trash leaf left a scheduled expiry'; END IF;
END $$;
INSERT INTO files (id, owner_id, original_name, storage_name, size_bytes, state, trashed_at)
SELECT 'fil_expiry_batch_' || n, 'usr_expiry', 'batch', 'expiry/batch/' || n, 1,
       'trashed', now() - interval '11 minutes' FROM generate_series(1, 501) n;
DO $$ BEGIN
  IF expire_trash_batch(500) <> 500 THEN RAISE EXCEPTION 'batch did not stop at 500'; END IF;
  IF expire_trash_batch(500) <> 1 THEN RAISE EXCEPTION 'next batch lost remaining work'; END IF;
END $$;
SQL
sql <<'SQL'
DO $$ DECLARE original_xmin TEXT; BEGIN
  SELECT xmin::text INTO original_xmin FROM trash_expiry_owners WHERE owner_id = 'usr_expiry';
  INSERT INTO files (id, owner_id, original_name, storage_name, size_bytes)
  VALUES ('fil_active_no_schedule', 'usr_expiry', 'active', 'expiry/no-schedule', 1);
  UPDATE files SET original_name = 'renamed' WHERE id = 'fil_active_no_schedule';
  DELETE FROM files WHERE id = 'fil_active_no_schedule';
  IF (SELECT xmin::text FROM trash_expiry_owners WHERE owner_id = 'usr_expiry') <> original_xmin
  THEN RAISE EXCEPTION 'active file writes contended on the trash owner schedule'; END IF;
END $$;
INSERT INTO files (id, owner_id, original_name, storage_name, size_bytes, entry_type, state, trashed_at, parent_id)
VALUES ('fil_lock_parent', 'usr_expiry', 'parent', 'expiry/lock-parent', 0, 'folder', 'active', NULL, NULL),
       ('fil_lock_expired', 'usr_expiry', 'expired', 'expiry/lock-expired', 1, 'file', 'trashed', now() - interval '11 minutes', 'fil_lock_parent');
SQL
# Acquire parent first, then publish an active sibling while expiry is waiting
# to decrement that parent's child count. Holding schedule before parent would
# deadlock this interleaving.
sql >"${test_log}" <<'SQL' &
BEGIN;
SET LOCAL statement_timeout = '5s';
SELECT id FROM files WHERE id = 'fil_lock_parent' FOR UPDATE;
SELECT pg_sleep(0.5);
INSERT INTO files (id, owner_id, original_name, storage_name, size_bytes, parent_id)
VALUES ('fil_lock_active', 'usr_expiry', 'active', 'expiry/lock-active', 1, 'fil_lock_parent');
COMMIT;
SQL
parent_writer=$!
sleep 0.2
test "$(sql -c "SET statement_timeout = '5s'; SELECT expire_trash_batch(500)")" = '0'
wait "${parent_writer}"
test "$(sql -c 'SELECT expire_trash_batch(500)')" = '1'
sql <<'SQL'
DO $$ BEGIN
  IF (SELECT trash_child_count FROM files WHERE id = 'fil_lock_parent') <> 1
    OR (SELECT next_due_at FROM trash_expiry_owners WHERE owner_id = 'usr_expiry') IS NOT NULL
  THEN RAISE EXCEPTION 'concurrent active sibling publication broke nonleaf eligibility'; END IF;
END $$;
INSERT INTO files (id, owner_id, original_name, storage_name, size_bytes, state, trashed_at)
VALUES ('fil_generations', 'usr_expiry', 'generations', 'expiry/generation-current', 1, 'trashed', now() - interval '11 minutes');
INSERT INTO vault_object_generations (node_id, owner_id, generation_number, generation_id,
  object_key, ciphertext_length, chunk_count, ciphertext_merkle_root)
SELECT 'fil_generations', 'usr_expiry', n, decode(lpad(to_hex(n), 32, '0'), 'hex'),
  'expiry/generation-' || n, 1, 1, decode(repeat('00', 32), 'hex') FROM generate_series(1, 2) n;
INSERT INTO vault_uploads (id, node_id, owner_id, entry_type, generation_number, generation_id,
  object_key, ciphertext_length, chunk_count, upload_mode, status, write_expires_at)
VALUES ('vup_expiry_generation', 'fil_generations', 'usr_expiry', 'file', 1,
  decode(lpad(to_hex(1), 32, '0'), 'hex'), 'expiry/generation-1', 1, 1, 'single', 'published', now() + interval '1 hour');
DO $$ DECLARE deleted_count BIGINT; BEGIN
  deleted_count := expire_trash_batch(500);
  IF deleted_count <> 1 OR (SELECT count(*) FROM storage_deletion_jobs WHERE object_key LIKE 'expiry/generation-%') <> 3
  THEN RAISE EXCEPTION 'generation object cleanup lost historical keys'; END IF;
  IF NOT EXISTS (SELECT 1 FROM storage_deletion_jobs WHERE object_key = 'expiry/generation-1' AND available_at >= now() + interval '59 minutes')
  THEN RAISE EXCEPTION 'generation cleanup ignored an outstanding signed write lease'; END IF;
END $$;
SQL
sql <<'SQL'
DO $$ DECLARE invalid_size INTEGER; BEGIN
  FOREACH invalid_size IN ARRAY ARRAY[NULL, 0, 501] LOOP
    BEGIN
      PERFORM expire_trash_batch(invalid_size);
      RAISE EXCEPTION 'unbounded or invalid batch accepted';
    EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
  END LOOP;
END $$;
INSERT INTO users (id, username, password_hash, role, trash_retention_minutes)
VALUES ('usr_fenced_expiry', 'fenced_expiry', 'test-only', 'user', 1),
       ('usr_unfenced_expiry', 'unfenced_expiry', 'test-only', 'user', 1);
INSERT INTO files (id, owner_id, original_name, storage_name, size_bytes, state, trashed_at)
VALUES ('fil_fenced_expiry', 'usr_fenced_expiry', 'fenced', 'expiry/fenced', 1, 'trashed', now() - interval '3 minutes'),
       ('fil_unfenced_expiry', 'usr_unfenced_expiry', 'unfenced', 'expiry/unfenced', 1, 'trashed', now() - interval '2 minutes');
INSERT INTO tree_operation_jobs (owner_id, root_id, action)
VALUES ('usr_fenced_expiry', 'fil_fenced_expiry', 'delete');
DO $$ DECLARE deleted_count BIGINT; BEGIN
  deleted_count := expire_trash_batch(500);
  IF deleted_count <> 1 OR NOT EXISTS (SELECT 1 FROM files WHERE id = 'fil_fenced_expiry')
    OR EXISTS (SELECT 1 FROM files WHERE id = 'fil_unfenced_expiry')
  THEN RAISE EXCEPTION 'pending tree job blocked unrelated expiry or lost its fence'; END IF;
END $$;
UPDATE tree_operation_jobs SET status = 'complete', completed_at = now() WHERE owner_id = 'usr_fenced_expiry';
DO $$ BEGIN
  IF expire_trash_batch(500) <> 1 THEN RAISE EXCEPTION 'completed tree job lost deferred expiry'; END IF;
END $$;
SQL
scale_verification="scale plans skipped"
if [[ "${AERALYTH_TEST_SKIP_SCALE:-0}" != 1 ]]; then
# 100k mostly unexpired leaves, distributed over heterogeneous owner policies.
# Capture actual plans and assert the two maintenance entry points use indexes.
sql <<'SQL'
INSERT INTO users (id, username, password_hash, role, trash_retention_minutes)
SELECT 'usr_expiry_scale_' || n, 'expiry_scale_' || n, 'test-only', 'user', 60 + n
FROM generate_series(1, 1000) n;
INSERT INTO files (id, owner_id, original_name, storage_name, size_bytes, state, trashed_at)
SELECT 'fil_expiry_scale_' || n, 'usr_expiry_scale_' || (1 + n % 1000),
       'scale', 'expiry/scale/' || n, 1, 'trashed',
       CASE WHEN n % 1000 = 0 THEN now() ELSE now() - interval '30 minutes' END
FROM generate_series(1, 100000) n;
UPDATE files SET trashed_at = now() WHERE owner_id = 'usr_expiry_scale_1';
VACUUM (ANALYZE) files;
ANALYZE users;
ANALYZE trash_expiry_owners;
-- The former query is retained here only as a measured comparison.
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT MIN(files.trashed_at + users.trash_retention_minutes * interval '1 minute')
FROM files JOIN users ON users.id = files.owner_id WHERE files.state = 'trashed' AND files.trashed_at IS NOT NULL;
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT MIN(next_due_at) FROM trash_expiry_owners WHERE next_due_at IS NOT NULL;
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT owner_id FROM trash_expiry_owners WHERE next_due_at <= now()
ORDER BY next_due_at, owner_id LIMIT 1;
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT id FROM files WHERE owner_id = 'usr_expiry_scale_1' AND state = 'trashed'
AND trash_child_count = 0 AND trashed_at IS NOT NULL AND trashed_at <= now() - interval '1 minute'
ORDER BY trashed_at, id LIMIT 500;
DO $$ DECLARE plan JSON; BEGIN
  EXECUTE 'EXPLAIN (FORMAT JSON) SELECT MIN(next_due_at) FROM trash_expiry_owners WHERE next_due_at IS NOT NULL' INTO plan;
  IF plan::text NOT LIKE '%trash_expiry_owners_due_idx%' THEN RAISE EXCEPTION 'next due does not use its index: %', plan; END IF;
  EXECUTE $query$EXPLAIN (FORMAT JSON) SELECT id FROM files WHERE owner_id = 'usr_expiry_scale_1' AND state = 'trashed' AND trash_child_count = 0 AND trashed_at IS NOT NULL AND trashed_at <= now() - interval '1 minute' ORDER BY trashed_at, id LIMIT 500$query$ INTO plan;
  IF plan::text NOT LIKE '%files_trash_leaf_owner_due_idx%' THEN RAISE EXCEPTION 'expiry does not use its index: %', plan; END IF;
  IF expire_trash_batch(500) <> 0 THEN RAISE EXCEPTION 'mostly unexpired pass deleted data'; END IF;
END $$;
SQL
scale_verification="100k-row old/new query plans"
fi
sql <database/init/034_indexed_trash_expiry.sql >"${test_log}" 2>&1
echo "Indexed trash expiry passed: leaf order, cascade, restore, move, bounded batches, concurrent child removal, policy extension/shortening/race, no nonleaf busy loop, active-write isolation, sibling lock-order race, historical generation cleanup, batch argument bounds, tree-job fencing, ${scale_verification}, migration replay."
