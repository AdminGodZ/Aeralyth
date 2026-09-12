\set ON_ERROR_STOP on
-- Exercise the real trigger -> durable outbox -> dispatcher payload contract.
-- The browser currently views A/B. C and D are siblings beneath A.
INSERT INTO files (id, owner_id, original_name, storage_name, size_bytes, entry_type, parent_id) VALUES
  ('fil_rt_path_a', 'usr_rt_owner', 'A', 'rt/path/a', 0, 'folder', NULL),
  ('fil_rt_path_b', 'usr_rt_owner', 'B', 'rt/path/b', 0, 'folder', 'fil_rt_path_a'),
  ('fil_rt_path_c', 'usr_rt_owner', 'C', 'rt/path/c', 1, 'file', 'fil_rt_path_a'),
  ('fil_rt_path_d', 'usr_rt_owner', 'D', 'rt/path/d', 0, 'folder', 'fil_rt_path_a'),
  ('fil_rt_path_e', 'usr_rt_owner', 'E', 'rt/path/e', 0, 'folder', NULL);
SELECT realtime_test_dispatch();
TRUNCATE realtime_events;
UPDATE files SET original_name = 'C renamed' WHERE id = 'fil_rt_path_c';
SELECT realtime_test_dispatch();
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM realtime_events WHERE user_id = 'usr_rt_owner' AND scope = 'files'
      AND folder_ids = ARRAY['fil_rt_path_a'])
    OR EXISTS (SELECT 1 FROM realtime_events WHERE scope = 'paths')
  THEN RAISE EXCEPTION 'sibling file update carried a breadcrumb or unrelated listing invalidation'; END IF;
END $$;

TRUNCATE realtime_events;
UPDATE files SET original_name = 'D renamed' WHERE id = 'fil_rt_path_d';
SELECT realtime_test_dispatch();
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM realtime_events WHERE scope = 'paths' AND folder_ids = ARRAY['fil_rt_path_d'])
    OR EXISTS (SELECT 1 FROM realtime_events WHERE scope = 'paths' AND 'fil_rt_path_a' = ANY(folder_ids))
  THEN RAISE EXCEPTION 'sibling folder rename invalidated its unchanged ancestor'; END IF;
END $$;

TRUNCATE realtime_events;
UPDATE files SET original_name = 'A renamed' WHERE id = 'fil_rt_path_a';
SELECT realtime_test_dispatch();
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM realtime_events WHERE scope = 'paths' AND folder_ids = ARRAY['fil_rt_path_a'])
  THEN RAISE EXCEPTION 'ancestor rename lost its breadcrumb invalidation'; END IF;
END $$;

-- This is the mutation used by deferred ancestor timestamp reconciliation.
TRUNCATE realtime_events;
UPDATE files SET updated_at = clock_timestamp() WHERE id = 'fil_rt_path_a';
SELECT realtime_test_dispatch();
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM realtime_events WHERE scope = 'files' AND folder_ids = ARRAY[''])
    OR EXISTS (SELECT 1 FROM realtime_events WHERE scope = 'paths')
  THEN RAISE EXCEPTION 'timestamp-only ancestor reconciliation emitted a path invalidation'; END IF;
END $$;

-- Bound the number of distinct parent listings, not the number of changed
-- nodes: a large upload into B stays narrow and cannot refresh every route.
TRUNCATE realtime_events;
INSERT INTO files (id, owner_id, original_name, storage_name, size_bytes, parent_id)
SELECT 'fil_rt_path_bulk_' || n, 'usr_rt_owner', 'bulk-' || n, 'rt/path/bulk/' || n, 1, 'fil_rt_path_b'
FROM generate_series(1, 1000) n;
SELECT realtime_test_dispatch();
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM realtime_events WHERE user_id = 'usr_rt_owner' AND scope = 'files'
      AND folder_ids = ARRAY['fil_rt_path_b'])
    OR EXISTS (SELECT 1 FROM realtime_events WHERE user_id = 'usr_rt_owner' AND scope = 'files'
      AND cardinality(folder_ids) = 0)
    OR EXISTS (SELECT 1 FROM realtime_events WHERE scope = 'paths')
  THEN RAISE EXCEPTION 'bulk sibling inserts widened the listing invalidation'; END IF;
END $$;

TRUNCATE realtime_events;
UPDATE files SET parent_id = 'fil_rt_path_e' WHERE id = 'fil_rt_path_d';
SELECT realtime_test_dispatch();
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM realtime_events WHERE scope = 'files'
      AND folder_ids @> ARRAY['fil_rt_path_a', 'fil_rt_path_e'])
    OR NOT EXISTS (SELECT 1 FROM realtime_events WHERE scope = 'paths' AND folder_ids = ARRAY['fil_rt_path_d'])
  THEN RAISE EXCEPTION 'folder move lost its old/new parent listings or current path'; END IF;
END $$;

TRUNCATE realtime_events;
UPDATE files SET state = 'trashed' WHERE id = 'fil_rt_path_d';
SELECT realtime_test_dispatch();
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM realtime_events WHERE scope = 'paths' AND folder_ids = ARRAY['fil_rt_path_d'])
  THEN RAISE EXCEPTION 'folder visibility change lost its path'; END IF;
END $$;

TRUNCATE realtime_events;
DELETE FROM files WHERE id = 'fil_rt_path_d';
SELECT realtime_test_dispatch();
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM realtime_events WHERE scope = 'paths' AND folder_ids = ARRAY['fil_rt_path_d'])
    OR NOT EXISTS (SELECT 1 FROM realtime_events WHERE scope = 'files' AND folder_ids = ARRAY['fil_rt_path_e'])
  THEN RAISE EXCEPTION 'folder deletion lost its current path or parent listing'; END IF;
END $$;

-- Encrypted names live in node records, so a folder head publication must also
-- invalidate that folder's breadcrumb even without a plaintext file rename.
INSERT INTO vault_node_records (node_id, owner_id, record_version, record_hash, bootstrap_cbor,
  bootstrap_signature, encrypted_manifest, manifest_hash, signer_key_version)
SELECT node_id, owner_id, 2, decode(repeat('09', 32), 'hex'), bootstrap_cbor,
  bootstrap_signature, encrypted_manifest, manifest_hash, signer_key_version
FROM vault_node_records WHERE node_id = 'fil_rt_encrypted' AND record_version = 1;
TRUNCATE realtime_events;
UPDATE vault_node_heads SET record_version = 2, record_hash = decode(repeat('09', 32), 'hex')
WHERE node_id = 'fil_rt_encrypted';
SELECT realtime_test_dispatch();
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM realtime_events WHERE scope = 'paths' AND folder_ids = ARRAY['fil_rt_encrypted'])
    OR NOT EXISTS (SELECT 1 FROM realtime_events WHERE scope = 'files' AND folder_ids = ARRAY[''])
  THEN RAISE EXCEPTION 'encrypted folder head omitted its path or parent listing'; END IF;
END $$;
TRUNCATE realtime_events;
