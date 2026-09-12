\set ON_ERROR_STOP on
BEGIN;
SET LOCAL statement_timeout = '10s';
SET LOCAL lock_timeout = '3s';
SET LOCAL synchronous_commit = off;

-- Each source statement remains bounded to 1,000 inserted or 5,000 updated
-- nodes, while the second account contains the 100,001-node scale fixture.
CREATE TEMP TABLE progress_bulk_accounts (owner_id TEXT, prefix TEXT, nodes INTEGER);
INSERT INTO progress_bulk_accounts VALUES
  ('usr_progress_bulk_small', 'fil_progress_bulk_small_', 5000),
  ('usr_progress_bulk_large', 'fil_progress_bulk_large_', 100001);
INSERT INTO users (id, username, password_hash, role, status)
SELECT owner_id, owner_id, 'not-a-login-hash', 'user', 'active' FROM progress_bulk_accounts;
INSERT INTO files (id, owner_id, original_name, storage_name, size_bytes, entry_type)
SELECT prefix || '000000', owner_id, 'root', prefix || '000000', 0, 'folder'
FROM progress_bulk_accounts;
SELECT format($query$
  INSERT INTO files (id, owner_id, parent_id, original_name, storage_name, size_bytes, entry_type)
  SELECT %L || lpad(n::text, 6, '0'), %L, %L || '000000', 'tiny-' || n,
    %L || n, 1, 'file' FROM generate_series(%s, %s) AS n
$query$, prefix, owner_id, prefix, prefix, first_node, LEAST(first_node + 999, nodes - 1))
FROM progress_bulk_accounts CROSS JOIN LATERAL generate_series(1, nodes - 1, 1000) AS first_node
ORDER BY nodes, first_node \gexec

CREATE TEMP TABLE progress_bulk_writes (owner_id TEXT);
CREATE FUNCTION pg_temp.capture_progress_bulk_write() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO progress_bulk_writes VALUES (NEW.owner_id);
  RETURN NULL;
END;
$$;
CREATE TRIGGER test_progress_bulk_writes AFTER INSERT OR UPDATE ON vault_migration_progress
FOR EACH ROW EXECUTE FUNCTION pg_temp.capture_progress_bulk_write();

\echo '5,000-row legacy trash and restore statements with 5,000 and 100,001 account nodes'
\timing on
SELECT format($query$
  UPDATE files SET state = %L, trashed_at = %s, updated_at = clock_timestamp()
  WHERE owner_id = %L AND id BETWEEN %L AND %L
$query$, target_state, CASE WHEN target_state = 'trashed' THEN 'now()' ELSE 'NULL' END,
  owner_id, prefix || lpad(first_node::text, 6, '0'),
  prefix || lpad(LEAST(first_node + 4999, nodes - 1)::text, 6, '0'))
FROM progress_bulk_accounts
CROSS JOIN (VALUES ('trashed', 1), ('active', 2)) AS states(target_state, sequence)
CROSS JOIN LATERAL generate_series(0, nodes - 1, 5000) AS first_node
ORDER BY nodes, sequence, first_node \gexec
\timing off
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM progress_bulk_writes) THEN
    RAISE EXCEPTION 'trash/restore rewrote migration counters without an E2EE state change';
  END IF;
  IF EXISTS (
    SELECT 1 FROM progress_bulk_accounts AS account
    LEFT JOIN vault_migration_progress AS progress ON progress.owner_id = account.owner_id
    WHERE progress.legacy_nodes IS DISTINCT FROM account.nodes::bigint
      OR progress.incomplete_nodes IS DISTINCT FROM 0::bigint
  ) THEN RAISE EXCEPTION 'legacy progress changed during bulk trash/restore'; END IF;
END $$;

SELECT format($query$
  INSERT INTO vault_migrations (node_id, owner_id, state)
  SELECT id, owner_id, 'pending' FROM files
  WHERE owner_id = %L AND id BETWEEN %L AND %L
$query$, owner_id, prefix || lpad(first_node::text, 6, '0'),
  prefix || lpad(LEAST(first_node + 999, nodes - 1)::text, 6, '0'))
FROM progress_bulk_accounts CROSS JOIN LATERAL generate_series(0, nodes - 1, 1000) AS first_node
ORDER BY nodes, first_node \gexec
TRUNCATE progress_bulk_writes;

\echo '5,000-row pending-to-failed retry transitions keep the same incomplete contribution'
\timing on
SELECT format($query$
  UPDATE vault_migrations SET state = 'failed', attempts = attempts + 1
  WHERE owner_id = %L AND node_id BETWEEN %L AND %L
$query$, owner_id, prefix || lpad(first_node::text, 6, '0'),
  prefix || lpad(LEAST(first_node + 4999, nodes - 1)::text, 6, '0'))
FROM progress_bulk_accounts CROSS JOIN LATERAL generate_series(0, nodes - 1, 5000) AS first_node
ORDER BY nodes, first_node \gexec
\timing off
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM progress_bulk_writes) THEN
    RAISE EXCEPTION 'same-contribution retry transitions rewrote migration counters';
  END IF;
  IF EXISTS (
    SELECT 1 FROM progress_bulk_accounts AS account
    LEFT JOIN vault_migration_progress AS progress ON progress.owner_id = account.owner_id
    WHERE progress.legacy_nodes IS DISTINCT FROM account.nodes::bigint
      OR progress.incomplete_nodes IS DISTINCT FROM account.nodes::bigint
  ) THEN RAISE EXCEPTION 'retry progress does not match the fixture population'; END IF;
END $$;

\echo '5,000-row completion transitions remove only the migration contribution'
\timing on
SELECT format($query$
  UPDATE vault_migrations SET state = 'complete'
  WHERE owner_id = %L AND node_id BETWEEN %L AND %L
$query$, owner_id, prefix || lpad(first_node::text, 6, '0'),
  prefix || lpad(LEAST(first_node + 4999, nodes - 1)::text, 6, '0'))
FROM progress_bulk_accounts CROSS JOIN LATERAL generate_series(0, nodes - 1, 5000) AS first_node
ORDER BY nodes, first_node \gexec
\timing off
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM progress_bulk_accounts AS account
    LEFT JOIN vault_migration_progress AS progress ON progress.owner_id = account.owner_id
    WHERE progress.legacy_nodes IS DISTINCT FROM account.nodes::bigint
      OR progress.incomplete_nodes IS DISTINCT FROM 0::bigint
  ) THEN RAISE EXCEPTION 'completion progress is incorrect'; END IF;
  IF (SELECT count(*) FROM progress_bulk_writes) <> 22 THEN
    RAISE EXCEPTION 'completion did not batch progress writes by owner/source statement';
  END IF;
END $$;
ROLLBACK;
\echo 'migration progress 5,000 / 100,001-node bulk regression passed under 10-second statement timeout'
