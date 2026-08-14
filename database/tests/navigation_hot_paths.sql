\set ON_ERROR_STOP on
\timing on

BEGIN;

SET LOCAL synchronous_commit = off;
SELECT set_config('aeralyth.test_scale', :'scale_nodes', FALSE);

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

CREATE OR REPLACE FUNCTION pg_temp.refresh_repository_totals(
  repository_id TEXT,
  repository_owner_id TEXT
)
RETURNS TABLE(total_files BIGINT, total_folders BIGINT)
LANGUAGE sql
AS $function$
  WITH RECURSIVE repository_snapshot AS MATERIALIZED (
    SELECT root_file_id, tree_version
    FROM repositories
    WHERE id = repository_id AND owner_id = repository_owner_id
    LIMIT 1
  ),
  tree AS (
    SELECT files.id, files.entry_type, ARRAY[files.id]::text[] AS visited_ids
    FROM files
    INNER JOIN repository_snapshot
      ON repository_snapshot.root_file_id = files.id
    WHERE files.owner_id = repository_owner_id AND files.state = 'active'

    UNION ALL

    SELECT child.id, child.entry_type, tree.visited_ids || child.id
    FROM files AS child
    INNER JOIN tree ON child.parent_id = tree.id
    WHERE child.owner_id = repository_owner_id
      AND child.state = 'active'
      AND NOT child.id = ANY(tree.visited_ids)
  ),
  totals AS (
    SELECT
      count(*) FILTER (WHERE entry_type = 'file')::bigint AS total_files,
      GREATEST(count(*) FILTER (WHERE entry_type = 'folder') - 1, 0)::bigint
        AS total_folders
    FROM tree
  )
  UPDATE repositories
  SET total_files = totals.total_files,
      total_folders = totals.total_folders,
      counts_version = repository_snapshot.tree_version
  FROM repository_snapshot
  CROSS JOIN totals
  WHERE repositories.id = repository_id
    AND repositories.owner_id = repository_owner_id
    AND repositories.tree_version = repository_snapshot.tree_version
  RETURNING repositories.total_files, repositories.total_folders;
$function$;

DO $schema_and_backfill$
BEGIN
  IF (
    SELECT count(*)
    FROM pg_trigger
    WHERE NOT tgisinternal
      AND tgname IN (
        'file_shares_file_state_insert',
        'file_shares_file_state_update',
        'file_shares_file_state_delete',
        'vault_shares_file_state_insert',
        'vault_shares_file_state_update',
        'vault_shares_file_state_delete',
        'share_links_file_state_insert',
        'share_links_file_state_update',
        'share_links_file_state_delete',
        'files_repository_counts_insert',
        'files_repository_counts_update',
        'files_repository_counts_delete'
      )
      AND (tgtype & 1) = 0
  ) <> 12 THEN
    RAISE EXCEPTION 'navigation state is not maintained by 12 statement-level triggers';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM files
    WHERE id = 'fil_nav_pre'
      AND legacy_share_count = 1
      AND vault_share_count = 1
      AND permanent_share_link_count = 1
      AND latest_share_link_expiry > now()
  ) THEN
    RAISE EXCEPTION 'migration did not backfill pre-existing share state';
  END IF;
END
$schema_and_backfill$;

INSERT INTO users (id, username, password_hash, role, status)
VALUES
  ('usr_nav_owner', 'navigation_owner', 'not-a-login-hash', 'user', 'active'),
  ('usr_nav_recipient', 'navigation_recipient', 'not-a-login-hash', 'user', 'active');

INSERT INTO files (
  id, owner_id, original_name, storage_name, size_bytes, entry_type
) VALUES (
  'fil_nav_root', 'usr_nav_owner', 'navigation-root',
  'navigation-hot-paths/root', 0, 'folder'
);

DO $folder_chain$
DECLARE
  depth INTEGER;
BEGIN
  FOR depth IN 1..12 LOOP
    INSERT INTO files (
      id, owner_id, original_name, storage_name, size_bytes, entry_type, parent_id
    ) VALUES (
      'fil_nav_depth_' || depth,
      'usr_nav_owner',
      'depth-' || depth,
      'navigation-hot-paths/depth-' || depth,
      0,
      'folder',
      CASE WHEN depth = 1 THEN 'fil_nav_root' ELSE 'fil_nav_depth_' || (depth - 1) END
    );
  END LOOP;
END
$folder_chain$;

INSERT INTO files (
  id, owner_id, original_name, storage_name, mime_type,
  size_bytes, entry_type, parent_id
)
SELECT
  'fil_nav_scale_' || lpad(value::text, 7, '0'),
  'usr_nav_owner',
  'file-' || lpad(value::text, 7, '0') || '.bin',
  'navigation-hot-paths/scale-' || value,
  'application/octet-stream',
  1,
  'file',
  'fil_nav_root'
FROM generate_series(1, current_setting('aeralyth.test_scale')::integer) AS value;

INSERT INTO repositories (id, owner_id, root_file_id, description)
VALUES ('repo_nav_scale', 'usr_nav_owner', 'fil_nav_root', 'navigation scale fixture');

SELECT *
FROM pg_temp.refresh_repository_totals('repo_nav_scale', 'usr_nav_owner');

DO $initial_repository_totals$
DECLARE
  scale_nodes BIGINT := current_setting('aeralyth.test_scale')::bigint;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM repositories
    WHERE id = 'repo_nav_scale'
      AND total_files = scale_nodes
      AND total_folders = 12
      AND counts_version = tree_version
  ) THEN
    RAISE EXCEPTION 'initial repository totals were not cached correctly';
  END IF;
END
$initial_repository_totals$;

INSERT INTO file_shares (id, file_id, owner_id, recipient_id)
VALUES (
  'fsh_nav_runtime', 'fil_nav_scale_0000001',
  'usr_nav_owner', 'usr_nav_recipient'
);

DO $legacy_share_insert$
BEGIN
  IF (SELECT legacy_share_count FROM files WHERE id = 'fil_nav_scale_0000001') <> 1 THEN
    RAISE EXCEPTION 'legacy share insert did not update file metadata';
  END IF;
END
$legacy_share_insert$;

DELETE FROM file_shares WHERE id = 'fsh_nav_runtime';

DO $legacy_share_delete$
BEGIN
  IF (SELECT legacy_share_count FROM files WHERE id = 'fil_nav_scale_0000001') <> 0 THEN
    RAISE EXCEPTION 'legacy share delete did not update file metadata';
  END IF;
END
$legacy_share_delete$;

INSERT INTO file_shares (id, file_id, owner_id, recipient_id)
VALUES (
  'fsh_nav_runtime', 'fil_nav_scale_0000001',
  'usr_nav_owner', 'usr_nav_recipient'
);

INSERT INTO vault_shares (id, owner_id, root_node_id, status)
VALUES ('vsh_nav_runtime', 'usr_nav_owner', 'fil_nav_scale_0000001', 'active');

UPDATE vault_shares SET status = 'revoked' WHERE id = 'vsh_nav_runtime';

DO $vault_share_revoked$
BEGIN
  IF (SELECT vault_share_count FROM files WHERE id = 'fil_nav_scale_0000001') <> 0 THEN
    RAISE EXCEPTION 'vault share revocation left the file marked as shared';
  END IF;
END
$vault_share_revoked$;

UPDATE vault_shares SET status = 'rotating' WHERE id = 'vsh_nav_runtime';

INSERT INTO share_links (
  id, token_hash, owner_id, root_file_id, access_scope, permission, expires_at
) VALUES
  (
    'lnk_nav_expired', repeat('c', 64), 'usr_nav_owner',
    'fil_nav_scale_0000001', 'public', 'viewer', now() - interval '1 day'
  ),
  (
    'lnk_nav_future', repeat('d', 64), 'usr_nav_owner',
    'fil_nav_scale_0000001', 'public', 'viewer', now() + interval '1 day'
  ),
  (
    'lnk_nav_permanent', repeat('e', 64), 'usr_nav_owner',
    'fil_nav_scale_0000001', 'public', 'viewer', NULL
  );

DO $active_link_insert$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM files
    WHERE id = 'fil_nav_scale_0000001'
      AND permanent_share_link_count = 1
      AND latest_share_link_expiry > now()
      AND (legacy_share_count > 0 OR vault_share_count > 0)
  ) THEN
    RAISE EXCEPTION 'share-link metadata did not preserve active and shared flags';
  END IF;
END
$active_link_insert$;

UPDATE share_links
SET revoked_at = now()
WHERE id IN ('lnk_nav_future', 'lnk_nav_permanent');

DO $active_link_revoke$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM files
    WHERE id = 'fil_nav_scale_0000001'
      AND (
        permanent_share_link_count > 0
        OR latest_share_link_expiry > now()
      )
  ) THEN
    RAISE EXCEPTION 'revoked and expired links left an active-link flag behind';
  END IF;
END
$active_link_revoke$;

UPDATE share_links
SET revoked_at = NULL,
    expires_at = now() + interval '2 days'
WHERE id = 'lnk_nav_future';

INSERT INTO share_links (
  id, token_hash, owner_id, root_file_id, access_scope, permission
) VALUES (
  'lnk_nav_root',
  encode(digest(repeat('a', 43), 'sha256'), 'hex'),
  'usr_nav_owner',
  'fil_nav_root',
  'public',
  'viewer'
);

DO $share_writes_do_not_dirty_tree$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM repositories
    WHERE id = 'repo_nav_scale'
      AND tree_version = counts_version
  ) THEN
    RAISE EXCEPTION 'share metadata writes invalidated repository structure totals';
  END IF;
END
$share_writes_do_not_dirty_tree$;

INSERT INTO files (
  id, owner_id, original_name, storage_name, size_bytes, entry_type, parent_id
) VALUES (
  'fil_nav_after_cache', 'usr_nav_owner', 'after-cache.bin',
  'navigation-hot-paths/after-cache', 1, 'file', 'fil_nav_depth_12'
);

DO $repository_invalidation$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM repositories
    WHERE id = 'repo_nav_scale'
      AND tree_version = counts_version + 1
  ) THEN
    RAISE EXCEPTION 'structural insert did not advance the repository tree version';
  END IF;
END
$repository_invalidation$;

SELECT *
FROM pg_temp.refresh_repository_totals('repo_nav_scale', 'usr_nav_owner');

DO $refreshed_repository_totals$
DECLARE
  expected_files BIGINT := current_setting('aeralyth.test_scale')::bigint + 1;
  version_before_rename BIGINT;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM repositories
    WHERE id = 'repo_nav_scale'
      AND total_files = expected_files
      AND total_folders = 12
      AND counts_version = tree_version
  ) THEN
    RAISE EXCEPTION 'stale repository totals were not refreshed correctly';
  END IF;

  SELECT tree_version INTO version_before_rename
  FROM repositories WHERE id = 'repo_nav_scale';

  UPDATE files
  SET original_name = 'renamed-after-cache.bin'
  WHERE id = 'fil_nav_after_cache';

  IF (SELECT tree_version FROM repositories WHERE id = 'repo_nav_scale')
     <> version_before_rename THEN
    RAISE EXCEPTION 'non-structural rename invalidated repository totals';
  END IF;
END
$refreshed_repository_totals$;

ANALYZE files;
ANALYZE repositories;
ANALYZE file_shares;
ANALYZE vault_shares;
ANALYZE share_links;

DO $listing_plans$
DECLARE
  page_50 JSON;
  page_500 JSON;
  buffers_50 BIGINT;
  buffers_500 BIGINT;
BEGIN
  EXECUTE $explain$
    EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON, COSTS OFF, TIMING OFF, SUMMARY OFF)
    SELECT
      files.id,
      (files.legacy_share_count > 0 OR files.vault_share_count > 0) AS shared,
      (
        files.permanent_share_link_count > 0
        OR COALESCE(files.latest_share_link_expiry > now(), FALSE)
      ) AS has_active_share_link
    FROM files
    WHERE files.owner_id = 'usr_nav_owner'
      AND files.parent_id = 'fil_nav_root'
      AND files.state = 'active'
    ORDER BY CASE WHEN files.entry_type = 'folder' THEN 0 ELSE 1 END,
             lower(files.original_name),
             files.id
    LIMIT 51
  $explain$
  INTO page_50;

  EXECUTE $explain$
    EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON, COSTS OFF, TIMING OFF, SUMMARY OFF)
    SELECT
      files.id,
      (files.legacy_share_count > 0 OR files.vault_share_count > 0) AS shared,
      (
        files.permanent_share_link_count > 0
        OR COALESCE(files.latest_share_link_expiry > now(), FALSE)
      ) AS has_active_share_link
    FROM files
    WHERE files.owner_id = 'usr_nav_owner'
      AND files.parent_id = 'fil_nav_root'
      AND files.state = 'active'
    ORDER BY CASE WHEN files.entry_type = 'folder' THEN 0 ELSE 1 END,
             lower(files.original_name),
             files.id
    LIMIT 501
  $explain$
  INTO page_500;

  IF page_50::text ~ 'file_shares|vault_shares|share_links|SubPlan'
     OR page_500::text ~ 'file_shares|vault_shares|share_links|SubPlan' THEN
    RAISE EXCEPTION 'owned listing still probes share relations per row';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM files
    WHERE owner_id = 'usr_nav_owner'
      AND parent_id = 'fil_nav_root'
      AND (
        permanent_share_link_count > 0
        OR COALESCE(latest_share_link_expiry > now(), FALSE)
      ) IS NULL
  ) THEN
    RAISE EXCEPTION 'owned listing produced a nullable active-link flag';
  END IF;
  IF (
       page_50::text NOT LIKE '%files_active_browse_name_idx%'
       AND page_50::text NOT LIKE '%files_active_owner_name_idx%'
     ) OR (
       page_500::text NOT LIKE '%files_active_browse_name_idx%'
       AND page_500::text NOT LIKE '%files_active_owner_name_idx%'
     ) OR page_50::text ~ '"Node Type"\s*:\s*"Sort"'
       OR page_500::text ~ '"Node Type"\s*:\s*"Sort"' THEN
    RAISE EXCEPTION 'owned listing is not a bounded ordered index scan: 50=%, 500=%',
      page_50, page_500;
  END IF;

  buffers_50 := COALESCE((page_50->0->'Plan'->>'Shared Hit Blocks')::bigint, 0)
              + COALESCE((page_50->0->'Plan'->>'Shared Read Blocks')::bigint, 0);
  buffers_500 := COALESCE((page_500->0->'Plan'->>'Shared Hit Blocks')::bigint, 0)
               + COALESCE((page_500->0->'Plan'->>'Shared Read Blocks')::bigint, 0);
  IF buffers_500 > GREATEST(200, buffers_50 * 15) THEN
    RAISE EXCEPTION '500-row share-state listing grew superlinearly: % -> % buffers',
      buffers_50, buffers_500;
  END IF;
  RAISE NOTICE 'share-state listing buffers at 50/500 rows: %/%', buffers_50, buffers_500;
END
$listing_plans$;

DO $repository_navigation_plan$
DECLARE
  navigation_plan JSON;
  touched_buffers BIGINT;
  recursive_rows BIGINT;
BEGIN
  EXECUTE $explain$
    EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON, COSTS OFF, TIMING OFF, SUMMARY OFF)
    WITH RECURSIVE repository AS MATERIALIZED (
      SELECT root_file_id
      FROM repositories
      WHERE id = 'repo_nav_scale' AND owner_id = 'usr_nav_owner'
    ),
    ancestors AS (
      SELECT folder.id, folder.parent_id, repository.root_file_id, 0::integer AS depth
      FROM repository
      INNER JOIN files AS folder ON folder.id = 'fil_nav_depth_12'
      WHERE folder.owner_id = 'usr_nav_owner'
        AND folder.entry_type = 'folder'
        AND folder.state = 'active'
      UNION ALL
      SELECT parent.id, parent.parent_id, child.root_file_id, child.depth + 1
      FROM files AS parent
      INNER JOIN ancestors AS child ON child.parent_id = parent.id
      WHERE parent.owner_id = 'usr_nav_owner'
        AND parent.state = 'active'
        AND child.id <> child.root_file_id
        AND child.depth < 100
    )
    SELECT count(*)
    FROM ancestors
    WHERE EXISTS (
      SELECT 1 FROM ancestors AS authorized
      WHERE authorized.id = authorized.root_file_id
    )
  $explain$
  INTO navigation_plan;

  IF EXISTS (
    SELECT 1
    FROM pg_temp.plan_nodes((navigation_plan->0->'Plan')::jsonb) AS plan_node(node)
    WHERE node->>'Relation Name' = 'files'
      AND node->>'Node Type' = 'Seq Scan'
  ) THEN
    RAISE EXCEPTION 'repository navigation scanned the files table: %', navigation_plan;
  END IF;

  SELECT COALESCE(max((node->>'Actual Rows')::numeric)::bigint, 0)
  INTO recursive_rows
  FROM pg_temp.plan_nodes((navigation_plan->0->'Plan')::jsonb) AS plan_node(node)
  WHERE node->>'Node Type' = 'Recursive Union';
  IF recursive_rows > 13 THEN
    RAISE EXCEPTION 'repository authorization touched more rows than path depth: %',
      navigation_plan;
  END IF;

  touched_buffers := COALESCE(
    (navigation_plan->0->'Plan'->>'Shared Hit Blocks')::bigint, 0
  ) + COALESCE(
    (navigation_plan->0->'Plan'->>'Shared Read Blocks')::bigint, 0
  );
  IF touched_buffers > 500 THEN
    RAISE EXCEPTION 'repository navigation buffers depend on tree size: %', navigation_plan;
  END IF;
  RAISE NOTICE 'repository ancestor navigation at % nodes: % rows, % buffers',
    current_setting('aeralyth.test_scale'), recursive_rows, touched_buffers;
END
$repository_navigation_plan$;

DO $repository_children_plan$
DECLARE
  children_plan JSON;
BEGIN
  EXECUTE $explain$
    EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON, COSTS OFF, TIMING OFF, SUMMARY OFF)
    SELECT id, original_name, entry_type
    FROM files
    WHERE owner_id = 'usr_nav_owner'
      AND parent_id = 'fil_nav_root'
      AND state = 'active'
    ORDER BY CASE WHEN entry_type = 'folder' THEN 0 ELSE 1 END,
             lower(original_name), id
    LIMIT 501
  $explain$
  INTO children_plan;

  IF (
       children_plan::text NOT LIKE '%files_active_browse_name_idx%'
       AND children_plan::text NOT LIKE '%files_active_owner_name_idx%'
     ) OR children_plan::text ~ '"Node Type"\s*:\s*"Sort"' THEN
    RAISE EXCEPTION 'repository child page is not a bounded ordered index scan: %',
      children_plan;
  END IF;
END
$repository_children_plan$;

DO $share_access_plan$
DECLARE
  access_plan JSON;
  recursive_rows BIGINT;
  touched_buffers BIGINT;
BEGIN
  EXECUTE $explain$
    EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON, COSTS OFF, TIMING OFF, SUMMARY OFF)
    WITH RECURSIVE share_grant AS MATERIALIZED (
      SELECT links.owner_id, links.root_file_id
      FROM share_links AS links
      INNER JOIN users AS owners ON owners.id = links.owner_id
      INNER JOIN files AS roots ON roots.id = links.root_file_id
      WHERE links.token_hash = encode(digest(repeat('a', 43), 'sha256'), 'hex')
        AND links.revoked_at IS NULL
        AND (links.expires_at IS NULL OR links.expires_at > now())
        AND owners.status = 'active'
        AND roots.state = 'active'
        AND roots.e2ee_state IN ('legacy', 'staged')
      LIMIT 1
    ),
    ancestors AS (
      SELECT node.id, node.parent_id, share_grant.root_file_id, 0::integer AS depth
      FROM share_grant
      INNER JOIN files AS node ON node.id = 'fil_nav_depth_12'
      WHERE node.owner_id = share_grant.owner_id
        AND node.state = 'active'
        AND node.entry_type = 'folder'
      UNION ALL
      SELECT parent.id, parent.parent_id, child.root_file_id, child.depth + 1
      FROM files AS parent
      INNER JOIN ancestors AS child ON child.parent_id = parent.id
      INNER JOIN share_grant ON share_grant.owner_id = parent.owner_id
      WHERE parent.state = 'active'
        AND child.id <> child.root_file_id
        AND child.depth < 100
    )
    SELECT count(*)
    FROM share_grant
    LEFT JOIN ancestors ON TRUE
    WHERE EXISTS (
      SELECT 1 FROM ancestors AS authorized
      WHERE authorized.id = authorized.root_file_id
    )
  $explain$
  INTO access_plan;

  IF EXISTS (
    SELECT 1
    FROM pg_temp.plan_nodes((access_plan->0->'Plan')::jsonb) AS plan_node(node)
    WHERE node->>'Relation Name' = 'files'
      AND node->>'Node Type' = 'Seq Scan'
  ) THEN
    RAISE EXCEPTION 'share access scanned the files table: %', access_plan;
  END IF;

  SELECT COALESCE(max((node->>'Actual Rows')::numeric)::bigint, 0)
  INTO recursive_rows
  FROM pg_temp.plan_nodes((access_plan->0->'Plan')::jsonb) AS plan_node(node)
  WHERE node->>'Node Type' = 'Recursive Union';
  IF recursive_rows > 13 THEN
    RAISE EXCEPTION 'share access touched more rows than path depth: %', access_plan;
  END IF;

  touched_buffers := COALESCE(
    (access_plan->0->'Plan'->>'Shared Hit Blocks')::bigint, 0
  ) + COALESCE(
    (access_plan->0->'Plan'->>'Shared Read Blocks')::bigint, 0
  );
  IF touched_buffers > 700 THEN
    RAISE EXCEPTION 'share access buffers depend on repository size: %', access_plan;
  END IF;
  RAISE NOTICE 'share access at % nodes: % rows, % buffers',
    current_setting('aeralyth.test_scale'), recursive_rows, touched_buffers;
END
$share_access_plan$;

DO $share_download_plan$
DECLARE
  download_plan JSON;
  recursive_rows BIGINT;
BEGIN
  EXECUTE $explain$
    EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON, COSTS OFF, TIMING OFF, SUMMARY OFF)
    WITH RECURSIVE share_grant AS MATERIALIZED (
      SELECT links.owner_id, links.root_file_id
      FROM share_links AS links
      INNER JOIN users AS owners ON owners.id = links.owner_id
      INNER JOIN files AS roots ON roots.id = links.root_file_id
      WHERE links.token_hash = encode(digest(repeat('a', 43), 'sha256'), 'hex')
        AND links.revoked_at IS NULL
        AND (links.expires_at IS NULL OR links.expires_at > now())
        AND owners.status = 'active'
        AND roots.state = 'active'
        AND roots.e2ee_state IN ('legacy', 'staged')
      LIMIT 1
    ),
    ancestors AS (
      SELECT target.id, target.parent_id, target.storage_name,
             share_grant.root_file_id, 0::integer AS depth
      FROM share_grant
      INNER JOIN files AS target ON target.id = 'fil_nav_scale_0000001'
      WHERE target.owner_id = share_grant.owner_id
        AND target.state = 'active'
        AND target.entry_type = 'file'
        AND target.e2ee_state IN ('legacy', 'staged')
      UNION ALL
      SELECT parent.id, parent.parent_id, parent.storage_name,
             child.root_file_id, child.depth + 1
      FROM files AS parent
      INNER JOIN ancestors AS child ON child.parent_id = parent.id
      INNER JOIN share_grant ON share_grant.owner_id = parent.owner_id
      WHERE parent.state = 'active'
        AND child.id <> child.root_file_id
        AND child.depth < 100
    )
    SELECT target.storage_name
    FROM share_grant
    LEFT JOIN ancestors AS target
      ON target.id = 'fil_nav_scale_0000001' AND target.depth = 0
    WHERE EXISTS (
      SELECT 1 FROM ancestors AS authorized
      WHERE authorized.id = authorized.root_file_id
    )
    LIMIT 1
  $explain$
  INTO download_plan;

  IF EXISTS (
    SELECT 1
    FROM pg_temp.plan_nodes((download_plan->0->'Plan')::jsonb) AS plan_node(node)
    WHERE node->>'Relation Name' = 'files'
      AND node->>'Node Type' = 'Seq Scan'
  ) THEN
    RAISE EXCEPTION 'share download scanned the files table: %', download_plan;
  END IF;

  SELECT COALESCE(max((node->>'Actual Rows')::numeric)::bigint, 0)
  INTO recursive_rows
  FROM pg_temp.plan_nodes((download_plan->0->'Plan')::jsonb) AS plan_node(node)
  WHERE node->>'Node Type' = 'Recursive Union';
  IF recursive_rows > 2 THEN
    RAISE EXCEPTION 'share download touched more rows than file depth: %', download_plan;
  END IF;
  RAISE NOTICE 'share download at % nodes: % authorization rows',
    current_setting('aeralyth.test_scale'), recursive_rows;
END
$share_download_plan$;

ROLLBACK;
