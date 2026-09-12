-- Bounded collection cursors, hierarchy integrity, and measured index cleanup.

\set ON_ERROR_STOP on

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

SELECT pg_advisory_lock(hashtextextended('aeralyth:migration:015-collection-hierarchy-performance', 0));

-- These standalone indexes had no representative reads and duplicate the
-- retained partial browse indexes. Keep this cleanup outside the ledger guard
-- so replay also removes indexes recreated by an older base migration.
DROP INDEX CONCURRENTLY IF EXISTS files_updated_at_idx;
DROP INDEX CONCURRENTLY IF EXISTS files_favorite_idx;
DROP INDEX CONCURRENTLY IF EXISTS files_recent_owner_idx;

SELECT EXISTS (
  SELECT 1
  FROM pg_class AS indexes
  INNER JOIN pg_index ON pg_index.indexrelid = indexes.oid
  WHERE indexes.relname = 'share_links_owner_root_page_idx'
    AND indexes.relnamespace = 'public'::regnamespace
    AND pg_index.indrelid = 'public.share_links'::regclass
    AND pg_index.indisvalid
) AS share_link_page_index_valid \gset

\if :share_link_page_index_valid
\else
DROP INDEX CONCURRENTLY IF EXISTS share_links_owner_root_page_idx;
CREATE INDEX CONCURRENTLY share_links_owner_root_page_idx
  ON share_links (owner_id, root_file_id, created_at DESC, id DESC);
\endif

DROP INDEX CONCURRENTLY IF EXISTS share_links_owner_root_idx;

SELECT EXISTS (
  SELECT 1
  FROM pg_class AS indexes
  INNER JOIN pg_index ON pg_index.indexrelid = indexes.oid
  WHERE indexes.relname = 'vault_shares_owner_root_page_idx'
    AND indexes.relnamespace = 'public'::regnamespace
    AND pg_index.indrelid = 'public.vault_shares'::regclass
    AND pg_index.indisvalid
) AS vault_share_page_index_valid \gset

\if :vault_share_page_index_valid
\else
DROP INDEX CONCURRENTLY IF EXISTS vault_shares_owner_root_page_idx;
CREATE INDEX CONCURRENTLY vault_shares_owner_root_page_idx
  ON vault_shares (owner_id, root_node_id, created_at, id)
  WHERE status IN ('active', 'rotating');
\endif

SELECT NOT EXISTS (
  SELECT 1 FROM schema_migrations WHERE version = '015-collection-hierarchy-performance'
) AS apply_migration \gset

\if :apply_migration

BEGIN;

CREATE OR REPLACE FUNCTION assert_file_hierarchy_valid(changed_ids TEXT[])
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
  violation RECORD;
BEGIN
  IF changed_ids IS NULL OR cardinality(changed_ids) = 0 THEN
    RETURN;
  END IF;

  WITH RECURSIVE hierarchy AS (
    SELECT
      files.id AS origin_id,
      files.owner_id AS origin_owner_id,
      files.id AS node_id,
      files.owner_id AS node_owner_id,
      files.parent_id,
      files.entry_type,
      ARRAY[files.id]::TEXT[] AS visited_ids,
      0::INTEGER AS depth,
      FALSE AS cycle
    FROM files
    WHERE files.id = ANY(changed_ids)

    UNION ALL

    SELECT
      hierarchy.origin_id,
      hierarchy.origin_owner_id,
      parent.id,
      parent.owner_id,
      parent.parent_id,
      parent.entry_type,
      hierarchy.visited_ids || parent.id,
      hierarchy.depth + 1,
      parent.id = ANY(hierarchy.visited_ids)
    FROM hierarchy
    INNER JOIN files AS parent ON parent.id = hierarchy.parent_id
    WHERE NOT hierarchy.cycle
      AND hierarchy.depth < 100
  )
  SELECT
    hierarchy.origin_id,
    CASE
      WHEN hierarchy.cycle THEN 'cycle'
      WHEN hierarchy.node_owner_id <> hierarchy.origin_owner_id THEN 'owner'
      WHEN hierarchy.depth > 0 AND hierarchy.entry_type <> 'folder' THEN 'parent_type'
      WHEN hierarchy.depth = 100 AND hierarchy.parent_id IS NOT NULL THEN 'depth'
    END AS reason
  INTO violation
  FROM hierarchy
  WHERE hierarchy.cycle
     OR hierarchy.node_owner_id <> hierarchy.origin_owner_id
     OR (hierarchy.depth > 0 AND hierarchy.entry_type <> 'folder')
     OR (hierarchy.depth = 100 AND hierarchy.parent_id IS NOT NULL)
  ORDER BY hierarchy.origin_id, hierarchy.depth
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION 'invalid file hierarchy for %: %', violation.origin_id, violation.reason
      USING ERRCODE = '23514';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION validate_inserted_file_hierarchy()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  changed_ids TEXT[];
  owner_key TEXT;
BEGIN
  -- Serialize structural changes per owner so two concurrent folder moves
  -- cannot both validate against stale graphs and create a cycle together.
  FOR owner_key IN
    SELECT DISTINCT owner_id
    FROM inserted_files
    WHERE entry_type = 'folder'
    ORDER BY owner_id
  LOOP
    PERFORM pg_advisory_xact_lock(
      hashtextextended('aeralyth:file-hierarchy:' || owner_key, 0)
    );
  END LOOP;

  SELECT array_agg(id ORDER BY id) INTO changed_ids FROM inserted_files;
  PERFORM assert_file_hierarchy_valid(changed_ids);
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION validate_updated_file_hierarchy()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  changed_ids TEXT[];
  owner_key TEXT;
BEGIN
  FOR owner_key IN
    SELECT DISTINCT owners.owner_id
    FROM (
      SELECT old_files.owner_id
      FROM old_files
      INNER JOIN updated_files USING (id)
      WHERE ROW(old_files.owner_id, old_files.parent_id, old_files.entry_type)
        IS DISTINCT FROM
        ROW(updated_files.owner_id, updated_files.parent_id, updated_files.entry_type)
      UNION
      SELECT updated_files.owner_id
      FROM old_files
      INNER JOIN updated_files USING (id)
      WHERE ROW(old_files.owner_id, old_files.parent_id, old_files.entry_type)
        IS DISTINCT FROM
        ROW(updated_files.owner_id, updated_files.parent_id, updated_files.entry_type)
    ) AS owners
    ORDER BY owners.owner_id
  LOOP
    PERFORM pg_advisory_xact_lock(
      hashtextextended('aeralyth:file-hierarchy:' || owner_key, 0)
    );
  END LOOP;

  SELECT array_agg(updated_files.id ORDER BY updated_files.id)
  INTO changed_ids
  FROM updated_files
  INNER JOIN old_files USING (id)
  WHERE ROW(old_files.owner_id, old_files.parent_id, old_files.entry_type)
    IS DISTINCT FROM
    ROW(updated_files.owner_id, updated_files.parent_id, updated_files.entry_type);

  PERFORM assert_file_hierarchy_valid(changed_ids);
  RETURN NULL;
END;
$$;

-- Refuse to install the guard over already-corrupt data.
SELECT assert_file_hierarchy_valid(array_agg(id ORDER BY id)) FROM files;

DROP TRIGGER IF EXISTS files_hierarchy_insert_guard ON files;
CREATE TRIGGER files_hierarchy_insert_guard
AFTER INSERT ON files
REFERENCING NEW TABLE AS inserted_files
FOR EACH STATEMENT
EXECUTE FUNCTION validate_inserted_file_hierarchy();

DROP TRIGGER IF EXISTS files_hierarchy_update_guard ON files;
CREATE TRIGGER files_hierarchy_update_guard
AFTER UPDATE ON files
REFERENCING OLD TABLE AS old_files NEW TABLE AS updated_files
FOR EACH STATEMENT
EXECUTE FUNCTION validate_updated_file_hierarchy();

INSERT INTO schema_migrations (version)
VALUES ('015-collection-hierarchy-performance')
ON CONFLICT (version) DO NOTHING;

COMMIT;

\else
\echo 'Skipping already-applied migration 015-collection-hierarchy-performance'
\endif

SELECT pg_advisory_unlock(hashtextextended('aeralyth:migration:015-collection-hierarchy-performance', 0));
