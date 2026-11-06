\set ON_ERROR_STOP on
BEGIN;
CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
SELECT pg_advisory_xact_lock(hashtextextended('aeralyth:migration:042-trash-listing-order-index', 0));
SELECT NOT EXISTS (
  SELECT 1 FROM schema_migrations WHERE version = '042-trash-listing-order-index'
) AS apply_migration \gset
\if :apply_migration

-- The trash listing orders and keysets on COALESCE(trashed_at, updated_at) so
-- legacy rows without a trash timestamp still sort, but the page index keyed
-- plain trashed_at. The planner could only use the rank prefix, read every
-- trashed row (each folder's descendants included), and sort before LIMIT.
-- Keying the index on the exact expression turns each page into a bounded
-- ordered index scan again. The name is kept for the hierarchy index contract.
DROP INDEX IF EXISTS files_trash_owner_page_idx;
CREATE INDEX files_trash_owner_page_idx
  ON files (
    owner_id,
    (CASE WHEN entry_type = 'folder' THEN 0 ELSE 1 END),
    (COALESCE(trashed_at, updated_at)) DESC,
    lower(original_name),
    id
  )
  WHERE state = 'trashed';

INSERT INTO schema_migrations (version) VALUES ('042-trash-listing-order-index');
\else
\echo 'Skipping already-applied migration 042-trash-listing-order-index'
\endif
COMMIT;
