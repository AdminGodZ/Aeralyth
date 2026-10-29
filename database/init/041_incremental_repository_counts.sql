\set ON_ERROR_STOP on
BEGIN;
CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
SELECT pg_advisory_xact_lock(hashtextextended('aeralyth:migration:041-incremental-repository-counts', 0));
SELECT NOT EXISTS (
  SELECT 1 FROM schema_migrations WHERE version = '041-incremental-repository-counts'
) AS apply_migration \gset
\if :apply_migration

-- Repository counts used to be recounted by walking the whole subtree after
-- every structural change, inside the same dispatcher statement as owner
-- timestamp propagation. One large repository could exceed the statement
-- timeout, roll back every other owner's work, and be picked first again.
--
-- Writers now record signed file/folder deltas next to the existing pending
-- change. A node counts toward repository R exactly as the recount walk sees
-- it: it is not R's root, and it and every ancestor up to and including R's
-- root are active and have R's owner. Each statement compares every changed
-- row's placement before and after the statement, using the transition
-- tables for the "before" versions of rows it changed.
--
-- A delta cannot describe a change to rows outside the statement. The writer
-- requests a full recount of a repository instead when:
-- * its root changes owner, type or lifecycle state;
-- * a reachable folder is deleted. PostgreSQL currently reports rows removed
--   by the parent_id ON DELETE CASCADE in the same transition table, but the
--   recount keeps this exact without relying on that. The application only
--   hard-deletes trashed subtrees, which are never reachable;
-- * a row's reachability in R changes while it still has children that this
--   statement did not change, e.g. trashing only a folder's top row or moving
--   a non-empty folder into or out of R.
-- Tree state changes run under the owner's exclusive tree-operation lock or a
-- tree job fence, while every file writer holds the shared side for its whole
-- transaction (029). A delta is therefore computed against the same ancestor
-- chain that is committed after it. Active child edges also take the parent's
-- lifecycle lock, so a parent cannot change lifecycle under a new child.
ALTER TABLE repository_pending_changes
  ADD COLUMN files_delta BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN folders_delta BIGINT NOT NULL DEFAULT 0;
CREATE INDEX repository_pending_changes_recount_idx
  ON repository_pending_changes (repository_id, id) WHERE counts_dirty;

-- A recount that fails (for example by timing out) is retried with an
-- exponential backoff, so it cannot be selected ahead of other repositories on
-- every pass. The claim commits before the recount starts.
CREATE TABLE repository_recount_attempts (
  repository_id TEXT PRIMARY KEY REFERENCES repositories(id) ON DELETE CASCADE,
  attempts INTEGER NOT NULL CHECK (attempts >= 0),
  not_before TIMESTAMPTZ NOT NULL
);

-- Recursive CTE estimates are far above the real handful of walk rows, which
-- made JIT compile this per-statement query for longer than it runs.
CREATE OR REPLACE FUNCTION repository_files_changed() RETURNS TRIGGER LANGUAGE plpgsql SET jit = off AS $$
DECLARE source_sql TEXT;
BEGIN
  IF TG_TABLE_NAME = 'vault_node_heads' THEN
    -- Publications change content but never counts.
    source_sql := CASE TG_OP
      WHEN 'INSERT' THEN 'SELECT node_id AS id, owner_id FROM collection_new'
      WHEN 'DELETE' THEN 'SELECT node_id AS id, owner_id FROM collection_old'
      ELSE 'SELECT n.node_id AS id, n.owner_id FROM collection_new n JOIN collection_old o USING (node_id)
        WHERE (n.record_version,n.record_hash) IS DISTINCT FROM (o.record_version,o.record_hash)' END;
    EXECUTE format($query$
      WITH RECURSIVE changed AS MATERIALIZED (
        SELECT n.id,n.owner_id,f.parent_id FROM (%s) n JOIN files f ON f.id=n.id
      ), ancestors AS (
        SELECT id,owner_id,parent_id FROM changed
        UNION
        SELECT p.id,p.owner_id,p.parent_id FROM ancestors a JOIN files p ON p.id=a.parent_id AND p.owner_id=a.owner_id
      ), queued AS (
        INSERT INTO repository_pending_changes (repository_id,counts_dirty)
        SELECT r.id,false FROM ancestors a JOIN repositories r
          ON r.root_file_id=a.id AND r.owner_id=a.owner_id GROUP BY r.id
        ON CONFLICT (transaction_id,repository_id) DO UPDATE SET counts_dirty=repository_pending_changes.counts_dirty
        RETURNING repository_id,(xmax=0) AS first_change
      )
      INSERT INTO repository_revision_shards (repository_id,shard,version)
      SELECT repository_id, (hashtextextended(pg_current_xact_id()::text,0) & 63)::smallint, 1 FROM queued WHERE first_change
      ORDER BY repository_id
      ON CONFLICT (repository_id,shard) DO UPDATE SET version=repository_revision_shards.version+1
    $query$,source_sql);
    PERFORM pg_notify('aeralyth_changes','pending');
    RETURN NULL;
  END IF;

  -- One row per changed id with its version before (o_*) and after (n_*) the
  -- statement. A missing version has a NULL owner.
  source_sql := CASE TG_OP
    WHEN 'INSERT' THEN 'SELECT id,NULL,NULL,NULL,NULL,owner_id,parent_id,entry_type,state FROM collection_new'
    WHEN 'DELETE' THEN 'SELECT id,owner_id,parent_id,entry_type,state,NULL,NULL,NULL,NULL FROM collection_old'
    ELSE 'SELECT id,o.owner_id,o.parent_id,o.entry_type,o.state,n.owner_id,n.parent_id,n.entry_type,n.state
      FROM collection_new n FULL JOIN collection_old o USING (id)
      WHERE (n.owner_id,n.parent_id,n.entry_type,n.original_name,n.mime_type,n.size_bytes,n.state,n.updated_at,n.e2ee_state,n.current_generation_id,n.favorite,n.legacy_share_count,n.vault_share_count,n.permanent_share_link_count,n.latest_share_link_expiry)
        IS DISTINCT FROM (o.owner_id,o.parent_id,o.entry_type,o.original_name,o.mime_type,o.size_bytes,o.state,o.updated_at,o.e2ee_state,o.current_generation_id,o.favorite,o.legacy_share_count,o.vault_share_count,o.permanent_share_link_count,o.latest_share_link_expiry)' END;
  EXECUTE format($query$
    WITH RECURSIVE changed(id,o_owner,o_parent,o_type,o_state,n_owner,n_parent,n_type,n_state) AS MATERIALIZED (%s),
    structural AS MATERIALIZED (
      SELECT COALESCE(bool_or((o_owner,o_parent,o_type,o_state) IS DISTINCT FROM (n_owner,n_parent,n_type,n_state)),false) AS edges
      FROM changed
    ),
    -- Cosmetic statements keep every edge, so the old placement equals the
    -- new one and only the new world is walked. Per-row flags travel with
    -- each version so later steps never join the transition table again.
    versions AS MATERIALIZED (
      SELECT true AS new_world,id,n_owner AS owner_id,n_parent AS parent_id,n_type AS entry_type,n_state='active' AS active,
        (o_owner,o_type,o_state) IS DISTINCT FROM (n_owner,n_type,n_state) AS lifecycle_changed,
        o_owner IS NOT NULL AS kept,false AS deleted_folder
      FROM changed WHERE n_owner IS NOT NULL
      UNION ALL
      SELECT false,id,o_owner,o_parent,o_type,o_state='active',
        (o_owner,o_type,o_state) IS DISTINCT FROM (n_owner,n_type,n_state),
        n_owner IS NOT NULL,n_owner IS NULL AND o_type<>'file'
      FROM changed,structural WHERE o_owner IS NOT NULL AND structural.edges
    ),
    -- Walk once per distinct parent, not per changed row. In the old world a
    -- changed ancestor is read from its transition-table version; otherwise
    -- each step is one primary-key probe (LIMIT keeps the planner from
    -- flattening it into a hash of the whole files table).
    walk(new_world,start_id,owner_id,node_id,next_id,active_chain) AS (
      SELECT DISTINCT new_world,parent_id,owner_id,NULL::text,parent_id,true FROM versions WHERE parent_id IS NOT NULL
      UNION
      SELECT w.new_world,w.start_id,w.owner_id,w.next_id,
        CASE WHEN c.id IS NULL THEN f.parent_id ELSE c.o_parent END,
        w.active_chain AND CASE WHEN c.id IS NULL THEN f.state ELSE c.o_state END='active'
      FROM walk w
      LEFT JOIN changed c ON NOT w.new_world AND c.id=w.next_id
      LEFT JOIN LATERAL (SELECT owner_id,parent_id,state FROM files WHERE c.id IS NULL AND id=w.next_id LIMIT 1) f ON true
      WHERE w.next_id IS NOT NULL AND CASE WHEN c.id IS NULL THEN f.owner_id ELSE c.o_owner END=w.owner_id
    ),
    reach AS (
      SELECT w.new_world,w.start_id,w.owner_id,r.id AS repository_id,w.active_chain
      FROM walk w JOIN repositories r ON r.root_file_id=w.node_id AND r.owner_id=w.owner_id
    ),
    placements AS (
      SELECT v.*,rc.repository_id,false AS is_root,v.active AND rc.active_chain AS reachable
      FROM versions v JOIN reach rc ON rc.new_world=v.new_world AND rc.start_id=v.parent_id AND rc.owner_id=v.owner_id
      UNION ALL
      SELECT v.*,r.id,true,v.active
      FROM versions v JOIN repositories r ON r.root_file_id=v.id AND r.owner_id=v.owner_id
    ),
    nodes AS (
      SELECT repository_id,id,bool_or(is_root) AS is_root,bool_or(lifecycle_changed) AS lifecycle_changed,
        bool_or(kept) AS kept,bool_or(deleted_folder) AS deleted_folder,
        COALESCE(bool_or(reachable) FILTER (WHERE NOT new_world),false) AS old_reachable,
        COALESCE(bool_or(reachable) FILTER (WHERE new_world),false) AS new_reachable,
        sum(CASE WHEN is_root OR NOT reachable OR entry_type<>'file' THEN 0 WHEN new_world THEN 1 ELSE -1 END) AS files_delta,
        sum(CASE WHEN is_root OR NOT reachable OR entry_type<>'folder' THEN 0 WHEN new_world THEN 1 ELSE -1 END) AS folders_delta
      FROM placements GROUP BY repository_id,id
    ),
    per_repository AS (
      SELECT n.repository_id,
        s.edges AND COALESCE(bool_or((n.is_root AND n.lifecycle_changed)
          OR (n.deleted_folder AND n.old_reachable) OR outside.found),false) AS counts_dirty,
        CASE WHEN s.edges THEN sum(n.files_delta) ELSE 0 END::bigint AS files_delta,
        CASE WHEN s.edges THEN sum(n.folders_delta) ELSE 0 END::bigint AS folders_delta
      FROM nodes n CROSS JOIN structural s
      -- Only rows whose reachability changed probe their children by index.
      LEFT JOIN LATERAL (
        SELECT true AS found FROM files child
        WHERE n.kept AND n.old_reachable<>n.new_reachable AND child.parent_id=n.id
          AND NOT EXISTS (SELECT 1 FROM changed x WHERE x.id=child.id)
        LIMIT 1
      ) outside ON true
      GROUP BY n.repository_id,s.edges
    ),
    queued AS (
      INSERT INTO repository_pending_changes AS pending (repository_id,counts_dirty,files_delta,folders_delta)
      SELECT repository_id,counts_dirty,files_delta,folders_delta FROM per_repository ORDER BY repository_id
      ON CONFLICT (transaction_id,repository_id) DO UPDATE
        SET counts_dirty=pending.counts_dirty OR EXCLUDED.counts_dirty,
          files_delta=pending.files_delta+EXCLUDED.files_delta,
          folders_delta=pending.folders_delta+EXCLUDED.folders_delta
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

-- Timestamp propagation and count deltas are bounded per pass. Full recounts
-- run separately through repository_counts_claim/repository_counts_recount,
-- one repository per statement, so a slow recount cannot roll this back.
CREATE OR REPLACE FUNCTION collection_changes_dispatch() RETURNS INTEGER LANGUAGE plpgsql AS $$
DECLARE processed INTEGER := 0; rows_processed INTEGER; selected_owner TEXT; eligible_owners TEXT[] := '{}';
  drifted TEXT[];
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
  -- Recount requests are claimed separately and do not occupy this window.
  FOR selected_owner IN
    SELECT DISTINCT owner_id FROM (
      (SELECT owner_id FROM collection_timestamp_changes q WHERE NOT EXISTS (SELECT 1 FROM tree_operation_jobs j WHERE j.owner_id=q.owner_id AND j.status IN ('pending','running')) ORDER BY id LIMIT 512)
      UNION ALL
      (SELECT r.owner_id FROM repository_pending_changes p JOIN repositories r ON r.id=p.repository_id WHERE NOT p.counts_dirty AND NOT EXISTS (SELECT 1 FROM tree_operation_jobs j WHERE j.owner_id=r.owner_id AND j.status IN ('pending','running')) ORDER BY p.id LIMIT 512)
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

  -- Consume visible deltas and apply them in one statement, so the deleted
  -- rows, the content version and any recount request share one snapshot.
  -- Increments use the locked row version: a recount that committed after
  -- this snapshot already deleted the rows it counted, so they are skipped.
  -- counts_version advances only when no visible recount request remains.
  WITH candidates AS (
    SELECT p.repository_id,min(p.id) AS first_id FROM (
      SELECT p.id,p.repository_id FROM repository_pending_changes p JOIN repositories r ON r.id=p.repository_id
      WHERE NOT p.counts_dirty AND r.owner_id=ANY(eligible_owners) ORDER BY p.id LIMIT 512
    ) p GROUP BY p.repository_id
  ), targets AS (
    SELECT r.id FROM repositories r JOIN candidates c ON c.repository_id=r.id
    ORDER BY c.first_id LIMIT 64 FOR UPDATE OF r SKIP LOCKED
  ), removed AS (
    DELETE FROM repository_pending_changes p USING targets t
    WHERE p.repository_id=t.id AND NOT p.counts_dirty
    RETURNING p.repository_id,p.files_delta,p.folders_delta
  ), sums AS (
    SELECT repository_id,sum(files_delta)::bigint AS files,sum(folders_delta)::bigint AS folders,
      EXISTS (SELECT 1 FROM repository_pending_changes d WHERE d.repository_id=removed.repository_id AND d.counts_dirty) AS recount_pending
    FROM removed GROUP BY repository_id
  ), applied AS (
    UPDATE repositories r SET total_files=r.total_files+s.files,total_folders=r.total_folders+s.folders,
      counts_version=CASE WHEN s.recount_pending THEN r.counts_version ELSE repository_content_version(r.id) END,
      updated_at=clock_timestamp()
    FROM sums s WHERE r.id=s.repository_id AND r.total_files+s.files>=0 AND r.total_folders+s.folders>=0
    RETURNING r.id
  ) SELECT count(a.id),array_agg(s.repository_id) FILTER (WHERE a.id IS NULL) INTO rows_processed,drifted
    FROM sums s LEFT JOIN applied a ON a.id=s.repository_id;
  processed:=processed+rows_processed;
  -- A negative total means the stored counts drifted. Its deltas were
  -- consumed above; a full recount replaces the totals.
  IF drifted IS NOT NULL THEN
    INSERT INTO repository_pending_changes AS pending (repository_id) SELECT unnest(drifted)
    ON CONFLICT (transaction_id,repository_id) DO UPDATE SET counts_dirty=true;
    processed:=processed+cardinality(drifted);
  END IF;

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

-- Returns the repository with the oldest recount request whose owner has no
-- tree job and which is not backing off, and records the attempt. Call it in
-- its own transaction before repository_counts_recount: a recount that times
-- out leaves the attempt and its backoff behind.
CREATE FUNCTION repository_counts_claim() RETURNS TEXT LANGUAGE plpgsql AS $$
DECLARE target TEXT;
BEGIN
  -- Skip-scan the partial index: one probe per repository with requests, not
  -- per request, so many queued requests for one repository cannot hide others.
  WITH RECURSIVE dirty(repository_id) AS (
    (SELECT repository_id FROM repository_pending_changes WHERE counts_dirty ORDER BY repository_id LIMIT 1)
    UNION ALL
    SELECT (SELECT p.repository_id FROM repository_pending_changes p
      WHERE p.counts_dirty AND p.repository_id>d.repository_id ORDER BY p.repository_id LIMIT 1)
    FROM dirty d WHERE d.repository_id IS NOT NULL
  )
  SELECT r.id INTO target FROM dirty d
  JOIN repositories r ON r.id=d.repository_id
  LEFT JOIN repository_recount_attempts a ON a.repository_id=r.id
  CROSS JOIN LATERAL (
    SELECT min(p.id) AS first_id FROM repository_pending_changes p WHERE p.repository_id=r.id AND p.counts_dirty
  ) oldest
  WHERE (a.not_before IS NULL OR a.not_before<=clock_timestamp()) AND NOT tree_operation_owner_busy(r.owner_id)
  ORDER BY oldest.first_id LIMIT 1;
  IF target IS NULL THEN RETURN NULL; END IF;
  -- The first backoff outlasts one statement timeout; repeated failures double
  -- it up to ten minutes. A successful recount removes the row.
  INSERT INTO repository_recount_attempts AS attempt (repository_id,attempts,not_before)
  VALUES (target,1,clock_timestamp()+interval '15 seconds')
  ON CONFLICT (repository_id) DO UPDATE SET attempts=attempt.attempts+1,
    not_before=clock_timestamp()+LEAST(interval '15 seconds'*power(2,LEAST(attempt.attempts,10)),interval '10 minutes');
  RETURN target;
END $$;

-- Recounts one repository and consumes every pending change visible to the
-- same statement snapshot, so no delta is counted twice or lost. Returns
-- false when the repository is busy and should be claimed again shortly.
CREATE FUNCTION repository_counts_recount(target_repository TEXT) RETURNS BOOLEAN LANGUAGE plpgsql AS $$
DECLARE target RECORD;
BEGIN
  SELECT id,owner_id,root_file_id INTO target FROM repositories WHERE id=target_repository FOR UPDATE SKIP LOCKED;
  IF FOUND AND pg_try_advisory_xact_lock_shared(hashtextextended('aeralyth:tree-operation:' || target.owner_id,0)) THEN
    PERFORM 1 FROM tree_operation_owners WHERE owner_id=target.owner_id FOR SHARE SKIP LOCKED;
    IF FOUND AND NOT tree_operation_owner_busy(target.owner_id) THEN
      -- The shared owner fence proves the physical tree is visible; avoid
      -- repeating the per-row visibility check during the recount.
      WITH RECURSIVE removed AS (
        DELETE FROM repository_pending_changes WHERE repository_id=target.id RETURNING id
      ), tree AS (
        SELECT id,entry_type FROM files WHERE id=target.root_file_id AND state='active'
        UNION ALL
        SELECT f.id,f.entry_type FROM files f JOIN tree t ON f.parent_id=t.id
        WHERE f.owner_id=target.owner_id AND f.state='active'
      ), totals AS (
        SELECT count(*) FILTER(WHERE entry_type='file')::bigint files,
          GREATEST(count(*) FILTER(WHERE entry_type='folder')-1,0)::bigint folders FROM tree
      ) UPDATE repositories r SET total_files=t.files,total_folders=t.folders,
          counts_version=repository_content_version(target.id),updated_at=clock_timestamp()
        FROM totals t WHERE r.id=target.id AND EXISTS (SELECT 1 FROM removed);
      DELETE FROM repository_recount_attempts WHERE repository_id=target.id;
      RETURN true;
    END IF;
  END IF;
  -- Busy is not a failure: undo this claim's attempt and retry soon.
  UPDATE repository_recount_attempts SET attempts=GREATEST(attempts-1,0),
    not_before=clock_timestamp()+interval '1 second' WHERE repository_id=target_repository;
  RETURN false;
END $$;

-- Recount every repository once so the first deltas start from totals that
-- match the walk exactly.
INSERT INTO repository_pending_changes (repository_id) SELECT id FROM repositories
ON CONFLICT (transaction_id,repository_id) DO UPDATE SET counts_dirty=true;

INSERT INTO schema_migrations (version) VALUES ('041-incremental-repository-counts');
\else
\echo 'Skipping already-applied migration 041-incremental-repository-counts'
\endif
COMMIT;
