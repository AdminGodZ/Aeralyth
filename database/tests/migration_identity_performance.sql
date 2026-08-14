\set ON_ERROR_STOP on

BEGIN;

SET LOCAL synchronous_commit = off;

DO $schema_assertions$
BEGIN
  IF (
    SELECT count(*)
    FROM pg_index
    INNER JOIN pg_class AS indexes ON indexes.oid = pg_index.indexrelid
    WHERE indexes.relname IN (
      'users_username_ci_idx',
      'files_e2ee_migration_claim_idx',
      'vault_migrations_incomplete_owner_idx',
      'vault_migrations_cleanup_object_idx'
    )
      AND pg_index.indisvalid
  ) <> 4 THEN
    RAISE EXCEPTION 'one or more migration/identity indexes are missing or invalid';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_index
    INNER JOIN pg_class AS indexes ON indexes.oid = pg_index.indexrelid
    WHERE indexes.relname = 'users_username_ci_idx'
      AND pg_index.indisunique
  ) THEN
    RAISE EXCEPTION 'case-insensitive username index is not unique';
  END IF;
END
$schema_assertions$;

INSERT INTO users (id, username, password_hash, role, status)
SELECT
  'usr_identity_perf_' || lpad(value::text, 6, '0'),
  'lookup-perf-' || lpad(value::text, 6, '0'),
  'not-a-login-hash',
  'user',
  'active'
FROM generate_series(1, 100000) AS value;

DO $username_uniqueness$
BEGIN
  BEGIN
    INSERT INTO users (id, username, password_hash, role, status)
    VALUES (
      'usr_identity_perf_duplicate',
      'LOOKUP-PERF-100000',
      'not-a-login-hash',
      'user',
      'active'
    );
    RAISE EXCEPTION 'case-variant duplicate username was accepted';
  EXCEPTION
    WHEN unique_violation THEN NULL;
  END;
END
$username_uniqueness$;

ANALYZE users;

DO $username_lookup_plan$
DECLARE
  lookup_plan JSON;
BEGIN
  EXECUTE $explain$
    EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON, COSTS OFF, TIMING OFF, SUMMARY OFF)
    SELECT id, username
    FROM users
    WHERE lower(username) = lower('LOOKUP-PERF-099999')
      AND status = 'active'
    LIMIT 1
  $explain$
  INTO lookup_plan;

  IF lookup_plan::text NOT LIKE '%users_username_ci_idx%' THEN
    RAISE EXCEPTION 'case-insensitive username lookup missed its unique index: %', lookup_plan;
  END IF;
END
$username_lookup_plan$;

INSERT INTO files (
  id, owner_id, original_name, storage_name, size_bytes,
  entry_type, e2ee_state, created_at
)
SELECT
  'fil_migration_perf_' || lpad(value::text, 6, '0'),
  'usr_admingod',
  'migration-node-' || value,
  'migration-performance/node-' || value,
  0,
  'folder',
  CASE
    WHEN value <= 1000 AND value % 2 = 0 THEN 'staged'
    WHEN value <= 1000 THEN 'legacy'
    ELSE 'encrypted'
  END,
  timestamptz '2026-01-01 00:00:00+00' + value * interval '1 second'
FROM generate_series(1, 100000) AS value;

INSERT INTO vault_migrations (
  node_id, owner_id, legacy_object_key, state, updated_at
)
SELECT
  'fil_migration_perf_' || lpad(value::text, 6, '0'),
  'usr_admingod',
  'migration-performance/object-' || value,
  CASE
    WHEN value <= 250 THEN 'cleanup_queued'
    WHEN value <= 500 THEN 'encrypting'
    WHEN value <= 750 THEN 'verifying'
    WHEN value <= 1000 THEN 'failed'
    ELSE 'complete'
  END,
  timestamptz '2026-01-01 00:00:00+00' + value * interval '1 second'
FROM generate_series(1, 100000) AS value;

ANALYZE files;
ANALYZE vault_migrations;

DO $migration_claim_plan$
DECLARE
  claim_plan JSON;
BEGIN
  EXECUTE $explain$
    EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON, COSTS OFF, TIMING OFF, SUMMARY OFF)
    SELECT files.id, files.parent_id, files.entry_type,
           files.original_name, files.mime_type, files.size_bytes,
           files.storage_name,
           (extract(epoch FROM files.updated_at) * 1000)::bigint AS last_modified
    FROM files
    LEFT JOIN files AS parent ON parent.id = files.parent_id
    WHERE files.owner_id = 'usr_admingod'
      AND files.e2ee_state IN ('legacy', 'staged')
      AND (files.parent_id IS NULL OR parent.e2ee_state = 'encrypted')
    ORDER BY files.created_at, files.id
    LIMIT 1
    FOR UPDATE OF files SKIP LOCKED
  $explain$
  INTO claim_plan;

  IF claim_plan::text NOT LIKE '%files_e2ee_migration_claim_idx%' THEN
    RAISE EXCEPTION 'migration claim missed its partial ordered index: %', claim_plan;
  END IF;
  IF claim_plan::text ~ '"Node Type"\s*:\s*"Sort"' THEN
    RAISE EXCEPTION 'migration claim still performs a sort: %', claim_plan;
  END IF;
END
$migration_claim_plan$;

DO $migration_summary_plan$
DECLARE
  summary_plan JSON;
BEGIN
  EXECUTE $explain$
    EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON, COSTS OFF, TIMING OFF, SUMMARY OFF)
    SELECT
      (SELECT count(*)::bigint FROM files
       WHERE owner_id = 'usr_admingod' AND e2ee_state = 'legacy') AS legacy_nodes,
      (SELECT count(DISTINCT pending.node_id)::bigint
       FROM (
         SELECT id AS node_id FROM files
         WHERE owner_id = 'usr_admingod' AND e2ee_state = 'staged'
         UNION ALL
         SELECT node_id FROM vault_migrations
         WHERE owner_id = 'usr_admingod' AND state <> 'complete'
       ) AS pending) AS incomplete_nodes
  $explain$
  INTO summary_plan;

  IF summary_plan::text NOT LIKE '%files_e2ee_migration_claim_idx%'
     OR summary_plan::text NOT LIKE '%vault_migrations_incomplete_owner_idx%' THEN
    RAISE EXCEPTION 'migration summary missed one or more partial indexes: %', summary_plan;
  END IF;
END
$migration_summary_plan$;

DO $migration_cleanup_plan$
DECLARE
  cleanup_plan JSON;
BEGIN
  EXECUTE $explain$
    EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON, COSTS OFF, TIMING OFF, SUMMARY OFF)
    UPDATE vault_migrations
    SET state = 'complete', updated_at = now()
    WHERE legacy_object_key = 'migration-performance/object-42'
      AND state = 'cleanup_queued'
  $explain$
  INTO cleanup_plan;

  IF cleanup_plan::text NOT LIKE '%vault_migrations_cleanup_object_idx%' THEN
    RAISE EXCEPTION 'migration cleanup acknowledgement missed its partial index: %', cleanup_plan;
  END IF;
END
$migration_cleanup_plan$;

ROLLBACK;
