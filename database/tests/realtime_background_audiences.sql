\set ON_ERROR_STOP on
-- Called by realtime_changes.sh after its fixtures and helper functions exist.
-- Large recipient fanout is absent from the foreground transaction and bounded
-- by 8 pages of 128 source rows per background expansion call.
INSERT INTO users (id, username, password_hash, role)
SELECT 'usr_rt_fanout_' || n, 'rt_fanout_' || n, 'test-only', 'user'
FROM generate_series(1, 1500) n;
INSERT INTO files (id, owner_id, original_name, storage_name, size_bytes, entry_type)
VALUES ('fil_rt_fanout', 'usr_rt_owner', 'fanout', 'rt/fanout', 0, 'folder');
INSERT INTO file_shares (id, file_id, owner_id, recipient_id)
SELECT 'fsh_rt_fanout_' || n, 'fil_rt_fanout', 'usr_rt_owner', 'usr_rt_fanout_' || n
FROM generate_series(1, 1500) n;
SELECT realtime_test_dispatch();
TRUNCATE realtime_outbox, realtime_events, realtime_audience_jobs, realtime_audience_deliveries;
UPDATE files SET favorite = TRUE WHERE id = 'fil_rt_fanout';
DO $$ BEGIN
  IF (SELECT count(*) FROM realtime_audience_jobs) <> 1
    OR (SELECT count(*) FROM realtime_outbox) <> 1
    OR EXISTS (SELECT 1 FROM realtime_outbox WHERE scope = 'shared')
  THEN RAISE EXCEPTION 'foreground expanded 1500 recipients'; END IF;
END $$;
SELECT realtime_expand_audiences();
DO $$ BEGIN
  IF (SELECT count(*) FROM realtime_outbox WHERE scope = 'shared') > 1024
    OR NOT EXISTS (SELECT 1 FROM realtime_audience_jobs WHERE NOT complete)
  THEN RAISE EXCEPTION 'recipient fanout exceeded background page budget'; END IF;
END $$;
SELECT realtime_test_dispatch();
DO $$ BEGIN
  IF (SELECT count(DISTINCT user_id) FROM realtime_events WHERE scope = 'shared') <> 1500
    OR EXISTS (SELECT 1 FROM realtime_events WHERE scope = 'shared' AND cardinality(folder_ids) <> 0)
    OR EXISTS (SELECT 1 FROM realtime_audience_jobs) OR EXISTS (SELECT 1 FROM realtime_audience_deliveries)
  THEN RAISE EXCEPTION 'paged fanout lost an audience, leaked IDs, or failed to reclaim work'; END IF;
END $$;
DELETE FROM files WHERE id = 'fil_rt_fanout';
SELECT realtime_test_dispatch();

-- A saved node path may be moved again before dispatch. Old/new recipients
-- still catch up, even when the old grant is deleted before expansion.
INSERT INTO files (id, owner_id, original_name, storage_name, size_bytes, entry_type, parent_id)
VALUES ('fil_rt_before', 'usr_rt_owner', 'before', 'rt/before', 0, 'folder', NULL),
  ('fil_rt_after', 'usr_rt_owner', 'after', 'rt/after', 0, 'folder', NULL),
  ('fil_rt_subtree', 'usr_rt_owner', 'subtree', 'rt/subtree', 0, 'folder', 'fil_rt_before'),
  ('fil_rt_leaf', 'usr_rt_owner', 'leaf', 'rt/leaf', 1, 'file', 'fil_rt_subtree');
INSERT INTO file_shares (id, file_id, owner_id, recipient_id) VALUES
  ('fsh_rt_before', 'fil_rt_before', 'usr_rt_owner', 'usr_rt_recipient'),
  ('fsh_rt_after', 'fil_rt_after', 'usr_rt_owner', 'usr_rt_other');
SELECT realtime_test_dispatch();
TRUNCATE realtime_outbox, realtime_events, realtime_audience_jobs, realtime_audience_deliveries;
UPDATE files SET favorite = TRUE WHERE id = 'fil_rt_leaf';
UPDATE files SET parent_id = 'fil_rt_after' WHERE id = 'fil_rt_subtree';
DELETE FROM file_shares WHERE id = 'fsh_rt_before';
SELECT realtime_test_dispatch();
DO $$ BEGIN
  IF (SELECT count(DISTINCT user_id) FROM realtime_events WHERE scope = 'shared') <> 2
  THEN RAISE EXCEPTION 'deferred move/revocation lost an old or new audience'; END IF;
END $$;
TRUNCATE realtime_outbox, realtime_events, realtime_audience_jobs, realtime_audience_deliveries;
UPDATE files SET favorite = FALSE WHERE id = 'fil_rt_leaf';
SELECT realtime_test_dispatch();
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM realtime_events WHERE user_id = 'usr_rt_recipient')
    OR NOT EXISTS (SELECT 1 FROM realtime_events WHERE user_id = 'usr_rt_other' AND scope = 'shared')
  THEN RAISE EXCEPTION 'ordinary changes followed an obsolete moved path'; END IF;
END $$;

-- Deep ancestry continues over multiple bounded dispatcher transactions, and
-- sibling/head paths share the same transaction/node dedup fence.
INSERT INTO files (id, owner_id, original_name, storage_name, size_bytes, entry_type, parent_id)
SELECT 'fil_rt_deep_' || n, 'usr_rt_owner', 'deep', 'rt/deep/' || n, 0, 'folder',
  CASE WHEN n = 1 THEN 'fil_rt_after' ELSE 'fil_rt_deep_' || (n - 1) END
FROM generate_series(1, 80) n;
INSERT INTO file_shares (id, file_id, owner_id, recipient_id)
SELECT 'fsh_rt_deep_' || n, 'fil_rt_deep_' || n, 'usr_rt_owner', 'usr_rt_other'
FROM generate_series(1, 80) n;
SELECT realtime_test_dispatch();
TRUNCATE realtime_outbox, realtime_events, realtime_audience_jobs, realtime_audience_deliveries;
UPDATE files SET favorite = TRUE WHERE id = 'fil_rt_deep_80';
DO $$ BEGIN
  IF realtime_dispatch() <> 512 OR NOT EXISTS (SELECT 1 FROM realtime_audience_jobs WHERE NOT complete)
  THEN RAISE EXCEPTION 'deep traversal did not yield at the background budget'; END IF;
END $$;
SELECT realtime_test_dispatch();
DO $$ BEGIN
  IF (SELECT count(*) FROM realtime_events WHERE user_id = 'usr_rt_other' AND scope = 'shared') <> 1
    OR EXISTS (SELECT 1 FROM realtime_audience_jobs) OR EXISTS (SELECT 1 FROM realtime_audience_deliveries)
  THEN RAISE EXCEPTION 'deep traversal did not converge or repeated a recipient across pages'; END IF;
END $$;

-- Share expiration during a slow writer/dispatcher gap must not erase a
-- recipient who could access the file when its change was written.
BEGIN;
INSERT INTO share_links (id, token_hash, owner_id, root_file_id, access_scope, permission, recipient_id, expires_at)
VALUES ('sl_rt_expiring', 'rt-expiring-token', 'usr_rt_owner', 'fil_rt_after',
  'account', 'viewer', 'usr_rt_recipient', now() + interval '0.2 seconds');
TRUNCATE realtime_outbox, realtime_events, realtime_audience_jobs, realtime_audience_deliveries;
UPDATE files SET favorite = NOT favorite WHERE id = 'fil_rt_leaf';
SELECT pg_sleep(0.3);
COMMIT;
SELECT realtime_test_dispatch();
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM realtime_events WHERE user_id = 'usr_rt_recipient' AND scope = 'shared')
  THEN RAISE EXCEPTION 'share expiration during queue lag lost the writer audience'; END IF;
END $$;
DELETE FROM share_links WHERE id = 'sl_rt_expiring';
SELECT realtime_test_dispatch();

-- Deleting the encrypted share cascades its recipient rows. Their OLD values
-- must remain durable even though deferred vault lookup now returns no rows.
UPDATE vault_share_recipients SET status = 'active', revoked_at = NULL WHERE share_id = 'vsh_rt';
SELECT realtime_test_dispatch();
TRUNCATE realtime_outbox, realtime_events, realtime_audience_jobs, realtime_audience_deliveries;
DELETE FROM vault_shares WHERE id = 'vsh_rt';
SELECT realtime_test_dispatch();
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM realtime_events WHERE user_id = 'usr_rt_recipient' AND scope = 'shared')
  THEN RAISE EXCEPTION 'encrypted cascade delete lost the former recipient'; END IF;
END $$;
TRUNCATE realtime_outbox, realtime_events, realtime_audience_jobs, realtime_audience_deliveries;
