-- Keep status/claim progress independent of the number of remaining nodes.
\set ON_ERROR_STOP on

BEGIN;
SELECT pg_advisory_xact_lock(hashtextextended('aeralyth:migration:028-migration-progress', 0));
SELECT NOT EXISTS (
  SELECT 1 FROM schema_migrations WHERE version = '028-migration-progress'
) AS apply_migration \gset

\if :apply_migration

-- Block source writes through backfill and trigger installation. Readers remain
-- available. This also prevents a commit from falling between those two steps.
LOCK TABLE files, vault_migrations IN SHARE ROW EXCLUSIVE MODE;

CREATE TABLE vault_migration_progress (
  owner_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  legacy_nodes BIGINT NOT NULL DEFAULT 0 CHECK (legacy_nodes >= 0),
  incomplete_nodes BIGINT NOT NULL DEFAULT 0 CHECK (incomplete_nodes >= 0)
);

-- The union used by the old summary must count a staged file with an unfinished
-- migration once. Separate flags also serialize concurrent writes to the same
-- node. There is deliberately no files FK: file deletion and migration cascade
-- triggers must each clear their own contribution, regardless of trigger order.
CREATE TABLE vault_migration_node_progress (
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL,
  legacy BOOLEAN NOT NULL DEFAULT FALSE,
  staged BOOLEAN NOT NULL DEFAULT FALSE,
  migration_incomplete BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (owner_id, node_id)
);

-- Statement triggers keep bulk operations to one summary write per owner. The
-- node rows serialize overlapping file/migration updates before the delta is
-- applied, so both flags changing concurrently cannot double count the union.
CREATE FUNCTION insert_vault_migration_progress()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO vault_migration_progress (owner_id, legacy_nodes, incomplete_nodes)
  SELECT owner_id, sum(legacy::integer), sum((staged OR migration_incomplete)::integer)
  FROM new_progress GROUP BY owner_id
  HAVING bool_or(legacy OR staged OR migration_incomplete)
  ON CONFLICT (owner_id) DO UPDATE SET
    legacy_nodes = vault_migration_progress.legacy_nodes + EXCLUDED.legacy_nodes,
    incomplete_nodes = vault_migration_progress.incomplete_nodes + EXCLUDED.incomplete_nodes;
  RETURN NULL;
END;
$$;

CREATE FUNCTION change_vault_migration_progress()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  UPDATE vault_migration_progress AS progress SET
    legacy_nodes = progress.legacy_nodes + delta.legacy_nodes,
    incomplete_nodes = progress.incomplete_nodes + delta.incomplete_nodes
  FROM (
    SELECT owner_id, sum(legacy_nodes) AS legacy_nodes, sum(incomplete_nodes) AS incomplete_nodes
    FROM (
      SELECT owner_id, legacy::integer AS legacy_nodes,
        (staged OR migration_incomplete)::integer AS incomplete_nodes FROM new_progress
      UNION ALL
      SELECT owner_id, -legacy::integer, -(staged OR migration_incomplete)::integer
      FROM old_progress
    ) AS changes GROUP BY owner_id
    HAVING sum(legacy_nodes) <> 0 OR sum(incomplete_nodes) <> 0
  ) AS delta WHERE progress.owner_id = delta.owner_id;
  RETURN NULL;
END;
$$;

CREATE FUNCTION delete_vault_migration_progress()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  -- UPDATE never recreates counters during a cascading owner deletion.
  UPDATE vault_migration_progress AS progress SET
    legacy_nodes = progress.legacy_nodes - delta.legacy_nodes,
    incomplete_nodes = progress.incomplete_nodes - delta.incomplete_nodes
  FROM (
    SELECT owner_id, sum(legacy::integer) AS legacy_nodes,
      sum((staged OR migration_incomplete)::integer) AS incomplete_nodes
    FROM old_progress GROUP BY owner_id
    HAVING bool_or(legacy OR staged OR migration_incomplete)
  ) AS delta WHERE progress.owner_id = delta.owner_id;
  RETURN NULL;
END;
$$;

CREATE TRIGGER vault_migration_progress_insert
AFTER INSERT ON vault_migration_node_progress REFERENCING NEW TABLE AS new_progress
FOR EACH STATEMENT EXECUTE FUNCTION insert_vault_migration_progress();
CREATE TRIGGER vault_migration_progress_update
AFTER UPDATE ON vault_migration_node_progress
REFERENCING OLD TABLE AS old_progress NEW TABLE AS new_progress
FOR EACH STATEMENT EXECUTE FUNCTION change_vault_migration_progress();
CREATE TRIGGER vault_migration_progress_delete
AFTER DELETE ON vault_migration_node_progress REFERENCING OLD TABLE AS old_progress
FOR EACH STATEMENT EXECUTE FUNCTION delete_vault_migration_progress();

CREATE FUNCTION track_file_migration_progress()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO vault_migration_node_progress (owner_id, node_id, legacy, staged)
    SELECT owner_id, id, e2ee_state = 'legacy', e2ee_state = 'staged'
    FROM new_files WHERE e2ee_state IN ('legacy', 'staged')
    ORDER BY owner_id, id
    ON CONFLICT (owner_id, node_id) DO UPDATE SET
      legacy = EXCLUDED.legacy, staged = EXCLUDED.staged;
  ELSIF TG_OP = 'UPDATE' THEN
    -- Transition tables have no indexes. Compute the changed state sets once
    -- before joining the indexed tracker; correlated anti-joins can scan the
    -- whole transition table for every row of a bulk trash/restore operation.
    WITH changed AS MATERIALIZED (
      SELECT owner_id, id, e2ee_state FROM old_files
      EXCEPT
      SELECT owner_id, id, e2ee_state FROM new_files
    )
    UPDATE vault_migration_node_progress AS progress SET legacy = FALSE, staged = FALSE
    FROM changed AS previous
    WHERE progress.owner_id = previous.owner_id AND progress.node_id = previous.id
      AND (progress.legacy OR progress.staged);
    WITH changed AS MATERIALIZED (
      SELECT owner_id, id, e2ee_state FROM new_files
      EXCEPT
      SELECT owner_id, id, e2ee_state FROM old_files
    )
    INSERT INTO vault_migration_node_progress (owner_id, node_id, legacy, staged)
    SELECT next.owner_id, next.id, next.e2ee_state = 'legacy', next.e2ee_state = 'staged'
    FROM changed AS next WHERE next.e2ee_state IN ('legacy', 'staged')
    ORDER BY next.owner_id, next.id
    ON CONFLICT (owner_id, node_id) DO UPDATE SET
      legacy = EXCLUDED.legacy, staged = EXCLUDED.staged;
  ELSE
    UPDATE vault_migration_node_progress AS progress SET legacy = FALSE, staged = FALSE
    FROM old_files AS previous
    WHERE progress.owner_id = previous.owner_id AND progress.node_id = previous.id
      AND (progress.legacy OR progress.staged);
  END IF;
  IF TG_OP <> 'INSERT' THEN
    DELETE FROM vault_migration_node_progress AS progress USING old_files AS previous
    WHERE progress.owner_id = previous.owner_id AND progress.node_id = previous.id
      AND NOT progress.legacy AND NOT progress.staged AND NOT progress.migration_incomplete;
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER files_migration_progress_insert
AFTER INSERT ON files REFERENCING NEW TABLE AS new_files
FOR EACH STATEMENT EXECUTE FUNCTION track_file_migration_progress();
CREATE TRIGGER files_migration_progress_update
AFTER UPDATE ON files REFERENCING OLD TABLE AS old_files NEW TABLE AS new_files
FOR EACH STATEMENT EXECUTE FUNCTION track_file_migration_progress();
CREATE TRIGGER files_migration_progress_delete
AFTER DELETE ON files REFERENCING OLD TABLE AS old_files
FOR EACH STATEMENT EXECUTE FUNCTION track_file_migration_progress();

CREATE FUNCTION track_vault_migration_progress()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO vault_migration_node_progress (owner_id, node_id, migration_incomplete)
    SELECT owner_id, node_id, TRUE FROM new_migrations WHERE state <> 'complete'
    ORDER BY owner_id, node_id
    ON CONFLICT (owner_id, node_id) DO UPDATE SET migration_incomplete = TRUE;
  ELSIF TG_OP = 'UPDATE' THEN
    WITH changed AS MATERIALIZED (
      SELECT owner_id, node_id, state <> 'complete' AS incomplete FROM old_migrations
      EXCEPT
      SELECT owner_id, node_id, state <> 'complete' AS incomplete FROM new_migrations
    )
    UPDATE vault_migration_node_progress AS progress SET migration_incomplete = FALSE
    FROM changed AS previous
    WHERE progress.owner_id = previous.owner_id AND progress.node_id = previous.node_id
      AND progress.migration_incomplete;
    WITH changed AS MATERIALIZED (
      SELECT owner_id, node_id, state <> 'complete' AS incomplete FROM new_migrations
      EXCEPT
      SELECT owner_id, node_id, state <> 'complete' AS incomplete FROM old_migrations
    )
    INSERT INTO vault_migration_node_progress (owner_id, node_id, migration_incomplete)
    SELECT next.owner_id, next.node_id, TRUE FROM changed AS next
    WHERE next.incomplete
    ORDER BY next.owner_id, next.node_id
    ON CONFLICT (owner_id, node_id) DO UPDATE SET migration_incomplete = TRUE;
  ELSE
    UPDATE vault_migration_node_progress AS progress SET migration_incomplete = FALSE
    FROM old_migrations AS previous
    WHERE progress.owner_id = previous.owner_id AND progress.node_id = previous.node_id
      AND progress.migration_incomplete;
  END IF;
  IF TG_OP <> 'INSERT' THEN
    DELETE FROM vault_migration_node_progress AS progress USING old_migrations AS previous
    WHERE progress.owner_id = previous.owner_id AND progress.node_id = previous.node_id
      AND NOT progress.legacy AND NOT progress.staged AND NOT progress.migration_incomplete;
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER vault_migrations_progress_insert
AFTER INSERT ON vault_migrations REFERENCING NEW TABLE AS new_migrations
FOR EACH STATEMENT EXECUTE FUNCTION track_vault_migration_progress();
CREATE TRIGGER vault_migrations_progress_update
AFTER UPDATE ON vault_migrations
REFERENCING OLD TABLE AS old_migrations NEW TABLE AS new_migrations
FOR EACH STATEMENT EXECUTE FUNCTION track_vault_migration_progress();
CREATE TRIGGER vault_migrations_progress_delete
AFTER DELETE ON vault_migrations REFERENCING OLD TABLE AS old_migrations
FOR EACH STATEMENT EXECUTE FUNCTION track_vault_migration_progress();

-- Explicit maintenance only, never called from status, claims, or a timer. The
-- source locks prevent concurrent transitions from being omitted/double counted.
-- Run outside peak traffic because a full rebuild blocks writes while it runs.
CREATE FUNCTION reconcile_vault_migration_progress()
RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  LOCK TABLE files, vault_migrations IN SHARE ROW EXCLUSIVE MODE;
  TRUNCATE vault_migration_node_progress, vault_migration_progress;
  INSERT INTO vault_migration_node_progress
    (owner_id, node_id, legacy, staged, migration_incomplete)
  SELECT owner_id, node_id, bool_or(legacy), bool_or(staged), bool_or(migration_incomplete)
  FROM (
    SELECT owner_id, id AS node_id, e2ee_state = 'legacy' AS legacy,
      e2ee_state = 'staged' AS staged, FALSE AS migration_incomplete
    FROM files WHERE e2ee_state IN ('legacy', 'staged')
    UNION ALL
    SELECT owner_id, node_id, FALSE, FALSE, TRUE
    FROM vault_migrations WHERE state <> 'complete'
  ) AS contributions
  GROUP BY owner_id, node_id;
END;
$$;

SELECT reconcile_vault_migration_progress();
INSERT INTO schema_migrations (version) VALUES ('028-migration-progress');
\else
\echo 'Skipping already-applied migration 028-migration-progress'
\endif
COMMIT;
