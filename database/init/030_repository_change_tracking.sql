\set ON_ERROR_STOP on
BEGIN;
SELECT pg_advisory_xact_lock(hashtextextended('aeralyth:migration:030-repository-change-tracking', 0));
SELECT NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = '030-repository-change-tracking') AS apply_migration \gset
\if :apply_migration

-- A publication touches one of 64 independent revision rows. Its content fence
-- is synchronous without rewriting folders or one shared repository root.
CREATE TABLE repository_revision_shards (
  repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  shard SMALLINT NOT NULL CHECK (shard BETWEEN 0 AND 63),
  version BIGINT NOT NULL CHECK (version >= 0),
  PRIMARY KEY (repository_id, shard)
);
INSERT INTO repository_revision_shards SELECT id, 0, tree_version FROM repositories;
CREATE FUNCTION repository_content_version(target_repository TEXT) RETURNS BIGINT
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT COALESCE(sum(version), 0)::bigint FROM repository_revision_shards
  WHERE repository_id = target_repository
$$;
CREATE TABLE repository_pending_changes (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  transaction_id XID8 NOT NULL DEFAULT pg_current_xact_id(),
  repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  counts_dirty BOOLEAN NOT NULL DEFAULT true,
  UNIQUE (transaction_id, repository_id)
);
CREATE INDEX repository_pending_changes_repository_idx ON repository_pending_changes (repository_id, id);
INSERT INTO repository_pending_changes (repository_id) SELECT id FROM repositories;
CREATE TABLE collection_timestamp_changes (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  transaction_id XID8 NOT NULL DEFAULT pg_current_xact_id(),
  owner_id TEXT NOT NULL,
  parent_id TEXT NOT NULL,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (transaction_id, owner_id, parent_id)
);

CREATE FUNCTION repository_files_changed() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE source_sql TEXT;
BEGIN
  IF TG_TABLE_NAME = 'vault_node_heads' THEN
    source_sql := CASE TG_OP
      WHEN 'INSERT' THEN 'SELECT node_id AS id, owner_id FROM collection_new'
      WHEN 'DELETE' THEN 'SELECT node_id AS id, owner_id FROM collection_old'
      ELSE 'SELECT n.node_id AS id, n.owner_id FROM collection_new n JOIN collection_old o USING (node_id)
        WHERE (n.record_version,n.record_hash) IS DISTINCT FROM (o.record_version,o.record_hash)' END;
    source_sql := format('SELECT n.id,n.owner_id,f.parent_id,false AS counts_dirty FROM (%s) n JOIN files f ON f.id=n.id', source_sql);
  ELSE
    source_sql := CASE TG_OP
      WHEN 'INSERT' THEN 'SELECT id,owner_id,parent_id,true AS counts_dirty FROM collection_new'
      WHEN 'DELETE' THEN 'SELECT id,owner_id,parent_id,true AS counts_dirty FROM collection_old'
      ELSE 'SELECT n.id,n.owner_id,n.parent_id,(n.owner_id,n.parent_id,n.entry_type,n.state) IS DISTINCT FROM (o.owner_id,o.parent_id,o.entry_type,o.state) AS counts_dirty FROM collection_new n JOIN collection_old o USING(id)
        WHERE (n.owner_id,n.parent_id,n.entry_type,n.original_name,n.mime_type,n.size_bytes,n.state,n.updated_at,n.e2ee_state,n.current_generation_id,n.favorite,n.legacy_share_count,n.vault_share_count,n.permanent_share_link_count,n.latest_share_link_expiry)
          IS DISTINCT FROM (o.owner_id,o.parent_id,o.entry_type,o.original_name,o.mime_type,o.size_bytes,o.state,o.updated_at,o.e2ee_state,o.current_generation_id,o.favorite,o.legacy_share_count,o.vault_share_count,o.permanent_share_link_count,o.latest_share_link_expiry)
        UNION SELECT o.id,o.owner_id,o.parent_id,(n.owner_id,n.parent_id,n.entry_type,n.state) IS DISTINCT FROM (o.owner_id,o.parent_id,o.entry_type,o.state) AS counts_dirty FROM collection_old o JOIN collection_new n USING(id)
        WHERE (n.owner_id,n.parent_id,n.entry_type,n.original_name,n.mime_type,n.size_bytes,n.state,n.updated_at,n.e2ee_state,n.current_generation_id,n.favorite,n.legacy_share_count,n.vault_share_count,n.permanent_share_link_count,n.latest_share_link_expiry)
          IS DISTINCT FROM (o.owner_id,o.parent_id,o.entry_type,o.original_name,o.mime_type,o.size_bytes,o.state,o.updated_at,o.e2ee_state,o.current_generation_id,o.favorite,o.legacy_share_count,o.vault_share_count,o.permanent_share_link_count,o.latest_share_link_expiry)' END;
  END IF;
  EXECUTE format($query$
    WITH RECURSIVE changed AS MATERIALIZED (%s), ancestors AS (
      SELECT id,owner_id,parent_id,counts_dirty FROM changed
      UNION
      SELECT COALESCE(previous.id,current.id),COALESCE(previous.owner_id,current.owner_id),
        CASE WHEN previous.id IS NOT NULL THEN previous.parent_id ELSE current.parent_id END,child.counts_dirty
      FROM ancestors child
      LEFT JOIN changed previous ON previous.id=child.parent_id AND previous.owner_id=child.owner_id
      LEFT JOIN files current ON current.id=child.parent_id AND current.owner_id=child.owner_id
      WHERE COALESCE(previous.id,current.id) IS NOT NULL
    ), queued AS (
      INSERT INTO repository_pending_changes (repository_id,counts_dirty)
      SELECT r.id,bool_or(a.counts_dirty) FROM ancestors a JOIN repositories r
        ON r.root_file_id=a.id AND r.owner_id=a.owner_id GROUP BY r.id
      ON CONFLICT (transaction_id,repository_id) DO UPDATE
        SET counts_dirty=repository_pending_changes.counts_dirty OR EXCLUDED.counts_dirty
      RETURNING repository_id,(xmax=0) AS first_change
    )
    INSERT INTO repository_revision_shards (repository_id,shard,version)
    SELECT repository_id, (hashtextextended(pg_current_xact_id()::text,0) & 63)::smallint, 1 FROM queued WHERE first_change
    ORDER BY repository_id
    ON CONFLICT (repository_id,shard) DO UPDATE SET version=repository_revision_shards.version+1
  $query$,source_sql);
  PERFORM pg_notify('aeralyth_changes','pending');
  RETURN NULL;
END;
$$;
DROP TRIGGER files_repository_counts_insert ON files;
DROP TRIGGER files_repository_counts_update ON files;
DROP TRIGGER files_repository_counts_delete ON files;
DO $$ DECLARE relation TEXT; BEGIN
  FOREACH relation IN ARRAY ARRAY['files','vault_node_heads'] LOOP
    EXECUTE format('CREATE TRIGGER collection_revision_insert AFTER INSERT ON %I REFERENCING NEW TABLE AS collection_new FOR EACH STATEMENT EXECUTE FUNCTION repository_files_changed()',relation);
    EXECUTE format('CREATE TRIGGER collection_revision_update AFTER UPDATE ON %I REFERENCING OLD TABLE AS collection_old NEW TABLE AS collection_new FOR EACH STATEMENT EXECUTE FUNCTION repository_files_changed()',relation);
    EXECUTE format('CREATE TRIGGER collection_revision_delete AFTER DELETE ON %I REFERENCING OLD TABLE AS collection_old FOR EACH STATEMENT EXECUTE FUNCTION repository_files_changed()',relation);
  END LOOP;
END $$;
CREATE FUNCTION repository_created_counts() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO repository_pending_changes (repository_id) SELECT id FROM collection_new
  ON CONFLICT (transaction_id,repository_id) DO NOTHING;
  PERFORM pg_notify('aeralyth_changes','pending');
  RETURN NULL;
END $$;
CREATE TRIGGER repository_created_counts AFTER INSERT ON repositories
REFERENCING NEW TABLE AS collection_new FOR EACH STATEMENT EXECUTE FUNCTION repository_created_counts();

CREATE TABLE repository_archive_manifests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  content_version BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp() + interval '15 minutes',
  total_entries BIGINT NOT NULL DEFAULT 0,
  total_files BIGINT NOT NULL DEFAULT 0,
  total_bytes BIGINT NOT NULL DEFAULT 0,
  total_encrypted_entries BIGINT NOT NULL DEFAULT 0,
  UNIQUE(owner_id,repository_id,content_version)
);
CREATE INDEX repository_archive_manifests_scope_idx ON repository_archive_manifests(owner_id,repository_id,content_version,expires_at DESC);
CREATE INDEX repository_archive_manifests_expiry_idx ON repository_archive_manifests(expires_at,id);
CREATE TABLE repository_archive_entries (
  manifest_id UUID NOT NULL REFERENCES repository_archive_manifests(id) ON DELETE CASCADE,
  ordinal BIGINT NOT NULL,
  id TEXT NOT NULL,
  original_name TEXT NOT NULL,
  mime_type TEXT,
  entry_type TEXT NOT NULL,
  parent_id TEXT,
  size_bytes BIGINT NOT NULL,
  e2ee_state TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  vault_generation_id BYTEA,
  vault_record_version BIGINT,
  vault_record_hash BYTEA,
  PRIMARY KEY (manifest_id,ordinal)
);

-- A durable subtree deletion drains large archive snapshots before deleting
-- their repository roots, so FK cascades cannot turn a file batch into 50k writes.
CREATE FUNCTION tree_operation_drain_repository_dependencies(target_owner TEXT,node_ids TEXT[],batch_limit INTEGER)
RETURNS BOOLEAN LANGUAGE plpgsql AS $$
DECLARE removed INTEGER;
BEGIN
  WITH targets AS (
    SELECT e.manifest_id,e.ordinal FROM repositories r
    JOIN repository_archive_manifests m ON m.repository_id=r.id
    JOIN repository_archive_entries e ON e.manifest_id=m.id
    WHERE r.owner_id=target_owner AND r.root_file_id=ANY(node_ids)
    ORDER BY e.manifest_id,e.ordinal LIMIT batch_limit
  ) DELETE FROM repository_archive_entries e USING targets t
    WHERE e.manifest_id=t.manifest_id AND e.ordinal=t.ordinal;
  GET DIAGNOSTICS removed=ROW_COUNT;
  IF removed>0 THEN RETURN false; END IF;
  DELETE FROM repository_archive_manifests WHERE id IN (
    SELECT m.id FROM repository_archive_manifests m JOIN repositories r ON r.id=m.repository_id
    WHERE r.owner_id=target_owner AND r.root_file_id=ANY(node_ids) LIMIT batch_limit
  );
  GET DIAGNOSTICS removed=ROW_COUNT;
  IF removed>0 THEN RETURN false; END IF;
  DELETE FROM repository_pending_changes WHERE id IN (
    SELECT p.id FROM repository_pending_changes p JOIN repositories r ON r.id=p.repository_id
    WHERE r.owner_id=target_owner AND r.root_file_id=ANY(node_ids) LIMIT batch_limit
  );
  GET DIAGNOSTICS removed=ROW_COUNT;
  RETURN removed=0;
END $$;

CREATE FUNCTION collection_changes_dispatch() RETURNS INTEGER LANGUAGE plpgsql AS $$
DECLARE processed INTEGER := 0; target RECORD; rows_processed INTEGER; counts_dirty BOOLEAN; captured_version BIGINT;
  selected_owner TEXT; eligible_owners TEXT[] := '{}';
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtextextended('aeralyth:collection-dispatch',0)) THEN RETURN 0; END IF;
  -- Queue rows intentionally carry IDs rather than FK cascades. Remove orphan
  -- work in bounded batches when account deletion has removed the owner fence.
  DELETE FROM collection_timestamp_changes WHERE id IN (
    SELECT q.id FROM collection_timestamp_changes q
    WHERE NOT EXISTS(SELECT 1 FROM tree_operation_owners o WHERE o.owner_id=q.owner_id)
    ORDER BY q.id LIMIT 512
  );
  -- Hold the same shared fence as file writers before taking queue snapshots.
  -- A tree job cannot hide a subtree between eligibility and timestamp writes.
  FOR selected_owner IN
    SELECT DISTINCT owner_id FROM (
      (SELECT owner_id FROM collection_timestamp_changes q WHERE NOT EXISTS (SELECT 1 FROM tree_operation_jobs j WHERE j.owner_id=q.owner_id AND j.status IN ('pending','running')) ORDER BY id LIMIT 512)
      UNION ALL
      (SELECT r.owner_id FROM repository_pending_changes p JOIN repositories r ON r.id=p.repository_id WHERE NOT EXISTS (SELECT 1 FROM tree_operation_jobs j WHERE j.owner_id=r.owner_id AND j.status IN ('pending','running')) ORDER BY p.id LIMIT 512)
    ) owners ORDER BY owner_id
  LOOP
    IF NOT pg_try_advisory_xact_lock_shared(hashtextextended('aeralyth:tree-operation:' || selected_owner,0)) THEN CONTINUE; END IF;
    PERFORM 1 FROM tree_operation_owners WHERE owner_id=selected_owner FOR SHARE SKIP LOCKED;
    IF FOUND AND NOT tree_operation_owner_busy(selected_owner) THEN
      eligible_owners:=array_append(eligible_owners,selected_owner);
    END IF;
  END LOOP;
  -- Timestamp freshness is eventual. Publication/content fences above remain
  -- transactional. Each pass writes any common ancestor at most once.
  WITH RECURSIVE batch AS (
    DELETE FROM collection_timestamp_changes WHERE id IN
      (SELECT id FROM collection_timestamp_changes WHERE owner_id=ANY(eligible_owners) ORDER BY id LIMIT 512)
    RETURNING owner_id,parent_id,changed_at
  ), ancestors AS (
    SELECT f.id,f.owner_id,f.parent_id,b.changed_at FROM batch b JOIN files f
      ON f.id=b.parent_id AND f.owner_id=b.owner_id AND f.state='active' AND f.entry_type='folder'
    UNION
    SELECT p.id,p.owner_id,p.parent_id,a.changed_at FROM ancestors a JOIN files p
      ON p.id=a.parent_id AND p.owner_id=a.owner_id AND p.state='active' AND p.entry_type='folder'
  ), touched AS (
    UPDATE files f SET updated_at=GREATEST(f.updated_at,a.changed_at)
    FROM (SELECT id,max(changed_at) changed_at FROM ancestors GROUP BY id) a
    WHERE f.id=a.id AND f.updated_at<a.changed_at RETURNING f.id,f.updated_at
  ) UPDATE repositories r SET updated_at=GREATEST(r.updated_at,t.updated_at)
    FROM touched t WHERE r.root_file_id=t.id AND r.updated_at<t.updated_at;
  GET DIAGNOSTICS processed=ROW_COUNT;

  FOR target IN
    SELECT r.id,r.owner_id,r.root_file_id FROM repositories r
    WHERE EXISTS (SELECT 1 FROM repository_pending_changes p WHERE p.repository_id=r.id)
      AND r.owner_id=ANY(eligible_owners)
    ORDER BY (SELECT min(p.id) FROM repository_pending_changes p WHERE p.repository_id=r.id)
    LIMIT 8 FOR UPDATE OF r SKIP LOCKED
  LOOP
    -- Delete exactly the visible notifications. Publications committing after
    -- this statement retain their notification and cause a later recount.
    WITH removed AS (
      DELETE FROM repository_pending_changes WHERE repository_id=target.id RETURNING repository_pending_changes.counts_dirty
    ) SELECT COALESCE(bool_or(removed.counts_dirty),false),repository_content_version(target.id)
      INTO counts_dirty,captured_version FROM removed;
    IF NOT counts_dirty THEN
      UPDATE repositories SET counts_version=captured_version,updated_at=clock_timestamp() WHERE id=target.id;
      processed:=processed+1;
      CONTINUE;
    END IF;
    -- The shared owner fence above proves the physical tree is visible; avoid
    -- repeating the per-row visibility check during the background recount.
    WITH RECURSIVE tree AS (
      SELECT id,entry_type FROM files WHERE id=target.root_file_id AND state='active'
      UNION ALL
      SELECT f.id,f.entry_type FROM files f JOIN tree t ON f.parent_id=t.id
      WHERE f.owner_id=target.owner_id AND f.state='active'
    ), totals AS (
      SELECT count(*) FILTER(WHERE entry_type='file')::bigint files,
        GREATEST(count(*) FILTER(WHERE entry_type='folder')-1,0)::bigint folders FROM tree
    ) UPDATE repositories r SET total_files=t.files,total_folders=t.folders,
        counts_version=repository_content_version(target.id),updated_at=clock_timestamp()
      FROM totals t WHERE r.id=target.id;
    processed:=processed+1;
  END LOOP;
  WITH expired AS (
    SELECT e.manifest_id,e.ordinal FROM repository_archive_manifests m
    JOIN repository_archive_entries e ON e.manifest_id=m.id
    WHERE m.expires_at<now() ORDER BY m.expires_at,m.id,e.ordinal LIMIT 2048
  ) DELETE FROM repository_archive_entries e USING expired x
    WHERE e.manifest_id=x.manifest_id AND e.ordinal=x.ordinal;
  GET DIAGNOSTICS rows_processed=ROW_COUNT;
  processed:=processed+rows_processed;
  DELETE FROM repository_archive_manifests WHERE id IN (
    SELECT m.id FROM repository_archive_manifests m WHERE m.expires_at<now()
      AND NOT EXISTS(SELECT 1 FROM repository_archive_entries e WHERE e.manifest_id=m.id)
    ORDER BY m.expires_at LIMIT 32
  );
  RETURN processed;
END $$;

INSERT INTO schema_migrations(version) VALUES('030-repository-change-tracking');
\else
\echo 'Skipping already-applied migration 030-repository-change-tracking'
\endif
COMMIT;
