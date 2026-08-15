\set ON_ERROR_STOP on
\timing on

BEGIN;
SET LOCAL synchronous_commit = off;

CREATE OR REPLACE FUNCTION pg_temp.plan_nodes(root JSONB)
RETURNS SETOF JSONB
LANGUAGE sql
IMMUTABLE
AS $function$
  WITH RECURSIVE nodes(node) AS (
    SELECT root
    UNION ALL
    SELECT child
    FROM nodes
    CROSS JOIN LATERAL jsonb_array_elements(
      COALESCE(nodes.node->'Plans', '[]'::jsonb)
    ) AS child
  )
  SELECT node FROM nodes;
$function$;

DO $indexes$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class
    WHERE relnamespace = 'public'::regnamespace
      AND relname IN ('files_updated_at_idx', 'files_favorite_idx', 'files_recent_owner_idx')
  ) THEN
    RAISE EXCEPTION 'measured redundant files indexes were not removed';
  END IF;

  IF (
    SELECT count(*)
    FROM pg_class
    WHERE relnamespace = 'public'::regnamespace
      AND relname IN (
        'files_parent_id_idx',
        'files_active_browse_name_idx',
        'files_active_owner_updated_desc_idx',
        'files_favorites_owner_page_idx',
        'files_trash_owner_page_idx',
        'share_links_owner_root_page_idx',
        'vault_shares_owner_root_page_idx'
      )
  ) <> 7 THEN
    RAISE EXCEPTION 'a required exact listing or hierarchy index is missing';
  END IF;
END
$indexes$;

INSERT INTO users (id, username, password_hash, role, status)
VALUES
  ('usr_collection_other', 'collection_other', 'not-a-login-hash', 'user', 'active')
ON CONFLICT (id) DO NOTHING;

INSERT INTO files (
  id, owner_id, original_name, storage_name, size_bytes, entry_type, parent_id
) VALUES (
  'fil_collection_child_folder', 'usr_collection_owner', 'child-folder',
  'collection/child-folder', 0, 'folder', 'fil_collection_root'
);

INSERT INTO files (
  id, owner_id, original_name, storage_name, size_bytes, entry_type
)
SELECT
  format('fil_repo_page_%s', lpad(series::text, 4, '0')),
  'usr_collection_owner',
  format('repository-%s', lpad(series::text, 4, '0')),
  format('collection/repository-%s', lpad(series::text, 4, '0')),
  0,
  'folder'
FROM generate_series(1, 205) AS series;

INSERT INTO repositories (id, owner_id, root_file_id, created_at, updated_at)
SELECT
  format('rep_page_%s', lpad(series::text, 4, '0')),
  'usr_collection_owner',
  format('fil_repo_page_%s', lpad(series::text, 4, '0')),
  timestamptz '2026-01-01 00:00:00+00' + series * interval '1 second',
  timestamptz '2026-01-01 00:00:00+00' + series * interval '1 second'
FROM generate_series(1, 205) AS series;

INSERT INTO share_links (
  id, token_hash, owner_id, root_file_id, access_scope, permission, created_at
)
SELECT
  format('lnk_page_%s', lpad(series::text, 4, '0')),
  encode(digest(format('collection-link-%s', series), 'sha256'), 'hex'),
  'usr_collection_owner',
  'fil_collection_root',
  'public',
  'viewer',
  timestamptz '2026-01-01 00:00:00+00' + series * interval '1 second'
FROM generate_series(1, 105) AS series;

INSERT INTO vault_shares (
  id, owner_id, root_node_id, status, created_at
)
SELECT
  format('vsh_page_%s', lpad(series::text, 4, '0')),
  'usr_collection_owner',
  'fil_collection_root',
  'active',
  timestamptz '2026-01-01 00:00:00+00' + series * interval '1 second'
FROM generate_series(1, 205) AS series;

ANALYZE files;
ANALYZE repositories;
ANALYZE share_links;
ANALYZE vault_shares;

CREATE TEMP TABLE seen_ids (id TEXT PRIMARY KEY);

DO $repository_pages$
DECLARE
  cursor_updated_at TIMESTAMPTZ;
  cursor_name TEXT;
  cursor_id TEXT;
  page_ids TEXT[];
  page_count INTEGER;
  reached INTEGER := 0;
BEGIN
  LOOP
    SELECT array_agg(page.id ORDER BY page.updated_at DESC, page.name, page.id)
    INTO page_ids
    FROM (
      SELECT repositories.id, repositories.updated_at,
             lower(roots.original_name) AS name
      FROM repositories
      INNER JOIN files AS roots ON roots.id = repositories.root_file_id
      WHERE repositories.owner_id = 'usr_collection_owner'
        AND repositories.id LIKE 'rep_page_%'
        AND (
          cursor_updated_at IS NULL
          OR repositories.updated_at < cursor_updated_at
          OR (
            repositories.updated_at = cursor_updated_at
            AND (
              lower(roots.original_name) > cursor_name
              OR (lower(roots.original_name) = cursor_name AND repositories.id > cursor_id)
            )
          )
        )
      ORDER BY repositories.updated_at DESC, lower(roots.original_name), repositories.id
      LIMIT 100
    ) AS page;

    page_count := COALESCE(cardinality(page_ids), 0);
    EXIT WHEN page_count = 0;
    INSERT INTO seen_ids SELECT unnest(page_ids);
    reached := reached + page_count;

    SELECT repositories.updated_at, lower(roots.original_name), repositories.id
    INTO cursor_updated_at, cursor_name, cursor_id
    FROM repositories
    INNER JOIN files AS roots ON roots.id = repositories.root_file_id
    WHERE repositories.id = page_ids[page_count];
  END LOOP;

  IF reached <> 205 OR (SELECT count(*) FROM seen_ids) <> 205 THEN
    RAISE EXCEPTION 'repository cursor pagination reached %, expected 205', reached;
  END IF;
END
$repository_pages$;

TRUNCATE seen_ids;

DO $child_pages$
DECLARE
  cursor_rank INTEGER;
  cursor_name TEXT;
  cursor_id TEXT;
  page_ids TEXT[];
  page_count INTEGER;
  reached INTEGER := 0;
  expected INTEGER;
BEGIN
  SELECT count(*) INTO expected
  FROM files
  WHERE owner_id = 'usr_collection_owner'
    AND parent_id = 'fil_collection_root'
    AND state = 'active';

  LOOP
    SELECT array_agg(page.id ORDER BY page.rank, page.name, page.id)
    INTO page_ids
    FROM (
      SELECT id,
             CASE WHEN entry_type = 'folder' THEN 0 ELSE 1 END AS rank,
             lower(original_name) AS name
      FROM files
      WHERE owner_id = 'usr_collection_owner'
        AND parent_id = 'fil_collection_root'
        AND state = 'active'
        AND (
          cursor_rank IS NULL
          OR CASE WHEN entry_type = 'folder' THEN 0 ELSE 1 END > cursor_rank
          OR (
            CASE WHEN entry_type = 'folder' THEN 0 ELSE 1 END = cursor_rank
            AND (lower(original_name) > cursor_name
              OR (lower(original_name) = cursor_name AND id > cursor_id))
          )
        )
      ORDER BY CASE WHEN entry_type = 'folder' THEN 0 ELSE 1 END,
               lower(original_name), id
      LIMIT 500
    ) AS page;

    page_count := COALESCE(cardinality(page_ids), 0);
    EXIT WHEN page_count = 0;
    INSERT INTO seen_ids SELECT unnest(page_ids);
    reached := reached + page_count;

    SELECT CASE WHEN entry_type = 'folder' THEN 0 ELSE 1 END,
           lower(original_name), id
    INTO cursor_rank, cursor_name, cursor_id
    FROM files
    WHERE id = page_ids[page_count];
  END LOOP;

  IF reached <> expected OR (SELECT count(*) FROM seen_ids) <> expected THEN
    RAISE EXCEPTION 'child cursor pagination reached % of % rows', reached, expected;
  END IF;
END
$child_pages$;

TRUNCATE seen_ids;

DO $share_link_pages$
DECLARE
  cursor_created_at TIMESTAMPTZ;
  cursor_id TEXT;
  page_ids TEXT[];
  page_count INTEGER;
  reached INTEGER := 0;
BEGIN
  LOOP
    SELECT array_agg(page.id ORDER BY page.created_at DESC, page.id DESC)
    INTO page_ids
    FROM (
      SELECT id, created_at
      FROM share_links
      WHERE owner_id = 'usr_collection_owner'
        AND root_file_id = 'fil_collection_root'
        AND id LIKE 'lnk_page_%'
        AND (
          cursor_created_at IS NULL
          OR (created_at, id) < (cursor_created_at, cursor_id)
        )
      ORDER BY created_at DESC, id DESC
      LIMIT 50
    ) AS page;

    page_count := COALESCE(cardinality(page_ids), 0);
    EXIT WHEN page_count = 0;
    INSERT INTO seen_ids SELECT unnest(page_ids);
    reached := reached + page_count;
    SELECT created_at, id INTO cursor_created_at, cursor_id
    FROM share_links WHERE id = page_ids[page_count];
  END LOOP;

  IF reached <> 105 OR (SELECT count(*) FROM seen_ids) <> 105 THEN
    RAISE EXCEPTION 'share-link cursor pagination reached %, expected 105', reached;
  END IF;
END
$share_link_pages$;

TRUNCATE seen_ids;

DO $vault_share_pages$
DECLARE
  cursor_created_at TIMESTAMPTZ;
  cursor_id TEXT;
  page_ids TEXT[];
  page_count INTEGER;
  reached INTEGER := 0;
BEGIN
  LOOP
    SELECT array_agg(page.id ORDER BY page.created_at, page.id)
    INTO page_ids
    FROM (
      SELECT id, created_at
      FROM vault_shares
      WHERE owner_id = 'usr_collection_owner'
        AND root_node_id = 'fil_collection_root'
        AND status IN ('active', 'rotating')
        AND id LIKE 'vsh_page_%'
        AND (
          cursor_created_at IS NULL
          OR (created_at, id) > (cursor_created_at, cursor_id)
        )
      ORDER BY created_at, id
      LIMIT 100
    ) AS page;

    page_count := COALESCE(cardinality(page_ids), 0);
    EXIT WHEN page_count = 0;
    INSERT INTO seen_ids SELECT unnest(page_ids);
    reached := reached + page_count;
    SELECT created_at, id INTO cursor_created_at, cursor_id
    FROM vault_shares WHERE id = page_ids[page_count];
  END LOOP;

  IF reached <> 205 OR (SELECT count(*) FROM seen_ids) <> 205 THEN
    RAISE EXCEPTION 'vault-share cursor pagination reached %, expected 205', reached;
  END IF;
END
$vault_share_pages$;

DO $hierarchy_guard$
BEGIN
  BEGIN
    UPDATE files
    SET parent_id = 'fil_collection_child_folder'
    WHERE id = 'fil_collection_root';
    RAISE EXCEPTION 'cycle update unexpectedly succeeded';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM NOT LIKE 'invalid file hierarchy%cycle%' THEN
      RAISE;
    END IF;
  END;

  BEGIN
    INSERT INTO files (
      id, owner_id, original_name, storage_name, size_bytes, entry_type, parent_id
    ) VALUES (
      'fil_cross_owner', 'usr_collection_other', 'cross-owner',
      'collection/cross-owner', 0, 'file', 'fil_collection_root'
    );
    RAISE EXCEPTION 'cross-owner parent unexpectedly succeeded';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM NOT LIKE 'invalid file hierarchy%owner%' THEN
      RAISE;
    END IF;
  END;
END
$hierarchy_guard$;

INSERT INTO files (
  id, owner_id, original_name, storage_name, size_bytes, entry_type, parent_id
)
SELECT
  format('fil_depth_%s', lpad(series::text, 3, '0')),
  'usr_collection_owner',
  format('depth-%s', series),
  format('collection/depth-%s', series),
  0,
  'folder',
  CASE WHEN series = 0 THEN NULL
       ELSE format('fil_depth_%s', lpad((series - 1)::text, 3, '0')) END
FROM generate_series(0, 100) AS series;

DO $depth_guard$
BEGIN
  BEGIN
    INSERT INTO files (
      id, owner_id, original_name, storage_name, size_bytes, entry_type, parent_id
    ) VALUES (
      'fil_depth_101', 'usr_collection_owner', 'depth-101',
      'collection/depth-101', 0, 'folder', 'fil_depth_100'
    );
    RAISE EXCEPTION 'over-depth insert unexpectedly succeeded';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM NOT LIKE 'invalid file hierarchy%depth%' THEN
      RAISE;
    END IF;
  END;
END
$depth_guard$;

SET LOCAL enable_seqscan = off;

DO $plans$
DECLARE
  plan JSONB;
BEGIN
  EXECUTE $query$
    EXPLAIN (FORMAT JSON, COSTS OFF)
    SELECT id
    FROM files
    WHERE owner_id = 'usr_collection_owner'
      AND parent_id = 'fil_collection_root'
      AND state = 'active'
    ORDER BY CASE WHEN entry_type = 'folder' THEN 0 ELSE 1 END,
             lower(original_name), id
    LIMIT 501
  $query$ INTO plan;
  IF NOT EXISTS (
    SELECT 1
    FROM pg_temp.plan_nodes(plan->0->'Plan') AS plan_node(node)
    WHERE node->>'Index Name' IN (
      'files_active_browse_name_idx',
      'files_active_owner_name_idx'
    )
  ) OR EXISTS (
    SELECT 1
    FROM pg_temp.plan_nodes(plan->0->'Plan') AS plan_node(node)
    WHERE node->>'Node Type' = 'Sort'
  ) THEN
    RAISE EXCEPTION 'child page plan lost an ordered partial browse index: %', plan;
  END IF;

  EXECUTE $query$
    EXPLAIN (FORMAT JSON, COSTS OFF)
    SELECT id
    FROM share_links
    WHERE owner_id = 'usr_collection_owner'
      AND root_file_id = 'fil_collection_root'
    ORDER BY created_at DESC, id DESC
    LIMIT 51
  $query$ INTO plan;
  IF NOT EXISTS (
    SELECT 1
    FROM pg_temp.plan_nodes(plan->0->'Plan') AS plan_node(node)
    WHERE node->>'Index Name' = 'share_links_owner_root_page_idx'
  ) THEN
    RAISE EXCEPTION 'share-link page plan lost its cursor index';
  END IF;

  EXECUTE $query$
    EXPLAIN (FORMAT JSON, COSTS OFF)
    SELECT id
    FROM vault_shares
    WHERE owner_id = 'usr_collection_owner'
      AND root_node_id = 'fil_collection_root'
      AND status IN ('active', 'rotating')
    ORDER BY created_at, id
    LIMIT 101
  $query$ INTO plan;
  IF NOT EXISTS (
    SELECT 1
    FROM pg_temp.plan_nodes(plan->0->'Plan') AS plan_node(node)
    WHERE node->>'Index Name' = 'vault_shares_owner_root_page_idx'
  ) THEN
    RAISE EXCEPTION 'vault-share page plan lost its cursor index';
  END IF;
END
$plans$;

ROLLBACK;

\echo 'collection pagination, hierarchy, and index regression checks passed'
