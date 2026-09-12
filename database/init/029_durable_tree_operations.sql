-- Persist each bounded discovery/mutation page and fence the tree until all
-- pages commit. No operation needs to collect the complete subtree in memory.
\set ON_ERROR_STOP on

BEGIN;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

SELECT pg_advisory_xact_lock(hashtextextended('aeralyth:migration:029-durable-tree-operations', 0));

SELECT NOT EXISTS (
  SELECT 1 FROM schema_migrations WHERE version = '029-durable-tree-operations'
) AS apply_migration \gset

\if :apply_migration

CREATE TABLE tree_operation_owners (
  owner_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  version BIGINT NOT NULL DEFAULT 0
);

INSERT INTO tree_operation_owners (owner_id) SELECT id FROM users;

CREATE FUNCTION ensure_tree_operation_owner() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO tree_operation_owners (owner_id) VALUES (NEW.id)
  ON CONFLICT (owner_id) DO NOTHING;
  RETURN NULL;
END;
$$;

CREATE TRIGGER users_tree_operation_owner_insert AFTER INSERT ON users
FOR EACH ROW EXECUTE FUNCTION ensure_tree_operation_owner();

CREATE TABLE tree_operation_jobs (
  id BIGSERIAL PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- These are deliberately not file foreign keys: bottom-up deletion must be
  -- able to remove the root before the durable job is marked complete.
  root_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('trash', 'restore', 'delete')),
  child_state TEXT CHECK (child_state IN ('active', 'trashed')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'complete')),
  phase TEXT NOT NULL DEFAULT 'discover' CHECK (phase IN ('discover', 'mutate')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  processed_nodes BIGINT NOT NULL DEFAULT 0 CHECK (processed_nodes >= 0),
  available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX tree_operation_jobs_active_owner_idx
  ON tree_operation_jobs (owner_id) WHERE status IN ('pending', 'running');
CREATE INDEX tree_operation_jobs_available_idx
  ON tree_operation_jobs (available_at, id) WHERE status IN ('pending', 'running');
CREATE INDEX tree_operation_jobs_complete_idx
  ON tree_operation_jobs (completed_at, id) WHERE status = 'complete';
CREATE INDEX files_owner_parent_state_walk_idx
  ON files(owner_id,parent_id,state,id) WHERE parent_id IS NOT NULL;

CREATE TABLE tree_operation_nodes (
  job_id BIGINT NOT NULL REFERENCES tree_operation_jobs(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL,
  parent_id TEXT,
  depth INTEGER NOT NULL CHECK (depth >= 0),
  entry_type TEXT NOT NULL CHECK (entry_type IN ('file', 'folder')),
  expanded BOOLEAN NOT NULL DEFAULT false,
  last_child_id TEXT,
  processed BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY (job_id, node_id)
);

CREATE INDEX tree_operation_nodes_frontier_idx
  ON tree_operation_nodes (job_id, depth, node_id) WHERE NOT expanded;
CREATE INDEX tree_operation_nodes_mutation_idx
  ON tree_operation_nodes (job_id, depth DESC, node_id) WHERE NOT processed;

CREATE FUNCTION tree_operation_owner_busy(target_owner TEXT) RETURNS BOOLEAN
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT EXISTS (
    SELECT 1 FROM tree_operation_jobs
    WHERE owner_id = target_owner AND status IN ('pending', 'running')
  );
$$;

-- Each lookup walks ancestors, never children. The existing hierarchy guard
-- caps valid trees at 100 edges, so this also bounds read-side fence checks.
CREATE FUNCTION tree_operation_ancestor(
  target_node TEXT, target_owner TEXT, possible_ancestor TEXT
) RETURNS BOOLEAN
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  WITH RECURSIVE ancestors AS (
    SELECT id, parent_id, 0 AS depth FROM files
    WHERE id = target_node AND owner_id = target_owner
    UNION ALL
    SELECT parent.id, parent.parent_id, ancestors.depth + 1
    FROM ancestors
    JOIN files AS parent ON parent.id = ancestors.parent_id
      AND parent.owner_id = target_owner
    WHERE ancestors.depth < 100
      AND ancestors.id <> possible_ancestor
  )
  SELECT target_node = possible_ancestor OR EXISTS (
    SELECT 1 FROM ancestors WHERE id = possible_ancestor
      -- A legacy corrupt/moved tree can exceed the normal hierarchy limit.
      -- Fail closed instead of exposing nodes beyond the bounded traversal.
      OR (depth = 100 AND parent_id IS NOT NULL)
  );
$$;

CREATE FUNCTION tree_operation_visible(target_node TEXT, target_owner TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql STABLE PARALLEL SAFE AS $$
DECLARE
  fenced_root TEXT;
BEGIN
  SELECT root_id INTO fenced_root FROM tree_operation_jobs
  WHERE owner_id = target_owner AND status IN ('pending', 'running');
  IF NOT FOUND THEN
    RETURN true;
  END IF;
  RETURN NOT tree_operation_ancestor(target_node, target_owner, fenced_root);
END;
$$;

CREATE VIEW visible_files AS
SELECT * FROM files WHERE tree_operation_visible(id, owner_id);

CREATE FUNCTION publish_tree_operation() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF ROW(NEW.id, NEW.owner_id, NEW.root_id, NEW.action, NEW.child_state)
      IS DISTINCT FROM ROW(OLD.id, OLD.owner_id, OLD.root_id, OLD.action, OLD.child_state)
      OR (OLD.status = 'complete' AND NEW.status <> 'complete') THEN
      RAISE EXCEPTION 'tree operation identity is immutable' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.status <> 'pending' OR NEW.phase <> 'discover' THEN
    RAISE EXCEPTION 'tree operations must start pending discovery' USING ERRCODE = '23514';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('aeralyth:tree-operation:' || NEW.owner_id, 0)
  );
  -- A shared advisory lock alone is insufficient for a REPEATABLE READ writer
  -- that started before this fence. Changing a persistent row makes that
  -- writer's subsequent FOR SHARE fail with a serialization error.
  UPDATE tree_operation_owners SET version = version + 1 WHERE owner_id = NEW.owner_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tree operation owner does not exist' USING ERRCODE = '23503';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM files WHERE id = NEW.root_id AND owner_id = NEW.owner_id) THEN
    RAISE EXCEPTION 'tree operation root does not exist' USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER tree_operation_publish_guard BEFORE INSERT OR UPDATE ON tree_operation_jobs
FOR EACH ROW EXECUTE FUNCTION publish_tree_operation();

CREATE FUNCTION guard_tree_operation_file_write() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
  target_owner TEXT;
  old_owner TEXT;
  new_owner TEXT;
  active_job RECORD;
  worker_job TEXT := current_setting('aeralyth.tree_job_id', true);
  protect_ancestors BOOLEAN;
  check_active_parent BOOLEAN := false;
  protect_parent_lifecycle BOOLEAN := false;
BEGIN
  IF TG_OP <> 'INSERT' THEN old_owner := OLD.owner_id; END IF;
  IF TG_OP <> 'DELETE' THEN new_owner := NEW.owner_id; END IF;
  IF TG_OP='INSERT' THEN
    check_active_parent := NEW.state='active' AND NEW.parent_id IS NOT NULL;
  ELSIF TG_OP='UPDATE' THEN
    check_active_parent := NEW.state='active' AND NEW.parent_id IS NOT NULL
      AND ROW(OLD.parent_id,OLD.owner_id) IS DISTINCT FROM ROW(NEW.parent_id,NEW.owner_id);
    protect_parent_lifecycle := OLD.entry_type='folder'
      AND ROW(OLD.id,OLD.owner_id,OLD.entry_type,OLD.state)
        IS DISTINCT FROM ROW(NEW.id,NEW.owner_id,NEW.entry_type,NEW.state);
  ELSE
    protect_parent_lifecycle := OLD.entry_type='folder';
  END IF;

  FOR target_owner IN
    SELECT DISTINCT owner_id
    FROM unnest(ARRAY[old_owner, new_owner]) AS owners(owner_id)
    WHERE owner_id IS NOT NULL ORDER BY owner_id
  LOOP
    PERFORM pg_advisory_xact_lock_shared(
      hashtextextended('aeralyth:tree-operation:' || target_owner, 0)
    );
    PERFORM version FROM tree_operation_owners WHERE owner_id = target_owner FOR SHARE;

    -- Account deletion cascades are allowed to remove its tree and its jobs.
    IF NOT EXISTS (SELECT 1 FROM users WHERE id = target_owner) THEN
      CONTINUE;
    END IF;

    IF protect_parent_lifecycle AND old_owner=target_owner THEN
      -- UPDATE has already locked this file row before a BEFORE-row trigger
      -- runs. Do not wait for child writers that may need that row to update
      -- its derived counters; let the lifecycle transaction retry instead.
      IF NOT pg_try_advisory_xact_lock(hashtextextended('aeralyth:file-parent-lifecycle:' || OLD.id,0)) THEN
        RAISE EXCEPTION 'parent lifecycle is busy; retry' USING ERRCODE='40001';
      END IF;
    END IF;
    IF check_active_parent AND new_owner=target_owner THEN
      -- A reserved upload may retry after the tree fence completes. Validate
      -- the parent's current lifecycle state at publication, not reservation.
      PERFORM pg_advisory_xact_lock_shared(hashtextextended('aeralyth:file-parent-lifecycle:' || NEW.parent_id,0));
      PERFORM 1 FROM files WHERE id=NEW.parent_id AND owner_id=NEW.owner_id
        AND state='active' AND entry_type='folder' FOR KEY SHARE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'active entries require an active parent folder' USING ERRCODE='23514';
      END IF;
      -- KEY SHARE verifies RR freshness but permits derived child-count
      -- updates. FOR SHARE here would deadlock concurrent child insertions
      -- when their statement triggers update the same parent's counters.
    END IF;

    SELECT id, root_id INTO active_job FROM tree_operation_jobs
    WHERE owner_id = target_owner AND status IN ('pending', 'running');
    IF NOT FOUND OR active_job.id::TEXT = worker_job THEN
      CONTINUE;
    END IF;

    -- Share-table cascades maintain only these four derived columns. They may
    -- touch a fenced root while the worker deletes a descendant's share row.
    -- Do not allow nested triggers to bypass the fence for real file changes.
    IF TG_OP = 'UPDATE' AND pg_trigger_depth() > 1
      AND (to_jsonb(NEW) - ARRAY['legacy_share_count', 'vault_share_count',
        'permanent_share_link_count', 'latest_share_link_expiry'])
        = (to_jsonb(OLD) - ARRAY['legacy_share_count', 'vault_share_count',
          'permanent_share_link_count', 'latest_share_link_expiry']) THEN
      CONTINUE;
    END IF;

    IF TG_OP <> 'INSERT' AND old_owner = target_owner
      AND tree_operation_ancestor(OLD.id, target_owner, active_job.root_id) THEN
      RAISE EXCEPTION 'file tree operation is in progress' USING ERRCODE = '55000';
    END IF;
    IF TG_OP <> 'DELETE' AND new_owner = target_owner
      AND (NEW.id = active_job.root_id
        OR tree_operation_ancestor(NEW.parent_id, target_owner, active_job.root_id)) THEN
      RAISE EXCEPTION 'file tree operation is in progress' USING ERRCODE = '55000';
    END IF;

    protect_ancestors := TG_OP = 'DELETE';
    IF TG_OP = 'UPDATE' THEN
      protect_ancestors := ROW(OLD.id, OLD.owner_id, OLD.parent_id, OLD.entry_type, OLD.state)
        IS DISTINCT FROM ROW(NEW.id, NEW.owner_id, NEW.parent_id, NEW.entry_type, NEW.state);
    END IF;
    IF protect_ancestors AND old_owner = target_owner
      AND tree_operation_ancestor(active_job.root_id, target_owner, OLD.id) THEN
      RAISE EXCEPTION 'ancestor has a file tree operation in progress' USING ERRCODE = '55000';
    END IF;
  END LOOP;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER files_tree_operation_write_guard BEFORE INSERT OR UPDATE OR DELETE ON files
FOR EACH ROW EXECUTE FUNCTION guard_tree_operation_file_write();

-- Upload completion and share edits can modify a tree through related tables.
-- They use the same publication lock and persistent version check as files.
CREATE FUNCTION guard_tree_operation_related_write() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
  old_data JSONB;
  new_data JSONB;
  reference_data JSONB;
  reference_owner TEXT;
  reference_root TEXT;
  target_owner TEXT;
  active_job RECORD;
  worker_job TEXT := current_setting('aeralyth.tree_job_id', true);
  column_name TEXT;
BEGIN
  IF TG_OP <> 'INSERT' THEN old_data := to_jsonb(OLD); END IF;
  IF TG_OP <> 'DELETE' THEN new_data := to_jsonb(NEW); END IF;

  -- A completion claimant can discover a newly published tree fence after it
  -- acquired its lease. Let it release/reschedule that lease without changing
  -- the upload, charging an attempt, or waiting behind the same tree fence.
  IF TG_TABLE_NAME='file_uploads' AND TG_OP='UPDATE'
    AND old_data->>'status'='completing' AND new_data->>'status'='completing'
    AND (old_data - ARRAY['completion_available_at','completion_locked_until',
      'completion_lease_token','completion_last_error'])
      = (new_data - ARRAY['completion_available_at','completion_locked_until',
        'completion_lease_token','completion_last_error']) THEN
    RETURN NEW;
  END IF;

  -- Cryptographic share children carry share_id/node_id instead of owner_id.
  -- Resolve those references before taking the same owner fence lock.
  FOR reference_data IN SELECT value FROM unnest(ARRAY[old_data,new_data]) AS rows(value)
    WHERE value IS NOT NULL LOOP
    SELECT owner_id, root_node_id INTO reference_owner, reference_root
      FROM vault_shares WHERE id = reference_data->>'share_id';
    IF reference_data->>'share_link_id' IS NOT NULL THEN
      SELECT owner_id, root_file_id INTO reference_owner, reference_root
        FROM share_links WHERE id = reference_data->>'share_link_id';
    END IF;
    reference_owner := coalesce(reference_data->>'owner_id', reference_owner,
      (SELECT owner_id FROM files WHERE id = reference_data->>'node_id'));
    IF reference_data IS NOT DISTINCT FROM old_data THEN
      old_data := old_data || jsonb_build_object('owner_id',reference_owner,'tree_share_root_id',reference_root);
    ELSE
      new_data := new_data || jsonb_build_object('owner_id',reference_owner,'tree_share_root_id',reference_root);
    END IF;
  END LOOP;

  FOR target_owner IN
    SELECT DISTINCT owner_id
    FROM unnest(ARRAY[old_data->>'owner_id', new_data->>'owner_id']) AS owners(owner_id)
    WHERE owner_id IS NOT NULL ORDER BY owner_id
  LOOP
    PERFORM pg_advisory_xact_lock_shared(
      hashtextextended('aeralyth:tree-operation:' || target_owner, 0)
    );
    PERFORM version FROM tree_operation_owners WHERE owner_id = target_owner FOR SHARE;
    IF NOT EXISTS (SELECT 1 FROM users WHERE id = target_owner) THEN CONTINUE; END IF;

    SELECT id, root_id INTO active_job FROM tree_operation_jobs
    WHERE owner_id = target_owner AND status IN ('pending', 'running');
    IF NOT FOUND OR active_job.id::TEXT = worker_job THEN CONTINUE; END IF;

    FOREACH column_name IN ARRAY TG_ARGV LOOP
      IF (old_data->>'owner_id' = target_owner
          AND tree_operation_ancestor(old_data->>column_name, target_owner, active_job.root_id))
        OR (new_data->>'owner_id' = target_owner
          AND tree_operation_ancestor(new_data->>column_name, target_owner, active_job.root_id)) THEN
        RAISE EXCEPTION 'file tree operation is in progress' USING ERRCODE = '55000';
      END IF;
    END LOOP;
  END LOOP;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER file_shares_tree_operation_write_guard
BEFORE INSERT OR UPDATE OR DELETE ON file_shares
FOR EACH ROW EXECUTE FUNCTION guard_tree_operation_related_write('file_id');
CREATE TRIGGER vault_shares_tree_operation_write_guard
BEFORE INSERT OR UPDATE OR DELETE ON vault_shares
FOR EACH ROW EXECUTE FUNCTION guard_tree_operation_related_write('root_node_id');
CREATE TRIGGER share_links_tree_operation_write_guard
BEFORE INSERT OR UPDATE OR DELETE ON share_links
FOR EACH ROW EXECUTE FUNCTION guard_tree_operation_related_write('root_file_id');
CREATE TRIGGER repositories_tree_operation_write_guard
BEFORE INSERT OR UPDATE OR DELETE ON repositories
FOR EACH ROW EXECUTE FUNCTION guard_tree_operation_related_write('root_file_id');
CREATE TRIGGER file_uploads_tree_operation_write_guard
BEFORE INSERT OR UPDATE OR DELETE ON file_uploads
FOR EACH ROW EXECUTE FUNCTION guard_tree_operation_related_write('file_id', 'parent_id', 'replacement_file_id','tree_share_root_id');
CREATE TRIGGER vault_uploads_tree_operation_write_guard
BEFORE INSERT OR UPDATE OR DELETE ON vault_uploads
FOR EACH ROW EXECUTE FUNCTION guard_tree_operation_related_write('node_id', 'parent_id');

DO $$ DECLARE relation_name TEXT; BEGIN
  FOREACH relation_name IN ARRAY ARRAY[
    'vault_node_heads','vault_node_records','vault_object_generations','vault_migrations',
    'vault_share_wrapper_directories','vault_share_sync_jobs'
  ] LOOP
    EXECUTE format('CREATE TRIGGER tree_operation_write_guard BEFORE INSERT OR UPDATE OR DELETE ON %I
      FOR EACH ROW EXECUTE FUNCTION guard_tree_operation_related_write(''node_id'')',relation_name);
  END LOOP;
  FOREACH relation_name IN ARRAY ARRAY[
    'vault_share_envelopes','vault_share_wrappers','vault_share_owner_keys',
    'vault_share_recipients','vault_share_epochs','vault_revocation_cutoffs','vault_share_pending_revocations'
  ] LOOP
    EXECUTE format('CREATE TRIGGER tree_operation_write_guard BEFORE INSERT OR UPDATE OR DELETE ON %I
      FOR EACH ROW EXECUTE FUNCTION guard_tree_operation_related_write(''node_id'',''tree_share_root_id'')',relation_name);
  END LOOP;
END; $$;
CREATE TRIGGER tree_operation_write_guard BEFORE INSERT OR UPDATE OR DELETE ON vault_wrappers
FOR EACH ROW EXECUTE FUNCTION guard_tree_operation_related_write('node_id','parent_node_id');

-- Child-side indexes keep every dependency page an indexed lookup even when
-- one file has many generations, shares, wrappers, or historical uploads.
CREATE INDEX file_uploads_tree_parent_idx ON file_uploads(owner_id,parent_id);
CREATE INDEX file_uploads_tree_replacement_idx ON file_uploads(owner_id,replacement_file_id);
CREATE INDEX vault_uploads_tree_parent_idx ON vault_uploads(owner_id,parent_id);
CREATE INDEX vault_shares_tree_root_idx ON vault_shares(owner_id,root_node_id,id);
CREATE INDEX vault_share_envelopes_tree_node_idx ON vault_share_envelopes(node_id);
CREATE INDEX vault_share_wrappers_tree_node_idx ON vault_share_wrappers(node_id);
CREATE INDEX vault_wrappers_tree_node_idx ON vault_wrappers(node_id);
CREATE INDEX vault_wrappers_tree_parent_idx ON vault_wrappers(parent_node_id);

CREATE FUNCTION tree_operation_drain_dependencies(
  target_owner TEXT, node_ids TEXT[], batch_limit INTEGER DEFAULT 256
) RETURNS BOOLEAN LANGUAGE plpgsql AS $$
DECLARE
  affected BIGINT;
  specification TEXT;
  relation_name TEXT;
  reference_column TEXT;
  identity_column TEXT;
  detach_columns TEXT;
  share_id TEXT;
  link_id TEXT;
  repository_ready BOOLEAN;
BEGIN
  IF batch_limit IS NULL OR batch_limit < 1 OR batch_limit > 256 OR cardinality(node_ids) > 256 THEN
    RAISE EXCEPTION 'tree dependency page must contain at most 256 rows' USING ERRCODE='22023';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(node_ids) AS requested(id)
    LEFT JOIN files ON files.id=requested.id AND files.owner_id=target_owner
    WHERE files.id IS NULL) THEN
    RAISE EXCEPTION 'tree dependency owner mismatch' USING ERRCODE='23514';
  END IF;

  -- Delete upload intents first so an in-flight completion cannot republish a
  -- removed node. Published intents belonging to a moved, surviving file must
  -- never cause deletion of that file's object through their old parent_id.
  FOREACH specification IN ARRAY ARRAY[
    'file_uploads:file_id','file_uploads:parent_id','file_uploads:replacement_file_id',
    'vault_uploads:node_id','vault_uploads:parent_id'
  ] LOOP
    relation_name := split_part(specification,':',1);
    reference_column := split_part(specification,':',2);
    identity_column := CASE relation_name WHEN 'file_uploads' THEN 'file_id' ELSE 'node_id' END;
    detach_columns := 'parent_id=CASE WHEN uploads.parent_id=ANY($2) THEN NULL ELSE uploads.parent_id END';
    IF relation_name='file_uploads' THEN
      detach_columns := detach_columns || ', replacement_file_id=CASE WHEN uploads.replacement_file_id=ANY($2) THEN NULL ELSE uploads.replacement_file_id END';
    END IF;
    EXECUTE format($query$
      WITH targets AS MATERIALIZED (
        SELECT uploads.id,object_key,multipart_upload_id,upload_mode,write_expires_at,expires_at,status,%I AS node_id,
          status IN ('completed','published') AND NOT %I=ANY($2)
            AND EXISTS(SELECT 1 FROM files WHERE files.id=uploads.%I AND files.owner_id=$1) AS preserve_intent
        FROM %I AS uploads WHERE owner_id=$1 AND %I=ANY($2) LIMIT $3 FOR UPDATE
      ), queued AS (
        INSERT INTO storage_deletion_jobs AS jobs(object_key,multipart_upload_id,available_at)
        SELECT object_key,multipart_upload_id,CASE WHEN upload_mode='single'
          THEN GREATEST(coalesce(write_expires_at,expires_at,now()),now()) ELSE now() END
        FROM targets WHERE object_key IS NOT NULL AND NOT preserve_intent
        ON CONFLICT(object_key) DO UPDATE SET
          multipart_upload_id=coalesce(EXCLUDED.multipart_upload_id,jobs.multipart_upload_id),
          available_at=GREATEST(jobs.available_at,EXCLUDED.available_at)
        RETURNING object_key
      ), detached AS (
        UPDATE %I AS uploads SET %s FROM targets
        WHERE uploads.id=targets.id AND targets.preserve_intent RETURNING uploads.id
      ), deleted AS (
        DELETE FROM %I AS uploads USING targets WHERE uploads.id=targets.id
          AND NOT targets.preserve_intent AND (SELECT count(*) FROM queued)>=0 RETURNING uploads.id
      ) SELECT (SELECT count(*) FROM deleted)+(SELECT count(*) FROM detached)
    $query$,identity_column,identity_column,identity_column,relation_name,reference_column,
      relation_name,detach_columns,relation_name)
    INTO affected USING target_owner,node_ids,batch_limit;
    IF affected>0 THEN RETURN false; END IF;
  END LOOP;

  WITH targets AS MATERIALIZED (
    SELECT node_id,generation_number,object_key FROM vault_object_generations
    WHERE owner_id=target_owner AND node_id=ANY(node_ids) LIMIT batch_limit FOR UPDATE
  ), queued AS (
    INSERT INTO storage_deletion_jobs(object_key) SELECT object_key FROM targets
    ON CONFLICT(object_key) DO NOTHING RETURNING object_key
  ), deleted AS (
    DELETE FROM vault_object_generations AS generations USING targets
    WHERE generations.node_id=targets.node_id AND generations.generation_number=targets.generation_number
      AND (SELECT count(*) FROM queued)>=0 RETURNING generations.node_id
  ) SELECT count(*) INTO affected FROM deleted;
  IF affected>0 THEN RETURN false; END IF;

  WITH targets AS MATERIALIZED (
    SELECT node_id,legacy_object_key,staged_object_key FROM vault_migrations
    WHERE owner_id=target_owner AND node_id=ANY(node_ids) LIMIT batch_limit FOR UPDATE
  ), queued AS (
    INSERT INTO storage_deletion_jobs(object_key)
    SELECT legacy_object_key FROM targets WHERE legacy_object_key IS NOT NULL
    UNION SELECT staged_object_key FROM targets WHERE staged_object_key IS NOT NULL
    ON CONFLICT(object_key) DO NOTHING RETURNING object_key
  ), deleted AS (
    DELETE FROM vault_migrations AS migrations USING targets WHERE migrations.node_id=targets.node_id
      AND (SELECT count(*) FROM queued)>=0 RETURNING migrations.node_id
  ) SELECT count(*) INTO affected FROM deleted;
  IF affected>0 THEN RETURN false; END IF;

  -- Drain direct node references before share roots and record versions. The
  -- order prevents an apparently small delete from cascading across versions.
  FOREACH specification IN ARRAY ARRAY[
    'vault_share_envelopes:node_id','vault_share_wrappers:node_id',
    'vault_wrappers:node_id','vault_wrappers:parent_node_id',
    'vault_share_wrapper_directories:node_id','vault_share_sync_jobs:node_id',
    'vault_node_heads:node_id','vault_node_records:node_id','file_shares:file_id'
  ] LOOP
    relation_name := split_part(specification,':',1);
    reference_column := split_part(specification,':',2);
    EXECUTE format('DELETE FROM %I WHERE ctid IN
      (SELECT ctid FROM %I WHERE %I=ANY($1) LIMIT $2 FOR UPDATE)',
      relation_name,relation_name,reference_column) USING node_ids,batch_limit;
    GET DIAGNOSTICS affected=ROW_COUNT;
    IF affected>0 THEN RETURN false; END IF;
  END LOOP;

  SELECT id INTO share_id FROM vault_shares
  WHERE owner_id=target_owner AND root_node_id=ANY(node_ids)
  ORDER BY root_node_id,id LIMIT 1 FOR UPDATE;
  IF FOUND THEN
    FOREACH relation_name IN ARRAY ARRAY[
      'vault_share_envelopes','vault_share_wrappers','vault_share_owner_keys',
      'vault_revocation_cutoffs','vault_share_pending_revocations','vault_share_recipients','vault_share_epochs'
    ] LOOP
      EXECUTE format('DELETE FROM %I WHERE ctid IN
        (SELECT ctid FROM %I WHERE share_id=$1 LIMIT $2 FOR UPDATE)',relation_name,relation_name)
        USING share_id,batch_limit;
      GET DIAGNOSTICS affected=ROW_COUNT;
      IF affected>0 THEN RETURN false; END IF;
    END LOOP;
    DELETE FROM vault_shares WHERE id=share_id;
    RETURN false;
  END IF;

  -- A link can have uploads with a NULL parent. Drain them separately before
  -- removing the link, whose FK would otherwise update an unbounded set.
  SELECT id INTO link_id FROM share_links WHERE owner_id=target_owner
    AND root_file_id=ANY(node_ids) ORDER BY root_file_id,id LIMIT 1 FOR UPDATE;
  IF FOUND THEN
    WITH targets AS MATERIALIZED (
      SELECT uploads.id,object_key,multipart_upload_id,upload_mode,write_expires_at,expires_at,status,file_id,
        status='completed' AND NOT file_id=ANY(node_ids)
          AND EXISTS(SELECT 1 FROM files WHERE files.id=uploads.file_id AND files.owner_id=target_owner) AS preserve_intent
      FROM file_uploads AS uploads WHERE share_link_id=link_id LIMIT batch_limit FOR UPDATE
    ), queued AS (
      INSERT INTO storage_deletion_jobs AS jobs(object_key,multipart_upload_id,available_at)
      SELECT object_key,multipart_upload_id,CASE WHEN upload_mode='single'
        THEN GREATEST(coalesce(write_expires_at,expires_at,now()),now()) ELSE now() END
      FROM targets WHERE NOT preserve_intent
      ON CONFLICT(object_key) DO UPDATE SET
        multipart_upload_id=coalesce(EXCLUDED.multipart_upload_id,jobs.multipart_upload_id),
        available_at=GREATEST(jobs.available_at,EXCLUDED.available_at)
      RETURNING object_key
    ), detached AS (
      UPDATE file_uploads AS uploads SET share_link_id=NULL,
        parent_id=CASE WHEN uploads.parent_id=ANY(node_ids) THEN NULL ELSE uploads.parent_id END,
        replacement_file_id=CASE WHEN uploads.replacement_file_id=ANY(node_ids) THEN NULL ELSE uploads.replacement_file_id END
      FROM targets WHERE uploads.id=targets.id AND targets.preserve_intent RETURNING uploads.id
    ), deleted AS (
      DELETE FROM file_uploads AS uploads USING targets WHERE uploads.id=targets.id
        AND NOT targets.preserve_intent AND (SELECT count(*) FROM queued)>=0 RETURNING uploads.id
    ) SELECT (SELECT count(*) FROM deleted)+(SELECT count(*) FROM detached) INTO affected;
    IF affected>0 THEN RETURN false; END IF;
    DELETE FROM share_links WHERE id=link_id;
    RETURN false;
  END IF;

  -- Later repository migrations can add large dependent tables. Their helper
  -- drains those tables before this migration removes a repository root.
  IF to_regprocedure('tree_operation_drain_repository_dependencies(text,text[],integer)') IS NOT NULL THEN
    EXECUTE 'SELECT tree_operation_drain_repository_dependencies($1,$2,$3)'
      INTO repository_ready USING target_owner,node_ids,batch_limit;
    IF NOT repository_ready THEN RETURN false; END IF;
  END IF;
  DELETE FROM repositories WHERE ctid IN (SELECT ctid FROM repositories
    WHERE owner_id=target_owner AND root_file_id=ANY(node_ids) LIMIT batch_limit FOR UPDATE);
  GET DIAGNOSTICS affected=ROW_COUNT;
  RETURN affected=0;
END;
$$;

-- Counter writes still follow every committed file page for correct quotas.
-- User-facing totals subtract the operation's accumulated deltas until its
-- final commit, so they never expose a partially trashed/restored/deleted tree.
CREATE TABLE tree_operation_counter_deltas (
  job_id BIGINT NOT NULL REFERENCES tree_operation_jobs(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  total_files BIGINT NOT NULL DEFAULT 0,
  total_folders BIGINT NOT NULL DEFAULT 0,
  active_files BIGINT NOT NULL DEFAULT 0,
  trashed_files BIGINT NOT NULL DEFAULT 0,
  favorite_files BIGINT NOT NULL DEFAULT 0,
  shared_files BIGINT NOT NULL DEFAULT 0,
  used_bytes BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (job_id, owner_id)
);
CREATE INDEX tree_operation_counter_deltas_owner_idx
  ON tree_operation_counter_deltas (owner_id, job_id);

CREATE FUNCTION capture_tree_operation_counter_delta() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
  active_job BIGINT;
  worker_job BIGINT := nullif(current_setting('aeralyth.tree_job_id', true), '')::BIGINT;
  previous user_file_counters%ROWTYPE;
BEGIN
  IF worker_job IS NULL THEN RETURN NULL; END IF;
  SELECT id INTO active_job FROM tree_operation_jobs
  WHERE id = worker_job AND status IN ('pending', 'running');
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF TG_OP = 'UPDATE' THEN previous := OLD; END IF;

  INSERT INTO tree_operation_counter_deltas AS deltas (
    job_id, owner_id, total_files, total_folders, active_files,
    trashed_files, favorite_files, shared_files, used_bytes
  ) VALUES (
    active_job, NEW.owner_id,
    NEW.total_files - coalesce(previous.total_files, 0),
    NEW.total_folders - coalesce(previous.total_folders, 0),
    NEW.active_files - coalesce(previous.active_files, 0),
    NEW.trashed_files - coalesce(previous.trashed_files, 0),
    NEW.favorite_files - coalesce(previous.favorite_files, 0),
    NEW.shared_files - coalesce(previous.shared_files, 0),
    NEW.used_bytes - coalesce(previous.used_bytes, 0)
  ) ON CONFLICT (job_id, owner_id) DO UPDATE SET
    total_files = deltas.total_files + EXCLUDED.total_files,
    total_folders = deltas.total_folders + EXCLUDED.total_folders,
    active_files = deltas.active_files + EXCLUDED.active_files,
    trashed_files = deltas.trashed_files + EXCLUDED.trashed_files,
    favorite_files = deltas.favorite_files + EXCLUDED.favorite_files,
    shared_files = deltas.shared_files + EXCLUDED.shared_files,
    used_bytes = deltas.used_bytes + EXCLUDED.used_bytes;
  RETURN NULL;
END;
$$;

CREATE TRIGGER user_file_counters_tree_operation_delta AFTER INSERT OR UPDATE ON user_file_counters
FOR EACH ROW EXECUTE FUNCTION capture_tree_operation_counter_delta();

CREATE VIEW visible_user_file_counters AS
SELECT counters.owner_id,
  counters.total_files - coalesce(deltas.total_files, 0)::BIGINT AS total_files,
  counters.total_folders - coalesce(deltas.total_folders, 0)::BIGINT AS total_folders,
  counters.active_files - coalesce(deltas.active_files, 0)::BIGINT AS active_files,
  counters.trashed_files - coalesce(deltas.trashed_files, 0)::BIGINT AS trashed_files,
  counters.favorite_files - coalesce(deltas.favorite_files, 0)::BIGINT AS favorite_files,
  counters.shared_files - coalesce(deltas.shared_files, 0)::BIGINT AS shared_files,
  counters.used_bytes - coalesce(deltas.used_bytes, 0)::BIGINT AS used_bytes,
  counters.updated_at,
  tree_operation_owner_busy(counters.owner_id) OR deltas.jobs > 0 AS tree_operation_pending
FROM user_file_counters AS counters
LEFT JOIN LATERAL (
  SELECT sum(delta.total_files) AS total_files, sum(delta.total_folders) AS total_folders,
    sum(delta.active_files) AS active_files, sum(delta.trashed_files) AS trashed_files,
    sum(delta.favorite_files) AS favorite_files, sum(delta.shared_files) AS shared_files,
    sum(delta.used_bytes) AS used_bytes, count(*) AS jobs
  FROM tree_operation_counter_deltas AS delta
  JOIN tree_operation_jobs AS jobs ON jobs.id = delta.job_id
    AND jobs.status IN ('pending', 'running')
  WHERE delta.owner_id = counters.owner_id
) AS deltas ON true;

CREATE TRIGGER notify_aeralyth_maintenance AFTER INSERT ON tree_operation_jobs
FOR EACH STATEMENT EXECUTE FUNCTION notify_aeralyth_maintenance();

INSERT INTO schema_migrations (version) VALUES ('029-durable-tree-operations');

\else
\echo 'Skipping already-applied migration 029-durable-tree-operations'
\endif

COMMIT;
