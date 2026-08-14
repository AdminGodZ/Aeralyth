-- Denormalized share flags and cache-backed, depth-bounded navigation hot paths.

\set ON_ERROR_STOP on

BEGIN;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

SELECT pg_advisory_xact_lock(hashtextextended('aeralyth:migration:014-navigation-hot-paths', 0));

SELECT NOT EXISTS (
  SELECT 1 FROM schema_migrations WHERE version = '014-navigation-hot-paths'
) AS apply_migration \gset

\if :apply_migration

ALTER TABLE files
  ADD COLUMN IF NOT EXISTS legacy_share_count BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS vault_share_count BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS permanent_share_link_count BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS latest_share_link_expiry TIMESTAMPTZ;

ALTER TABLE repositories
  ADD COLUMN IF NOT EXISTS total_files BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_folders BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tree_version BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS counts_version BIGINT NOT NULL DEFAULT -1;

DO $constraints$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'files_legacy_share_count_check'
      AND conrelid = 'files'::regclass
  ) THEN
    ALTER TABLE files
      ADD CONSTRAINT files_legacy_share_count_check
      CHECK (legacy_share_count >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'files_vault_share_count_check'
      AND conrelid = 'files'::regclass
  ) THEN
    ALTER TABLE files
      ADD CONSTRAINT files_vault_share_count_check
      CHECK (vault_share_count >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'files_permanent_share_link_count_check'
      AND conrelid = 'files'::regclass
  ) THEN
    ALTER TABLE files
      ADD CONSTRAINT files_permanent_share_link_count_check
      CHECK (permanent_share_link_count >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'repositories_total_files_check'
      AND conrelid = 'repositories'::regclass
  ) THEN
    ALTER TABLE repositories
      ADD CONSTRAINT repositories_total_files_check
      CHECK (total_files >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'repositories_total_folders_check'
      AND conrelid = 'repositories'::regclass
  ) THEN
    ALTER TABLE repositories
      ADD CONSTRAINT repositories_total_folders_check
      CHECK (total_folders >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'repositories_tree_version_check'
      AND conrelid = 'repositories'::regclass
  ) THEN
    ALTER TABLE repositories
      ADD CONSTRAINT repositories_tree_version_check
      CHECK (tree_version >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'repositories_counts_version_check'
      AND conrelid = 'repositories'::regclass
  ) THEN
    ALTER TABLE repositories
      ADD CONSTRAINT repositories_counts_version_check
      CHECK (counts_version >= -1);
  END IF;
END
$constraints$;

WITH legacy_totals AS (
  SELECT owner_id, file_id, count(*)::bigint AS share_count
  FROM file_shares
  GROUP BY owner_id, file_id
)
UPDATE files
SET legacy_share_count = legacy_totals.share_count
FROM legacy_totals
WHERE files.id = legacy_totals.file_id
  AND files.owner_id = legacy_totals.owner_id;

WITH vault_totals AS (
  SELECT owner_id, root_node_id, count(*)::bigint AS share_count
  FROM vault_shares
  WHERE status IN ('active', 'rotating')
  GROUP BY owner_id, root_node_id
)
UPDATE files
SET vault_share_count = vault_totals.share_count
FROM vault_totals
WHERE files.id = vault_totals.root_node_id
  AND files.owner_id = vault_totals.owner_id;

WITH link_totals AS (
  SELECT
    owner_id,
    root_file_id,
    count(*) FILTER (WHERE expires_at IS NULL)::bigint AS permanent_count,
    max(expires_at) FILTER (WHERE expires_at IS NOT NULL) AS latest_expiry
  FROM share_links
  WHERE revoked_at IS NULL
  GROUP BY owner_id, root_file_id
)
UPDATE files
SET permanent_share_link_count = link_totals.permanent_count,
    latest_share_link_expiry = link_totals.latest_expiry
FROM link_totals
WHERE files.id = link_totals.root_file_id
  AND files.owner_id = link_totals.owner_id;

CREATE OR REPLACE FUNCTION update_file_legacy_share_state()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (SELECT 1 FROM new_share_rows) THEN
      RETURN NULL;
    END IF;
    WITH deltas AS (
      SELECT owner_id, file_id, count(*)::bigint AS share_delta
      FROM new_share_rows
      GROUP BY owner_id, file_id
    )
    UPDATE files
    SET legacy_share_count = legacy_share_count + deltas.share_delta
    FROM deltas
    WHERE files.id = deltas.file_id
      AND files.owner_id = deltas.owner_id;
  ELSIF TG_OP = 'DELETE' THEN
    IF NOT EXISTS (SELECT 1 FROM old_share_rows) THEN
      RETURN NULL;
    END IF;
    WITH deltas AS (
      SELECT owner_id, file_id, -count(*)::bigint AS share_delta
      FROM old_share_rows
      GROUP BY owner_id, file_id
    )
    UPDATE files
    SET legacy_share_count = GREATEST(0, legacy_share_count + deltas.share_delta)
    FROM deltas
    WHERE files.id = deltas.file_id
      AND files.owner_id = deltas.owner_id;
  ELSE
    IF NOT EXISTS (
      SELECT 1
      FROM old_share_rows AS old_rows
      FULL JOIN new_share_rows AS new_rows ON new_rows.id = old_rows.id
      WHERE ROW(old_rows.owner_id, old_rows.file_id)
            IS DISTINCT FROM ROW(new_rows.owner_id, new_rows.file_id)
    ) THEN
      RETURN NULL;
    END IF;
    WITH contributions AS (
      SELECT owner_id, file_id, -1::bigint AS share_delta FROM old_share_rows
      UNION ALL
      SELECT owner_id, file_id, 1::bigint AS share_delta FROM new_share_rows
    ),
    deltas AS (
      SELECT owner_id, file_id, sum(share_delta)::bigint AS share_delta
      FROM contributions
      GROUP BY owner_id, file_id
      HAVING sum(share_delta) <> 0
    )
    UPDATE files
    SET legacy_share_count = GREATEST(0, legacy_share_count + deltas.share_delta)
    FROM deltas
    WHERE files.id = deltas.file_id
      AND files.owner_id = deltas.owner_id;
  END IF;
  RETURN NULL;
END;
$function$;

DROP TRIGGER IF EXISTS file_shares_file_state_insert ON file_shares;
DROP TRIGGER IF EXISTS file_shares_file_state_update ON file_shares;
DROP TRIGGER IF EXISTS file_shares_file_state_delete ON file_shares;
CREATE TRIGGER file_shares_file_state_insert
AFTER INSERT ON file_shares
REFERENCING NEW TABLE AS new_share_rows
FOR EACH STATEMENT EXECUTE FUNCTION update_file_legacy_share_state();
CREATE TRIGGER file_shares_file_state_update
AFTER UPDATE ON file_shares
REFERENCING OLD TABLE AS old_share_rows NEW TABLE AS new_share_rows
FOR EACH STATEMENT EXECUTE FUNCTION update_file_legacy_share_state();
CREATE TRIGGER file_shares_file_state_delete
AFTER DELETE ON file_shares
REFERENCING OLD TABLE AS old_share_rows
FOR EACH STATEMENT EXECUTE FUNCTION update_file_legacy_share_state();

CREATE OR REPLACE FUNCTION update_file_vault_share_state()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (SELECT 1 FROM new_share_rows) THEN
      RETURN NULL;
    END IF;
    WITH deltas AS (
      SELECT owner_id, root_node_id,
             count(*) FILTER (WHERE status IN ('active', 'rotating'))::bigint AS share_delta
      FROM new_share_rows
      GROUP BY owner_id, root_node_id
    )
    UPDATE files
    SET vault_share_count = vault_share_count + deltas.share_delta
    FROM deltas
    WHERE deltas.share_delta <> 0
      AND files.id = deltas.root_node_id
      AND files.owner_id = deltas.owner_id;
  ELSIF TG_OP = 'DELETE' THEN
    IF NOT EXISTS (SELECT 1 FROM old_share_rows) THEN
      RETURN NULL;
    END IF;
    WITH deltas AS (
      SELECT owner_id, root_node_id,
             -count(*) FILTER (WHERE status IN ('active', 'rotating'))::bigint AS share_delta
      FROM old_share_rows
      GROUP BY owner_id, root_node_id
    )
    UPDATE files
    SET vault_share_count = GREATEST(0, vault_share_count + deltas.share_delta)
    FROM deltas
    WHERE deltas.share_delta <> 0
      AND files.id = deltas.root_node_id
      AND files.owner_id = deltas.owner_id;
  ELSE
    IF NOT EXISTS (
      SELECT 1
      FROM old_share_rows AS old_rows
      FULL JOIN new_share_rows AS new_rows ON new_rows.id = old_rows.id
      WHERE ROW(
              old_rows.owner_id,
              old_rows.root_node_id,
              old_rows.status IN ('active', 'rotating')
            ) IS DISTINCT FROM ROW(
              new_rows.owner_id,
              new_rows.root_node_id,
              new_rows.status IN ('active', 'rotating')
            )
    ) THEN
      RETURN NULL;
    END IF;
    WITH contributions AS (
      SELECT owner_id, root_node_id,
             -CASE WHEN status IN ('active', 'rotating') THEN 1 ELSE 0 END::bigint AS share_delta
      FROM old_share_rows
      UNION ALL
      SELECT owner_id, root_node_id,
             CASE WHEN status IN ('active', 'rotating') THEN 1 ELSE 0 END::bigint AS share_delta
      FROM new_share_rows
    ),
    deltas AS (
      SELECT owner_id, root_node_id, sum(share_delta)::bigint AS share_delta
      FROM contributions
      GROUP BY owner_id, root_node_id
      HAVING sum(share_delta) <> 0
    )
    UPDATE files
    SET vault_share_count = GREATEST(0, vault_share_count + deltas.share_delta)
    FROM deltas
    WHERE files.id = deltas.root_node_id
      AND files.owner_id = deltas.owner_id;
  END IF;
  RETURN NULL;
END;
$function$;

DROP TRIGGER IF EXISTS vault_shares_file_state_insert ON vault_shares;
DROP TRIGGER IF EXISTS vault_shares_file_state_update ON vault_shares;
DROP TRIGGER IF EXISTS vault_shares_file_state_delete ON vault_shares;
CREATE TRIGGER vault_shares_file_state_insert
AFTER INSERT ON vault_shares
REFERENCING NEW TABLE AS new_share_rows
FOR EACH STATEMENT EXECUTE FUNCTION update_file_vault_share_state();
CREATE TRIGGER vault_shares_file_state_update
AFTER UPDATE ON vault_shares
REFERENCING OLD TABLE AS old_share_rows NEW TABLE AS new_share_rows
FOR EACH STATEMENT EXECUTE FUNCTION update_file_vault_share_state();
CREATE TRIGGER vault_shares_file_state_delete
AFTER DELETE ON vault_shares
REFERENCING OLD TABLE AS old_share_rows
FOR EACH STATEMENT EXECUTE FUNCTION update_file_vault_share_state();

CREATE OR REPLACE FUNCTION refresh_file_link_share_state()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (SELECT 1 FROM new_share_rows) THEN
      RETURN NULL;
    END IF;
    WITH affected AS (
      SELECT DISTINCT owner_id, root_file_id FROM new_share_rows
    ),
    totals AS (
      SELECT
        affected.owner_id,
        affected.root_file_id,
        count(links.id) FILTER (
          WHERE links.revoked_at IS NULL AND links.expires_at IS NULL
        )::bigint AS permanent_count,
        max(links.expires_at) FILTER (
          WHERE links.revoked_at IS NULL AND links.expires_at IS NOT NULL
        ) AS latest_expiry
      FROM affected
      LEFT JOIN share_links AS links
        ON links.owner_id = affected.owner_id
       AND links.root_file_id = affected.root_file_id
      GROUP BY affected.owner_id, affected.root_file_id
    )
    UPDATE files
    SET permanent_share_link_count = totals.permanent_count,
        latest_share_link_expiry = totals.latest_expiry
    FROM totals
    WHERE files.id = totals.root_file_id
      AND files.owner_id = totals.owner_id;
  ELSIF TG_OP = 'DELETE' THEN
    IF NOT EXISTS (SELECT 1 FROM old_share_rows) THEN
      RETURN NULL;
    END IF;
    WITH affected AS (
      SELECT DISTINCT owner_id, root_file_id FROM old_share_rows
    ),
    totals AS (
      SELECT
        affected.owner_id,
        affected.root_file_id,
        count(links.id) FILTER (
          WHERE links.revoked_at IS NULL AND links.expires_at IS NULL
        )::bigint AS permanent_count,
        max(links.expires_at) FILTER (
          WHERE links.revoked_at IS NULL AND links.expires_at IS NOT NULL
        ) AS latest_expiry
      FROM affected
      LEFT JOIN share_links AS links
        ON links.owner_id = affected.owner_id
       AND links.root_file_id = affected.root_file_id
      GROUP BY affected.owner_id, affected.root_file_id
    )
    UPDATE files
    SET permanent_share_link_count = totals.permanent_count,
        latest_share_link_expiry = totals.latest_expiry
    FROM totals
    WHERE files.id = totals.root_file_id
      AND files.owner_id = totals.owner_id;
  ELSE
    IF NOT EXISTS (
      SELECT 1
      FROM old_share_rows AS old_rows
      FULL JOIN new_share_rows AS new_rows ON new_rows.id = old_rows.id
      WHERE ROW(
              old_rows.owner_id,
              old_rows.root_file_id,
              old_rows.revoked_at,
              old_rows.expires_at
            ) IS DISTINCT FROM ROW(
              new_rows.owner_id,
              new_rows.root_file_id,
              new_rows.revoked_at,
              new_rows.expires_at
            )
    ) THEN
      RETURN NULL;
    END IF;
    WITH affected AS (
      SELECT owner_id, root_file_id FROM old_share_rows
      UNION
      SELECT owner_id, root_file_id FROM new_share_rows
    ),
    totals AS (
      SELECT
        affected.owner_id,
        affected.root_file_id,
        count(links.id) FILTER (
          WHERE links.revoked_at IS NULL AND links.expires_at IS NULL
        )::bigint AS permanent_count,
        max(links.expires_at) FILTER (
          WHERE links.revoked_at IS NULL AND links.expires_at IS NOT NULL
        ) AS latest_expiry
      FROM affected
      LEFT JOIN share_links AS links
        ON links.owner_id = affected.owner_id
       AND links.root_file_id = affected.root_file_id
      GROUP BY affected.owner_id, affected.root_file_id
    )
    UPDATE files
    SET permanent_share_link_count = totals.permanent_count,
        latest_share_link_expiry = totals.latest_expiry
    FROM totals
    WHERE files.id = totals.root_file_id
      AND files.owner_id = totals.owner_id;
  END IF;
  RETURN NULL;
END;
$function$;

DROP TRIGGER IF EXISTS share_links_file_state_insert ON share_links;
DROP TRIGGER IF EXISTS share_links_file_state_update ON share_links;
DROP TRIGGER IF EXISTS share_links_file_state_delete ON share_links;
CREATE TRIGGER share_links_file_state_insert
AFTER INSERT ON share_links
REFERENCING NEW TABLE AS new_share_rows
FOR EACH STATEMENT EXECUTE FUNCTION refresh_file_link_share_state();
CREATE TRIGGER share_links_file_state_update
AFTER UPDATE ON share_links
REFERENCING OLD TABLE AS old_share_rows NEW TABLE AS new_share_rows
FOR EACH STATEMENT EXECUTE FUNCTION refresh_file_link_share_state();
CREATE TRIGGER share_links_file_state_delete
AFTER DELETE ON share_links
REFERENCING OLD TABLE AS old_share_rows
FOR EACH STATEMENT EXECUTE FUNCTION refresh_file_link_share_state();

CREATE OR REPLACE FUNCTION mark_repository_counts_dirty_after_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM new_repository_file_rows WHERE state = 'active') THEN
    RETURN NULL;
  END IF;
  UPDATE repositories
  SET tree_version = tree_version + 1
  WHERE owner_id IN (
      SELECT DISTINCT owner_id FROM new_repository_file_rows
      WHERE state = 'active'
    );
  RETURN NULL;
END;
$function$;

CREATE OR REPLACE FUNCTION mark_repository_counts_dirty_after_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM old_repository_file_rows WHERE state = 'active') THEN
    RETURN NULL;
  END IF;
  UPDATE repositories
  SET tree_version = tree_version + 1
  WHERE owner_id IN (
      SELECT DISTINCT owner_id FROM old_repository_file_rows
      WHERE state = 'active'
    );
  RETURN NULL;
END;
$function$;

CREATE OR REPLACE FUNCTION mark_repository_counts_dirty_after_update()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM old_repository_file_rows AS old_rows
    INNER JOIN new_repository_file_rows AS new_rows ON new_rows.id = old_rows.id
    WHERE ROW(old_rows.owner_id, old_rows.parent_id, old_rows.entry_type, old_rows.state)
          IS DISTINCT FROM
          ROW(new_rows.owner_id, new_rows.parent_id, new_rows.entry_type, new_rows.state)
      AND (old_rows.state = 'active' OR new_rows.state = 'active')
  ) THEN
    RETURN NULL;
  END IF;
  WITH changed_owners AS (
    SELECT old_rows.owner_id
    FROM old_repository_file_rows AS old_rows
    INNER JOIN new_repository_file_rows AS new_rows ON new_rows.id = old_rows.id
    WHERE ROW(old_rows.owner_id, old_rows.parent_id, old_rows.entry_type, old_rows.state)
          IS DISTINCT FROM
          ROW(new_rows.owner_id, new_rows.parent_id, new_rows.entry_type, new_rows.state)
      AND (old_rows.state = 'active' OR new_rows.state = 'active')
    UNION
    SELECT new_rows.owner_id
    FROM old_repository_file_rows AS old_rows
    INNER JOIN new_repository_file_rows AS new_rows ON new_rows.id = old_rows.id
    WHERE ROW(old_rows.owner_id, old_rows.parent_id, old_rows.entry_type, old_rows.state)
          IS DISTINCT FROM
          ROW(new_rows.owner_id, new_rows.parent_id, new_rows.entry_type, new_rows.state)
      AND (old_rows.state = 'active' OR new_rows.state = 'active')
  )
  UPDATE repositories
  SET tree_version = tree_version + 1
  WHERE owner_id IN (SELECT owner_id FROM changed_owners);
  RETURN NULL;
END;
$function$;

DROP TRIGGER IF EXISTS files_repository_counts_insert ON files;
DROP TRIGGER IF EXISTS files_repository_counts_update ON files;
DROP TRIGGER IF EXISTS files_repository_counts_delete ON files;
CREATE TRIGGER files_repository_counts_insert
AFTER INSERT ON files
REFERENCING NEW TABLE AS new_repository_file_rows
FOR EACH STATEMENT EXECUTE FUNCTION mark_repository_counts_dirty_after_insert();
CREATE TRIGGER files_repository_counts_update
AFTER UPDATE ON files
REFERENCING OLD TABLE AS old_repository_file_rows NEW TABLE AS new_repository_file_rows
FOR EACH STATEMENT EXECUTE FUNCTION mark_repository_counts_dirty_after_update();
CREATE TRIGGER files_repository_counts_delete
AFTER DELETE ON files
REFERENCING OLD TABLE AS old_repository_file_rows
FOR EACH STATEMENT EXECUTE FUNCTION mark_repository_counts_dirty_after_delete();

INSERT INTO schema_migrations (version)
VALUES ('014-navigation-hot-paths');

\else
\echo 'Skipping already-applied migration 014-navigation-hot-paths'
\endif

COMMIT;
