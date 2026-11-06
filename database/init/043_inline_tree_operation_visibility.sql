\set ON_ERROR_STOP on
BEGIN;
CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
SELECT pg_advisory_xact_lock(hashtextextended('aeralyth:migration:043-inline-tree-operation-visibility', 0));
SELECT NOT EXISTS (
  SELECT 1 FROM schema_migrations WHERE version = '043-inline-tree-operation-visibility'
) AS apply_migration \gset
\if :apply_migration

-- visible_files filtered every row through tree_operation_visible(), a
-- PL/pgSQL function the planner cannot see into. Each row paid a function
-- call plus its own lookup of the owner's active job, about ten times the
-- cost of the scan itself, even though almost no owner has a job running.
--
-- The same fence as a correlated NOT EXISTS becomes an anti-join against the
-- tree_operation_jobs_active_owner_idx partial index, whose predicate matches
-- the status filter exactly. With no active job the inner side is empty and
-- the ancestor walk never runs. While a job is active, rows are hidden exactly
-- as before: tree_operation_ancestor() still walks the bounded ancestor chain
-- to the job root, the root itself included, and fails closed past depth 100.
-- The unique partial index keeps at most one active job per owner, so the
-- function's single-row SELECT INTO and this EXISTS see the same job.
--
-- tree_operation_visible() keeps its definition for the parent checks that
-- call it directly. PostgreSQL expanded SELECT * when the view was last
-- defined, and files has gained no columns since, so the column list is
-- unchanged and the view stays automatically updatable.
CREATE OR REPLACE VIEW visible_files AS
SELECT * FROM files
WHERE NOT EXISTS (
  SELECT 1 FROM tree_operation_jobs AS active_job
  WHERE active_job.owner_id = files.owner_id
    AND active_job.status IN ('pending', 'running')
    AND tree_operation_ancestor(files.id, files.owner_id, active_job.root_id)
);

INSERT INTO schema_migrations (version) VALUES ('043-inline-tree-operation-visibility');
\else
\echo 'Skipping already-applied migration 043-inline-tree-operation-visibility'
\endif
COMMIT;
