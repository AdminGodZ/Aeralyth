-- Atomic, set-based folder hierarchy creation for legacy folder uploads.

\set ON_ERROR_STOP on

BEGIN;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

SELECT pg_advisory_xact_lock(hashtextextended('aeralyth:migration:008-folder-manifest', 0));

SELECT NOT EXISTS (
  SELECT 1 FROM schema_migrations WHERE version = '008-folder-manifest'
) AS apply_migration \gset

\if :apply_migration

DO $duplicates$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM files
    WHERE entry_type = 'folder' AND state = 'active'
    GROUP BY owner_id, parent_id, lower(original_name)
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION
      'active sibling folders contain duplicate case-insensitive names; resolve them before applying 008-folder-manifest';
  END IF;
END
$duplicates$;

CREATE UNIQUE INDEX files_active_folder_sibling_name_unique_idx
  ON files (owner_id, (COALESCE(parent_id, '')), (lower(original_name)))
  WHERE entry_type = 'folder' AND state = 'active';

CREATE FUNCTION ensure_legacy_folder_level(
  requested_owner_id TEXT,
  requested_paths TEXT[],
  requested_parent_ids TEXT[],
  requested_names TEXT[]
)
RETURNS TABLE(path TEXT, id TEXT)
LANGUAGE SQL
AS $function$
  WITH candidates AS (
    SELECT requested.path, requested.parent_id, requested.name
    FROM unnest(
      requested_paths,
      requested_parent_ids,
      requested_names
    ) AS requested(path, parent_id, name)
    WHERE requested.path IS NOT NULL
      AND requested.name IS NOT NULL
      AND requested.name <> ''
  ),
  inserted AS (
    INSERT INTO files (
      id,
      owner_id,
      original_name,
      storage_name,
      size_bytes,
      entry_type,
      parent_id
    )
    SELECT
      gen_random_uuid()::text,
      requested_owner_id,
      candidates.name,
      'folder_' || replace(gen_random_uuid()::text, '-', ''),
      0,
      'folder',
      candidates.parent_id
    FROM candidates
    ON CONFLICT (
      owner_id,
      (COALESCE(parent_id, '')),
      (lower(original_name))
    )
    WHERE entry_type = 'folder' AND state = 'active'
    DO NOTHING
    RETURNING files.id, files.parent_id, files.original_name
  )
  SELECT
    candidates.path,
    COALESCE(inserted.id, existing.id) AS id
  FROM candidates
  LEFT JOIN inserted
    ON inserted.parent_id IS NOT DISTINCT FROM candidates.parent_id
   AND lower(inserted.original_name) = lower(candidates.name)
  LEFT JOIN files AS existing
    ON existing.owner_id = requested_owner_id
   AND existing.entry_type = 'folder'
   AND existing.state = 'active'
   AND existing.parent_id IS NOT DISTINCT FROM candidates.parent_id
   AND lower(existing.original_name) = lower(candidates.name)
  WHERE COALESCE(inserted.id, existing.id) IS NOT NULL;
$function$;

INSERT INTO schema_migrations (version)
VALUES ('008-folder-manifest');

\else
\echo 'Skipping already-applied migration 008-folder-manifest'
\endif

COMMIT;
