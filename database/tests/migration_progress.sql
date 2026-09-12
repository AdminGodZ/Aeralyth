\set ON_ERROR_STOP on
BEGIN;
SET LOCAL synchronous_commit = off;

INSERT INTO users (id, username, password_hash, role, status) VALUES
  ('usr_progress_a', 'progress-a', 'not-a-login-hash', 'user', 'active'),
  ('usr_progress_b', 'progress-b', 'not-a-login-hash', 'user', 'active');

CREATE FUNCTION pg_temp.assert_progress(account TEXT, expected_legacy BIGINT, expected_pending BIGINT)
RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE
  actual_legacy BIGINT;
  actual_pending BIGINT;
  canonical_legacy BIGINT;
  canonical_pending BIGINT;
BEGIN
  SELECT COALESCE(progress.legacy_nodes, 0), COALESCE(progress.incomplete_nodes, 0)
  INTO actual_legacy, actual_pending FROM (VALUES (account)) AS owner(id)
  LEFT JOIN vault_migration_progress AS progress ON progress.owner_id = owner.id;
  SELECT count(*) INTO canonical_legacy FROM files
  WHERE owner_id = account AND e2ee_state = 'legacy';
  SELECT count(DISTINCT node_id) INTO canonical_pending FROM (
    SELECT id AS node_id FROM files WHERE owner_id = account AND e2ee_state = 'staged'
    UNION ALL
    SELECT node_id FROM vault_migrations WHERE owner_id = account AND state <> 'complete'
  ) AS pending;
  IF (actual_legacy, actual_pending) IS DISTINCT FROM (expected_legacy, expected_pending)
    OR (actual_legacy, actual_pending) IS DISTINCT FROM (canonical_legacy, canonical_pending) THEN
    RAISE EXCEPTION 'progress % actual=(%,%) canonical=(%,%) expected=(%,%)',
      account, actual_legacy, actual_pending, canonical_legacy, canonical_pending,
      expected_legacy, expected_pending;
  END IF;
END;
$$;

CREATE TEMP TABLE progress_writes (owner_id TEXT) ON COMMIT DROP;
CREATE FUNCTION pg_temp.capture_progress_write() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO progress_writes VALUES (NEW.owner_id);
  RETURN NULL;
END;
$$;
CREATE TRIGGER test_progress_writes AFTER INSERT OR UPDATE ON vault_migration_progress
FOR EACH ROW EXECUTE FUNCTION pg_temp.capture_progress_write();

SELECT pg_temp.assert_progress('usr_progress_a', 0, 0);
INSERT INTO files (id, owner_id, original_name, storage_name, size_bytes, entry_type, e2ee_state)
VALUES
  ('fil_progress_legacy', 'usr_progress_a', 'legacy', 'progress/legacy', 0, 'file', 'legacy'),
  ('fil_progress_folder', 'usr_progress_a', 'folder', 'progress/folder', 0, 'folder', 'legacy'),
  ('fil_progress_staged', 'usr_progress_a', 'staged', 'progress/staged', 0, 'file', 'staged'),
  ('fil_progress_cleanup', 'usr_progress_a', 'cleanup', 'progress/cleanup', 0, 'file', 'encrypted');
SELECT pg_temp.assert_progress('usr_progress_a', 2, 1);
DO $$ BEGIN
  IF (SELECT count(*) FROM progress_writes) <> 1 THEN
    RAISE EXCEPTION 'bulk insert wrote the owner summary more than once';
  END IF;
END $$;

INSERT INTO vault_migrations (node_id, owner_id, state) VALUES
  ('fil_progress_staged', 'usr_progress_a', 'failed'),
  ('fil_progress_cleanup', 'usr_progress_a', 'cleanup_queued');
SELECT pg_temp.assert_progress('usr_progress_a', 2, 2);

-- Interrupted upload/retry transitions must not count the same node twice or
-- rewrite progress when its contribution remains unchanged.
TRUNCATE progress_writes;
UPDATE vault_migrations SET state = 'encrypting', attempts = attempts + 1
WHERE node_id = 'fil_progress_staged';
UPDATE vault_migrations SET state = 'verifying' WHERE node_id = 'fil_progress_staged';
UPDATE files SET updated_at = clock_timestamp() WHERE owner_id = 'usr_progress_a';
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM progress_writes) THEN
    RAISE EXCEPTION 'retry or metadata update rewrote unchanged progress';
  END IF;
END $$;
SELECT pg_temp.assert_progress('usr_progress_a', 2, 2);

-- Completed migration metadata cannot hide a file that is still staged.
UPDATE vault_migrations SET state = 'complete' WHERE node_id = 'fil_progress_staged';
SELECT pg_temp.assert_progress('usr_progress_a', 2, 2);
UPDATE files SET e2ee_state = 'encrypted' WHERE id = 'fil_progress_staged';
SELECT pg_temp.assert_progress('usr_progress_a', 2, 1);

-- A folder without object cleanup can finish directly. Cleanup elsewhere keeps
-- ready_for_required false until the cleanup transition commits.
UPDATE files SET e2ee_state = 'encrypted' WHERE id = 'fil_progress_folder';
SELECT pg_temp.assert_progress('usr_progress_a', 1, 1);
SAVEPOINT interrupted_cleanup;
UPDATE vault_migrations SET state = 'complete' WHERE node_id = 'fil_progress_cleanup';
SELECT pg_temp.assert_progress('usr_progress_a', 1, 0);
ROLLBACK TO SAVEPOINT interrupted_cleanup;
SELECT pg_temp.assert_progress('usr_progress_a', 1, 1);

UPDATE files SET e2ee_state = 'staged' WHERE id = 'fil_progress_legacy';
INSERT INTO vault_migrations (node_id, owner_id, state)
VALUES ('fil_progress_legacy', 'usr_progress_a', 'encrypting');
SELECT pg_temp.assert_progress('usr_progress_a', 0, 2);
DELETE FROM vault_migrations WHERE node_id = 'fil_progress_legacy';
SELECT pg_temp.assert_progress('usr_progress_a', 0, 2);

-- Ownership is tracked independently for the two source tables, matching the
-- original SQL even during an ownership transition across statements.
UPDATE files SET owner_id = 'usr_progress_b' WHERE id = 'fil_progress_legacy';
SELECT pg_temp.assert_progress('usr_progress_a', 0, 1);
SELECT pg_temp.assert_progress('usr_progress_b', 0, 1);
UPDATE vault_migrations SET owner_id = 'usr_progress_b' WHERE node_id = 'fil_progress_cleanup';
SELECT pg_temp.assert_progress('usr_progress_a', 0, 0);
SELECT pg_temp.assert_progress('usr_progress_b', 0, 2);

DELETE FROM files WHERE id = 'fil_progress_cleanup';
SELECT pg_temp.assert_progress('usr_progress_b', 0, 1);
INSERT INTO vault_migrations (node_id, owner_id, state)
VALUES ('fil_progress_legacy', 'usr_progress_b', 'failed');
DELETE FROM files WHERE id = 'fil_progress_legacy';
SELECT pg_temp.assert_progress('usr_progress_b', 0, 0);

INSERT INTO files (id, owner_id, original_name, storage_name, size_bytes, entry_type)
VALUES ('fil_progress_rebuild', 'usr_progress_a', 'rebuild', 'progress/rebuild', 0, 'folder');
UPDATE vault_migration_progress SET legacy_nodes = 987, incomplete_nodes = 654
WHERE owner_id = 'usr_progress_a';
SELECT reconcile_vault_migration_progress();
SELECT pg_temp.assert_progress('usr_progress_a', 1, 0);
SELECT pg_temp.assert_progress('usr_progress_b', 0, 0);
SELECT reconcile_vault_migration_progress();
SELECT pg_temp.assert_progress('usr_progress_a', 1, 0);

-- Doubling the tiny-node population leaves each progress read at one summary
-- row. Capture each actual query plan, including the cumulative rows examined.
CREATE TEMP TABLE progress_scaling (nodes INTEGER, reads INTEGER, rows_examined BIGINT);
DO $$
DECLARE
  population INTEGER;
  node_number INTEGER;
  progress_plan JSONB;
  total_rows BIGINT;
  plan_rows BIGINT;
BEGIN
  FOREACH population IN ARRAY ARRAY[1000, 2000] LOOP
    INSERT INTO files (id, owner_id, original_name, storage_name, size_bytes, entry_type)
    SELECT 'fil_progress_scale_' || value, 'usr_progress_b', 'tiny-' || value,
      'progress/scale/' || value, 0, 'folder' FROM generate_series(1, population) AS value;
    PERFORM pg_temp.assert_progress('usr_progress_b', population, 0);
    total_rows := 0;
    FOR node_number IN 1..population LOOP
      UPDATE files SET e2ee_state = 'encrypted' WHERE id = 'fil_progress_scale_' || node_number;
      EXECUTE $query$
        EXPLAIN (ANALYZE, FORMAT JSON, COSTS OFF, TIMING OFF, SUMMARY OFF)
        SELECT COALESCE(progress.legacy_nodes, 0)::bigint AS legacy_nodes,
          COALESCE(progress.incomplete_nodes, 0)::bigint AS incomplete_nodes
        FROM (VALUES ('usr_progress_b'::text)) AS owner(id)
        LEFT JOIN vault_migration_progress AS progress ON progress.owner_id = owner.id
      $query$ INTO progress_plan;
      IF progress_plan::text LIKE '%"Relation Name": "files"%'
        OR progress_plan::text LIKE '%"Relation Name": "vault_migrations"%'
        OR progress_plan::text LIKE '%"Relation Name": "vault_migration_node_progress"%' THEN
        RAISE EXCEPTION 'progress query scanned source nodes: %', progress_plan;
      END IF;
      WITH RECURSIVE plans AS (
        SELECT progress_plan->0->'Plan' AS plan
        UNION ALL
        SELECT child FROM plans CROSS JOIN LATERAL jsonb_array_elements(plan->'Plans') AS child
      ) SELECT sum(COALESCE((plan->>'Actual Rows')::numeric, 0)
          + COALESCE((plan->>'Rows Removed by Filter')::numeric, 0))
        INTO plan_rows FROM plans WHERE plan ? 'Relation Name';
      total_rows := total_rows + plan_rows;
    END LOOP;
    PERFORM pg_temp.assert_progress('usr_progress_b', 0, 0);
    INSERT INTO progress_scaling VALUES (population, population, total_rows);
    DELETE FROM files WHERE id LIKE 'fil_progress_scale_%';
  END LOOP;
  IF (SELECT rows_examined FROM progress_scaling WHERE nodes = 2000)
    > 2 * (SELECT rows_examined FROM progress_scaling WHERE nodes = 1000) THEN
    RAISE EXCEPTION 'doubling migration population more than doubled progress rows';
  END IF;
END;
$$;
TABLE progress_scaling;

DELETE FROM users WHERE id IN ('usr_progress_a', 'usr_progress_b');
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM vault_migration_progress WHERE owner_id IN ('usr_progress_a', 'usr_progress_b'))
    OR EXISTS (SELECT 1 FROM vault_migration_node_progress WHERE owner_id IN ('usr_progress_a', 'usr_progress_b')) THEN
    RAISE EXCEPTION 'owner deletion left migration progress behind';
  END IF;
END $$;
ROLLBACK;
\echo 'migration progress transitions, rollback, reconciliation, bulk writes and linear read scaling passed'
