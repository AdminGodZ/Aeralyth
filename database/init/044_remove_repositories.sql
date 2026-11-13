\set ON_ERROR_STOP on
BEGIN;
CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
SELECT pg_advisory_xact_lock(hashtextextended('aeralyth:migration:044-remove-repositories', 0));
SELECT NOT EXISTS (
  SELECT 1 FROM schema_migrations WHERE version = '044-remove-repositories'
) AS apply_migration \gset
\if :apply_migration

-- Repositories are removed from the product. Nothing outside them reads their
-- tables, so this drops the tables, the triggers that tracked repository
-- revisions and counts, and the functions behind them. Repository root folders
-- are ordinary folders in files and stay where they are.

-- These statement triggers only queued repository revisions and counts.
DO $$ DECLARE relation TEXT; BEGIN
  FOREACH relation IN ARRAY ARRAY['files','vault_node_heads'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS collection_revision_insert ON %I',relation);
    EXECUTE format('DROP TRIGGER IF EXISTS collection_revision_update ON %I',relation);
    EXECUTE format('DROP TRIGGER IF EXISTS collection_revision_delete ON %I',relation);
  END LOOP;
END $$;
DROP FUNCTION IF EXISTS repository_files_changed();

-- Folder timestamp propagation stays; the repository passes go.
CREATE OR REPLACE FUNCTION collection_changes_dispatch() RETURNS INTEGER LANGUAGE plpgsql AS $$
DECLARE processed INTEGER := 0; selected_owner TEXT; eligible_owners TEXT[] := '{}';
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
      SELECT owner_id FROM collection_timestamp_changes q WHERE NOT EXISTS (SELECT 1 FROM tree_operation_jobs j WHERE j.owner_id=q.owner_id AND j.status IN ('pending','running')) ORDER BY id LIMIT 512
    ) owners ORDER BY owner_id
  LOOP
    IF NOT pg_try_advisory_xact_lock_shared(hashtextextended('aeralyth:tree-operation:' || selected_owner,0)) THEN CONTINUE; END IF;
    PERFORM 1 FROM tree_operation_owners WHERE owner_id=selected_owner FOR SHARE SKIP LOCKED;
    IF FOUND AND NOT tree_operation_owner_busy(selected_owner) THEN
      eligible_owners:=array_append(eligible_owners,selected_owner);
    END IF;
  END LOOP;
  -- Timestamp freshness is eventual. Each pass writes any common ancestor at
  -- most once.
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
  ) UPDATE files f SET updated_at=GREATEST(f.updated_at,a.changed_at)
    FROM (SELECT id,max(changed_at) changed_at FROM ancestors GROUP BY id) a
    WHERE f.id=a.id AND f.updated_at<a.changed_at;
  GET DIAGNOSTICS processed=ROW_COUNT;
  RETURN processed;
END $$;

-- Tree operations no longer drain repository roots after the other dependencies.
CREATE OR REPLACE FUNCTION tree_operation_drain_dependencies(
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

  RETURN true;
END;
$$;

DROP FUNCTION IF EXISTS tree_operation_drain_repository_dependencies(TEXT,TEXT[],INTEGER);
DROP FUNCTION IF EXISTS repository_counts_recount(TEXT);
DROP FUNCTION IF EXISTS repository_counts_claim();
DROP TABLE IF EXISTS repository_recount_attempts;
DROP TABLE IF EXISTS repository_archive_entries;
DROP TABLE IF EXISTS repository_archive_manifests;
DROP TABLE IF EXISTS repository_pending_changes;
DROP TABLE IF EXISTS repository_revision_shards;
DROP FUNCTION IF EXISTS repository_content_version(TEXT);
-- Also drops the realtime, tree-operation guard and creation-count triggers
-- attached to the table.
DROP TABLE IF EXISTS repositories;
DROP FUNCTION IF EXISTS repository_created_counts();
DROP FUNCTION IF EXISTS mark_repository_counts_dirty_after_insert();
DROP FUNCTION IF EXISTS mark_repository_counts_dirty_after_update();
DROP FUNCTION IF EXISTS mark_repository_counts_dirty_after_delete();

-- Account deletion no longer has a repositories phase. A job paused there
-- resumes at the phase that followed it.
UPDATE user_deletion_jobs SET phase='vault_node_heads' WHERE phase='repositories';

INSERT INTO schema_migrations (version) VALUES ('044-remove-repositories');
\else
\echo 'Skipping already-applied migration 044-remove-repositories'
\endif
COMMIT;
