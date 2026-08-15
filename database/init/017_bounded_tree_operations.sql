-- Keyset support for bounded, non-recursive subtree walks.

\set ON_ERROR_STOP on

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

SELECT pg_advisory_lock(hashtextextended('aeralyth:migration:017-bounded-tree-operations', 0));

SELECT EXISTS (
  SELECT 1
  FROM pg_class AS indexes
  INNER JOIN pg_index ON pg_index.indexrelid = indexes.oid
  WHERE indexes.relname = 'files_owner_parent_walk_idx'
    AND indexes.relnamespace = 'public'::regnamespace
    AND pg_index.indrelid = 'public.files'::regclass
    AND pg_index.indisvalid
) AS tree_walk_index_valid \gset

\if :tree_walk_index_valid
\else
DROP INDEX CONCURRENTLY IF EXISTS files_owner_parent_walk_idx;
CREATE INDEX CONCURRENTLY files_owner_parent_walk_idx
  ON files (owner_id, parent_id, id)
  WHERE parent_id IS NOT NULL;
\endif

BEGIN;

COMMENT ON INDEX files_owner_parent_walk_idx IS
  'Supports bounded (owner, parent, id) keyset pages used by subtree operations.';

INSERT INTO schema_migrations (version)
VALUES ('017-bounded-tree-operations')
ON CONFLICT (version) DO NOTHING;

COMMIT;

SELECT pg_advisory_unlock(hashtextextended('aeralyth:migration:017-bounded-tree-operations', 0));
