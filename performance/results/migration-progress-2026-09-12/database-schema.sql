--
-- PostgreSQL database dump
--

\restrict cqKPS4mDB2oph8CTQPaiTqWnRkbmCUJccfMudEXubfXu4tUnaEEr2iNsEHHFrKP

-- Dumped from database version 18.4 (Debian 18.4-1.pgdg13+1)
-- Dumped by pg_dump version 18.4 (Debian 18.4-1.pgdg13+1)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA public;


--
-- Name: SCHEMA public; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON SCHEMA public IS 'standard public schema';


--
-- Name: apply_file_counter_delta(text, bigint, bigint, bigint, bigint, bigint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.apply_file_counter_delta(owner text, total_files_delta bigint, total_folders_delta bigint, trashed_files_delta bigint, favorites_delta bigint, bytes_delta bigint) RETURNS void
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF total_files_delta = 0
     AND total_folders_delta = 0
     AND trashed_files_delta = 0
     AND favorites_delta = 0
     AND bytes_delta = 0 THEN
    RETURN;
  END IF;

  INSERT INTO user_file_counters (
    owner_id,
    total_files,
    total_folders,
    active_files,
    trashed_files,
    favorite_files,
    used_bytes
  )
  SELECT
    owner,
    GREATEST(0, total_files_delta),
    GREATEST(0, total_folders_delta),
    GREATEST(0, total_files_delta),
    GREATEST(0, trashed_files_delta),
    GREATEST(0, favorites_delta),
    GREATEST(0, bytes_delta)
  WHERE EXISTS (SELECT 1 FROM users WHERE id = owner)
  ON CONFLICT (owner_id) DO UPDATE SET
    total_files = GREATEST(0, user_file_counters.total_files + total_files_delta),
    total_folders = GREATEST(0, user_file_counters.total_folders + total_folders_delta),
    active_files = GREATEST(0, user_file_counters.active_files + total_files_delta),
    trashed_files = GREATEST(0, user_file_counters.trashed_files + trashed_files_delta),
    favorite_files = GREATEST(0, user_file_counters.favorite_files + favorites_delta),
    used_bytes = GREATEST(0, user_file_counters.used_bytes + bytes_delta),
    updated_at = now();

  IF bytes_delta <> 0 THEN
    INSERT INTO user_storage_usage (owner_id, used_bytes)
    SELECT owner, GREATEST(0, bytes_delta)
    WHERE EXISTS (SELECT 1 FROM users WHERE id = owner)
    ON CONFLICT (owner_id) DO UPDATE SET
      used_bytes = GREATEST(0, user_storage_usage.used_bytes + bytes_delta),
      updated_at = now();
  END IF;
END;
$$;


--
-- Name: apply_upload_reservation_delta(text, bigint, bigint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.apply_upload_reservation_delta(owner text, bytes_delta bigint, pending_delta bigint) RETURNS void
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF bytes_delta = 0 AND pending_delta = 0 THEN
    RETURN;
  END IF;

  UPDATE user_storage_usage
  SET reserved_bytes = reserved_bytes + bytes_delta,
      pending_uploads = pending_uploads + pending_delta,
      updated_at = now()
  WHERE owner_id = owner;

  IF NOT FOUND AND EXISTS (
    SELECT 1 FROM users WHERE id = owner AND status <> 'deleting'
  ) THEN
    RAISE EXCEPTION 'storage usage ledger missing for user %', owner;
  END IF;
END;
$$;


--
-- Name: assert_file_hierarchy_valid(text[]); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.assert_file_hierarchy_valid(changed_ids text[]) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE
  violation RECORD;
BEGIN
  IF changed_ids IS NULL OR cardinality(changed_ids) = 0 THEN
    RETURN;
  END IF;

  WITH RECURSIVE hierarchy AS (
    SELECT
      files.id AS origin_id,
      files.owner_id AS origin_owner_id,
      files.id AS node_id,
      files.owner_id AS node_owner_id,
      files.parent_id,
      files.entry_type,
      ARRAY[files.id]::TEXT[] AS visited_ids,
      0::INTEGER AS depth,
      FALSE AS cycle
    FROM files
    WHERE files.id = ANY(changed_ids)

    UNION ALL

    SELECT
      hierarchy.origin_id,
      hierarchy.origin_owner_id,
      parent.id,
      parent.owner_id,
      parent.parent_id,
      parent.entry_type,
      hierarchy.visited_ids || parent.id,
      hierarchy.depth + 1,
      parent.id = ANY(hierarchy.visited_ids)
    FROM hierarchy
    INNER JOIN files AS parent ON parent.id = hierarchy.parent_id
    WHERE NOT hierarchy.cycle
      AND hierarchy.depth < 100
  )
  SELECT
    hierarchy.origin_id,
    CASE
      WHEN hierarchy.cycle THEN 'cycle'
      WHEN hierarchy.node_owner_id <> hierarchy.origin_owner_id THEN 'owner'
      WHEN hierarchy.depth > 0 AND hierarchy.entry_type <> 'folder' THEN 'parent_type'
      WHEN hierarchy.depth = 100 AND hierarchy.parent_id IS NOT NULL THEN 'depth'
    END AS reason
  INTO violation
  FROM hierarchy
  WHERE hierarchy.cycle
     OR hierarchy.node_owner_id <> hierarchy.origin_owner_id
     OR (hierarchy.depth > 0 AND hierarchy.entry_type <> 'folder')
     OR (hierarchy.depth = 100 AND hierarchy.parent_id IS NOT NULL)
  ORDER BY hierarchy.origin_id, hierarchy.depth
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION 'invalid file hierarchy for %: %', violation.origin_id, violation.reason
      USING ERRCODE = '23514';
  END IF;
END;
$$;


--
-- Name: capture_tree_operation_counter_delta(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.capture_tree_operation_counter_delta() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: change_vault_migration_progress(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.change_vault_migration_progress() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  UPDATE vault_migration_progress AS progress SET
    legacy_nodes = progress.legacy_nodes + delta.legacy_nodes,
    incomplete_nodes = progress.incomplete_nodes + delta.incomplete_nodes
  FROM (
    SELECT owner_id, sum(legacy_nodes) AS legacy_nodes, sum(incomplete_nodes) AS incomplete_nodes
    FROM (
      SELECT owner_id, legacy::integer AS legacy_nodes,
        (staged OR migration_incomplete)::integer AS incomplete_nodes FROM new_progress
      UNION ALL
      SELECT owner_id, -legacy::integer, -(staged OR migration_incomplete)::integer
      FROM old_progress
    ) AS changes GROUP BY owner_id
    HAVING sum(legacy_nodes) <> 0 OR sum(incomplete_nodes) <> 0
  ) AS delta WHERE progress.owner_id = delta.owner_id;
  RETURN NULL;
END;
$$;


--
-- Name: collection_changes_dispatch(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.collection_changes_dispatch() RETURNS integer
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: delete_file_upload_reservations(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.delete_file_upload_reservations() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  delta RECORD;
BEGIN
  FOR delta IN
    SELECT owner_id,
           -sum(reservation_bytes)::bigint AS reserved_bytes,
           -count(*)::bigint AS pending_uploads
    FROM old_upload_rows
    WHERE status IN ('initializing', 'pending', 'completing', 'aborting')
    GROUP BY owner_id
  LOOP
    PERFORM apply_upload_reservation_delta(
      delta.owner_id,
      delta.reserved_bytes,
      delta.pending_uploads
    );
  END LOOP;
  RETURN NULL;
END;
$$;


--
-- Name: delete_vault_migration_progress(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.delete_vault_migration_progress() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  -- UPDATE never recreates counters during a cascading owner deletion.
  UPDATE vault_migration_progress AS progress SET
    legacy_nodes = progress.legacy_nodes - delta.legacy_nodes,
    incomplete_nodes = progress.incomplete_nodes - delta.incomplete_nodes
  FROM (
    SELECT owner_id, sum(legacy::integer) AS legacy_nodes,
      sum((staged OR migration_incomplete)::integer) AS incomplete_nodes
    FROM old_progress GROUP BY owner_id
    HAVING bool_or(legacy OR staged OR migration_incomplete)
  ) AS delta WHERE progress.owner_id = delta.owner_id;
  RETURN NULL;
END;
$$;


--
-- Name: delete_vault_upload_reservations(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.delete_vault_upload_reservations() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  delta RECORD;
BEGIN
  FOR delta IN
    SELECT owner_id,
           -sum(reservation_bytes)::bigint AS reserved_bytes,
           -count(*)::bigint AS pending_uploads
    FROM old_vault_upload_rows
    WHERE status IN ('initializing', 'pending', 'completing', 'aborting')
    GROUP BY owner_id
  LOOP
    PERFORM apply_upload_reservation_delta(
      delta.owner_id,
      delta.reserved_bytes,
      delta.pending_uploads
    );
  END LOOP;
  RETURN NULL;
END;
$$;


--
-- Name: enforce_vault_share_epoch_write(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.enforce_vault_share_epoch_write() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  share_row RECORD;
  write_epoch BIGINT;
BEGIN
  FOR share_row IN
    SELECT shares.id,
           shares.status,
           shares.active_epoch,
           shares.pending_epoch,
           shares.publication_fenced,
           writes.epochs
    FROM vault_shares AS shares
    INNER JOIN (
      SELECT share_id, array_agg(DISTINCT epoch ORDER BY epoch) AS epochs
      FROM new_share_writes
      GROUP BY share_id
    ) AS writes ON writes.share_id = shares.id
    ORDER BY shares.id
    FOR SHARE OF shares
  LOOP
    IF share_row.status = 'revoked' THEN
      RAISE EXCEPTION 'share is not writable';
    END IF;

    FOREACH write_epoch IN ARRAY share_row.epochs
    LOOP
      IF share_row.publication_fenced
         AND write_epoch = share_row.active_epoch THEN
        RAISE EXCEPTION 'old share epoch is fenced';
      END IF;

      IF write_epoch <> share_row.active_epoch
         AND write_epoch IS DISTINCT FROM share_row.pending_epoch THEN
        RAISE EXCEPTION 'share epoch is not active or pending';
      END IF;
    END LOOP;
  END LOOP;

  RETURN NULL;
END;
$$;


--
-- Name: ensure_legacy_folder_level(text, text[], text[], text[]); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ensure_legacy_folder_level(requested_owner_id text, requested_paths text[], requested_parent_ids text[], requested_names text[]) RETURNS TABLE(path text, id text)
    LANGUAGE sql
    AS $$
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
$$;


--
-- Name: ensure_tree_operation_owner(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ensure_tree_operation_owner() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  INSERT INTO tree_operation_owners (owner_id) VALUES (NEW.id)
  ON CONFLICT (owner_id) DO NOTHING;
  RETURN NULL;
END;
$$;


--
-- Name: ensure_user_file_counter(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ensure_user_file_counter() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  INSERT INTO user_file_counters (owner_id)
  VALUES (NEW.id)
  ON CONFLICT (owner_id) DO NOTHING;
  RETURN NEW;
END;
$$;


--
-- Name: ensure_user_storage_usage(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ensure_user_storage_usage() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  INSERT INTO user_storage_usage (owner_id)
  VALUES (NEW.id)
  ON CONFLICT (owner_id) DO NOTHING;
  RETURN NEW;
END;
$$;


--
-- Name: expire_trash_batch(integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.expire_trash_batch(batch_size integer) RETURNS bigint
    LANGUAGE plpgsql
    AS $$
DECLARE selected_owner TEXT; retention_minutes INTEGER; deleted_count BIGINT;
BEGIN
  IF batch_size IS NULL OR batch_size < 1 OR batch_size > 500 THEN
    RAISE EXCEPTION 'trash expiry batch size must be between 1 and 500' USING ERRCODE = '22023';
  END IF;
  -- The policy row is locked before the schedule or files. Retention updates
  -- take the same policy -> schedule order, and cannot extend a deadline after
  -- our authoritative check but before deletion. A changed policy is re-read
  -- under this lock; materialized deadlines are only scheduling hints.
  SELECT users.id, users.trash_retention_minutes INTO selected_owner, retention_minutes
  FROM trash_expiry_owners AS schedule JOIN users ON users.id = schedule.owner_id
  WHERE schedule.next_due_at <= now() AND NOT tree_operation_owner_busy(users.id)
  ORDER BY schedule.next_due_at, schedule.owner_id LIMIT 1
  FOR SHARE OF users SKIP LOCKED;
  IF selected_owner IS NULL THEN RETURN 0; END IF;
  -- Serialize expiry replicas without holding the schedule row while acquiring
  -- file/parent locks. File writers take those locks before refreshing schedule.
  IF NOT pg_try_advisory_xact_lock(hashtextextended('aeralyth:trash-expiry:' || selected_owner, 0))
    OR NOT pg_try_advisory_xact_lock_shared(hashtextextended('aeralyth:tree-operation:' || selected_owner, 0))
  THEN RETURN 0; END IF;
  PERFORM version FROM tree_operation_owners WHERE owner_id = selected_owner FOR SHARE;
  IF tree_operation_owner_busy(selected_owner) THEN RETURN 0; END IF;

  WITH candidates AS MATERIALIZED (
    SELECT files.id, files.parent_id FROM files
    WHERE files.owner_id = selected_owner AND files.state = 'trashed'
      AND files.trash_child_count = 0 AND files.trashed_at IS NOT NULL
      AND files.trashed_at <= now() - retention_minutes * interval '1 minute'
    ORDER BY files.trashed_at, files.id LIMIT batch_size
  ), locked_parents AS MATERIALIZED (
    -- FK checks take KEY SHARE before insert statement counters. Taking these
    -- parent locks first, and skipping contended parents, preserves that order
    -- through the child-count and owner-counter triggers during deletion.
    SELECT parents.id FROM files AS parents
    JOIN (SELECT DISTINCT parent_id FROM candidates WHERE parent_id IS NOT NULL) AS wanted
      ON wanted.parent_id = parents.id
    ORDER BY parents.id FOR UPDATE OF parents SKIP LOCKED
  ), targets AS MATERIALIZED (
    SELECT files.id, files.owner_id, files.storage_name, files.entry_type,
           uploads.upload_mode, uploads.write_expires_at
    FROM candidates JOIN files ON files.id = candidates.id
    LEFT JOIN file_uploads AS uploads
      ON uploads.file_id = files.id AND uploads.status = 'completed'
    WHERE files.owner_id = selected_owner AND files.state = 'trashed'
      AND files.trash_child_count = 0 AND files.trashed_at IS NOT NULL
      AND files.trashed_at <= now() - retention_minutes * interval '1 minute'
      AND (files.parent_id IS NULL OR EXISTS (
        SELECT 1 FROM locked_parents WHERE locked_parents.id = files.parent_id
      ))
      AND NOT EXISTS (SELECT 1 FROM files AS children WHERE children.parent_id = files.id)
    ORDER BY files.trashed_at, files.id LIMIT batch_size
    FOR UPDATE OF files SKIP LOCKED
  ), objects AS (
    SELECT CASE WHEN position('/' IN targets.storage_name) = 0
      THEN targets.owner_id || '/' || targets.storage_name ELSE targets.storage_name END AS object_key,
      CASE WHEN targets.upload_mode = 'single'
        THEN GREATEST(COALESCE(targets.write_expires_at, now()), now()) ELSE now() END AS available_at
    FROM targets WHERE targets.entry_type = 'file'
    UNION ALL
    SELECT generations.object_key,
      CASE WHEN generation_uploads.upload_mode = 'single'
        THEN GREATEST(COALESCE(generation_uploads.write_expires_at, now()), now()) ELSE now() END
    FROM vault_object_generations AS generations
    JOIN targets ON targets.id = generations.node_id
    LEFT JOIN vault_uploads AS generation_uploads ON generation_uploads.object_key = generations.object_key
  ), queued AS (
    INSERT INTO storage_deletion_jobs (object_key, available_at)
    SELECT object_key, max(available_at) FROM objects GROUP BY object_key
    ON CONFLICT (object_key) DO UPDATE SET available_at = GREATEST(storage_deletion_jobs.available_at, EXCLUDED.available_at)
    RETURNING object_key
  ), deleted AS (
    DELETE FROM files AS entries USING targets
    WHERE entries.id = targets.id AND (SELECT count(*) FROM queued) >= 0
    RETURNING entries.id
  ) SELECT count(*) INTO deleted_count FROM deleted;
  PERFORM refresh_trash_expiry_owners(ARRAY[selected_owner]);
  -- Give other overdue owners a turn before draining another batch from this
  -- owner. Future deadlines keep their precise timestamp.
  UPDATE trash_expiry_owners SET next_due_at = GREATEST(next_due_at, now())
  WHERE owner_id = selected_owner AND next_due_at IS NOT NULL;
  RETURN deleted_count;
END;
$$;


--
-- Name: fence_multipart_orphan_adoption(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.fence_multipart_orphan_adoption() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.object_key IS NULL OR NEW.status NOT IN ('initializing', 'pending', 'completing', 'aborting') THEN
    RETURN NEW;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('aeralyth:multipart-object:' || NEW.object_key, 0));
  IF EXISTS (
    SELECT 1 FROM multipart_orphan_abort_claims AS claims
    WHERE claims.object_key = NEW.object_key
      AND (NEW.multipart_upload_id IS NULL OR claims.upload_id = NEW.multipart_upload_id)
  ) THEN
    RAISE EXCEPTION 'multipart upload is fenced for orphan cleanup' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: guard_share_link_legacy_token_rotation(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.guard_share_link_legacy_token_rotation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF OLD.token_version >= 1
     AND NEW.token_hash IS DISTINCT FROM OLD.token_hash
     AND NEW.token_version = OLD.token_version THEN
    RAISE EXCEPTION 'legacy share-link rotation cannot modify a versioned token'
      USING ERRCODE = '55000',
            HINT = 'Drain or upgrade older Aeralyth instances before rotating this link.';
  END IF;

  RETURN NEW;
END
$$;


--
-- Name: FUNCTION guard_share_link_legacy_token_rotation(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.guard_share_link_legacy_token_rotation() IS 'Rejects old-writer token replacements on versioned share links during rolling deployments.';


--
-- Name: guard_tree_operation_file_write(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.guard_tree_operation_file_write() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: guard_tree_operation_related_write(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.guard_tree_operation_related_write() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: insert_vault_migration_progress(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.insert_vault_migration_progress() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  INSERT INTO vault_migration_progress (owner_id, legacy_nodes, incomplete_nodes)
  SELECT owner_id, sum(legacy::integer), sum((staged OR migration_incomplete)::integer)
  FROM new_progress GROUP BY owner_id
  HAVING bool_or(legacy OR staged OR migration_incomplete)
  ON CONFLICT (owner_id) DO UPDATE SET
    legacy_nodes = vault_migration_progress.legacy_nodes + EXCLUDED.legacy_nodes,
    incomplete_nodes = vault_migration_progress.incomplete_nodes + EXCLUDED.incomplete_nodes;
  RETURN NULL;
END;
$$;


--
-- Name: maintain_trash_expiry_delete(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.maintain_trash_expiry_delete() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  UPDATE files AS parents SET trash_child_count = parents.trash_child_count - children.count
  FROM (SELECT parent_id, count(*) AS count FROM trash_old WHERE parent_id IS NOT NULL GROUP BY parent_id) AS children
  WHERE parents.id = children.parent_id;
  PERFORM refresh_trash_expiry_owners(ARRAY(SELECT DISTINCT owner_id FROM trash_old WHERE state = 'trashed' AND trashed_at IS NOT NULL));
  RETURN NULL;
END;
$$;


--
-- Name: maintain_trash_expiry_insert(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.maintain_trash_expiry_insert() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  UPDATE files AS parents SET trash_child_count = parents.trash_child_count + children.count
  FROM (SELECT parent_id, count(*) AS count FROM trash_new WHERE parent_id IS NOT NULL GROUP BY parent_id) AS children
  WHERE parents.id = children.parent_id;
  PERFORM refresh_trash_expiry_owners(ARRAY(SELECT DISTINCT owner_id FROM trash_new WHERE state = 'trashed' AND trashed_at IS NOT NULL));
  RETURN NULL;
END;
$$;


--
-- Name: maintain_trash_expiry_policy(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.maintain_trash_expiry_policy() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO trash_expiry_owners (owner_id) VALUES (NEW.id) ON CONFLICT DO NOTHING;
  ELSIF NEW.trash_retention_minutes IS DISTINCT FROM OLD.trash_retention_minutes THEN
    PERFORM refresh_trash_expiry_owners(ARRAY[NEW.id]);
  END IF;
  RETURN NULL;
END;
$$;


--
-- Name: maintain_trash_expiry_update(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.maintain_trash_expiry_update() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE affected_owners TEXT[];
BEGIN
  -- Transition tables have no indexes or column statistics. Comparing narrow
  -- sets avoids repeated nested-loop joins when a bulk restore changes rows.
  IF NOT EXISTS (SELECT 1 FROM trash_new) THEN RETURN NULL; END IF;
  WITH previous_leaves AS MATERIALIZED (
    SELECT id, owner_id, trashed_at FROM trash_old
    WHERE state = 'trashed' AND trashed_at IS NOT NULL AND trash_child_count = 0
  ), current_leaves AS MATERIALIZED (
    SELECT id, owner_id, trashed_at FROM trash_new
    WHERE state = 'trashed' AND trashed_at IS NOT NULL AND trash_child_count = 0
  ), removed AS (
    SELECT * FROM previous_leaves EXCEPT SELECT * FROM current_leaves
  ), added AS (
    SELECT * FROM current_leaves EXCEPT SELECT * FROM previous_leaves
  )
  SELECT array_agg(DISTINCT owner_id) INTO affected_owners
  FROM (SELECT owner_id FROM removed UNION ALL SELECT owner_id FROM added) AS changed;

  -- Child counts depend on the net number of incoming edges, not on which
  -- individual child moved. Unchanged parents cancel without joining rows.
  UPDATE files AS parents SET trash_child_count = parents.trash_child_count + delta.count
  FROM (
    SELECT parent_id, sum(count) AS count FROM (
      SELECT parent_id, -1::bigint AS count FROM trash_old WHERE parent_id IS NOT NULL
      UNION ALL
      SELECT parent_id, 1::bigint FROM trash_new WHERE parent_id IS NOT NULL
    ) AS changes GROUP BY parent_id HAVING sum(count) <> 0
  ) AS delta WHERE parents.id = delta.parent_id;
  IF affected_owners IS NOT NULL THEN
    PERFORM refresh_trash_expiry_owners(affected_owners);
  END IF;
  RETURN NULL;
END;
$$;


--
-- Name: mark_repository_counts_dirty_after_delete(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.mark_repository_counts_dirty_after_delete() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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
$$;


--
-- Name: mark_repository_counts_dirty_after_insert(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.mark_repository_counts_dirty_after_insert() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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
$$;


--
-- Name: mark_repository_counts_dirty_after_update(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.mark_repository_counts_dirty_after_update() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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
$$;


--
-- Name: notify_aeralyth_maintenance(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.notify_aeralyth_maintenance() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE scheduling_changed BOOLEAN;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM maintenance_new) THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    -- TG_ARGV comes only from the trigger declarations below, never a request.
    EXECUTE format(
      'SELECT EXISTS (SELECT %s FROM maintenance_new EXCEPT SELECT %s FROM maintenance_old)',
      TG_ARGV[0], TG_ARGV[0]
    ) INTO scheduling_changed;
    IF NOT scheduling_changed THEN
      RETURN NULL;
    END IF;
  END IF;
  PERFORM pg_notify('aeralyth_maintenance', TG_TABLE_NAME);
  RETURN NULL;
END;
$$;


--
-- Name: prepare_multipart_orphan_group(text, text, text[], text[]); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.prepare_multipart_orphan_group(sweep_namespace text, sweep_token text, keys text[], upload_ids text[]) RETURNS bigint
    LANGUAGE plpgsql
    AS $$
DECLARE queued bigint;
BEGIN
  IF cardinality(keys) <> cardinality(upload_ids) OR cardinality(keys) > 64 THEN
    RAISE EXCEPTION 'invalid multipart reconciliation group';
  END IF;
  UPDATE multipart_reconciliation_progress
    SET lease_until = now() + interval '120 seconds', updated_at = now()
    WHERE namespace = sweep_namespace AND lease_token = sweep_token AND lease_until > now();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'multipart reconciliation lease was lost' USING ERRCODE = '55000';
  END IF;
  -- Upload UPDATE acquires its row lock before running the identity trigger.
  -- Follow that order so an in-flight initializer never deadlocks against adoption.
  PERFORM id FROM file_uploads WHERE object_key = ANY(keys) ORDER BY id FOR UPDATE;
  PERFORM id FROM vault_uploads WHERE object_key = ANY(keys) ORDER BY id FOR UPDATE;
  PERFORM pg_advisory_xact_lock(hashtextextended('aeralyth:multipart-object:' || object_key, 0))
    FROM (SELECT DISTINCT unnest(keys) AS object_key ORDER BY object_key) AS ordered_keys;
  -- An insertion may have committed between the row scan and identity lock.
  -- Retry this maintenance group if its new row is already being updated, rather
  -- than reversing lock order and forcing that interactive writer to fail.
  PERFORM id FROM file_uploads WHERE object_key = ANY(keys) ORDER BY id FOR UPDATE NOWAIT;
  PERFORM id FROM vault_uploads WHERE object_key = ANY(keys) ORDER BY id FOR UPDATE NOWAIT;

  WITH candidates AS (
    SELECT DISTINCT ON (object_key) object_key, upload_id
    FROM unnest(keys, upload_ids) AS items(object_key, upload_id)
    ORDER BY object_key, upload_id
  )
  UPDATE file_uploads AS intents SET multipart_upload_id = candidates.upload_id,
    status = 'pending', expires_at = now() + interval '24 hours'
  FROM candidates WHERE intents.object_key = candidates.object_key
    AND position('/files/' IN intents.object_key) > 0
    AND intents.status = 'initializing' AND intents.multipart_upload_id IS NULL
    AND intents.expires_at > now()
    AND NOT EXISTS (SELECT 1 FROM multipart_orphan_abort_claims AS claims
                    WHERE claims.object_key = candidates.object_key);

  WITH candidates AS (
    SELECT DISTINCT ON (object_key) object_key, upload_id
    FROM unnest(keys, upload_ids) AS items(object_key, upload_id)
    ORDER BY object_key, upload_id
  )
  UPDATE vault_uploads AS intents SET multipart_upload_id = candidates.upload_id,
    status = 'pending', expires_at = now() + interval '1 hour'
  FROM candidates WHERE intents.object_key = candidates.object_key
    AND position('/vault/' IN intents.object_key) > 0
    AND intents.status = 'initializing' AND intents.multipart_upload_id IS NULL
    AND intents.expires_at > now()
    AND NOT EXISTS (SELECT 1 FROM multipart_orphan_abort_claims AS claims
                    WHERE claims.object_key = candidates.object_key);

  INSERT INTO multipart_orphan_abort_claims (namespace, object_key, upload_id)
  SELECT sweep_namespace, candidates.object_key, candidates.upload_id
  FROM unnest(keys, upload_ids) AS candidates(object_key, upload_id)
  WHERE NOT EXISTS (
    SELECT 1 FROM file_uploads AS intents
    WHERE intents.object_key = candidates.object_key
      AND intents.status IN ('initializing', 'pending', 'completing', 'aborting')
      AND (intents.multipart_upload_id = candidates.upload_id
        OR GREATEST(intents.expires_at, COALESCE(intents.write_expires_at, intents.expires_at)) > now())
  ) AND NOT EXISTS (
    SELECT 1 FROM vault_uploads AS intents
    WHERE intents.object_key = candidates.object_key
      AND intents.status IN ('initializing', 'pending', 'completing', 'aborting')
      AND (intents.multipart_upload_id = candidates.upload_id
        OR GREATEST(intents.expires_at, COALESCE(intents.write_expires_at, intents.expires_at)) > now())
  ) ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS queued = ROW_COUNT;
  RETURN queued;
END;
$$;


--
-- Name: prevent_upload_reservation_rewrite(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.prevent_upload_reservation_rewrite() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF OLD.owner_id IS DISTINCT FROM NEW.owner_id
     OR OLD.reservation_bytes IS DISTINCT FROM NEW.reservation_bytes THEN
    RAISE EXCEPTION 'upload reservation ownership and bytes are immutable';
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: publish_tree_operation(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.publish_tree_operation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: realtime_dispatch(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.realtime_dispatch() RETURNS integer
    LANGUAGE plpgsql
    AS $$
DECLARE dispatched INTEGER; new_head BIGINT; published_users TEXT[]; target_user TEXT;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtextextended('aeralyth:realtime-dispatch', 0)) THEN RETURN 0; END IF;
  PERFORM realtime_expand_audiences();
  WITH pending AS (
    DELETE FROM realtime_outbox WHERE id IN (SELECT id FROM realtime_outbox ORDER BY id LIMIT 512)
    RETURNING transaction_id, user_id, scope, folder_ids
  ), recorded AS (
    INSERT INTO realtime_audience_deliveries (transaction_id, user_id, scope)
    SELECT DISTINCT transaction_id, user_id, scope FROM pending
    WHERE scope IN ('shared', 'users') AND EXISTS (
      SELECT 1 FROM realtime_audience_jobs jobs
      WHERE jobs.transaction_id = pending.transaction_id AND NOT jobs.complete
    ) ON CONFLICT (transaction_id, user_id, scope) DO NOTHING
  ), published AS (
    INSERT INTO realtime_events (user_id, scope, folder_ids)
    SELECT user_id, scope, folder_ids FROM pending RETURNING id, user_id
  ) SELECT count(*)::integer, max(id), array_agg(DISTINCT user_id)
    INTO dispatched, new_head, published_users FROM published;
  IF dispatched > 0 THEN
    UPDATE realtime_stream_state SET head = new_head WHERE singleton;
    FOREACH target_user IN ARRAY published_users LOOP
      PERFORM pg_notify('aeralyth_changes', 'user:' || target_user);
    END LOOP;
  END IF;
  -- The worker already treats 512 as more work. Retain that contract while
  -- allowing a page to make progress without publishing an event yet.
  IF EXISTS (SELECT 1 FROM realtime_audience_jobs) OR EXISTS (SELECT 1 FROM realtime_outbox)
    OR EXISTS (SELECT 1 FROM realtime_audience_deliveries)
    THEN RETURN 512; END IF;
  RETURN dispatched;
END;
$$;


--
-- Name: realtime_enqueue(text, text, text[]); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.realtime_enqueue(target_user text, target_scope text, folders text[] DEFAULT '{}'::text[]) RETURNS void
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF target_user IS NULL THEN RETURN; END IF;
  INSERT INTO realtime_outbox (user_id, scope, folder_ids)
  VALUES (target_user, target_scope,
    CASE WHEN cardinality(folders) > 32 THEN '{}'::text[] ELSE folders END)
  ON CONFLICT (transaction_id, user_id, scope) DO UPDATE
    SET folder_ids = realtime_merge_folders(realtime_outbox.folder_ids, EXCLUDED.folder_ids);
  PERFORM pg_notify('aeralyth_changes', 'pending');
END;
$$;


--
-- Name: realtime_expand_audiences(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.realtime_expand_audiences() RETURNS integer
    LANGUAGE plpgsql
    AS $_$
DECLARE job realtime_audience_jobs%ROWTYPE; step INTEGER; scanned INTEGER; last_id TEXT;
  audience_sql TEXT; work INTEGER := 0;
BEGIN
  FOR step IN 1..8 LOOP
    SELECT * INTO job FROM realtime_audience_jobs WHERE NOT complete ORDER BY id LIMIT 1;
    EXIT WHEN NOT FOUND;
    work := work + 1;
    IF job.kind IN ('node', 'owner') AND job.phase = 0 THEN
      IF job.kind = 'node' THEN
        INSERT INTO realtime_audience_jobs (transaction_id, kind, owner_id, entity_id, created_at)
        SELECT job.transaction_id, 'node', job.owner_id, parent_id, job.created_at FROM files
        WHERE id = job.entity_id AND owner_id = job.owner_id AND parent_id IS NOT NULL
        ON CONFLICT (transaction_id, kind, owner_id, entity_id) DO NOTHING;
      END IF;
      UPDATE realtime_audience_jobs SET phase = 1 WHERE id = job.id;
      CONTINUE;
    END IF;
    IF job.kind IN ('node', 'owner') AND job.phase = 2 THEN
      -- Fanout to vault shares is also paged, before expanding their recipients.
      audience_sql := 'SELECT id FROM vault_shares WHERE owner_id = $1 AND id > $2
        AND status IN (''active'', ''rotating'')';
      IF job.kind = 'node' THEN audience_sql := audience_sql || ' AND root_node_id = $3'; END IF;
      EXECUTE 'WITH page AS MATERIALIZED (' || audience_sql || ' ORDER BY id LIMIT 128), inserted AS (
        INSERT INTO realtime_audience_jobs (transaction_id, kind, owner_id, entity_id, created_at)
        SELECT $4, ''vault-active'', $1, id, $5 FROM page
        ON CONFLICT (transaction_id, kind, owner_id, entity_id) DO NOTHING
      ) SELECT count(*)::integer, max(id) FROM page'
      INTO scanned, last_id USING job.owner_id, job.after_id, job.entity_id, job.transaction_id, job.created_at;
    ELSE
      IF job.kind = 'admins' THEN
        audience_sql := 'SELECT id, id AS user_id, ''users''::text AS scope FROM users
          WHERE role = ''admin'' AND status = ''active'' AND id > $2';
      ELSIF job.kind IN ('vault-active', 'vault-all') THEN
        audience_sql := 'SELECT recipient_id AS id, recipient_id AS user_id, ''shared''::text AS scope, status
          FROM vault_share_recipients WHERE share_id = $3 AND recipient_id > $2';
      ELSIF job.phase = 1 THEN
        audience_sql := 'SELECT id, recipient_id AS user_id, ''shared''::text AS scope FROM file_shares
          WHERE owner_id = $1 AND id > $2';
        IF job.kind = 'node' THEN audience_sql := audience_sql || ' AND file_id = $3'; END IF;
      ELSE
        audience_sql := 'SELECT id, recipient_id AS user_id, ''shared''::text AS scope FROM share_links
          WHERE owner_id = $1 AND id > $2 AND recipient_id IS NOT NULL AND revoked_at IS NULL';
        IF job.kind = 'node' THEN audience_sql := audience_sql || ' AND root_file_id = $3'; END IF;
        -- Page expired grants too, so a large expired prefix cannot turn a
        -- nominal LIMIT into an unbounded scan. Check expiration at the writer
        -- timestamp, so expiration during queue lag cannot lose its audience.
        audience_sql := replace(audience_sql, 'FROM share_links', ', expires_at FROM share_links');
      END IF;
      EXECUTE 'WITH page AS MATERIALIZED (' || audience_sql || ' ORDER BY id LIMIT 128), fresh AS (
        INSERT INTO realtime_audience_deliveries (transaction_id, user_id, scope)
        SELECT DISTINCT $4, user_id, scope FROM page' ||
        CASE WHEN job.kind IN ('node', 'owner') AND job.phase = 3
          THEN ' WHERE expires_at IS NULL OR expires_at > $5'
          WHEN job.kind = 'vault-active' THEN ' WHERE status = ''active''
            AND EXISTS (SELECT 1 FROM vault_shares WHERE id = $3 AND status IN (''active'', ''rotating''))'
          ELSE '' END || '
        ON CONFLICT (transaction_id, user_id, scope) DO NOTHING RETURNING transaction_id, user_id, scope
      ), inserted AS (
        INSERT INTO realtime_outbox (transaction_id, user_id, scope, folder_ids)
        SELECT transaction_id, user_id, scope, ''{}''::text[] FROM fresh
        ON CONFLICT (transaction_id, user_id, scope) DO UPDATE SET folder_ids = ''{}''::text[]
      ) SELECT count(*)::integer, max(id) FROM page'
      INTO scanned, last_id USING job.owner_id, job.after_id, job.entity_id, job.transaction_id, job.created_at;
    END IF;
    IF scanned = 128 THEN
      UPDATE realtime_audience_jobs SET after_id = last_id WHERE id = job.id;
    ELSIF job.kind IN ('node', 'owner') AND job.phase < 3 THEN
      UPDATE realtime_audience_jobs SET phase = job.phase + 1, after_id = '' WHERE id = job.id;
    ELSE
      UPDATE realtime_audience_jobs SET complete = TRUE WHERE id = job.id;
    END IF;
  END LOOP;
  -- Bounded reclamation also leaves a completed-node dedup fence in place
  -- until all the work from its committed writer transaction has finished.
  DELETE FROM realtime_audience_jobs WHERE id IN (
    WITH candidates AS MATERIALIZED (
      SELECT id, transaction_id FROM realtime_audience_jobs WHERE complete ORDER BY id LIMIT 512
    ) SELECT done.id FROM candidates done WHERE NOT EXISTS (
      SELECT 1 FROM realtime_audience_jobs pending
      WHERE pending.transaction_id = done.transaction_id AND NOT pending.complete
    )
  );
  DELETE FROM realtime_audience_deliveries WHERE id IN (
    WITH candidates AS MATERIALIZED (
      SELECT id, transaction_id FROM realtime_audience_deliveries ORDER BY id LIMIT 512
    ) SELECT done.id FROM candidates done WHERE NOT EXISTS (
      SELECT 1 FROM realtime_audience_jobs pending WHERE pending.transaction_id = done.transaction_id AND NOT pending.complete
    ) AND NOT EXISTS (
      SELECT 1 FROM realtime_outbox pending WHERE pending.transaction_id = done.transaction_id
    )
  );
  RETURN work;
END;
$_$;


--
-- Name: realtime_files_changed(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.realtime_files_changed() RETURNS trigger
    LANGUAGE plpgsql
    AS $_$
DECLARE source_sql TEXT;
BEGIN
  IF TG_TABLE_NAME = 'vault_node_heads' THEN
    IF TG_OP = 'DELETE' THEN
      source_sql := 'SELECT node_id AS id, owner_id FROM realtime_old';
    ELSIF TG_OP = 'INSERT' THEN
      source_sql := 'SELECT node_id AS id, owner_id FROM realtime_new';
    ELSE
      source_sql := 'SELECT n.node_id AS id, n.owner_id FROM realtime_new n JOIN realtime_old o USING (node_id)
        WHERE (n.record_version, n.record_hash) IS DISTINCT FROM (o.record_version, o.record_hash)';
    END IF;
    source_sql := format('SELECT n.id, n.owner_id, f.parent_id, FALSE AS topology,
      COALESCE(f.entry_type = ''folder'', FALSE) AS path_change FROM (%s) n LEFT JOIN files f ON f.id = n.id', source_sql);
  ELSIF TG_OP = 'DELETE' THEN
    source_sql := 'SELECT id, owner_id, parent_id, TRUE AS topology, entry_type = ''folder'' AS path_change FROM realtime_old';
  ELSIF TG_OP = 'INSERT' THEN
    source_sql := 'SELECT id, owner_id, parent_id, FALSE AS topology, FALSE AS path_change FROM realtime_new WHERE e2ee_state <> ''staged''';
  ELSE
    source_sql := 'SELECT n.id, n.owner_id, n.parent_id,
        (n.parent_id, n.owner_id) IS DISTINCT FROM (o.parent_id, o.owner_id) AS topology,
        (n.entry_type = ''folder'' OR o.entry_type = ''folder'') AND
          (n.original_name, n.parent_id, n.owner_id, n.state, n.entry_type, n.e2ee_state) IS DISTINCT FROM
          (o.original_name, o.parent_id, o.owner_id, o.state, o.entry_type, o.e2ee_state) AS path_change
      FROM realtime_new n JOIN realtime_old o USING (id)
      WHERE (n.original_name, n.parent_id, n.owner_id, n.state, n.entry_type, n.favorite, n.size_bytes, n.updated_at, n.e2ee_state,
             n.current_generation_id, n.legacy_share_count, n.vault_share_count)
        IS DISTINCT FROM
            (o.original_name, o.parent_id, o.owner_id, o.state, o.entry_type, o.favorite, o.size_bytes, o.updated_at, o.e2ee_state,
             o.current_generation_id, o.legacy_share_count, o.vault_share_count)
        AND (n.e2ee_state <> ''staged'' OR o.e2ee_state <> ''staged'')
      UNION SELECT o.id, o.owner_id, o.parent_id, TRUE, o.entry_type = ''folder'' FROM realtime_old o JOIN realtime_new n USING (id)
        WHERE (o.parent_id, o.owner_id) IS DISTINCT FROM (n.parent_id, n.owner_id)
        AND (n.e2ee_state <> ''staged'' OR o.e2ee_state <> ''staged'')';
  END IF;

  EXECUTE format($query$
    WITH changed AS MATERIALIZED (%s), owners AS MATERIALIZED (
      SELECT owner_id, count(*) AS amount, bool_or(topology) AS topology FROM changed GROUP BY owner_id
    ), affected AS MATERIALIZED (
      SELECT DISTINCT owner_id, 'files'::text AS scope, COALESCE(parent_id, '') AS folder_id FROM changed
      UNION SELECT owner_id, 'paths', id FROM changed WHERE path_change
    ), scope_counts AS (
      SELECT owner_id, scope, count(*) AS amount FROM affected GROUP BY owner_id, scope
    ), enqueued AS (
      INSERT INTO realtime_outbox (user_id, scope, folder_ids)
      SELECT a.owner_id, a.scope, CASE WHEN c.amount > 32 THEN '{}'::text[] ELSE
        array_agg(a.folder_id ORDER BY a.folder_id) FILTER (WHERE c.amount <= 32) END
      FROM affected a JOIN scope_counts c USING (owner_id, scope)
      GROUP BY a.owner_id, a.scope, c.amount
      ON CONFLICT (transaction_id, user_id, scope) DO UPDATE
        SET folder_ids = realtime_merge_folders(realtime_outbox.folder_ids, EXCLUDED.folder_ids)
    )
    INSERT INTO realtime_audience_jobs (kind, owner_id, entity_id)
    SELECT 'owner', owner_id, '' FROM owners WHERE topology OR amount > 32
    UNION SELECT 'node', c.owner_id, c.id FROM changed c JOIN owners o USING (owner_id)
      WHERE NOT o.topology AND o.amount <= 32
    UNION SELECT 'node', c.owner_id, c.parent_id FROM changed c JOIN owners o USING (owner_id)
      WHERE NOT o.topology AND o.amount <= 32 AND c.parent_id IS NOT NULL
    ON CONFLICT (transaction_id, kind, owner_id, entity_id) DO NOTHING
  $query$, source_sql);
  -- A move/delete may happen again before expansion. Its owner seed covers
  -- former paths without retaining private names or a historical tree. Direct
  -- grant deletions separately save their OLD recipients, including cascades.
  PERFORM pg_notify('aeralyth_changes', 'pending');
  RETURN NULL;
END;
$_$;


--
-- Name: realtime_merge_folders(text[], text[]); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.realtime_merge_folders(a text[], b text[]) RETURNS text[]
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    AS $$
  SELECT CASE WHEN cardinality(a) = 0 OR cardinality(b) = 0 OR count(*) > 32
    THEN '{}'::text[] ELSE COALESCE(array_agg(folder ORDER BY folder), '{}'::text[]) END
  FROM (SELECT DISTINCT unnest(a || b) AS folder LIMIT 33) AS folders
$$;


--
-- Name: realtime_prune(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.realtime_prune() RETURNS integer
    LANGUAGE plpgsql
    AS $$
DECLARE removed INTEGER; new_floor BIGINT;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtextextended('aeralyth:realtime-dispatch', 0)) THEN RETURN 0; END IF;
  WITH expired AS (
    DELETE FROM realtime_events WHERE id IN (
      SELECT id FROM realtime_events
      WHERE created_at < now() - interval '24 hours'
        OR id <= (SELECT head - 100000 FROM realtime_stream_state WHERE singleton)
      ORDER BY id LIMIT 2048
    ) RETURNING id
  ) SELECT count(*)::integer, max(id) INTO removed, new_floor FROM expired;
  IF removed > 0 THEN
    UPDATE realtime_stream_state SET floor = GREATEST(floor, new_floor) WHERE singleton;
  END IF;
  RETURN removed;
END;
$$;


--
-- Name: realtime_related_changed(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.realtime_related_changed() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE source_sql TEXT; row_sql TEXT; own_scope TEXT;
BEGIN
  source_sql := CASE TG_OP WHEN 'INSERT' THEN 'SELECT * FROM realtime_new'
    WHEN 'DELETE' THEN 'SELECT * FROM realtime_old'
    ELSE 'SELECT * FROM realtime_new UNION ALL SELECT * FROM realtime_old' END;
  own_scope := CASE TG_TABLE_NAME WHEN 'repositories' THEN 'repositories' WHEN 'users' THEN 'profile'
    WHEN 'sessions' THEN 'security' WHEN 'user_vaults' THEN 'vault' ELSE 'files' END;
  IF TG_TABLE_NAME = 'users' THEN
    row_sql := format('SELECT DISTINCT id AS user_id, %L AS scope FROM (%s) r', own_scope, source_sql);
    EXECUTE format('INSERT INTO realtime_audience_jobs (kind, owner_id, entity_id)
      SELECT ''admins'', '''', '''' WHERE EXISTS (SELECT 1 FROM (%s) r)
      ON CONFLICT (transaction_id, kind, owner_id, entity_id) DO NOTHING', source_sql);
  ELSIF TG_TABLE_NAME IN ('sessions', 'user_vaults') THEN
    row_sql := format('SELECT DISTINCT user_id, %L AS scope FROM (%s) r', own_scope, source_sql);
  ELSIF TG_TABLE_NAME IN ('file_shares', 'share_links') THEN
    row_sql := format('SELECT owner_id AS user_id, ''files'' AS scope FROM (%s) r
      UNION SELECT recipient_id, ''shared'' FROM (%s) r WHERE recipient_id IS NOT NULL', source_sql, source_sql);
  ELSIF TG_TABLE_NAME = 'vault_share_recipients' THEN
    row_sql := format('SELECT recipient_id AS user_id, ''shared'' AS scope FROM (%s) r
      UNION SELECT s.owner_id, ''files'' FROM (%s) r JOIN vault_shares s ON s.id = r.share_id', source_sql, source_sql);
  ELSIF TG_TABLE_NAME = 'vault_shares' THEN
    row_sql := format('SELECT DISTINCT owner_id AS user_id, ''files'' AS scope FROM (%s) r', source_sql);
    EXECUTE format('INSERT INTO realtime_audience_jobs (kind, owner_id, entity_id)
      SELECT DISTINCT ''vault-all'', owner_id, id FROM (%s) r
      ON CONFLICT (transaction_id, kind, owner_id, entity_id) DO NOTHING', source_sql);
  ELSE
    row_sql := format('SELECT DISTINCT owner_id AS user_id, %L AS scope FROM (%s) r', own_scope, source_sql);
  END IF;
  EXECUTE format('INSERT INTO realtime_outbox (user_id, scope, folder_ids)
    SELECT DISTINCT user_id, scope, ''{}''::text[] FROM (%s) targets WHERE user_id IS NOT NULL
    ON CONFLICT (transaction_id, user_id, scope) DO UPDATE SET folder_ids = ''{}''::text[]', row_sql);
  PERFORM pg_notify('aeralyth_changes', 'pending');
  RETURN NULL;
END;
$$;


--
-- Name: reconcile_vault_migration_progress(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.reconcile_vault_migration_progress() RETURNS void
    LANGUAGE plpgsql
    AS $$
BEGIN
  LOCK TABLE files, vault_migrations IN SHARE ROW EXCLUSIVE MODE;
  TRUNCATE vault_migration_node_progress, vault_migration_progress;
  INSERT INTO vault_migration_node_progress
    (owner_id, node_id, legacy, staged, migration_incomplete)
  SELECT owner_id, node_id, bool_or(legacy), bool_or(staged), bool_or(migration_incomplete)
  FROM (
    SELECT owner_id, id AS node_id, e2ee_state = 'legacy' AS legacy,
      e2ee_state = 'staged' AS staged, FALSE AS migration_incomplete
    FROM files WHERE e2ee_state IN ('legacy', 'staged')
    UNION ALL
    SELECT owner_id, node_id, FALSE, FALSE, TRUE
    FROM vault_migrations WHERE state <> 'complete'
  ) AS contributions
  GROUP BY owner_id, node_id;
END;
$$;


--
-- Name: refresh_file_link_share_state(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.refresh_file_link_share_state() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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
$$;


--
-- Name: refresh_trash_expiry_owners(text[]); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.refresh_trash_expiry_owners(owner_ids text[]) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE selected_owner TEXT;
BEGIN
  FOR selected_owner IN SELECT DISTINCT unnest(owner_ids) ORDER BY 1 LOOP
    -- Lock before the next SQL command takes its snapshot. Computing the MIN
    -- as part of a contended UPDATE could publish an obsolete deadline.
    PERFORM 1 FROM trash_expiry_owners WHERE owner_id = selected_owner FOR UPDATE;
    UPDATE trash_expiry_owners AS schedule SET next_due_at = (
      SELECT files.trashed_at + users.trash_retention_minutes * interval '1 minute'
      FROM files JOIN users ON users.id = files.owner_id
      WHERE files.owner_id = selected_owner AND files.state = 'trashed'
        AND files.trashed_at IS NOT NULL AND files.trash_child_count = 0
      ORDER BY files.trashed_at, files.id LIMIT 1
    ) WHERE schedule.owner_id = selected_owner;
  END LOOP;
END;
$$;


--
-- Name: repository_content_version(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.repository_content_version(target_repository text) RETURNS bigint
    LANGUAGE sql STABLE PARALLEL SAFE
    AS $$
  SELECT COALESCE(sum(version), 0)::bigint FROM repository_revision_shards
  WHERE repository_id = target_repository
$$;


--
-- Name: repository_created_counts(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.repository_created_counts() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  INSERT INTO repository_pending_changes (repository_id) SELECT id FROM collection_new
  ON CONFLICT (transaction_id,repository_id) DO NOTHING;
  PERFORM pg_notify('aeralyth_changes','pending');
  RETURN NULL;
END $$;


--
-- Name: repository_files_changed(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.repository_files_changed() RETURNS trigger
    LANGUAGE plpgsql
    AS $_$
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
$_$;


--
-- Name: sync_trash_retention_units(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sync_trash_retention_units() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.trash_retention_minutes = 43200 AND NEW.trash_retention_days <> 30 THEN
      NEW.trash_retention_minutes := NEW.trash_retention_days * 1440;
    ELSE
      NEW.trash_retention_days := CEIL(NEW.trash_retention_minutes / 1440.0)::integer;
    END IF;
  ELSIF NEW.trash_retention_minutes IS DISTINCT FROM OLD.trash_retention_minutes THEN
    NEW.trash_retention_days := CEIL(NEW.trash_retention_minutes / 1440.0)::integer;
  ELSIF NEW.trash_retention_days IS DISTINCT FROM OLD.trash_retention_days THEN
    NEW.trash_retention_minutes := NEW.trash_retention_days * 1440;
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: track_file_migration_progress(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.track_file_migration_progress() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO vault_migration_node_progress (owner_id, node_id, legacy, staged)
    SELECT owner_id, id, e2ee_state = 'legacy', e2ee_state = 'staged'
    FROM new_files WHERE e2ee_state IN ('legacy', 'staged')
    ORDER BY owner_id, id
    ON CONFLICT (owner_id, node_id) DO UPDATE SET
      legacy = EXCLUDED.legacy, staged = EXCLUDED.staged;
  ELSIF TG_OP = 'UPDATE' THEN
    -- Transition tables have no indexes. Compute the changed state sets once
    -- before joining the indexed tracker; correlated anti-joins can scan the
    -- whole transition table for every row of a bulk trash/restore operation.
    WITH changed AS MATERIALIZED (
      SELECT owner_id, id, e2ee_state FROM old_files
      EXCEPT
      SELECT owner_id, id, e2ee_state FROM new_files
    )
    UPDATE vault_migration_node_progress AS progress SET legacy = FALSE, staged = FALSE
    FROM changed AS previous
    WHERE progress.owner_id = previous.owner_id AND progress.node_id = previous.id
      AND (progress.legacy OR progress.staged);
    WITH changed AS MATERIALIZED (
      SELECT owner_id, id, e2ee_state FROM new_files
      EXCEPT
      SELECT owner_id, id, e2ee_state FROM old_files
    )
    INSERT INTO vault_migration_node_progress (owner_id, node_id, legacy, staged)
    SELECT next.owner_id, next.id, next.e2ee_state = 'legacy', next.e2ee_state = 'staged'
    FROM changed AS next WHERE next.e2ee_state IN ('legacy', 'staged')
    ORDER BY next.owner_id, next.id
    ON CONFLICT (owner_id, node_id) DO UPDATE SET
      legacy = EXCLUDED.legacy, staged = EXCLUDED.staged;
  ELSE
    UPDATE vault_migration_node_progress AS progress SET legacy = FALSE, staged = FALSE
    FROM old_files AS previous
    WHERE progress.owner_id = previous.owner_id AND progress.node_id = previous.id
      AND (progress.legacy OR progress.staged);
  END IF;
  IF TG_OP <> 'INSERT' THEN
    DELETE FROM vault_migration_node_progress AS progress USING old_files AS previous
    WHERE progress.owner_id = previous.owner_id AND progress.node_id = previous.id
      AND NOT progress.legacy AND NOT progress.staged AND NOT progress.migration_incomplete;
  END IF;
  RETURN NULL;
END;
$$;


--
-- Name: track_vault_migration_progress(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.track_vault_migration_progress() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO vault_migration_node_progress (owner_id, node_id, migration_incomplete)
    SELECT owner_id, node_id, TRUE FROM new_migrations WHERE state <> 'complete'
    ORDER BY owner_id, node_id
    ON CONFLICT (owner_id, node_id) DO UPDATE SET migration_incomplete = TRUE;
  ELSIF TG_OP = 'UPDATE' THEN
    WITH changed AS MATERIALIZED (
      SELECT owner_id, node_id, state <> 'complete' AS incomplete FROM old_migrations
      EXCEPT
      SELECT owner_id, node_id, state <> 'complete' AS incomplete FROM new_migrations
    )
    UPDATE vault_migration_node_progress AS progress SET migration_incomplete = FALSE
    FROM changed AS previous
    WHERE progress.owner_id = previous.owner_id AND progress.node_id = previous.node_id
      AND progress.migration_incomplete;
    WITH changed AS MATERIALIZED (
      SELECT owner_id, node_id, state <> 'complete' AS incomplete FROM new_migrations
      EXCEPT
      SELECT owner_id, node_id, state <> 'complete' AS incomplete FROM old_migrations
    )
    INSERT INTO vault_migration_node_progress (owner_id, node_id, migration_incomplete)
    SELECT next.owner_id, next.node_id, TRUE FROM changed AS next
    WHERE next.incomplete
    ORDER BY next.owner_id, next.node_id
    ON CONFLICT (owner_id, node_id) DO UPDATE SET migration_incomplete = TRUE;
  ELSE
    UPDATE vault_migration_node_progress AS progress SET migration_incomplete = FALSE
    FROM old_migrations AS previous
    WHERE progress.owner_id = previous.owner_id AND progress.node_id = previous.node_id
      AND progress.migration_incomplete;
  END IF;
  IF TG_OP <> 'INSERT' THEN
    DELETE FROM vault_migration_node_progress AS progress USING old_migrations AS previous
    WHERE progress.owner_id = previous.owner_id AND progress.node_id = previous.node_id
      AND NOT progress.legacy AND NOT progress.staged AND NOT progress.migration_incomplete;
  END IF;
  RETURN NULL;
END;
$$;


--
-- Name: tree_operation_ancestor(text, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.tree_operation_ancestor(target_node text, target_owner text, possible_ancestor text) RETURNS boolean
    LANGUAGE sql STABLE PARALLEL SAFE
    AS $$
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


--
-- Name: tree_operation_drain_dependencies(text, text[], integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.tree_operation_drain_dependencies(target_owner text, node_ids text[], batch_limit integer DEFAULT 256) RETURNS boolean
    LANGUAGE plpgsql
    AS $_$
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
$_$;


--
-- Name: tree_operation_drain_repository_dependencies(text, text[], integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.tree_operation_drain_repository_dependencies(target_owner text, node_ids text[], batch_limit integer) RETURNS boolean
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: tree_operation_owner_busy(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.tree_operation_owner_busy(target_owner text) RETURNS boolean
    LANGUAGE sql STABLE PARALLEL SAFE
    AS $$
  SELECT EXISTS (
    SELECT 1 FROM tree_operation_jobs
    WHERE owner_id = target_owner AND status IN ('pending', 'running')
  );
$$;


--
-- Name: tree_operation_visible(text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.tree_operation_visible(target_node text, target_owner text) RETURNS boolean
    LANGUAGE plpgsql STABLE PARALLEL SAFE
    AS $$
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


--
-- Name: update_admin_invitation_counters(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_admin_invitation_counters() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  old_pending BIGINT := 0;
  new_pending BIGINT := 0;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    old_pending := CASE WHEN OLD.status = 'pending' THEN 1 ELSE 0 END;
  END IF;

  IF TG_OP <> 'DELETE' THEN
    new_pending := CASE WHEN NEW.status = 'pending' THEN 1 ELSE 0 END;
  END IF;

  IF old_pending = new_pending THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  UPDATE admin_directory_counters
  SET pending_invitations = GREATEST(
        0,
        pending_invitations + new_pending - old_pending
      ),
      updated_at = now()
  WHERE singleton = TRUE;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: update_admin_user_counters(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_admin_user_counters() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  old_total BIGINT := 0;
  new_total BIGINT := 0;
  old_active BIGINT := 0;
  new_active BIGINT := 0;
  old_admin BIGINT := 0;
  new_admin BIGINT := 0;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    old_total := CASE WHEN OLD.status <> 'deleting' THEN 1 ELSE 0 END;
    old_active := CASE WHEN OLD.status = 'active' THEN 1 ELSE 0 END;
    old_admin := CASE WHEN OLD.status = 'active' AND OLD.role = 'admin' THEN 1 ELSE 0 END;
  END IF;

  IF TG_OP <> 'DELETE' THEN
    new_total := CASE WHEN NEW.status <> 'deleting' THEN 1 ELSE 0 END;
    new_active := CASE WHEN NEW.status = 'active' THEN 1 ELSE 0 END;
    new_admin := CASE WHEN NEW.status = 'active' AND NEW.role = 'admin' THEN 1 ELSE 0 END;
  END IF;

  IF old_total = new_total
     AND old_active = new_active
     AND old_admin = new_admin THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  UPDATE admin_directory_counters
  SET total_users = GREATEST(0, total_users + new_total - old_total),
      active_users = GREATEST(0, active_users + new_active - old_active),
      active_admins = GREATEST(0, active_admins + new_admin - old_admin),
      updated_at = now()
  WHERE singleton = TRUE;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: update_file_counters(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_file_counters() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  owner TEXT;
  old_total_files BIGINT := 0;
  new_total_files BIGINT := 0;
  old_total_folders BIGINT := 0;
  new_total_folders BIGINT := 0;
  old_trashed_files BIGINT := 0;
  new_trashed_files BIGINT := 0;
  old_favorites BIGINT := 0;
  new_favorites BIGINT := 0;
  old_bytes BIGINT := 0;
  new_bytes BIGINT := 0;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    owner := OLD.owner_id;
    old_total_files := CASE WHEN OLD.entry_type = 'file' AND OLD.state = 'active' THEN 1 ELSE 0 END;
    old_total_folders := CASE WHEN OLD.entry_type = 'folder' AND OLD.state = 'active' THEN 1 ELSE 0 END;
    old_trashed_files := CASE WHEN OLD.entry_type = 'file' AND OLD.state = 'trashed' THEN 1 ELSE 0 END;
    old_favorites := CASE WHEN OLD.state = 'active' AND OLD.favorite THEN 1 ELSE 0 END;
    old_bytes := CASE WHEN OLD.entry_type = 'file' THEN OLD.size_bytes ELSE 0 END;
  END IF;

  IF TG_OP <> 'DELETE' THEN
    owner := NEW.owner_id;
    new_total_files := CASE WHEN NEW.entry_type = 'file' AND NEW.state = 'active' THEN 1 ELSE 0 END;
    new_total_folders := CASE WHEN NEW.entry_type = 'folder' AND NEW.state = 'active' THEN 1 ELSE 0 END;
    new_trashed_files := CASE WHEN NEW.entry_type = 'file' AND NEW.state = 'trashed' THEN 1 ELSE 0 END;
    new_favorites := CASE WHEN NEW.state = 'active' AND NEW.favorite THEN 1 ELSE 0 END;
    new_bytes := CASE WHEN NEW.entry_type = 'file' THEN NEW.size_bytes ELSE 0 END;
  END IF;

  INSERT INTO user_file_counters (
    owner_id,
    total_files,
    total_folders,
    active_files,
    trashed_files,
    favorite_files,
    used_bytes
  )
  VALUES (
    owner,
    new_total_files,
    new_total_folders,
    new_total_files,
    new_trashed_files,
    new_favorites,
    new_bytes
  )
  ON CONFLICT (owner_id) DO UPDATE SET
    total_files = GREATEST(0, user_file_counters.total_files + new_total_files - old_total_files),
    total_folders = GREATEST(0, user_file_counters.total_folders + new_total_folders - old_total_folders),
    active_files = GREATEST(0, user_file_counters.active_files + new_total_files - old_total_files),
    trashed_files = GREATEST(0, user_file_counters.trashed_files + new_trashed_files - old_trashed_files),
    favorite_files = GREATEST(0, user_file_counters.favorite_files + new_favorites - old_favorites),
    used_bytes = GREATEST(0, user_file_counters.used_bytes + new_bytes - old_bytes),
    updated_at = now();

  IF TG_OP = 'UPDATE' AND OLD.state IS DISTINCT FROM NEW.state AND NEW.entry_type = 'file' THEN
    UPDATE user_file_counters
    SET shared_files = GREATEST(
          0,
          shared_files + CASE WHEN NEW.state = 'active' THEN 1 ELSE -1 END
        ),
        updated_at = now()
    WHERE owner_id IN (
      SELECT recipient_id FROM file_shares WHERE file_id = NEW.id
    );

    UPDATE file_shares
    SET counts_toward_shared = (NEW.state = 'active')
    WHERE file_id = NEW.id;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  RETURN NEW;
END;
$$;


--
-- Name: update_file_counters_after_delete(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_file_counters_after_delete() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  delta RECORD;
BEGIN
  FOR delta IN
    SELECT
      owner_id,
      -count(*) FILTER (WHERE entry_type = 'file' AND state = 'active')::bigint AS total_files,
      -count(*) FILTER (WHERE entry_type = 'folder' AND state = 'active')::bigint AS total_folders,
      -count(*) FILTER (WHERE entry_type = 'file' AND state = 'trashed')::bigint AS trashed_files,
      -count(*) FILTER (WHERE state = 'active' AND favorite)::bigint AS favorites,
      -COALESCE(sum(size_bytes) FILTER (WHERE entry_type = 'file'), 0)::bigint AS used_bytes
    FROM old_file_rows
    GROUP BY owner_id
  LOOP
    PERFORM apply_file_counter_delta(
      delta.owner_id,
      delta.total_files,
      delta.total_folders,
      delta.trashed_files,
      delta.favorites,
      delta.used_bytes
    );
  END LOOP;
  RETURN NULL;
END;
$$;


--
-- Name: update_file_counters_after_insert(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_file_counters_after_insert() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  delta RECORD;
BEGIN
  FOR delta IN
    SELECT
      owner_id,
      count(*) FILTER (WHERE entry_type = 'file' AND state = 'active')::bigint AS total_files,
      count(*) FILTER (WHERE entry_type = 'folder' AND state = 'active')::bigint AS total_folders,
      count(*) FILTER (WHERE entry_type = 'file' AND state = 'trashed')::bigint AS trashed_files,
      count(*) FILTER (WHERE state = 'active' AND favorite)::bigint AS favorites,
      COALESCE(sum(size_bytes) FILTER (WHERE entry_type = 'file'), 0)::bigint AS used_bytes
    FROM new_file_rows
    GROUP BY owner_id
  LOOP
    PERFORM apply_file_counter_delta(
      delta.owner_id,
      delta.total_files,
      delta.total_folders,
      delta.trashed_files,
      delta.favorites,
      delta.used_bytes
    );
  END LOOP;
  RETURN NULL;
END;
$$;


--
-- Name: update_file_counters_after_update(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_file_counters_after_update() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  delta RECORD;
BEGIN
  FOR delta IN
    WITH contributions AS (
      SELECT
        owner_id,
        -CASE WHEN entry_type = 'file' AND state = 'active' THEN 1 ELSE 0 END::bigint AS total_files,
        -CASE WHEN entry_type = 'folder' AND state = 'active' THEN 1 ELSE 0 END::bigint AS total_folders,
        -CASE WHEN entry_type = 'file' AND state = 'trashed' THEN 1 ELSE 0 END::bigint AS trashed_files,
        -CASE WHEN state = 'active' AND favorite THEN 1 ELSE 0 END::bigint AS favorites,
        -CASE WHEN entry_type = 'file' THEN size_bytes ELSE 0 END::bigint AS used_bytes
      FROM old_file_rows
      UNION ALL
      SELECT
        owner_id,
        CASE WHEN entry_type = 'file' AND state = 'active' THEN 1 ELSE 0 END::bigint,
        CASE WHEN entry_type = 'folder' AND state = 'active' THEN 1 ELSE 0 END::bigint,
        CASE WHEN entry_type = 'file' AND state = 'trashed' THEN 1 ELSE 0 END::bigint,
        CASE WHEN state = 'active' AND favorite THEN 1 ELSE 0 END::bigint,
        CASE WHEN entry_type = 'file' THEN size_bytes ELSE 0 END::bigint
      FROM new_file_rows
    )
    SELECT
      owner_id,
      sum(total_files)::bigint AS total_files,
      sum(total_folders)::bigint AS total_folders,
      sum(trashed_files)::bigint AS trashed_files,
      sum(favorites)::bigint AS favorites,
      sum(used_bytes)::bigint AS used_bytes
    FROM contributions
    GROUP BY owner_id
    HAVING sum(total_files) <> 0
        OR sum(total_folders) <> 0
        OR sum(trashed_files) <> 0
        OR sum(favorites) <> 0
        OR sum(used_bytes) <> 0
  LOOP
    PERFORM apply_file_counter_delta(
      delta.owner_id,
      delta.total_files,
      delta.total_folders,
      delta.trashed_files,
      delta.favorites,
      delta.used_bytes
    );
  END LOOP;

  FOR delta IN
    SELECT
      shares.recipient_id AS owner_id,
      sum(
        CASE WHEN new_files.entry_type = 'file' AND new_files.state = 'active' THEN 1 ELSE 0 END
        - CASE WHEN old_files.entry_type = 'file' AND old_files.state = 'active' THEN 1 ELSE 0 END
      )::bigint AS shared_files
    FROM old_file_rows AS old_files
    INNER JOIN new_file_rows AS new_files ON new_files.id = old_files.id
    INNER JOIN file_shares AS shares ON shares.file_id = new_files.id
    WHERE old_files.entry_type IS DISTINCT FROM new_files.entry_type
       OR old_files.state IS DISTINCT FROM new_files.state
    GROUP BY shares.recipient_id
    HAVING sum(
      CASE WHEN new_files.entry_type = 'file' AND new_files.state = 'active' THEN 1 ELSE 0 END
      - CASE WHEN old_files.entry_type = 'file' AND old_files.state = 'active' THEN 1 ELSE 0 END
    ) <> 0
  LOOP
    UPDATE user_file_counters
    SET shared_files = GREATEST(0, shared_files + delta.shared_files),
        updated_at = now()
    WHERE owner_id = delta.owner_id;
  END LOOP;

  UPDATE file_shares AS shares
  SET counts_toward_shared = (
    new_files.entry_type = 'file' AND new_files.state = 'active'
  )
  FROM old_file_rows AS old_files, new_file_rows AS new_files
  WHERE old_files.id = new_files.id
    AND shares.file_id = new_files.id
    AND (
      old_files.entry_type IS DISTINCT FROM new_files.entry_type
      OR old_files.state IS DISTINCT FROM new_files.state
    )
    AND shares.counts_toward_shared IS DISTINCT FROM (
      new_files.entry_type = 'file' AND new_files.state = 'active'
    );

  RETURN NULL;
END;
$$;


--
-- Name: update_file_legacy_share_state(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_file_legacy_share_state() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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
$$;


--
-- Name: update_file_upload_reservations(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_file_upload_reservations() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  delta RECORD;
BEGIN
  FOR delta IN
    WITH contributions AS (
      SELECT
        owner_id,
        -CASE WHEN status IN ('initializing', 'pending', 'completing', 'aborting')
          THEN reservation_bytes ELSE 0 END::bigint AS reserved_bytes,
        -CASE WHEN status IN ('initializing', 'pending', 'completing', 'aborting')
          THEN 1 ELSE 0 END::bigint AS pending_uploads
      FROM old_upload_rows
      UNION ALL
      SELECT
        owner_id,
        CASE WHEN status IN ('initializing', 'pending', 'completing', 'aborting')
          THEN reservation_bytes ELSE 0 END::bigint,
        CASE WHEN status IN ('initializing', 'pending', 'completing', 'aborting')
          THEN 1 ELSE 0 END::bigint
      FROM new_upload_rows
    )
    SELECT owner_id,
           sum(reserved_bytes)::bigint AS reserved_bytes,
           sum(pending_uploads)::bigint AS pending_uploads
    FROM contributions
    GROUP BY owner_id
    HAVING sum(reserved_bytes) <> 0 OR sum(pending_uploads) <> 0
  LOOP
    PERFORM apply_upload_reservation_delta(
      delta.owner_id,
      delta.reserved_bytes,
      delta.pending_uploads
    );
  END LOOP;
  RETURN NULL;
END;
$$;


--
-- Name: update_file_vault_share_state(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_file_vault_share_state() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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
$$;


--
-- Name: update_share_counters(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_share_counters() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  recipient TEXT;
  shared_file_id TEXT;
  delta BIGINT;
BEGIN
  IF TG_OP = 'INSERT' THEN
    recipient := NEW.recipient_id;
    shared_file_id := NEW.file_id;
    delta := CASE WHEN NEW.counts_toward_shared THEN 1 ELSE 0 END;
  ELSE
    recipient := OLD.recipient_id;
    shared_file_id := OLD.file_id;
    delta := CASE WHEN OLD.counts_toward_shared THEN -1 ELSE 0 END;
  END IF;

  IF delta <> 0 AND (TG_OP = 'DELETE' OR EXISTS (
    SELECT 1 FROM files
    WHERE id = shared_file_id
      AND state = 'active'
      AND entry_type = 'file'
  )) THEN
    INSERT INTO user_file_counters (owner_id, shared_files)
    VALUES (recipient, GREATEST(0, delta))
    ON CONFLICT (owner_id) DO UPDATE SET
      shared_files = GREATEST(0, user_file_counters.shared_files + delta),
      updated_at = now();
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  RETURN NEW;
END;
$$;


--
-- Name: update_vault_upload_reservations(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_vault_upload_reservations() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  delta RECORD;
BEGIN
  FOR delta IN
    WITH contributions AS (
      SELECT
        owner_id,
        -CASE WHEN status IN ('initializing', 'pending', 'completing', 'aborting')
          THEN reservation_bytes ELSE 0 END::bigint AS reserved_bytes,
        -CASE WHEN status IN ('initializing', 'pending', 'completing', 'aborting')
          THEN 1 ELSE 0 END::bigint AS pending_uploads
      FROM old_vault_upload_rows
      UNION ALL
      SELECT
        owner_id,
        CASE WHEN status IN ('initializing', 'pending', 'completing', 'aborting')
          THEN reservation_bytes ELSE 0 END::bigint,
        CASE WHEN status IN ('initializing', 'pending', 'completing', 'aborting')
          THEN 1 ELSE 0 END::bigint
      FROM new_vault_upload_rows
    )
    SELECT owner_id,
           sum(reserved_bytes)::bigint AS reserved_bytes,
           sum(pending_uploads)::bigint AS pending_uploads
    FROM contributions
    GROUP BY owner_id
    HAVING sum(reserved_bytes) <> 0 OR sum(pending_uploads) <> 0
  LOOP
    PERFORM apply_upload_reservation_delta(
      delta.owner_id,
      delta.reserved_bytes,
      delta.pending_uploads
    );
  END LOOP;
  RETURN NULL;
END;
$$;


--
-- Name: validate_inserted_file_hierarchy(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.validate_inserted_file_hierarchy() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  changed_ids TEXT[];
  owner_key TEXT;
BEGIN
  -- Serialize structural changes per owner so two concurrent folder moves
  -- cannot both validate against stale graphs and create a cycle together.
  FOR owner_key IN
    SELECT DISTINCT owner_id
    FROM inserted_files
    WHERE entry_type = 'folder'
    ORDER BY owner_id
  LOOP
    PERFORM pg_advisory_xact_lock(
      hashtextextended('aeralyth:file-hierarchy:' || owner_key, 0)
    );
  END LOOP;

  SELECT array_agg(id ORDER BY id) INTO changed_ids FROM inserted_files;
  PERFORM assert_file_hierarchy_valid(changed_ids);
  RETURN NULL;
END;
$$;


--
-- Name: validate_updated_file_hierarchy(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.validate_updated_file_hierarchy() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  changed_ids TEXT[];
  owner_key TEXT;
BEGIN
  FOR owner_key IN
    SELECT DISTINCT owners.owner_id
    FROM (
      SELECT old_files.owner_id
      FROM old_files
      INNER JOIN updated_files USING (id)
      WHERE ROW(old_files.owner_id, old_files.parent_id, old_files.entry_type)
        IS DISTINCT FROM
        ROW(updated_files.owner_id, updated_files.parent_id, updated_files.entry_type)
      UNION
      SELECT updated_files.owner_id
      FROM old_files
      INNER JOIN updated_files USING (id)
      WHERE ROW(old_files.owner_id, old_files.parent_id, old_files.entry_type)
        IS DISTINCT FROM
        ROW(updated_files.owner_id, updated_files.parent_id, updated_files.entry_type)
    ) AS owners
    ORDER BY owners.owner_id
  LOOP
    PERFORM pg_advisory_xact_lock(
      hashtextextended('aeralyth:file-hierarchy:' || owner_key, 0)
    );
  END LOOP;

  SELECT array_agg(updated_files.id ORDER BY updated_files.id)
  INTO changed_ids
  FROM updated_files
  INNER JOIN old_files USING (id)
  WHERE ROW(old_files.owner_id, old_files.parent_id, old_files.entry_type)
    IS DISTINCT FROM
    ROW(updated_files.owner_id, updated_files.parent_id, updated_files.entry_type);

  PERFORM assert_file_hierarchy_valid(changed_ids);
  RETURN NULL;
END;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: admin_directory_counters; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.admin_directory_counters (
    singleton boolean DEFAULT true NOT NULL,
    total_users bigint DEFAULT 0 NOT NULL,
    active_users bigint DEFAULT 0 NOT NULL,
    active_admins bigint DEFAULT 0 NOT NULL,
    pending_invitations bigint DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT admin_directory_counters_active_admins_check CHECK ((active_admins >= 0)),
    CONSTRAINT admin_directory_counters_active_users_check CHECK ((active_users >= 0)),
    CONSTRAINT admin_directory_counters_pending_invitations_check CHECK ((pending_invitations >= 0)),
    CONSTRAINT admin_directory_counters_singleton_check CHECK (singleton),
    CONSTRAINT admin_directory_counters_total_users_check CHECK ((total_users >= 0))
);


--
-- Name: bucket_usage_snapshots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.bucket_usage_snapshots (
    namespace text NOT NULL,
    used_bytes bigint DEFAULT 0 NOT NULL,
    object_count bigint DEFAULT 0 NOT NULL,
    measured_at timestamp with time zone,
    completed_at timestamp with time zone,
    scan_token text,
    scan_used_bytes bigint DEFAULT 0 NOT NULL,
    scan_object_count bigint DEFAULT 0 NOT NULL,
    scan_pages bigint DEFAULT 0 NOT NULL,
    scan_token_hashes text[] DEFAULT '{}'::text[] NOT NULL,
    scan_started_at timestamp with time zone,
    lease_token text,
    lease_until timestamp with time zone,
    next_attempt_at timestamp with time zone DEFAULT now() NOT NULL,
    failed boolean DEFAULT false NOT NULL,
    CONSTRAINT bucket_usage_snapshots_check CHECK (((lease_token IS NULL) = (lease_until IS NULL))),
    CONSTRAINT bucket_usage_snapshots_check1 CHECK (((measured_at IS NULL) = (completed_at IS NULL))),
    CONSTRAINT bucket_usage_snapshots_object_count_check CHECK ((object_count >= 0)),
    CONSTRAINT bucket_usage_snapshots_scan_object_count_check CHECK ((scan_object_count >= 0)),
    CONSTRAINT bucket_usage_snapshots_scan_pages_check CHECK ((scan_pages >= 0)),
    CONSTRAINT bucket_usage_snapshots_scan_token_hashes_check CHECK ((cardinality(scan_token_hashes) <= 64)),
    CONSTRAINT bucket_usage_snapshots_scan_used_bytes_check CHECK ((scan_used_bytes >= 0)),
    CONSTRAINT bucket_usage_snapshots_used_bytes_check CHECK ((used_bytes >= 0))
);


--
-- Name: collection_timestamp_changes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.collection_timestamp_changes (
    id bigint NOT NULL,
    transaction_id xid8 DEFAULT pg_current_xact_id() NOT NULL,
    owner_id text NOT NULL,
    parent_id text NOT NULL,
    changed_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);


--
-- Name: collection_timestamp_changes_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.collection_timestamp_changes ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.collection_timestamp_changes_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: file_shares; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.file_shares (
    id text NOT NULL,
    file_id text NOT NULL,
    owner_id text NOT NULL,
    recipient_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    counts_toward_shared boolean DEFAULT true NOT NULL,
    CONSTRAINT file_shares_check CHECK ((owner_id <> recipient_id))
);


--
-- Name: file_uploads; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.file_uploads (
    id text NOT NULL,
    file_id text NOT NULL,
    owner_id text NOT NULL,
    parent_id text,
    original_name text NOT NULL,
    object_key text NOT NULL,
    mime_type text,
    size_bytes bigint NOT NULL,
    upload_mode text NOT NULL,
    part_size_bytes bigint,
    multipart_upload_id text,
    status text DEFAULT 'pending'::text NOT NULL,
    checksum_sha256 text,
    write_expires_at timestamp with time zone,
    expires_at timestamp with time zone NOT NULL,
    completed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    share_link_id text,
    replacement_file_id text,
    reservation_bytes bigint DEFAULT 0 NOT NULL,
    completion_attempts integer DEFAULT 0 NOT NULL,
    completion_available_at timestamp with time zone DEFAULT now() NOT NULL,
    completion_locked_until timestamp with time zone,
    completion_lease_token text,
    completion_dead_lettered_at timestamp with time zone,
    completion_last_error text,
    completion_checksum_sha256 text,
    completion_etag text,
    completion_verified_at timestamp with time zone,
    CONSTRAINT file_uploads_completion_attempts_check CHECK ((completion_attempts >= 0)),
    CONSTRAINT file_uploads_part_size_check CHECK (((part_size_bytes IS NULL) OR ((part_size_bytes >= 5242880) AND (part_size_bytes <= 536870912)))),
    CONSTRAINT file_uploads_reservation_bytes_check CHECK ((reservation_bytes >= 0)),
    CONSTRAINT file_uploads_size_bytes_check CHECK (((size_bytes >= 0) AND (size_bytes <= '2147483648'::bigint))),
    CONSTRAINT file_uploads_status_check CHECK ((status = ANY (ARRAY['initializing'::text, 'pending'::text, 'completing'::text, 'aborting'::text, 'completed'::text, 'aborted'::text]))),
    CONSTRAINT file_uploads_upload_mode_check CHECK ((upload_mode = ANY (ARRAY['local'::text, 'single'::text, 'multipart'::text])))
);


--
-- Name: files; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.files (
    id text NOT NULL,
    owner_id text NOT NULL,
    original_name text NOT NULL,
    storage_name text NOT NULL,
    mime_type text,
    size_bytes bigint NOT NULL,
    state text DEFAULT 'active'::text NOT NULL,
    favorite boolean DEFAULT false NOT NULL,
    trashed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    entry_type text DEFAULT 'file'::text NOT NULL,
    parent_id text,
    checksum_sha256 text,
    object_etag text,
    e2ee_state text DEFAULT 'legacy'::text NOT NULL,
    current_generation_number bigint,
    current_generation_id bytea,
    legacy_share_count bigint DEFAULT 0 NOT NULL,
    vault_share_count bigint DEFAULT 0 NOT NULL,
    permanent_share_link_count bigint DEFAULT 0 NOT NULL,
    latest_share_link_expiry timestamp with time zone,
    trash_child_count bigint DEFAULT 0 NOT NULL,
    CONSTRAINT files_e2ee_state_check CHECK ((e2ee_state = ANY (ARRAY['legacy'::text, 'staged'::text, 'encrypted'::text]))),
    CONSTRAINT files_entry_type_check CHECK ((entry_type = ANY (ARRAY['file'::text, 'folder'::text]))),
    CONSTRAINT files_generation_id_check CHECK (((current_generation_id IS NULL) OR (octet_length(current_generation_id) = 16))),
    CONSTRAINT files_legacy_share_count_check CHECK ((legacy_share_count >= 0)),
    CONSTRAINT files_permanent_share_link_count_check CHECK ((permanent_share_link_count >= 0)),
    CONSTRAINT files_size_bytes_check CHECK ((size_bytes >= 0)),
    CONSTRAINT files_state_check CHECK ((state = ANY (ARRAY['active'::text, 'trashed'::text]))),
    CONSTRAINT files_trash_child_count_check CHECK ((trash_child_count >= 0)),
    CONSTRAINT files_vault_share_count_check CHECK ((vault_share_count >= 0))
);


--
-- Name: invitations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.invitations (
    id text NOT NULL,
    invited_username text NOT NULL,
    role text NOT NULL,
    token_hash text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    created_by text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    accepted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT invitations_role_check CHECK ((role = ANY (ARRAY['admin'::text, 'user'::text]))),
    CONSTRAINT invitations_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'accepted'::text, 'revoked'::text, 'expired'::text])))
);


--
-- Name: legacy_text_identifier_columns; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.legacy_text_identifier_columns (
    table_name name NOT NULL,
    column_name name NOT NULL,
    constraint_kind "char" NOT NULL,
    captured_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT legacy_text_identifier_columns_constraint_kind_check CHECK ((constraint_kind = ANY (ARRAY['p'::"char", 'f'::"char"])))
);


--
-- Name: TABLE legacy_text_identifier_columns; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.legacy_text_identifier_columns IS 'Frozen allowlist of pre-016 TEXT PK/FK columns; new internal identifiers must use compact native types.';


--
-- Name: multipart_orphan_abort_claims; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.multipart_orphan_abort_claims (
    namespace text NOT NULL,
    object_key text NOT NULL,
    upload_id text NOT NULL,
    lease_token text,
    lease_until timestamp with time zone,
    attempts integer DEFAULT 0 NOT NULL,
    next_attempt_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: multipart_reconciliation_progress; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.multipart_reconciliation_progress (
    namespace text NOT NULL,
    lease_token text,
    lease_until timestamp with time zone,
    key_marker text,
    upload_id_marker text,
    next_scan_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: realtime_audience_deliveries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.realtime_audience_deliveries (
    id bigint NOT NULL,
    transaction_id xid8 NOT NULL,
    user_id text NOT NULL,
    scope text NOT NULL
);


--
-- Name: realtime_audience_deliveries_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.realtime_audience_deliveries ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.realtime_audience_deliveries_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: realtime_audience_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.realtime_audience_jobs (
    id bigint NOT NULL,
    transaction_id xid8 DEFAULT pg_current_xact_id() NOT NULL,
    kind text NOT NULL,
    owner_id text NOT NULL,
    entity_id text NOT NULL,
    phase smallint DEFAULT 0 NOT NULL,
    after_id text DEFAULT ''::text NOT NULL,
    complete boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT realtime_audience_jobs_kind_check CHECK ((kind = ANY (ARRAY['node'::text, 'owner'::text, 'vault-active'::text, 'vault-all'::text, 'admins'::text])))
);


--
-- Name: realtime_audience_jobs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.realtime_audience_jobs ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.realtime_audience_jobs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: realtime_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.realtime_events (
    id bigint NOT NULL,
    user_id text NOT NULL,
    scope text NOT NULL,
    folder_ids text[] NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);


--
-- Name: realtime_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.realtime_events ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.realtime_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: realtime_outbox; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.realtime_outbox (
    id bigint NOT NULL,
    transaction_id xid8 DEFAULT pg_current_xact_id() NOT NULL,
    user_id text NOT NULL,
    scope text NOT NULL,
    folder_ids text[] DEFAULT '{}'::text[] NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT realtime_outbox_folder_ids_check CHECK ((cardinality(folder_ids) <= 32)),
    CONSTRAINT realtime_outbox_scope_check CHECK ((scope = ANY (ARRAY['files'::text, 'paths'::text, 'shared'::text, 'repositories'::text, 'profile'::text, 'vault'::text, 'security'::text, 'users'::text])))
);


--
-- Name: realtime_outbox_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.realtime_outbox ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.realtime_outbox_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: realtime_stream_state; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.realtime_stream_state (
    singleton boolean DEFAULT true NOT NULL,
    head bigint DEFAULT 0 NOT NULL,
    floor bigint DEFAULT 0 NOT NULL,
    CONSTRAINT realtime_stream_state_singleton_check CHECK (singleton)
);


--
-- Name: repositories; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.repositories (
    id text NOT NULL,
    owner_id text NOT NULL,
    root_file_id text NOT NULL,
    description text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    total_files bigint DEFAULT 0 NOT NULL,
    total_folders bigint DEFAULT 0 NOT NULL,
    tree_version bigint DEFAULT 0 NOT NULL,
    counts_version bigint DEFAULT '-1'::integer NOT NULL,
    CONSTRAINT repositories_counts_version_check CHECK ((counts_version >= '-1'::integer)),
    CONSTRAINT repositories_description_length_check CHECK ((char_length(description) <= 350)),
    CONSTRAINT repositories_total_files_check CHECK ((total_files >= 0)),
    CONSTRAINT repositories_total_folders_check CHECK ((total_folders >= 0)),
    CONSTRAINT repositories_tree_version_check CHECK ((tree_version >= 0))
);


--
-- Name: repository_archive_entries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.repository_archive_entries (
    manifest_id uuid NOT NULL,
    ordinal bigint NOT NULL,
    id text NOT NULL,
    original_name text NOT NULL,
    mime_type text,
    entry_type text NOT NULL,
    parent_id text,
    size_bytes bigint NOT NULL,
    e2ee_state text NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    vault_generation_id bytea,
    vault_record_version bigint,
    vault_record_hash bytea
);


--
-- Name: repository_archive_manifests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.repository_archive_manifests (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    owner_id text NOT NULL,
    repository_id text NOT NULL,
    content_version bigint NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    expires_at timestamp with time zone DEFAULT (clock_timestamp() + '00:15:00'::interval) NOT NULL,
    total_entries bigint DEFAULT 0 NOT NULL,
    total_files bigint DEFAULT 0 NOT NULL,
    total_bytes bigint DEFAULT 0 NOT NULL,
    total_encrypted_entries bigint DEFAULT 0 NOT NULL
);


--
-- Name: repository_pending_changes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.repository_pending_changes (
    id bigint NOT NULL,
    transaction_id xid8 DEFAULT pg_current_xact_id() NOT NULL,
    repository_id text NOT NULL,
    counts_dirty boolean DEFAULT true NOT NULL
);


--
-- Name: repository_pending_changes_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.repository_pending_changes ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.repository_pending_changes_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: repository_revision_shards; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.repository_revision_shards (
    repository_id text NOT NULL,
    shard smallint NOT NULL,
    version bigint NOT NULL,
    CONSTRAINT repository_revision_shards_shard_check CHECK (((shard >= 0) AND (shard <= 63))),
    CONSTRAINT repository_revision_shards_version_check CHECK ((version >= 0))
);


--
-- Name: schema_migrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.schema_migrations (
    version text NOT NULL,
    applied_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sessions (
    id text NOT NULL,
    user_id text NOT NULL,
    token_hash bytea NOT NULL,
    csrf_token text,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT sessions_token_hash_length CHECK ((octet_length(token_hash) = 32))
);


--
-- Name: share_links; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.share_links (
    id text NOT NULL,
    token_hash text NOT NULL,
    owner_id text NOT NULL,
    root_file_id text NOT NULL,
    access_scope text NOT NULL,
    permission text NOT NULL,
    recipient_id text,
    expires_at timestamp with time zone,
    revoked_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    token_version bigint DEFAULT 0 NOT NULL,
    CONSTRAINT share_links_access_scope_check CHECK ((access_scope = ANY (ARRAY['public'::text, 'account'::text]))),
    CONSTRAINT share_links_check CHECK ((((access_scope = 'public'::text) AND (recipient_id IS NULL)) OR ((access_scope = 'account'::text) AND (recipient_id IS NOT NULL)))),
    CONSTRAINT share_links_check1 CHECK (((recipient_id IS NULL) OR (owner_id <> recipient_id))),
    CONSTRAINT share_links_permission_check CHECK ((permission = ANY (ARRAY['viewer'::text, 'editor'::text]))),
    CONSTRAINT share_links_token_version_check CHECK ((token_version >= 0))
);


--
-- Name: COLUMN share_links.token_version; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.share_links.token_version IS 'Version zero preserves legacy writers and URLs; current writers explicitly use version one and rotations increment it.';


--
-- Name: storage_deletion_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.storage_deletion_jobs (
    id bigint NOT NULL,
    object_key text NOT NULL,
    multipart_upload_id text,
    attempts integer DEFAULT 0 NOT NULL,
    available_at timestamp with time zone DEFAULT now() NOT NULL,
    locked_until timestamp with time zone,
    lease_token text,
    dead_lettered_at timestamp with time zone,
    last_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT storage_deletion_jobs_attempts_check CHECK ((attempts >= 0))
);


--
-- Name: storage_deletion_jobs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.storage_deletion_jobs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: storage_deletion_jobs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.storage_deletion_jobs_id_seq OWNED BY public.storage_deletion_jobs.id;


--
-- Name: trash_expiry_owners; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.trash_expiry_owners (
    owner_id text NOT NULL,
    next_due_at timestamp with time zone
);


--
-- Name: tree_operation_counter_deltas; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tree_operation_counter_deltas (
    job_id bigint NOT NULL,
    owner_id text NOT NULL,
    total_files bigint DEFAULT 0 NOT NULL,
    total_folders bigint DEFAULT 0 NOT NULL,
    active_files bigint DEFAULT 0 NOT NULL,
    trashed_files bigint DEFAULT 0 NOT NULL,
    favorite_files bigint DEFAULT 0 NOT NULL,
    shared_files bigint DEFAULT 0 NOT NULL,
    used_bytes bigint DEFAULT 0 NOT NULL
);


--
-- Name: tree_operation_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tree_operation_jobs (
    id bigint NOT NULL,
    owner_id text NOT NULL,
    root_id text NOT NULL,
    action text NOT NULL,
    child_state text,
    status text DEFAULT 'pending'::text NOT NULL,
    phase text DEFAULT 'discover'::text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    processed_nodes bigint DEFAULT 0 NOT NULL,
    available_at timestamp with time zone DEFAULT now() NOT NULL,
    last_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    CONSTRAINT tree_operation_jobs_action_check CHECK ((action = ANY (ARRAY['trash'::text, 'restore'::text, 'delete'::text]))),
    CONSTRAINT tree_operation_jobs_attempts_check CHECK ((attempts >= 0)),
    CONSTRAINT tree_operation_jobs_child_state_check CHECK ((child_state = ANY (ARRAY['active'::text, 'trashed'::text]))),
    CONSTRAINT tree_operation_jobs_phase_check CHECK ((phase = ANY (ARRAY['discover'::text, 'mutate'::text]))),
    CONSTRAINT tree_operation_jobs_processed_nodes_check CHECK ((processed_nodes >= 0)),
    CONSTRAINT tree_operation_jobs_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'running'::text, 'complete'::text])))
);


--
-- Name: tree_operation_jobs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tree_operation_jobs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tree_operation_jobs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tree_operation_jobs_id_seq OWNED BY public.tree_operation_jobs.id;


--
-- Name: tree_operation_nodes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tree_operation_nodes (
    job_id bigint NOT NULL,
    node_id text NOT NULL,
    parent_id text,
    depth integer NOT NULL,
    entry_type text NOT NULL,
    expanded boolean DEFAULT false NOT NULL,
    last_child_id text,
    processed boolean DEFAULT false NOT NULL,
    CONSTRAINT tree_operation_nodes_depth_check CHECK ((depth >= 0)),
    CONSTRAINT tree_operation_nodes_entry_type_check CHECK ((entry_type = ANY (ARRAY['file'::text, 'folder'::text])))
);


--
-- Name: tree_operation_owners; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tree_operation_owners (
    owner_id text NOT NULL,
    version bigint DEFAULT 0 NOT NULL
);


--
-- Name: user_deletion_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_deletion_jobs (
    user_id text NOT NULL,
    phase text DEFAULT 'file_uploads'::text NOT NULL,
    processed_rows bigint DEFAULT 0 NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    available_at timestamp with time zone DEFAULT now() NOT NULL,
    locked_until timestamp with time zone,
    lease_token text,
    dead_lettered_at timestamp with time zone,
    last_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT user_deletion_jobs_attempts_check CHECK ((attempts >= 0)),
    CONSTRAINT user_deletion_jobs_phase_check CHECK ((phase = ANY (ARRAY['file_uploads'::text, 'vault_uploads'::text, 'vault_object_generations'::text, 'vault_migrations'::text, 'vault_share_envelopes'::text, 'vault_share_wrappers'::text, 'vault_share_owner_keys'::text, 'vault_revocation_cutoffs'::text, 'vault_share_pending_revocations'::text, 'vault_share_recipients'::text, 'vault_share_epochs'::text, 'vault_shares'::text, 'file_shares'::text, 'share_links'::text, 'repositories'::text, 'vault_node_heads'::text, 'vault_node_records'::text, 'vault_wrappers'::text, 'files'::text, 'vault_identity_trust'::text, 'vault_identity_keys'::text, 'user_vaults'::text, 'invitations'::text, 'sessions'::text, 'finalize'::text]))),
    CONSTRAINT user_deletion_jobs_processed_rows_check CHECK ((processed_rows >= 0))
);


--
-- Name: user_file_counters; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_file_counters (
    owner_id text NOT NULL,
    total_files bigint DEFAULT 0 NOT NULL,
    total_folders bigint DEFAULT 0 NOT NULL,
    active_files bigint DEFAULT 0 NOT NULL,
    trashed_files bigint DEFAULT 0 NOT NULL,
    favorite_files bigint DEFAULT 0 NOT NULL,
    shared_files bigint DEFAULT 0 NOT NULL,
    used_bytes bigint DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT user_file_counters_active_files_check CHECK ((active_files >= 0)),
    CONSTRAINT user_file_counters_favorite_files_check CHECK ((favorite_files >= 0)),
    CONSTRAINT user_file_counters_shared_files_check CHECK ((shared_files >= 0)),
    CONSTRAINT user_file_counters_total_files_check CHECK ((total_files >= 0)),
    CONSTRAINT user_file_counters_total_folders_check CHECK ((total_folders >= 0)),
    CONSTRAINT user_file_counters_trashed_files_check CHECK ((trashed_files >= 0)),
    CONSTRAINT user_file_counters_used_bytes_check CHECK ((used_bytes >= 0))
);


--
-- Name: user_storage_usage; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_storage_usage (
    owner_id text NOT NULL,
    used_bytes bigint DEFAULT 0 NOT NULL,
    reserved_bytes bigint DEFAULT 0 NOT NULL,
    pending_uploads bigint DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT user_storage_usage_pending_uploads_check CHECK ((pending_uploads >= 0)),
    CONSTRAINT user_storage_usage_reserved_bytes_check CHECK ((reserved_bytes >= 0)),
    CONSTRAINT user_storage_usage_used_bytes_check CHECK ((used_bytes >= 0))
);


--
-- Name: user_vaults; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_vaults (
    user_id text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    format_version smallint DEFAULT 1 NOT NULL,
    vault_version bigint DEFAULT 1 NOT NULL,
    kdf_algorithm text NOT NULL,
    kdf_salt bytea NOT NULL,
    kdf_operations bigint NOT NULL,
    kdf_memory_bytes bigint NOT NULL,
    kdf_output_bytes integer NOT NULL,
    password_wrapper_id bytea NOT NULL,
    password_root_ciphertext bytea NOT NULL,
    recovery_salt bytea NOT NULL,
    recovery_wrapper_id bytea NOT NULL,
    recovery_root_ciphertext bytea NOT NULL,
    identity_record_id bytea NOT NULL,
    identity_private_ciphertext bytea NOT NULL,
    encrypted_account_state bytea DEFAULT '\x'::bytea NOT NULL,
    account_state_record_id bytea,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    recovered_at timestamp with time zone,
    CONSTRAINT user_vaults_account_state_record_id_check CHECK (((account_state_record_id IS NULL) OR (octet_length(account_state_record_id) = 16))),
    CONSTRAINT user_vaults_encrypted_account_state_check CHECK ((octet_length(encrypted_account_state) <= 16384)),
    CONSTRAINT user_vaults_format_version_check CHECK ((format_version = 1)),
    CONSTRAINT user_vaults_identity_private_ciphertext_check CHECK (((octet_length(identity_private_ciphertext) >= 96) AND (octet_length(identity_private_ciphertext) <= 8192))),
    CONSTRAINT user_vaults_identity_record_id_check CHECK ((octet_length(identity_record_id) = 16)),
    CONSTRAINT user_vaults_kdf_algorithm_check CHECK ((kdf_algorithm = 'argon2id13'::text)),
    CONSTRAINT user_vaults_kdf_memory_bytes_check CHECK ((kdf_memory_bytes = 268435456)),
    CONSTRAINT user_vaults_kdf_operations_check CHECK ((kdf_operations = 3)),
    CONSTRAINT user_vaults_kdf_output_bytes_check CHECK ((kdf_output_bytes = 32)),
    CONSTRAINT user_vaults_kdf_salt_check CHECK ((octet_length(kdf_salt) = 16)),
    CONSTRAINT user_vaults_password_root_ciphertext_check CHECK ((octet_length(password_root_ciphertext) = 48)),
    CONSTRAINT user_vaults_password_wrapper_id_check CHECK ((octet_length(password_wrapper_id) = 16)),
    CONSTRAINT user_vaults_recovery_root_ciphertext_check CHECK ((octet_length(recovery_root_ciphertext) = 48)),
    CONSTRAINT user_vaults_recovery_salt_check CHECK ((octet_length(recovery_salt) = 16)),
    CONSTRAINT user_vaults_recovery_wrapper_id_check CHECK ((octet_length(recovery_wrapper_id) = 16)),
    CONSTRAINT user_vaults_status_check CHECK ((status = ANY (ARRAY['active'::text, 'recovery_pending'::text]))),
    CONSTRAINT user_vaults_vault_version_check CHECK ((vault_version > 0))
);


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    id text NOT NULL,
    username text NOT NULL,
    password_hash text NOT NULL,
    role text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    display_name text,
    theme_preference text DEFAULT 'system'::text NOT NULL,
    accent_color text DEFAULT '#3088f0'::text NOT NULL,
    folder_zip_prompt_enabled boolean DEFAULT true NOT NULL,
    profile_image_bytes bytea,
    profile_image_mime_type text,
    profile_image_size_bytes bigint,
    profile_image_updated_at timestamp with time zone,
    vault_auto_lock_minutes integer DEFAULT 15 NOT NULL,
    auth_version smallint DEFAULT 0 NOT NULL,
    auth_kdf_salt bytea,
    trash_retention_days integer DEFAULT 30 NOT NULL,
    trash_retention_minutes integer DEFAULT 43200 NOT NULL,
    CONSTRAINT users_accent_color_check CHECK ((accent_color ~ '^#[0-9a-fA-F]{6}$'::text)),
    CONSTRAINT users_one_password_auth_check CHECK ((((auth_version = 0) AND (auth_kdf_salt IS NULL)) OR ((auth_version = 1) AND (octet_length(auth_kdf_salt) = 16)))),
    CONSTRAINT users_profile_image_size_check CHECK (((profile_image_size_bytes IS NULL) OR ((profile_image_size_bytes >= 0) AND (profile_image_size_bytes <= 2097152)))),
    CONSTRAINT users_role_check CHECK ((role = ANY (ARRAY['admin'::text, 'user'::text]))),
    CONSTRAINT users_status_check CHECK ((status = ANY (ARRAY['active'::text, 'disabled'::text, 'deleting'::text]))),
    CONSTRAINT users_theme_preference_check CHECK ((theme_preference = ANY (ARRAY['system'::text, 'light'::text, 'dark'::text]))),
    CONSTRAINT users_trash_retention_days_check CHECK (((trash_retention_days >= 1) AND (trash_retention_days <= 365))),
    CONSTRAINT users_trash_retention_minutes_check CHECK (((trash_retention_minutes >= 1) AND (trash_retention_minutes <= 525600))),
    CONSTRAINT users_vault_auto_lock_minutes_check CHECK ((vault_auto_lock_minutes = ANY (ARRAY[0, 5, 15, 30, 60])))
);


--
-- Name: vault_identity_keys; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vault_identity_keys (
    user_id text NOT NULL,
    key_version bigint NOT NULL,
    x25519_public_key bytea NOT NULL,
    ed25519_public_key bytea NOT NULL,
    fingerprint_sha256 bytea NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    retired_at timestamp with time zone,
    CONSTRAINT vault_identity_keys_ed25519_public_key_check CHECK ((octet_length(ed25519_public_key) = 32)),
    CONSTRAINT vault_identity_keys_fingerprint_sha256_check CHECK ((octet_length(fingerprint_sha256) = 32)),
    CONSTRAINT vault_identity_keys_key_version_check CHECK ((key_version > 0)),
    CONSTRAINT vault_identity_keys_status_check CHECK ((status = ANY (ARRAY['active'::text, 'retired'::text, 'revoked'::text]))),
    CONSTRAINT vault_identity_keys_x25519_public_key_check CHECK ((octet_length(x25519_public_key) = 32))
);


--
-- Name: vault_identity_trust; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vault_identity_trust (
    user_id text NOT NULL,
    peer_user_id text NOT NULL,
    peer_key_version bigint NOT NULL,
    fingerprint_sha256 bytea NOT NULL,
    status text NOT NULL,
    accepted_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT vault_identity_trust_check CHECK ((user_id <> peer_user_id)),
    CONSTRAINT vault_identity_trust_fingerprint_sha256_check CHECK ((octet_length(fingerprint_sha256) = 32)),
    CONSTRAINT vault_identity_trust_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'accepted'::text, 'blocked'::text])))
);


--
-- Name: vault_migration_node_progress; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vault_migration_node_progress (
    owner_id text NOT NULL,
    node_id text NOT NULL,
    legacy boolean DEFAULT false NOT NULL,
    staged boolean DEFAULT false NOT NULL,
    migration_incomplete boolean DEFAULT false NOT NULL
);


--
-- Name: vault_migration_progress; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vault_migration_progress (
    owner_id text NOT NULL,
    legacy_nodes bigint DEFAULT 0 NOT NULL,
    incomplete_nodes bigint DEFAULT 0 NOT NULL,
    CONSTRAINT vault_migration_progress_incomplete_nodes_check CHECK ((incomplete_nodes >= 0)),
    CONSTRAINT vault_migration_progress_legacy_nodes_check CHECK ((legacy_nodes >= 0))
);


--
-- Name: vault_migrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vault_migrations (
    node_id text NOT NULL,
    owner_id text NOT NULL,
    legacy_object_key text,
    staged_object_key text,
    state text DEFAULT 'pending'::text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    last_error text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT vault_migrations_attempts_check CHECK ((attempts >= 0)),
    CONSTRAINT vault_migrations_state_check CHECK ((state = ANY (ARRAY['pending'::text, 'encrypting'::text, 'verifying'::text, 'switched'::text, 'cleanup_queued'::text, 'complete'::text, 'failed'::text])))
);


--
-- Name: vault_node_heads; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vault_node_heads (
    node_id text NOT NULL,
    owner_id text NOT NULL,
    record_version bigint NOT NULL,
    record_hash bytea NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT vault_node_heads_record_hash_check CHECK ((octet_length(record_hash) = 32)),
    CONSTRAINT vault_node_heads_record_version_check CHECK ((record_version > 0))
);


--
-- Name: vault_node_records; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vault_node_records (
    node_id text NOT NULL,
    owner_id text NOT NULL,
    record_version bigint NOT NULL,
    record_hash bytea NOT NULL,
    previous_record_hash bytea,
    bootstrap_cbor bytea NOT NULL,
    bootstrap_signature bytea NOT NULL,
    encrypted_manifest bytea NOT NULL,
    manifest_hash bytea NOT NULL,
    signer_key_version bigint NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT vault_node_records_bootstrap_cbor_check CHECK (((octet_length(bootstrap_cbor) >= 128) AND (octet_length(bootstrap_cbor) <= 65536))),
    CONSTRAINT vault_node_records_bootstrap_signature_check CHECK ((octet_length(bootstrap_signature) = 64)),
    CONSTRAINT vault_node_records_encrypted_manifest_check CHECK (((octet_length(encrypted_manifest) >= 16) AND (octet_length(encrypted_manifest) <= 1048576))),
    CONSTRAINT vault_node_records_manifest_hash_check CHECK ((octet_length(manifest_hash) = 32)),
    CONSTRAINT vault_node_records_previous_record_hash_check CHECK (((previous_record_hash IS NULL) OR (octet_length(previous_record_hash) = 32))),
    CONSTRAINT vault_node_records_record_hash_check CHECK ((octet_length(record_hash) = 32)),
    CONSTRAINT vault_node_records_record_version_check CHECK ((record_version > 0)),
    CONSTRAINT vault_node_records_signer_key_version_check CHECK ((signer_key_version > 0))
);


--
-- Name: vault_object_generations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vault_object_generations (
    node_id text NOT NULL,
    owner_id text NOT NULL,
    generation_number bigint NOT NULL,
    generation_id bytea NOT NULL,
    object_key text NOT NULL,
    ciphertext_length bigint NOT NULL,
    crypto_chunk_bytes integer DEFAULT 4194304 NOT NULL,
    chunk_count integer NOT NULL,
    ciphertext_merkle_root bytea NOT NULL,
    status text DEFAULT 'published'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    retired_at timestamp with time zone,
    CONSTRAINT vault_object_generations_chunk_count_check CHECK (((chunk_count >= 1) AND (chunk_count <= 513))),
    CONSTRAINT vault_object_generations_ciphertext_length_check CHECK (((ciphertext_length >= 1) AND (ciphertext_length <= '2415919104'::bigint))),
    CONSTRAINT vault_object_generations_ciphertext_merkle_root_check CHECK ((octet_length(ciphertext_merkle_root) = 32)),
    CONSTRAINT vault_object_generations_crypto_chunk_bytes_check CHECK ((crypto_chunk_bytes = 4194304)),
    CONSTRAINT vault_object_generations_generation_id_check CHECK ((octet_length(generation_id) = 16)),
    CONSTRAINT vault_object_generations_generation_number_check CHECK ((generation_number > 0)),
    CONSTRAINT vault_object_generations_status_check CHECK ((status = ANY (ARRAY['published'::text, 'retired'::text])))
);


--
-- Name: vault_revocation_cutoffs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vault_revocation_cutoffs (
    share_id text NOT NULL,
    retired_epoch bigint NOT NULL,
    published_epoch bigint NOT NULL,
    cutoff_record_version bigint NOT NULL,
    cutoff_record_hash bytea NOT NULL,
    revoked_recipient_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT vault_revocation_cutoffs_cutoff_record_hash_check CHECK ((octet_length(cutoff_record_hash) = 32))
);


--
-- Name: vault_share_envelopes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vault_share_envelopes (
    envelope_id bytea NOT NULL,
    share_id text NOT NULL,
    epoch bigint NOT NULL,
    sender_id text NOT NULL,
    sender_key_version bigint NOT NULL,
    recipient_id text NOT NULL,
    recipient_key_version bigint NOT NULL,
    node_id text NOT NULL,
    permissions text NOT NULL,
    generation_scope bigint,
    record_version bigint NOT NULL,
    previous_record_hash bytea,
    encapsulated_key bytea NOT NULL,
    ciphertext bytea NOT NULL,
    canonical_cbor bytea NOT NULL,
    signature bytea NOT NULL,
    envelope_hash bytea NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT vault_share_envelopes_canonical_cbor_check CHECK (((octet_length(canonical_cbor) >= 128) AND (octet_length(canonical_cbor) <= 131072))),
    CONSTRAINT vault_share_envelopes_ciphertext_check CHECK (((octet_length(ciphertext) >= 48) AND (octet_length(ciphertext) <= 65536))),
    CONSTRAINT vault_share_envelopes_encapsulated_key_check CHECK ((octet_length(encapsulated_key) = 32)),
    CONSTRAINT vault_share_envelopes_envelope_hash_check CHECK ((octet_length(envelope_hash) = 32)),
    CONSTRAINT vault_share_envelopes_envelope_id_check CHECK ((octet_length(envelope_id) = 16)),
    CONSTRAINT vault_share_envelopes_permissions_check CHECK ((permissions = 'read'::text)),
    CONSTRAINT vault_share_envelopes_previous_record_hash_check CHECK (((previous_record_hash IS NULL) OR (octet_length(previous_record_hash) = 32))),
    CONSTRAINT vault_share_envelopes_recipient_key_version_check CHECK ((recipient_key_version > 0)),
    CONSTRAINT vault_share_envelopes_record_version_check CHECK ((record_version > 0)),
    CONSTRAINT vault_share_envelopes_sender_key_version_check CHECK ((sender_key_version > 0)),
    CONSTRAINT vault_share_envelopes_signature_check CHECK ((octet_length(signature) = 64))
);


--
-- Name: vault_share_epochs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vault_share_epochs (
    share_id text NOT NULL,
    epoch bigint NOT NULL,
    status text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    published_at timestamp with time zone,
    retired_at timestamp with time zone,
    protocol_version smallint DEFAULT 1 NOT NULL,
    wrapper_set_root bytea,
    wrapper_count integer,
    CONSTRAINT vault_share_epochs_epoch_check CHECK ((epoch > 0)),
    CONSTRAINT vault_share_epochs_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'published'::text, 'retired'::text]))),
    CONSTRAINT vault_share_epochs_wrapper_commitment_check CHECK ((((protocol_version = 1) AND (wrapper_set_root IS NULL) AND (wrapper_count IS NULL)) OR ((protocol_version = 2) AND (wrapper_set_root IS NOT NULL) AND (octet_length(wrapper_set_root) = 32) AND (wrapper_count IS NOT NULL) AND ((wrapper_count >= 1) AND (wrapper_count <= 100000)))))
);


--
-- Name: vault_share_owner_keys; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vault_share_owner_keys (
    share_id text NOT NULL,
    epoch bigint NOT NULL,
    wrapper_id bytea NOT NULL,
    root_ciphertext bytea NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT vault_share_owner_keys_root_ciphertext_check CHECK ((octet_length(root_ciphertext) = 48)),
    CONSTRAINT vault_share_owner_keys_wrapper_id_check CHECK ((octet_length(wrapper_id) = 16))
);


--
-- Name: vault_share_pending_revocations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vault_share_pending_revocations (
    share_id text NOT NULL,
    pending_epoch bigint NOT NULL,
    recipient_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: vault_share_recipients; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vault_share_recipients (
    share_id text NOT NULL,
    recipient_id text NOT NULL,
    recipient_key_version bigint NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    joined_at timestamp with time zone DEFAULT now() NOT NULL,
    revoked_at timestamp with time zone,
    CONSTRAINT vault_share_recipients_recipient_key_version_check CHECK ((recipient_key_version > 0)),
    CONSTRAINT vault_share_recipients_status_check CHECK ((status = ANY (ARRAY['active'::text, 'revoked'::text])))
);


--
-- Name: vault_share_sync_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vault_share_sync_jobs (
    node_id text NOT NULL,
    owner_id text NOT NULL,
    record_version bigint NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    last_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT vault_share_sync_jobs_attempts_check CHECK ((attempts >= 0)),
    CONSTRAINT vault_share_sync_jobs_record_version_check CHECK ((record_version > 0))
);


--
-- Name: vault_share_wrapper_directories; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vault_share_wrapper_directories (
    node_id text NOT NULL,
    record_version bigint NOT NULL,
    owner_id text NOT NULL,
    signer_key_version bigint NOT NULL,
    canonical_cbor bytea NOT NULL,
    signature bytea NOT NULL,
    wrapper_set_root bytea NOT NULL,
    wrapper_count integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT vault_share_wrapper_directories_canonical_cbor_check CHECK (((octet_length(canonical_cbor) >= 96) AND (octet_length(canonical_cbor) <= 4096))),
    CONSTRAINT vault_share_wrapper_directories_record_version_check CHECK ((record_version > 0)),
    CONSTRAINT vault_share_wrapper_directories_signature_check CHECK ((octet_length(signature) = 64)),
    CONSTRAINT vault_share_wrapper_directories_signer_key_version_check CHECK ((signer_key_version > 0)),
    CONSTRAINT vault_share_wrapper_directories_wrapper_count_check CHECK (((wrapper_count >= 1) AND (wrapper_count <= 100000))),
    CONSTRAINT vault_share_wrapper_directories_wrapper_set_root_check CHECK ((octet_length(wrapper_set_root) = 32))
);


--
-- Name: vault_share_wrappers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vault_share_wrappers (
    wrapper_id bytea NOT NULL,
    share_id text NOT NULL,
    epoch bigint NOT NULL,
    node_id text NOT NULL,
    generation_id bytea,
    wrapper_kind text NOT NULL,
    record_version bigint DEFAULT 1 NOT NULL,
    canonical_cbor bytea NOT NULL,
    wrapper_hash bytea NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    merkle_leaf_index integer,
    merkle_proof bytea,
    commitment_source text DEFAULT 'epoch'::text NOT NULL,
    CONSTRAINT vault_share_wrappers_canonical_cbor_check CHECK (((octet_length(canonical_cbor) >= 64) AND (octet_length(canonical_cbor) <= 65536))),
    CONSTRAINT vault_share_wrappers_commitment_source_check CHECK ((commitment_source = ANY (ARRAY['bootstrap'::text, 'epoch'::text, 'directory'::text]))),
    CONSTRAINT vault_share_wrappers_generation_id_check CHECK (((generation_id IS NULL) OR (octet_length(generation_id) = 16))),
    CONSTRAINT vault_share_wrappers_merkle_proof_check CHECK ((((merkle_leaf_index IS NULL) AND (merkle_proof IS NULL)) OR ((merkle_leaf_index IS NOT NULL) AND (merkle_proof IS NOT NULL) AND (merkle_leaf_index >= 0) AND ((octet_length(merkle_proof) % 32) = 0) AND (octet_length(merkle_proof) <= 448)))),
    CONSTRAINT vault_share_wrappers_record_version_check CHECK ((record_version > 0)),
    CONSTRAINT vault_share_wrappers_wrapper_hash_check CHECK ((octet_length(wrapper_hash) = 32)),
    CONSTRAINT vault_share_wrappers_wrapper_id_check CHECK ((octet_length(wrapper_id) = 16)),
    CONSTRAINT vault_share_wrappers_wrapper_kind_check CHECK ((wrapper_kind = ANY (ARRAY['generation_dek'::text, 'metadata'::text])))
);


--
-- Name: vault_shares; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vault_shares (
    id text NOT NULL,
    owner_id text NOT NULL,
    root_node_id text NOT NULL,
    permissions text DEFAULT 'read'::text NOT NULL,
    active_epoch bigint DEFAULT 1 NOT NULL,
    pending_epoch bigint,
    publication_fenced boolean DEFAULT false NOT NULL,
    fence_snapshot_hash bytea,
    status text DEFAULT 'active'::text NOT NULL,
    record_version bigint DEFAULT 1 NOT NULL,
    record_hash bytea,
    previous_record_hash bytea,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    revoked_at timestamp with time zone,
    CONSTRAINT vault_shares_active_epoch_check CHECK ((active_epoch > 0)),
    CONSTRAINT vault_shares_check CHECK (((pending_epoch IS NULL) OR (pending_epoch > active_epoch))),
    CONSTRAINT vault_shares_fence_snapshot_hash_check CHECK (((fence_snapshot_hash IS NULL) OR (octet_length(fence_snapshot_hash) = 32))),
    CONSTRAINT vault_shares_permissions_check CHECK ((permissions = 'read'::text)),
    CONSTRAINT vault_shares_previous_record_hash_check CHECK (((previous_record_hash IS NULL) OR (octet_length(previous_record_hash) = 32))),
    CONSTRAINT vault_shares_record_hash_check CHECK (((record_hash IS NULL) OR (octet_length(record_hash) = 32))),
    CONSTRAINT vault_shares_record_version_check CHECK ((record_version > 0)),
    CONSTRAINT vault_shares_status_check CHECK ((status = ANY (ARRAY['active'::text, 'rotating'::text, 'revoked'::text])))
);


--
-- Name: vault_uploads; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vault_uploads (
    id text NOT NULL,
    node_id text NOT NULL,
    owner_id text NOT NULL,
    parent_id text,
    entry_type text NOT NULL,
    generation_number bigint NOT NULL,
    generation_id bytea NOT NULL,
    object_key text,
    ciphertext_length bigint NOT NULL,
    crypto_chunk_bytes integer DEFAULT 4194304 NOT NULL,
    chunk_count integer NOT NULL,
    upload_mode text NOT NULL,
    part_size_bytes bigint,
    multipart_upload_id text,
    checksum_sha256 text,
    status text DEFAULT 'initializing'::text NOT NULL,
    write_expires_at timestamp with time zone,
    expires_at timestamp with time zone DEFAULT (now() + '24:00:00'::interval) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    published_at timestamp with time zone,
    reservation_bytes bigint DEFAULT 0 NOT NULL,
    CONSTRAINT vault_uploads_check CHECK (((entry_type = 'folder'::text) = (upload_mode = 'none'::text))),
    CONSTRAINT vault_uploads_check1 CHECK (((upload_mode = 'none'::text) = (object_key IS NULL))),
    CONSTRAINT vault_uploads_check2 CHECK (((upload_mode = 'none'::text) = (ciphertext_length = 0))),
    CONSTRAINT vault_uploads_chunk_count_check CHECK (((chunk_count >= 0) AND (chunk_count <= 513))),
    CONSTRAINT vault_uploads_ciphertext_length_check CHECK (((ciphertext_length >= 0) AND (ciphertext_length <= '2415919104'::bigint))),
    CONSTRAINT vault_uploads_crypto_chunk_bytes_check CHECK ((crypto_chunk_bytes = 4194304)),
    CONSTRAINT vault_uploads_entry_type_check CHECK ((entry_type = ANY (ARRAY['file'::text, 'folder'::text]))),
    CONSTRAINT vault_uploads_generation_id_check CHECK ((octet_length(generation_id) = 16)),
    CONSTRAINT vault_uploads_generation_number_check CHECK ((generation_number > 0)),
    CONSTRAINT vault_uploads_part_size_bytes_check CHECK (((part_size_bytes IS NULL) OR (part_size_bytes = 33554432))),
    CONSTRAINT vault_uploads_reservation_bytes_check CHECK ((reservation_bytes >= 0)),
    CONSTRAINT vault_uploads_status_check CHECK ((status = ANY (ARRAY['initializing'::text, 'pending'::text, 'completing'::text, 'published'::text, 'aborting'::text, 'aborted'::text]))),
    CONSTRAINT vault_uploads_upload_mode_check CHECK ((upload_mode = ANY (ARRAY['none'::text, 'single'::text, 'multipart'::text])))
);


--
-- Name: vault_wrappers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vault_wrappers (
    wrapper_id bytea NOT NULL,
    owner_id text NOT NULL,
    node_id text NOT NULL,
    parent_node_id text,
    wrapper_kind text NOT NULL,
    record_version bigint NOT NULL,
    canonical_cbor bytea NOT NULL,
    wrapper_hash bytea NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT vault_wrappers_canonical_cbor_check CHECK (((octet_length(canonical_cbor) >= 64) AND (octet_length(canonical_cbor) <= 65536))),
    CONSTRAINT vault_wrappers_record_version_check CHECK ((record_version > 0)),
    CONSTRAINT vault_wrappers_wrapper_hash_check CHECK ((octet_length(wrapper_hash) = 32)),
    CONSTRAINT vault_wrappers_wrapper_id_check CHECK ((octet_length(wrapper_id) = 16)),
    CONSTRAINT vault_wrappers_wrapper_kind_check CHECK ((wrapper_kind = ANY (ARRAY['account_root'::text, 'parent_node'::text])))
);


--
-- Name: visible_files; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.visible_files AS
 SELECT id,
    owner_id,
    original_name,
    storage_name,
    mime_type,
    size_bytes,
    state,
    favorite,
    trashed_at,
    created_at,
    updated_at,
    entry_type,
    parent_id,
    checksum_sha256,
    object_etag,
    e2ee_state,
    current_generation_number,
    current_generation_id,
    legacy_share_count,
    vault_share_count,
    permanent_share_link_count,
    latest_share_link_expiry,
    trash_child_count
   FROM public.files
  WHERE public.tree_operation_visible(id, owner_id);


--
-- Name: visible_user_file_counters; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.visible_user_file_counters AS
 SELECT counters.owner_id,
    (counters.total_files - (COALESCE(deltas.total_files, (0)::numeric))::bigint) AS total_files,
    (counters.total_folders - (COALESCE(deltas.total_folders, (0)::numeric))::bigint) AS total_folders,
    (counters.active_files - (COALESCE(deltas.active_files, (0)::numeric))::bigint) AS active_files,
    (counters.trashed_files - (COALESCE(deltas.trashed_files, (0)::numeric))::bigint) AS trashed_files,
    (counters.favorite_files - (COALESCE(deltas.favorite_files, (0)::numeric))::bigint) AS favorite_files,
    (counters.shared_files - (COALESCE(deltas.shared_files, (0)::numeric))::bigint) AS shared_files,
    (counters.used_bytes - (COALESCE(deltas.used_bytes, (0)::numeric))::bigint) AS used_bytes,
    counters.updated_at,
    (public.tree_operation_owner_busy(counters.owner_id) OR (deltas.jobs > 0)) AS tree_operation_pending
   FROM (public.user_file_counters counters
     LEFT JOIN LATERAL ( SELECT sum(delta.total_files) AS total_files,
            sum(delta.total_folders) AS total_folders,
            sum(delta.active_files) AS active_files,
            sum(delta.trashed_files) AS trashed_files,
            sum(delta.favorite_files) AS favorite_files,
            sum(delta.shared_files) AS shared_files,
            sum(delta.used_bytes) AS used_bytes,
            count(*) AS jobs
           FROM (public.tree_operation_counter_deltas delta
             JOIN public.tree_operation_jobs jobs ON (((jobs.id = delta.job_id) AND (jobs.status = ANY (ARRAY['pending'::text, 'running'::text])))))
          WHERE (delta.owner_id = counters.owner_id)) deltas ON (true));


--
-- Name: storage_deletion_jobs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.storage_deletion_jobs ALTER COLUMN id SET DEFAULT nextval('public.storage_deletion_jobs_id_seq'::regclass);


--
-- Name: tree_operation_jobs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tree_operation_jobs ALTER COLUMN id SET DEFAULT nextval('public.tree_operation_jobs_id_seq'::regclass);


--
-- Name: admin_directory_counters admin_directory_counters_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_directory_counters
    ADD CONSTRAINT admin_directory_counters_pkey PRIMARY KEY (singleton);


--
-- Name: bucket_usage_snapshots bucket_usage_snapshots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bucket_usage_snapshots
    ADD CONSTRAINT bucket_usage_snapshots_pkey PRIMARY KEY (namespace);


--
-- Name: collection_timestamp_changes collection_timestamp_changes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.collection_timestamp_changes
    ADD CONSTRAINT collection_timestamp_changes_pkey PRIMARY KEY (id);


--
-- Name: collection_timestamp_changes collection_timestamp_changes_transaction_id_owner_id_parent_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.collection_timestamp_changes
    ADD CONSTRAINT collection_timestamp_changes_transaction_id_owner_id_parent_key UNIQUE (transaction_id, owner_id, parent_id);


--
-- Name: file_shares file_shares_file_id_recipient_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.file_shares
    ADD CONSTRAINT file_shares_file_id_recipient_id_key UNIQUE (file_id, recipient_id);


--
-- Name: file_shares file_shares_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.file_shares
    ADD CONSTRAINT file_shares_pkey PRIMARY KEY (id);


--
-- Name: file_uploads file_uploads_file_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.file_uploads
    ADD CONSTRAINT file_uploads_file_id_key UNIQUE (file_id);


--
-- Name: file_uploads file_uploads_object_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.file_uploads
    ADD CONSTRAINT file_uploads_object_key_key UNIQUE (object_key);


--
-- Name: file_uploads file_uploads_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.file_uploads
    ADD CONSTRAINT file_uploads_pkey PRIMARY KEY (id);


--
-- Name: files files_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.files
    ADD CONSTRAINT files_pkey PRIMARY KEY (id);


--
-- Name: files files_storage_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.files
    ADD CONSTRAINT files_storage_name_key UNIQUE (storage_name);


--
-- Name: invitations invitations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invitations
    ADD CONSTRAINT invitations_pkey PRIMARY KEY (id);


--
-- Name: invitations invitations_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invitations
    ADD CONSTRAINT invitations_token_hash_key UNIQUE (token_hash);


--
-- Name: legacy_text_identifier_columns legacy_text_identifier_columns_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.legacy_text_identifier_columns
    ADD CONSTRAINT legacy_text_identifier_columns_pkey PRIMARY KEY (table_name, column_name, constraint_kind);


--
-- Name: multipart_orphan_abort_claims multipart_orphan_abort_claims_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.multipart_orphan_abort_claims
    ADD CONSTRAINT multipart_orphan_abort_claims_pkey PRIMARY KEY (namespace, object_key, upload_id);


--
-- Name: multipart_reconciliation_progress multipart_reconciliation_progress_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.multipart_reconciliation_progress
    ADD CONSTRAINT multipart_reconciliation_progress_pkey PRIMARY KEY (namespace);


--
-- Name: realtime_audience_deliveries realtime_audience_deliveries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.realtime_audience_deliveries
    ADD CONSTRAINT realtime_audience_deliveries_pkey PRIMARY KEY (id);


--
-- Name: realtime_audience_deliveries realtime_audience_deliveries_transaction_id_user_id_scope_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.realtime_audience_deliveries
    ADD CONSTRAINT realtime_audience_deliveries_transaction_id_user_id_scope_key UNIQUE (transaction_id, user_id, scope);


--
-- Name: realtime_audience_jobs realtime_audience_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.realtime_audience_jobs
    ADD CONSTRAINT realtime_audience_jobs_pkey PRIMARY KEY (id);


--
-- Name: realtime_audience_jobs realtime_audience_jobs_transaction_id_kind_owner_id_entity__key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.realtime_audience_jobs
    ADD CONSTRAINT realtime_audience_jobs_transaction_id_kind_owner_id_entity__key UNIQUE (transaction_id, kind, owner_id, entity_id);


--
-- Name: realtime_events realtime_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.realtime_events
    ADD CONSTRAINT realtime_events_pkey PRIMARY KEY (id);


--
-- Name: realtime_outbox realtime_outbox_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.realtime_outbox
    ADD CONSTRAINT realtime_outbox_pkey PRIMARY KEY (id);


--
-- Name: realtime_outbox realtime_outbox_transaction_id_user_id_scope_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.realtime_outbox
    ADD CONSTRAINT realtime_outbox_transaction_id_user_id_scope_key UNIQUE (transaction_id, user_id, scope);


--
-- Name: realtime_stream_state realtime_stream_state_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.realtime_stream_state
    ADD CONSTRAINT realtime_stream_state_pkey PRIMARY KEY (singleton);


--
-- Name: repositories repositories_owner_id_root_file_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.repositories
    ADD CONSTRAINT repositories_owner_id_root_file_id_key UNIQUE (owner_id, root_file_id);


--
-- Name: repositories repositories_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.repositories
    ADD CONSTRAINT repositories_pkey PRIMARY KEY (id);


--
-- Name: repository_archive_entries repository_archive_entries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.repository_archive_entries
    ADD CONSTRAINT repository_archive_entries_pkey PRIMARY KEY (manifest_id, ordinal);


--
-- Name: repository_archive_manifests repository_archive_manifests_owner_id_repository_id_content_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.repository_archive_manifests
    ADD CONSTRAINT repository_archive_manifests_owner_id_repository_id_content_key UNIQUE (owner_id, repository_id, content_version);


--
-- Name: repository_archive_manifests repository_archive_manifests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.repository_archive_manifests
    ADD CONSTRAINT repository_archive_manifests_pkey PRIMARY KEY (id);


--
-- Name: repository_pending_changes repository_pending_changes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.repository_pending_changes
    ADD CONSTRAINT repository_pending_changes_pkey PRIMARY KEY (id);


--
-- Name: repository_pending_changes repository_pending_changes_transaction_id_repository_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.repository_pending_changes
    ADD CONSTRAINT repository_pending_changes_transaction_id_repository_id_key UNIQUE (transaction_id, repository_id);


--
-- Name: repository_revision_shards repository_revision_shards_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.repository_revision_shards
    ADD CONSTRAINT repository_revision_shards_pkey PRIMARY KEY (repository_id, shard);


--
-- Name: schema_migrations schema_migrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schema_migrations
    ADD CONSTRAINT schema_migrations_pkey PRIMARY KEY (version);


--
-- Name: sessions sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_pkey PRIMARY KEY (id);


--
-- Name: sessions sessions_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_token_hash_key UNIQUE (token_hash);


--
-- Name: share_links share_links_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.share_links
    ADD CONSTRAINT share_links_pkey PRIMARY KEY (id);


--
-- Name: share_links share_links_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.share_links
    ADD CONSTRAINT share_links_token_hash_key UNIQUE (token_hash);


--
-- Name: storage_deletion_jobs storage_deletion_jobs_object_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.storage_deletion_jobs
    ADD CONSTRAINT storage_deletion_jobs_object_key_key UNIQUE (object_key);


--
-- Name: storage_deletion_jobs storage_deletion_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.storage_deletion_jobs
    ADD CONSTRAINT storage_deletion_jobs_pkey PRIMARY KEY (id);


--
-- Name: trash_expiry_owners trash_expiry_owners_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trash_expiry_owners
    ADD CONSTRAINT trash_expiry_owners_pkey PRIMARY KEY (owner_id);


--
-- Name: tree_operation_counter_deltas tree_operation_counter_deltas_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tree_operation_counter_deltas
    ADD CONSTRAINT tree_operation_counter_deltas_pkey PRIMARY KEY (job_id, owner_id);


--
-- Name: tree_operation_jobs tree_operation_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tree_operation_jobs
    ADD CONSTRAINT tree_operation_jobs_pkey PRIMARY KEY (id);


--
-- Name: tree_operation_nodes tree_operation_nodes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tree_operation_nodes
    ADD CONSTRAINT tree_operation_nodes_pkey PRIMARY KEY (job_id, node_id);


--
-- Name: tree_operation_owners tree_operation_owners_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tree_operation_owners
    ADD CONSTRAINT tree_operation_owners_pkey PRIMARY KEY (owner_id);


--
-- Name: user_deletion_jobs user_deletion_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_deletion_jobs
    ADD CONSTRAINT user_deletion_jobs_pkey PRIMARY KEY (user_id);


--
-- Name: user_file_counters user_file_counters_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_file_counters
    ADD CONSTRAINT user_file_counters_pkey PRIMARY KEY (owner_id);


--
-- Name: user_storage_usage user_storage_usage_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_storage_usage
    ADD CONSTRAINT user_storage_usage_pkey PRIMARY KEY (owner_id);


--
-- Name: user_vaults user_vaults_compact_account_state; Type: CHECK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE public.user_vaults
    ADD CONSTRAINT user_vaults_compact_account_state CHECK ((octet_length(encrypted_account_state) <= 16384)) NOT VALID;


--
-- Name: user_vaults user_vaults_identity_record_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_vaults
    ADD CONSTRAINT user_vaults_identity_record_id_key UNIQUE (identity_record_id);


--
-- Name: user_vaults user_vaults_password_wrapper_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_vaults
    ADD CONSTRAINT user_vaults_password_wrapper_id_key UNIQUE (password_wrapper_id);


--
-- Name: user_vaults user_vaults_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_vaults
    ADD CONSTRAINT user_vaults_pkey PRIMARY KEY (user_id);


--
-- Name: user_vaults user_vaults_recovery_wrapper_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_vaults
    ADD CONSTRAINT user_vaults_recovery_wrapper_id_key UNIQUE (recovery_wrapper_id);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: users users_username_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_username_key UNIQUE (username);


--
-- Name: vault_identity_keys vault_identity_keys_fingerprint_sha256_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vault_identity_keys
    ADD CONSTRAINT vault_identity_keys_fingerprint_sha256_key UNIQUE (fingerprint_sha256);


--
-- Name: vault_identity_keys vault_identity_keys_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vault_identity_keys
    ADD CONSTRAINT vault_identity_keys_pkey PRIMARY KEY (user_id, key_version);


--
-- Name: vault_identity_trust vault_identity_trust_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vault_identity_trust
    ADD CONSTRAINT vault_identity_trust_pkey PRIMARY KEY (user_id, peer_user_id);


--
-- Name: vault_migration_node_progress vault_migration_node_progress_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vault_migration_node_progress
    ADD CONSTRAINT vault_migration_node_progress_pkey PRIMARY KEY (owner_id, node_id);


--
-- Name: vault_migration_progress vault_migration_progress_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vault_migration_progress
    ADD CONSTRAINT vault_migration_progress_pkey PRIMARY KEY (owner_id);


--
-- Name: vault_migrations vault_migrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vault_migrations
    ADD CONSTRAINT vault_migrations_pkey PRIMARY KEY (node_id);


--
-- Name: vault_node_heads vault_node_heads_node_id_record_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vault_node_heads
    ADD CONSTRAINT vault_node_heads_node_id_record_hash_key UNIQUE (node_id, record_hash);


--
-- Name: vault_node_heads vault_node_heads_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vault_node_heads
    ADD CONSTRAINT vault_node_heads_pkey PRIMARY KEY (node_id);


--
-- Name: vault_node_records vault_node_records_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vault_node_records
    ADD CONSTRAINT vault_node_records_pkey PRIMARY KEY (node_id, record_version);


--
-- Name: vault_node_records vault_node_records_record_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vault_node_records
    ADD CONSTRAINT vault_node_records_record_hash_key UNIQUE (record_hash);


--
-- Name: vault_object_generations vault_object_generations_node_id_generation_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vault_object_generations
    ADD CONSTRAINT vault_object_generations_node_id_generation_id_key UNIQUE (node_id, generation_id);


--
-- Name: vault_object_generations vault_object_generations_object_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vault_object_generations
    ADD CONSTRAINT vault_object_generations_object_key_key UNIQUE (object_key);


--
-- Name: vault_object_generations vault_object_generations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vault_object_generations
    ADD CONSTRAINT vault_object_generations_pkey PRIMARY KEY (node_id, generation_number);


--
-- Name: vault_revocation_cutoffs vault_revocation_cutoffs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vault_revocation_cutoffs
    ADD CONSTRAINT vault_revocation_cutoffs_pkey PRIMARY KEY (share_id, retired_epoch, revoked_recipient_id);


--
-- Name: vault_share_envelopes vault_share_envelopes_envelope_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vault_share_envelopes
    ADD CONSTRAINT vault_share_envelopes_envelope_hash_key UNIQUE (envelope_hash);


--
-- Name: vault_share_envelopes vault_share_envelopes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vault_share_envelopes
    ADD CONSTRAINT vault_share_envelopes_pkey PRIMARY KEY (envelope_id);


--
-- Name: vault_share_epochs vault_share_epochs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vault_share_epochs
    ADD CONSTRAINT vault_share_epochs_pkey PRIMARY KEY (share_id, epoch);


--
-- Name: vault_share_owner_keys vault_share_owner_keys_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vault_share_owner_keys
    ADD CONSTRAINT vault_share_owner_keys_pkey PRIMARY KEY (share_id, epoch);


--
-- Name: vault_share_owner_keys vault_share_owner_keys_wrapper_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vault_share_owner_keys
    ADD CONSTRAINT vault_share_owner_keys_wrapper_id_key UNIQUE (wrapper_id);


--
-- Name: vault_share_pending_revocations vault_share_pending_revocations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vault_share_pending_revocations
    ADD CONSTRAINT vault_share_pending_revocations_pkey PRIMARY KEY (share_id, pending_epoch, recipient_id);


--
-- Name: vault_share_recipients vault_share_recipients_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vault_share_recipients
    ADD CONSTRAINT vault_share_recipients_pkey PRIMARY KEY (share_id, recipient_id);


--
-- Name: vault_share_sync_jobs vault_share_sync_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vault_share_sync_jobs
    ADD CONSTRAINT vault_share_sync_jobs_pkey PRIMARY KEY (node_id);


--
-- Name: vault_share_wrapper_directories vault_share_wrapper_directories_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vault_share_wrapper_directories
    ADD CONSTRAINT vault_share_wrapper_directories_pkey PRIMARY KEY (node_id, record_version);


--
-- Name: vault_share_wrappers vault_share_wrappers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vault_share_wrappers
    ADD CONSTRAINT vault_share_wrappers_pkey PRIMARY KEY (wrapper_id);


--
-- Name: vault_share_wrappers vault_share_wrappers_share_id_epoch_node_id_generation_id_w_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vault_share_wrappers
    ADD CONSTRAINT vault_share_wrappers_share_id_epoch_node_id_generation_id_w_key UNIQUE (share_id, epoch, node_id, generation_id, wrapper_kind);


--
-- Name: vault_share_wrappers vault_share_wrappers_wrapper_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vault_share_wrappers
    ADD CONSTRAINT vault_share_wrappers_wrapper_hash_key UNIQUE (wrapper_hash);


--
-- Name: vault_shares vault_shares_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vault_shares
    ADD CONSTRAINT vault_shares_pkey PRIMARY KEY (id);


--
-- Name: vault_uploads vault_uploads_object_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vault_uploads
    ADD CONSTRAINT vault_uploads_object_key_key UNIQUE (object_key);


--
-- Name: vault_uploads vault_uploads_owner_id_node_id_generation_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vault_uploads
    ADD CONSTRAINT vault_uploads_owner_id_node_id_generation_id_key UNIQUE (owner_id, node_id, generation_id);


--
-- Name: vault_uploads vault_uploads_owner_id_node_id_generation_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vault_uploads
    ADD CONSTRAINT vault_uploads_owner_id_node_id_generation_number_key UNIQUE (owner_id, node_id, generation_number);


--
-- Name: vault_uploads vault_uploads_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vault_uploads
    ADD CONSTRAINT vault_uploads_pkey PRIMARY KEY (id);


--
-- Name: vault_wrappers vault_wrappers_node_id_record_version_wrapper_kind_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vault_wrappers
    ADD CONSTRAINT vault_wrappers_node_id_record_version_wrapper_kind_key UNIQUE (node_id, record_version, wrapper_kind);


--
-- Name: vault_wrappers vault_wrappers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vault_wrappers
    ADD CONSTRAINT vault_wrappers_pkey PRIMARY KEY (wrapper_id);


--
-- Name: vault_wrappers vault_wrappers_wrapper_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vault_wrappers
    ADD CONSTRAINT vault_wrappers_wrapper_hash_key UNIQUE (wrapper_hash);


--
-- Name: file_shares_file_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX file_shares_file_id_idx ON public.file_shares USING btree (file_id);


--
-- Name: file_shares_owner_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX file_shares_owner_id_idx ON public.file_shares USING btree (owner_id);


--
-- Name: file_shares_realtime_node_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX file_shares_realtime_node_idx ON public.file_shares USING btree (owner_id, file_id, id) INCLUDE (recipient_id);


--
-- Name: file_shares_realtime_owner_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX file_shares_realtime_owner_idx ON public.file_shares USING btree (owner_id, id) INCLUDE (recipient_id);


--
-- Name: file_shares_recipient_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX file_shares_recipient_created_idx ON public.file_shares USING btree (recipient_id, created_at DESC, file_id);


--
-- Name: file_shares_recipient_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX file_shares_recipient_id_idx ON public.file_shares USING btree (recipient_id);


--
-- Name: file_uploads_completion_jobs_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX file_uploads_completion_jobs_idx ON public.file_uploads USING btree (completion_available_at, completion_locked_until, id) WHERE ((status = 'completing'::text) AND (completion_dead_lettered_at IS NULL));


--
-- Name: file_uploads_completion_next_due_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX file_uploads_completion_next_due_idx ON public.file_uploads USING btree (GREATEST(completion_available_at, COALESCE(completion_locked_until, completion_available_at))) WHERE ((status = 'completing'::text) AND (completion_dead_lettered_at IS NULL));


--
-- Name: file_uploads_global_expiry_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX file_uploads_global_expiry_idx ON public.file_uploads USING btree (expires_at, id) WHERE (status = ANY (ARRAY['initializing'::text, 'pending'::text, 'aborting'::text]));


--
-- Name: file_uploads_owner_status_expiry_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX file_uploads_owner_status_expiry_idx ON public.file_uploads USING btree (owner_id, status, expires_at);


--
-- Name: file_uploads_share_link_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX file_uploads_share_link_idx ON public.file_uploads USING btree (share_link_id, status, expires_at);


--
-- Name: file_uploads_tree_parent_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX file_uploads_tree_parent_idx ON public.file_uploads USING btree (owner_id, parent_id);


--
-- Name: file_uploads_tree_replacement_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX file_uploads_tree_replacement_idx ON public.file_uploads USING btree (owner_id, replacement_file_id);


--
-- Name: files_active_browse_name_desc_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX files_active_browse_name_desc_idx ON public.files USING btree (owner_id, parent_id, (
CASE
    WHEN (entry_type = 'folder'::text) THEN 0
    ELSE 1
END), lower(original_name) DESC, id) WHERE (state = 'active'::text);


--
-- Name: files_active_browse_name_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX files_active_browse_name_idx ON public.files USING btree (owner_id, parent_id, (
CASE
    WHEN (entry_type = 'folder'::text) THEN 0
    ELSE 1
END), lower(original_name), id) WHERE (state = 'active'::text);


--
-- Name: files_active_browse_size_desc_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX files_active_browse_size_desc_idx ON public.files USING btree (owner_id, parent_id, (
CASE
    WHEN (entry_type = 'folder'::text) THEN 0
    ELSE 1
END), size_bytes DESC, lower(original_name), id) WHERE (state = 'active'::text);


--
-- Name: files_active_browse_size_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX files_active_browse_size_idx ON public.files USING btree (owner_id, parent_id, (
CASE
    WHEN (entry_type = 'folder'::text) THEN 0
    ELSE 1
END), size_bytes, lower(original_name), id) WHERE (state = 'active'::text);


--
-- Name: files_active_browse_updated_desc_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX files_active_browse_updated_desc_idx ON public.files USING btree (owner_id, parent_id, (
CASE
    WHEN (entry_type = 'folder'::text) THEN 0
    ELSE 1
END), updated_at DESC, lower(original_name), id) WHERE (state = 'active'::text);


--
-- Name: files_active_browse_updated_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX files_active_browse_updated_idx ON public.files USING btree (owner_id, parent_id, (
CASE
    WHEN (entry_type = 'folder'::text) THEN 0
    ELSE 1
END), updated_at, lower(original_name), id) WHERE (state = 'active'::text);


--
-- Name: files_active_folder_sibling_name_unique_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX files_active_folder_sibling_name_unique_idx ON public.files USING btree (owner_id, COALESCE(parent_id, ''::text), lower(original_name)) WHERE ((entry_type = 'folder'::text) AND (state = 'active'::text));


--
-- Name: files_active_owner_name_desc_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX files_active_owner_name_desc_idx ON public.files USING btree (owner_id, (
CASE
    WHEN (entry_type = 'folder'::text) THEN 0
    ELSE 1
END), lower(original_name) DESC, id) WHERE (state = 'active'::text);


--
-- Name: files_active_owner_name_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX files_active_owner_name_idx ON public.files USING btree (owner_id, (
CASE
    WHEN (entry_type = 'folder'::text) THEN 0
    ELSE 1
END), lower(original_name), id) WHERE (state = 'active'::text);


--
-- Name: files_active_owner_size_desc_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX files_active_owner_size_desc_idx ON public.files USING btree (owner_id, (
CASE
    WHEN (entry_type = 'folder'::text) THEN 0
    ELSE 1
END), size_bytes DESC, lower(original_name), id) WHERE (state = 'active'::text);


--
-- Name: files_active_owner_size_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX files_active_owner_size_idx ON public.files USING btree (owner_id, (
CASE
    WHEN (entry_type = 'folder'::text) THEN 0
    ELSE 1
END), size_bytes, lower(original_name), id) WHERE (state = 'active'::text);


--
-- Name: files_active_owner_updated_desc_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX files_active_owner_updated_desc_idx ON public.files USING btree (owner_id, (
CASE
    WHEN (entry_type = 'folder'::text) THEN 0
    ELSE 1
END), updated_at DESC, lower(original_name), id) WHERE (state = 'active'::text);


--
-- Name: files_active_owner_updated_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX files_active_owner_updated_idx ON public.files USING btree (owner_id, (
CASE
    WHEN (entry_type = 'folder'::text) THEN 0
    ELSE 1
END), updated_at, lower(original_name), id) WHERE (state = 'active'::text);


--
-- Name: files_e2ee_migration_claim_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX files_e2ee_migration_claim_idx ON public.files USING btree (owner_id, created_at, id) INCLUDE (e2ee_state) WHERE (e2ee_state = ANY (ARRAY['legacy'::text, 'staged'::text]));


--
-- Name: files_favorites_owner_page_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX files_favorites_owner_page_idx ON public.files USING btree (owner_id, (
CASE
    WHEN (entry_type = 'folder'::text) THEN 0
    ELSE 1
END), updated_at DESC, lower(original_name), id) WHERE ((state = 'active'::text) AND favorite);


--
-- Name: files_owner_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX files_owner_id_idx ON public.files USING btree (owner_id);


--
-- Name: files_owner_parent_state_walk_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX files_owner_parent_state_walk_idx ON public.files USING btree (owner_id, parent_id, state, id) WHERE (parent_id IS NOT NULL);


--
-- Name: files_owner_parent_walk_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX files_owner_parent_walk_idx ON public.files USING btree (owner_id, parent_id, id) WHERE (parent_id IS NOT NULL);


--
-- Name: INDEX files_owner_parent_walk_idx; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON INDEX public.files_owner_parent_walk_idx IS 'Supports bounded (owner, parent, id) keyset pages used by subtree operations.';


--
-- Name: files_parent_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX files_parent_id_idx ON public.files USING btree (parent_id);


--
-- Name: files_state_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX files_state_idx ON public.files USING btree (state);


--
-- Name: files_trash_leaf_owner_due_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX files_trash_leaf_owner_due_idx ON public.files USING btree (owner_id, trashed_at, id) WHERE ((state = 'trashed'::text) AND (trashed_at IS NOT NULL) AND (trash_child_count = 0));


--
-- Name: files_trash_owner_page_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX files_trash_owner_page_idx ON public.files USING btree (owner_id, (
CASE
    WHEN (entry_type = 'folder'::text) THEN 0
    ELSE 1
END), trashed_at DESC, lower(original_name), id) WHERE (state = 'trashed'::text);


--
-- Name: files_trashed_retention_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX files_trashed_retention_idx ON public.files USING btree (trashed_at, id) WHERE ((state = 'trashed'::text) AND (trashed_at IS NOT NULL));


--
-- Name: invitations_created_by_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX invitations_created_by_idx ON public.invitations USING btree (created_by);


--
-- Name: invitations_created_cursor_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX invitations_created_cursor_idx ON public.invitations USING btree (created_at DESC, id DESC);


--
-- Name: invitations_expires_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX invitations_expires_at_idx ON public.invitations USING btree (expires_at);


--
-- Name: invitations_pending_expiry_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX invitations_pending_expiry_idx ON public.invitations USING btree (expires_at, id) WHERE (status = 'pending'::text);


--
-- Name: invitations_pending_username_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX invitations_pending_username_idx ON public.invitations USING btree (lower(invited_username)) WHERE (status = 'pending'::text);


--
-- Name: invitations_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX invitations_status_idx ON public.invitations USING btree (status);


--
-- Name: invitations_username_trgm_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX invitations_username_trgm_idx ON public.invitations USING gin (invited_username public.gin_trgm_ops);


--
-- Name: multipart_orphan_abort_claims_due_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX multipart_orphan_abort_claims_due_idx ON public.multipart_orphan_abort_claims USING btree (namespace, next_attempt_at);


--
-- Name: multipart_orphan_abort_claims_object_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX multipart_orphan_abort_claims_object_idx ON public.multipart_orphan_abort_claims USING btree (object_key, upload_id);


--
-- Name: realtime_audience_jobs_complete_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX realtime_audience_jobs_complete_idx ON public.realtime_audience_jobs USING btree (id) WHERE complete;


--
-- Name: realtime_audience_jobs_pending_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX realtime_audience_jobs_pending_idx ON public.realtime_audience_jobs USING btree (id) WHERE (NOT complete);


--
-- Name: realtime_audience_jobs_transaction_pending_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX realtime_audience_jobs_transaction_pending_idx ON public.realtime_audience_jobs USING btree (transaction_id) WHERE (NOT complete);


--
-- Name: realtime_events_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX realtime_events_created_idx ON public.realtime_events USING btree (created_at, id);


--
-- Name: realtime_events_user_cursor_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX realtime_events_user_cursor_idx ON public.realtime_events USING btree (user_id, id);


--
-- Name: repositories_owner_updated_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX repositories_owner_updated_idx ON public.repositories USING btree (owner_id, updated_at DESC, id);


--
-- Name: repository_archive_manifests_expiry_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX repository_archive_manifests_expiry_idx ON public.repository_archive_manifests USING btree (expires_at, id);


--
-- Name: repository_archive_manifests_scope_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX repository_archive_manifests_scope_idx ON public.repository_archive_manifests USING btree (owner_id, repository_id, content_version, expires_at DESC);


--
-- Name: repository_pending_changes_repository_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX repository_pending_changes_repository_idx ON public.repository_pending_changes USING btree (repository_id, id);


--
-- Name: sessions_expiry_cleanup_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sessions_expiry_cleanup_idx ON public.sessions USING btree (expires_at, id);


--
-- Name: sessions_user_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sessions_user_id_idx ON public.sessions USING btree (user_id);


--
-- Name: share_links_owner_root_page_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX share_links_owner_root_page_idx ON public.share_links USING btree (owner_id, root_file_id, created_at DESC, id DESC);


--
-- Name: share_links_realtime_node_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX share_links_realtime_node_idx ON public.share_links USING btree (owner_id, root_file_id, id) INCLUDE (recipient_id, expires_at) WHERE ((recipient_id IS NOT NULL) AND (revoked_at IS NULL));


--
-- Name: share_links_realtime_owner_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX share_links_realtime_owner_idx ON public.share_links USING btree (owner_id, id) INCLUDE (recipient_id, expires_at) WHERE ((recipient_id IS NOT NULL) AND (revoked_at IS NULL));


--
-- Name: share_links_recipient_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX share_links_recipient_idx ON public.share_links USING btree (recipient_id, expires_at) WHERE (revoked_at IS NULL);


--
-- Name: storage_deletion_jobs_available_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX storage_deletion_jobs_available_idx ON public.storage_deletion_jobs USING btree (available_at, locked_until, id) WHERE (dead_lettered_at IS NULL);


--
-- Name: storage_deletion_jobs_next_due_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX storage_deletion_jobs_next_due_idx ON public.storage_deletion_jobs USING btree (GREATEST(available_at, COALESCE(locked_until, available_at))) WHERE (dead_lettered_at IS NULL);


--
-- Name: trash_expiry_owners_due_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX trash_expiry_owners_due_idx ON public.trash_expiry_owners USING btree (next_due_at, owner_id) WHERE (next_due_at IS NOT NULL);


--
-- Name: tree_operation_counter_deltas_owner_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX tree_operation_counter_deltas_owner_idx ON public.tree_operation_counter_deltas USING btree (owner_id, job_id);


--
-- Name: tree_operation_jobs_active_owner_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX tree_operation_jobs_active_owner_idx ON public.tree_operation_jobs USING btree (owner_id) WHERE (status = ANY (ARRAY['pending'::text, 'running'::text]));


--
-- Name: tree_operation_jobs_available_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX tree_operation_jobs_available_idx ON public.tree_operation_jobs USING btree (available_at, id) WHERE (status = ANY (ARRAY['pending'::text, 'running'::text]));


--
-- Name: tree_operation_jobs_complete_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX tree_operation_jobs_complete_idx ON public.tree_operation_jobs USING btree (completed_at, id) WHERE (status = 'complete'::text);


--
-- Name: tree_operation_nodes_frontier_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX tree_operation_nodes_frontier_idx ON public.tree_operation_nodes USING btree (job_id, depth, node_id) WHERE (NOT expanded);


--
-- Name: tree_operation_nodes_mutation_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX tree_operation_nodes_mutation_idx ON public.tree_operation_nodes USING btree (job_id, depth DESC, node_id) WHERE (NOT processed);


--
-- Name: user_deletion_jobs_available_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX user_deletion_jobs_available_idx ON public.user_deletion_jobs USING btree (available_at, locked_until, created_at) WHERE (dead_lettered_at IS NULL);


--
-- Name: user_deletion_jobs_next_due_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX user_deletion_jobs_next_due_idx ON public.user_deletion_jobs USING btree (GREATEST(available_at, COALESCE(locked_until, available_at))) WHERE (dead_lettered_at IS NULL);


--
-- Name: users_created_cursor_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX users_created_cursor_idx ON public.users USING btree (created_at, id);


--
-- Name: users_display_name_trgm_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX users_display_name_trgm_idx ON public.users USING gin (COALESCE(display_name, ''::text) public.gin_trgm_ops) WHERE (status <> 'deleting'::text);


--
-- Name: users_realtime_admin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX users_realtime_admin_idx ON public.users USING btree (id) WHERE ((role = 'admin'::text) AND (status = 'active'::text));


--
-- Name: users_username_ci_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX users_username_ci_idx ON public.users USING btree (lower(username));


--
-- Name: users_username_trgm_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX users_username_trgm_idx ON public.users USING gin (username public.gin_trgm_ops) WHERE (status <> 'deleting'::text);


--
-- Name: vault_generations_owner_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX vault_generations_owner_idx ON public.vault_object_generations USING btree (owner_id, created_at DESC);


--
-- Name: vault_identity_one_active_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX vault_identity_one_active_key ON public.vault_identity_keys USING btree (user_id) WHERE (status = 'active'::text);


--
-- Name: vault_migrations_cleanup_object_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX vault_migrations_cleanup_object_idx ON public.vault_migrations USING btree (legacy_object_key) WHERE ((state = 'cleanup_queued'::text) AND (legacy_object_key IS NOT NULL));


--
-- Name: vault_migrations_incomplete_owner_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX vault_migrations_incomplete_owner_idx ON public.vault_migrations USING btree (owner_id, node_id) WHERE (state <> 'complete'::text);


--
-- Name: vault_migrations_owner_state_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX vault_migrations_owner_state_idx ON public.vault_migrations USING btree (owner_id, state, updated_at);


--
-- Name: vault_node_records_owner_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX vault_node_records_owner_idx ON public.vault_node_records USING btree (owner_id, created_at DESC);


--
-- Name: vault_share_envelopes_recipient_latest_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX vault_share_envelopes_recipient_latest_idx ON public.vault_share_envelopes USING btree (share_id, epoch, recipient_id, created_at DESC, envelope_id DESC);


--
-- Name: vault_share_envelopes_tree_node_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX vault_share_envelopes_tree_node_idx ON public.vault_share_envelopes USING btree (node_id);


--
-- Name: vault_share_recipients_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX vault_share_recipients_user_idx ON public.vault_share_recipients USING btree (recipient_id, status);


--
-- Name: vault_share_sync_jobs_owner_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX vault_share_sync_jobs_owner_idx ON public.vault_share_sync_jobs USING btree (owner_id, updated_at, node_id);


--
-- Name: vault_share_wrappers_current_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX vault_share_wrappers_current_idx ON public.vault_share_wrappers USING btree (share_id, epoch, node_id, wrapper_kind, record_version DESC);


--
-- Name: vault_share_wrappers_tree_node_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX vault_share_wrappers_tree_node_idx ON public.vault_share_wrappers USING btree (node_id);


--
-- Name: vault_shares_owner_root_page_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX vault_shares_owner_root_page_idx ON public.vault_shares USING btree (owner_id, root_node_id, created_at, id) WHERE (status = ANY (ARRAY['active'::text, 'rotating'::text]));


--
-- Name: vault_shares_realtime_node_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX vault_shares_realtime_node_idx ON public.vault_shares USING btree (owner_id, root_node_id, id) WHERE (status = ANY (ARRAY['active'::text, 'rotating'::text]));


--
-- Name: vault_shares_realtime_owner_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX vault_shares_realtime_owner_idx ON public.vault_shares USING btree (owner_id, id) WHERE (status = ANY (ARRAY['active'::text, 'rotating'::text]));


--
-- Name: vault_shares_root_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX vault_shares_root_idx ON public.vault_shares USING btree (owner_id, root_node_id, status);


--
-- Name: vault_shares_tree_root_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX vault_shares_tree_root_idx ON public.vault_shares USING btree (owner_id, root_node_id, id);


--
-- Name: vault_uploads_global_expiry_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX vault_uploads_global_expiry_idx ON public.vault_uploads USING btree (expires_at, id) WHERE (status = ANY (ARRAY['initializing'::text, 'pending'::text, 'completing'::text, 'aborting'::text]));


--
-- Name: vault_uploads_owner_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX vault_uploads_owner_status_idx ON public.vault_uploads USING btree (owner_id, status, expires_at);


--
-- Name: vault_uploads_tree_parent_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX vault_uploads_tree_parent_idx ON public.vault_uploads USING btree (owner_id, parent_id);


--
-- Name: vault_wrappers_tree_node_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX vault_wrappers_tree_node_idx ON public.vault_wrappers USING btree (node_id);


--
-- Name: vault_wrappers_tree_parent_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX vault_wrappers_tree_parent_idx ON public.vault_wrappers USING btree (parent_node_id);


--
-- Name: files collection_revision_delete; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER collection_revision_delete AFTER DELETE ON public.files REFERENCING OLD TABLE AS collection_old FOR EACH STATEMENT EXECUTE FUNCTION public.repository_files_changed();


--
-- Name: vault_node_heads collection_revision_delete; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER collection_revision_delete AFTER DELETE ON public.vault_node_heads REFERENCING OLD TABLE AS collection_old FOR EACH STATEMENT EXECUTE FUNCTION public.repository_files_changed();


--
-- Name: files collection_revision_insert; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER collection_revision_insert AFTER INSERT ON public.files REFERENCING NEW TABLE AS collection_new FOR EACH STATEMENT EXECUTE FUNCTION public.repository_files_changed();


--
-- Name: vault_node_heads collection_revision_insert; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER collection_revision_insert AFTER INSERT ON public.vault_node_heads REFERENCING NEW TABLE AS collection_new FOR EACH STATEMENT EXECUTE FUNCTION public.repository_files_changed();


--
-- Name: files collection_revision_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER collection_revision_update AFTER UPDATE ON public.files REFERENCING OLD TABLE AS collection_old NEW TABLE AS collection_new FOR EACH STATEMENT EXECUTE FUNCTION public.repository_files_changed();


--
-- Name: vault_node_heads collection_revision_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER collection_revision_update AFTER UPDATE ON public.vault_node_heads REFERENCING OLD TABLE AS collection_old NEW TABLE AS collection_new FOR EACH STATEMENT EXECUTE FUNCTION public.repository_files_changed();


--
-- Name: file_uploads fence_multipart_orphan_adoption; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER fence_multipart_orphan_adoption BEFORE INSERT OR UPDATE OF object_key, multipart_upload_id, status, expires_at, write_expires_at ON public.file_uploads FOR EACH ROW EXECUTE FUNCTION public.fence_multipart_orphan_adoption();


--
-- Name: vault_uploads fence_multipart_orphan_adoption; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER fence_multipart_orphan_adoption BEFORE INSERT OR UPDATE OF object_key, multipart_upload_id, status, expires_at, write_expires_at ON public.vault_uploads FOR EACH ROW EXECUTE FUNCTION public.fence_multipart_orphan_adoption();


--
-- Name: file_shares file_shares_counter_change; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER file_shares_counter_change AFTER INSERT OR DELETE ON public.file_shares FOR EACH ROW EXECUTE FUNCTION public.update_share_counters();


--
-- Name: file_shares file_shares_file_state_delete; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER file_shares_file_state_delete AFTER DELETE ON public.file_shares REFERENCING OLD TABLE AS old_share_rows FOR EACH STATEMENT EXECUTE FUNCTION public.update_file_legacy_share_state();


--
-- Name: file_shares file_shares_file_state_insert; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER file_shares_file_state_insert AFTER INSERT ON public.file_shares REFERENCING NEW TABLE AS new_share_rows FOR EACH STATEMENT EXECUTE FUNCTION public.update_file_legacy_share_state();


--
-- Name: file_shares file_shares_file_state_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER file_shares_file_state_update AFTER UPDATE ON public.file_shares REFERENCING OLD TABLE AS old_share_rows NEW TABLE AS new_share_rows FOR EACH STATEMENT EXECUTE FUNCTION public.update_file_legacy_share_state();


--
-- Name: file_shares file_shares_tree_operation_write_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER file_shares_tree_operation_write_guard BEFORE INSERT OR DELETE OR UPDATE ON public.file_shares FOR EACH ROW EXECUTE FUNCTION public.guard_tree_operation_related_write('file_id');


--
-- Name: file_uploads file_upload_reservation_delete; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER file_upload_reservation_delete AFTER DELETE ON public.file_uploads REFERENCING OLD TABLE AS old_upload_rows FOR EACH STATEMENT EXECUTE FUNCTION public.delete_file_upload_reservations();


--
-- Name: file_uploads file_upload_reservation_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER file_upload_reservation_immutable BEFORE UPDATE OF owner_id, reservation_bytes ON public.file_uploads FOR EACH ROW EXECUTE FUNCTION public.prevent_upload_reservation_rewrite();


--
-- Name: file_uploads file_upload_reservation_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER file_upload_reservation_update AFTER UPDATE ON public.file_uploads REFERENCING OLD TABLE AS old_upload_rows NEW TABLE AS new_upload_rows FOR EACH STATEMENT EXECUTE FUNCTION public.update_file_upload_reservations();


--
-- Name: file_uploads file_uploads_tree_operation_write_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER file_uploads_tree_operation_write_guard BEFORE INSERT OR DELETE OR UPDATE ON public.file_uploads FOR EACH ROW EXECUTE FUNCTION public.guard_tree_operation_related_write('file_id', 'parent_id', 'replacement_file_id', 'tree_share_root_id');


--
-- Name: files files_counter_delete_statement; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER files_counter_delete_statement AFTER DELETE ON public.files REFERENCING OLD TABLE AS old_file_rows FOR EACH STATEMENT EXECUTE FUNCTION public.update_file_counters_after_delete();


--
-- Name: files files_counter_insert_statement; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER files_counter_insert_statement AFTER INSERT ON public.files REFERENCING NEW TABLE AS new_file_rows FOR EACH STATEMENT EXECUTE FUNCTION public.update_file_counters_after_insert();


--
-- Name: files files_counter_update_statement; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER files_counter_update_statement AFTER UPDATE ON public.files REFERENCING OLD TABLE AS old_file_rows NEW TABLE AS new_file_rows FOR EACH STATEMENT EXECUTE FUNCTION public.update_file_counters_after_update();


--
-- Name: files files_hierarchy_insert_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER files_hierarchy_insert_guard AFTER INSERT ON public.files REFERENCING NEW TABLE AS inserted_files FOR EACH STATEMENT EXECUTE FUNCTION public.validate_inserted_file_hierarchy();


--
-- Name: files files_hierarchy_update_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER files_hierarchy_update_guard AFTER UPDATE ON public.files REFERENCING OLD TABLE AS old_files NEW TABLE AS updated_files FOR EACH STATEMENT EXECUTE FUNCTION public.validate_updated_file_hierarchy();


--
-- Name: files files_migration_progress_delete; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER files_migration_progress_delete AFTER DELETE ON public.files REFERENCING OLD TABLE AS old_files FOR EACH STATEMENT EXECUTE FUNCTION public.track_file_migration_progress();


--
-- Name: files files_migration_progress_insert; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER files_migration_progress_insert AFTER INSERT ON public.files REFERENCING NEW TABLE AS new_files FOR EACH STATEMENT EXECUTE FUNCTION public.track_file_migration_progress();


--
-- Name: files files_migration_progress_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER files_migration_progress_update AFTER UPDATE ON public.files REFERENCING OLD TABLE AS old_files NEW TABLE AS new_files FOR EACH STATEMENT EXECUTE FUNCTION public.track_file_migration_progress();


--
-- Name: files files_tree_operation_write_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER files_tree_operation_write_guard BEFORE INSERT OR DELETE OR UPDATE ON public.files FOR EACH ROW EXECUTE FUNCTION public.guard_tree_operation_file_write();


--
-- Name: invitations invitations_admin_counter_delete; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER invitations_admin_counter_delete AFTER DELETE ON public.invitations FOR EACH ROW EXECUTE FUNCTION public.update_admin_invitation_counters();


--
-- Name: invitations invitations_admin_counter_insert; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER invitations_admin_counter_insert AFTER INSERT ON public.invitations FOR EACH ROW EXECUTE FUNCTION public.update_admin_invitation_counters();


--
-- Name: invitations invitations_admin_counter_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER invitations_admin_counter_update AFTER UPDATE OF status ON public.invitations FOR EACH ROW WHEN (((old.status = 'pending'::text) IS DISTINCT FROM (new.status = 'pending'::text))) EXECUTE FUNCTION public.update_admin_invitation_counters();


--
-- Name: files maintain_trash_expiry_delete; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER maintain_trash_expiry_delete AFTER DELETE ON public.files REFERENCING OLD TABLE AS trash_old FOR EACH STATEMENT EXECUTE FUNCTION public.maintain_trash_expiry_delete();


--
-- Name: files maintain_trash_expiry_insert; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER maintain_trash_expiry_insert AFTER INSERT ON public.files REFERENCING NEW TABLE AS trash_new FOR EACH STATEMENT EXECUTE FUNCTION public.maintain_trash_expiry_insert();


--
-- Name: users maintain_trash_expiry_policy; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER maintain_trash_expiry_policy AFTER INSERT OR UPDATE OF trash_retention_minutes, trash_retention_days ON public.users FOR EACH ROW EXECUTE FUNCTION public.maintain_trash_expiry_policy();


--
-- Name: files maintain_trash_expiry_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER maintain_trash_expiry_update AFTER UPDATE ON public.files REFERENCING OLD TABLE AS trash_old NEW TABLE AS trash_new FOR EACH STATEMENT EXECUTE FUNCTION public.maintain_trash_expiry_update();


--
-- Name: tree_operation_jobs notify_aeralyth_maintenance; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER notify_aeralyth_maintenance AFTER INSERT ON public.tree_operation_jobs REFERENCING NEW TABLE AS maintenance_new FOR EACH STATEMENT EXECUTE FUNCTION public.notify_aeralyth_maintenance();


--
-- Name: file_uploads notify_aeralyth_maintenance_insert; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER notify_aeralyth_maintenance_insert AFTER INSERT ON public.file_uploads REFERENCING NEW TABLE AS maintenance_new FOR EACH STATEMENT EXECUTE FUNCTION public.notify_aeralyth_maintenance();


--
-- Name: invitations notify_aeralyth_maintenance_insert; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER notify_aeralyth_maintenance_insert AFTER INSERT ON public.invitations REFERENCING NEW TABLE AS maintenance_new FOR EACH STATEMENT EXECUTE FUNCTION public.notify_aeralyth_maintenance();


--
-- Name: sessions notify_aeralyth_maintenance_insert; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER notify_aeralyth_maintenance_insert AFTER INSERT ON public.sessions REFERENCING NEW TABLE AS maintenance_new FOR EACH STATEMENT EXECUTE FUNCTION public.notify_aeralyth_maintenance();


--
-- Name: storage_deletion_jobs notify_aeralyth_maintenance_insert; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER notify_aeralyth_maintenance_insert AFTER INSERT ON public.storage_deletion_jobs REFERENCING NEW TABLE AS maintenance_new FOR EACH STATEMENT EXECUTE FUNCTION public.notify_aeralyth_maintenance();


--
-- Name: user_deletion_jobs notify_aeralyth_maintenance_insert; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER notify_aeralyth_maintenance_insert AFTER INSERT ON public.user_deletion_jobs REFERENCING NEW TABLE AS maintenance_new FOR EACH STATEMENT EXECUTE FUNCTION public.notify_aeralyth_maintenance();


--
-- Name: vault_uploads notify_aeralyth_maintenance_insert; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER notify_aeralyth_maintenance_insert AFTER INSERT ON public.vault_uploads REFERENCING NEW TABLE AS maintenance_new FOR EACH STATEMENT EXECUTE FUNCTION public.notify_aeralyth_maintenance();


--
-- Name: file_uploads notify_aeralyth_maintenance_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER notify_aeralyth_maintenance_update AFTER UPDATE ON public.file_uploads REFERENCING OLD TABLE AS maintenance_old NEW TABLE AS maintenance_new FOR EACH STATEMENT EXECUTE FUNCTION public.notify_aeralyth_maintenance('id, status, expires_at, completion_available_at, completion_locked_until, completion_dead_lettered_at');


--
-- Name: invitations notify_aeralyth_maintenance_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER notify_aeralyth_maintenance_update AFTER UPDATE ON public.invitations REFERENCING OLD TABLE AS maintenance_old NEW TABLE AS maintenance_new FOR EACH STATEMENT EXECUTE FUNCTION public.notify_aeralyth_maintenance('id, status, expires_at');


--
-- Name: sessions notify_aeralyth_maintenance_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER notify_aeralyth_maintenance_update AFTER UPDATE ON public.sessions REFERENCING OLD TABLE AS maintenance_old NEW TABLE AS maintenance_new FOR EACH STATEMENT EXECUTE FUNCTION public.notify_aeralyth_maintenance('id, expires_at');


--
-- Name: storage_deletion_jobs notify_aeralyth_maintenance_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER notify_aeralyth_maintenance_update AFTER UPDATE ON public.storage_deletion_jobs REFERENCING OLD TABLE AS maintenance_old NEW TABLE AS maintenance_new FOR EACH STATEMENT EXECUTE FUNCTION public.notify_aeralyth_maintenance('id, available_at, locked_until, dead_lettered_at');


--
-- Name: user_deletion_jobs notify_aeralyth_maintenance_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER notify_aeralyth_maintenance_update AFTER UPDATE ON public.user_deletion_jobs REFERENCING OLD TABLE AS maintenance_old NEW TABLE AS maintenance_new FOR EACH STATEMENT EXECUTE FUNCTION public.notify_aeralyth_maintenance('user_id, phase, available_at, locked_until, dead_lettered_at');


--
-- Name: vault_uploads notify_aeralyth_maintenance_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER notify_aeralyth_maintenance_update AFTER UPDATE ON public.vault_uploads REFERENCING OLD TABLE AS maintenance_old NEW TABLE AS maintenance_new FOR EACH STATEMENT EXECUTE FUNCTION public.notify_aeralyth_maintenance('id, status, expires_at');


--
-- Name: files notify_aeralyth_trash_retention_file_insert; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER notify_aeralyth_trash_retention_file_insert AFTER INSERT ON public.files REFERENCING NEW TABLE AS maintenance_new FOR EACH STATEMENT EXECUTE FUNCTION public.notify_aeralyth_maintenance();


--
-- Name: files notify_aeralyth_trash_retention_file_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER notify_aeralyth_trash_retention_file_update AFTER UPDATE ON public.files REFERENCING OLD TABLE AS maintenance_old NEW TABLE AS maintenance_new FOR EACH STATEMENT EXECUTE FUNCTION public.notify_aeralyth_maintenance('id, owner_id, state, trashed_at, trash_child_count = 0');


--
-- Name: users notify_aeralyth_trash_retention_users; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER notify_aeralyth_trash_retention_users AFTER UPDATE ON public.users REFERENCING OLD TABLE AS maintenance_old NEW TABLE AS maintenance_new FOR EACH STATEMENT EXECUTE FUNCTION public.notify_aeralyth_maintenance('id, trash_retention_minutes');


--
-- Name: file_shares realtime_delete; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER realtime_delete AFTER DELETE ON public.file_shares REFERENCING OLD TABLE AS realtime_old FOR EACH STATEMENT EXECUTE FUNCTION public.realtime_related_changed();


--
-- Name: files realtime_delete; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER realtime_delete AFTER DELETE ON public.files REFERENCING OLD TABLE AS realtime_old FOR EACH STATEMENT EXECUTE FUNCTION public.realtime_files_changed();


--
-- Name: repositories realtime_delete; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER realtime_delete AFTER DELETE ON public.repositories REFERENCING OLD TABLE AS realtime_old FOR EACH STATEMENT EXECUTE FUNCTION public.realtime_related_changed();


--
-- Name: sessions realtime_delete; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER realtime_delete AFTER DELETE ON public.sessions REFERENCING OLD TABLE AS realtime_old FOR EACH STATEMENT EXECUTE FUNCTION public.realtime_related_changed();


--
-- Name: share_links realtime_delete; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER realtime_delete AFTER DELETE ON public.share_links REFERENCING OLD TABLE AS realtime_old FOR EACH STATEMENT EXECUTE FUNCTION public.realtime_related_changed();


--
-- Name: user_vaults realtime_delete; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER realtime_delete AFTER DELETE ON public.user_vaults REFERENCING OLD TABLE AS realtime_old FOR EACH STATEMENT EXECUTE FUNCTION public.realtime_related_changed();


--
-- Name: users realtime_delete; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER realtime_delete AFTER DELETE ON public.users REFERENCING OLD TABLE AS realtime_old FOR EACH STATEMENT EXECUTE FUNCTION public.realtime_related_changed();


--
-- Name: vault_node_heads realtime_delete; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER realtime_delete AFTER DELETE ON public.vault_node_heads REFERENCING OLD TABLE AS realtime_old FOR EACH STATEMENT EXECUTE FUNCTION public.realtime_files_changed();


--
-- Name: vault_share_recipients realtime_delete; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER realtime_delete AFTER DELETE ON public.vault_share_recipients REFERENCING OLD TABLE AS realtime_old FOR EACH STATEMENT EXECUTE FUNCTION public.realtime_related_changed();


--
-- Name: vault_shares realtime_delete; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER realtime_delete AFTER DELETE ON public.vault_shares REFERENCING OLD TABLE AS realtime_old FOR EACH STATEMENT EXECUTE FUNCTION public.realtime_related_changed();


--
-- Name: file_shares realtime_insert; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER realtime_insert AFTER INSERT ON public.file_shares REFERENCING NEW TABLE AS realtime_new FOR EACH STATEMENT EXECUTE FUNCTION public.realtime_related_changed();


--
-- Name: files realtime_insert; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER realtime_insert AFTER INSERT ON public.files REFERENCING NEW TABLE AS realtime_new FOR EACH STATEMENT EXECUTE FUNCTION public.realtime_files_changed();


--
-- Name: repositories realtime_insert; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER realtime_insert AFTER INSERT ON public.repositories REFERENCING NEW TABLE AS realtime_new FOR EACH STATEMENT EXECUTE FUNCTION public.realtime_related_changed();


--
-- Name: sessions realtime_insert; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER realtime_insert AFTER INSERT ON public.sessions REFERENCING NEW TABLE AS realtime_new FOR EACH STATEMENT EXECUTE FUNCTION public.realtime_related_changed();


--
-- Name: share_links realtime_insert; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER realtime_insert AFTER INSERT ON public.share_links REFERENCING NEW TABLE AS realtime_new FOR EACH STATEMENT EXECUTE FUNCTION public.realtime_related_changed();


--
-- Name: user_vaults realtime_insert; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER realtime_insert AFTER INSERT ON public.user_vaults REFERENCING NEW TABLE AS realtime_new FOR EACH STATEMENT EXECUTE FUNCTION public.realtime_related_changed();


--
-- Name: users realtime_insert; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER realtime_insert AFTER INSERT ON public.users REFERENCING NEW TABLE AS realtime_new FOR EACH STATEMENT EXECUTE FUNCTION public.realtime_related_changed();


--
-- Name: vault_node_heads realtime_insert; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER realtime_insert AFTER INSERT ON public.vault_node_heads REFERENCING NEW TABLE AS realtime_new FOR EACH STATEMENT EXECUTE FUNCTION public.realtime_files_changed();


--
-- Name: vault_share_recipients realtime_insert; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER realtime_insert AFTER INSERT ON public.vault_share_recipients REFERENCING NEW TABLE AS realtime_new FOR EACH STATEMENT EXECUTE FUNCTION public.realtime_related_changed();


--
-- Name: vault_shares realtime_insert; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER realtime_insert AFTER INSERT ON public.vault_shares REFERENCING NEW TABLE AS realtime_new FOR EACH STATEMENT EXECUTE FUNCTION public.realtime_related_changed();


--
-- Name: file_shares realtime_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER realtime_update AFTER UPDATE ON public.file_shares REFERENCING OLD TABLE AS realtime_old NEW TABLE AS realtime_new FOR EACH STATEMENT EXECUTE FUNCTION public.realtime_related_changed();


--
-- Name: files realtime_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER realtime_update AFTER UPDATE ON public.files REFERENCING OLD TABLE AS realtime_old NEW TABLE AS realtime_new FOR EACH STATEMENT EXECUTE FUNCTION public.realtime_files_changed();


--
-- Name: repositories realtime_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER realtime_update AFTER UPDATE ON public.repositories REFERENCING OLD TABLE AS realtime_old NEW TABLE AS realtime_new FOR EACH STATEMENT EXECUTE FUNCTION public.realtime_related_changed();


--
-- Name: sessions realtime_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER realtime_update AFTER UPDATE ON public.sessions REFERENCING OLD TABLE AS realtime_old NEW TABLE AS realtime_new FOR EACH STATEMENT EXECUTE FUNCTION public.realtime_related_changed();


--
-- Name: share_links realtime_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER realtime_update AFTER UPDATE ON public.share_links REFERENCING OLD TABLE AS realtime_old NEW TABLE AS realtime_new FOR EACH STATEMENT EXECUTE FUNCTION public.realtime_related_changed();


--
-- Name: user_vaults realtime_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER realtime_update AFTER UPDATE ON public.user_vaults REFERENCING OLD TABLE AS realtime_old NEW TABLE AS realtime_new FOR EACH STATEMENT EXECUTE FUNCTION public.realtime_related_changed();


--
-- Name: users realtime_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER realtime_update AFTER UPDATE ON public.users REFERENCING OLD TABLE AS realtime_old NEW TABLE AS realtime_new FOR EACH STATEMENT EXECUTE FUNCTION public.realtime_related_changed();


--
-- Name: vault_node_heads realtime_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER realtime_update AFTER UPDATE ON public.vault_node_heads REFERENCING OLD TABLE AS realtime_old NEW TABLE AS realtime_new FOR EACH STATEMENT EXECUTE FUNCTION public.realtime_files_changed();


--
-- Name: vault_share_recipients realtime_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER realtime_update AFTER UPDATE ON public.vault_share_recipients REFERENCING OLD TABLE AS realtime_old NEW TABLE AS realtime_new FOR EACH STATEMENT EXECUTE FUNCTION public.realtime_related_changed();


--
-- Name: vault_shares realtime_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER realtime_update AFTER UPDATE ON public.vault_shares REFERENCING OLD TABLE AS realtime_old NEW TABLE AS realtime_new FOR EACH STATEMENT EXECUTE FUNCTION public.realtime_related_changed();


--
-- Name: repositories repositories_tree_operation_write_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER repositories_tree_operation_write_guard BEFORE INSERT OR DELETE OR UPDATE ON public.repositories FOR EACH ROW EXECUTE FUNCTION public.guard_tree_operation_related_write('root_file_id');


--
-- Name: repositories repository_created_counts; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER repository_created_counts AFTER INSERT ON public.repositories REFERENCING NEW TABLE AS collection_new FOR EACH STATEMENT EXECUTE FUNCTION public.repository_created_counts();


--
-- Name: share_links share_links_file_state_delete; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER share_links_file_state_delete AFTER DELETE ON public.share_links REFERENCING OLD TABLE AS old_share_rows FOR EACH STATEMENT EXECUTE FUNCTION public.refresh_file_link_share_state();


--
-- Name: share_links share_links_file_state_insert; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER share_links_file_state_insert AFTER INSERT ON public.share_links REFERENCING NEW TABLE AS new_share_rows FOR EACH STATEMENT EXECUTE FUNCTION public.refresh_file_link_share_state();


--
-- Name: share_links share_links_file_state_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER share_links_file_state_update AFTER UPDATE ON public.share_links REFERENCING OLD TABLE AS old_share_rows NEW TABLE AS new_share_rows FOR EACH STATEMENT EXECUTE FUNCTION public.refresh_file_link_share_state();


--
-- Name: share_links share_links_legacy_token_rotation_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER share_links_legacy_token_rotation_guard BEFORE UPDATE OF token_hash, token_version ON public.share_links FOR EACH ROW EXECUTE FUNCTION public.guard_share_link_legacy_token_rotation();


--
-- Name: share_links share_links_tree_operation_write_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER share_links_tree_operation_write_guard BEFORE INSERT OR DELETE OR UPDATE ON public.share_links FOR EACH ROW EXECUTE FUNCTION public.guard_tree_operation_related_write('root_file_id');


--
-- Name: users sync_trash_retention_units; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER sync_trash_retention_units BEFORE INSERT OR UPDATE OF trash_retention_days, trash_retention_minutes ON public.users FOR EACH ROW EXECUTE FUNCTION public.sync_trash_retention_units();


--
-- Name: tree_operation_jobs tree_operation_publish_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER tree_operation_publish_guard BEFORE INSERT OR UPDATE ON public.tree_operation_jobs FOR EACH ROW EXECUTE FUNCTION public.publish_tree_operation();


--
-- Name: vault_migrations tree_operation_write_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER tree_operation_write_guard BEFORE INSERT OR DELETE OR UPDATE ON public.vault_migrations FOR EACH ROW EXECUTE FUNCTION public.guard_tree_operation_related_write('node_id');


--
-- Name: vault_node_heads tree_operation_write_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER tree_operation_write_guard BEFORE INSERT OR DELETE OR UPDATE ON public.vault_node_heads FOR EACH ROW EXECUTE FUNCTION public.guard_tree_operation_related_write('node_id');


--
-- Name: vault_node_records tree_operation_write_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER tree_operation_write_guard BEFORE INSERT OR DELETE OR UPDATE ON public.vault_node_records FOR EACH ROW EXECUTE FUNCTION public.guard_tree_operation_related_write('node_id');


--
-- Name: vault_object_generations tree_operation_write_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER tree_operation_write_guard BEFORE INSERT OR DELETE OR UPDATE ON public.vault_object_generations FOR EACH ROW EXECUTE FUNCTION public.guard_tree_operation_related_write('node_id');


--
-- Name: vault_revocation_cutoffs tree_operation_write_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER tree_operation_write_guard BEFORE INSERT OR DELETE OR UPDATE ON public.vault_revocation_cutoffs FOR EACH ROW EXECUTE FUNCTION public.guard_tree_operation_related_write('node_id', 'tree_share_root_id');


--
-- Name: vault_share_envelopes tree_operation_write_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER tree_operation_write_guard BEFORE INSERT OR DELETE OR UPDATE ON public.vault_share_envelopes FOR EACH ROW EXECUTE FUNCTION public.guard_tree_operation_related_write('node_id', 'tree_share_root_id');


--
-- Name: vault_share_epochs tree_operation_write_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER tree_operation_write_guard BEFORE INSERT OR DELETE OR UPDATE ON public.vault_share_epochs FOR EACH ROW EXECUTE FUNCTION public.guard_tree_operation_related_write('node_id', 'tree_share_root_id');


--
-- Name: vault_share_owner_keys tree_operation_write_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER tree_operation_write_guard BEFORE INSERT OR DELETE OR UPDATE ON public.vault_share_owner_keys FOR EACH ROW EXECUTE FUNCTION public.guard_tree_operation_related_write('node_id', 'tree_share_root_id');


--
-- Name: vault_share_pending_revocations tree_operation_write_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER tree_operation_write_guard BEFORE INSERT OR DELETE OR UPDATE ON public.vault_share_pending_revocations FOR EACH ROW EXECUTE FUNCTION public.guard_tree_operation_related_write('node_id', 'tree_share_root_id');


--
-- Name: vault_share_recipients tree_operation_write_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER tree_operation_write_guard BEFORE INSERT OR DELETE OR UPDATE ON public.vault_share_recipients FOR EACH ROW EXECUTE FUNCTION public.guard_tree_operation_related_write('node_id', 'tree_share_root_id');


--
-- Name: vault_share_sync_jobs tree_operation_write_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER tree_operation_write_guard BEFORE INSERT OR DELETE OR UPDATE ON public.vault_share_sync_jobs FOR EACH ROW EXECUTE FUNCTION public.guard_tree_operation_related_write('node_id');


--
-- Name: vault_share_wrapper_directories tree_operation_write_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER tree_operation_write_guard BEFORE INSERT OR DELETE OR UPDATE ON public.vault_share_wrapper_directories FOR EACH ROW EXECUTE FUNCTION public.guard_tree_operation_related_write('node_id');


--
-- Name: vault_share_wrappers tree_operation_write_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER tree_operation_write_guard BEFORE INSERT OR DELETE OR UPDATE ON public.vault_share_wrappers FOR EACH ROW EXECUTE FUNCTION public.guard_tree_operation_related_write('node_id', 'tree_share_root_id');


--
-- Name: vault_wrappers tree_operation_write_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER tree_operation_write_guard BEFORE INSERT OR DELETE OR UPDATE ON public.vault_wrappers FOR EACH ROW EXECUTE FUNCTION public.guard_tree_operation_related_write('node_id', 'parent_node_id');


--
-- Name: user_file_counters user_file_counters_tree_operation_delta; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER user_file_counters_tree_operation_delta AFTER INSERT OR UPDATE ON public.user_file_counters FOR EACH ROW EXECUTE FUNCTION public.capture_tree_operation_counter_delta();


--
-- Name: users users_admin_counter_delete; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER users_admin_counter_delete AFTER DELETE ON public.users FOR EACH ROW EXECUTE FUNCTION public.update_admin_user_counters();


--
-- Name: users users_admin_counter_insert; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER users_admin_counter_insert AFTER INSERT ON public.users FOR EACH ROW EXECUTE FUNCTION public.update_admin_user_counters();


--
-- Name: users users_admin_counter_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER users_admin_counter_update AFTER UPDATE OF role, status ON public.users FOR EACH ROW WHEN (((((old.status <> 'deleting'::text) IS DISTINCT FROM (new.status <> 'deleting'::text)) OR ((old.status = 'active'::text) IS DISTINCT FROM (new.status = 'active'::text))) OR (((old.status = 'active'::text) AND (old.role = 'admin'::text)) IS DISTINCT FROM ((new.status = 'active'::text) AND (new.role = 'admin'::text))))) EXECUTE FUNCTION public.update_admin_user_counters();


--
-- Name: users users_file_counter_insert; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER users_file_counter_insert AFTER INSERT ON public.users FOR EACH ROW EXECUTE FUNCTION public.ensure_user_file_counter();


--
-- Name: users users_storage_usage_insert; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER users_storage_usage_insert AFTER INSERT ON public.users FOR EACH ROW EXECUTE FUNCTION public.ensure_user_storage_usage();


--
-- Name: users users_tree_operation_owner_insert; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER users_tree_operation_owner_insert AFTER INSERT ON public.users FOR EACH ROW EXECUTE FUNCTION public.ensure_tree_operation_owner();


--
-- Name: vault_migration_node_progress vault_migration_progress_delete; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER vault_migration_progress_delete AFTER DELETE ON public.vault_migration_node_progress REFERENCING OLD TABLE AS old_progress FOR EACH STATEMENT EXECUTE FUNCTION public.delete_vault_migration_progress();


--
-- Name: vault_migration_node_progress vault_migration_progress_insert; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER vault_migration_progress_insert AFTER INSERT ON public.vault_migration_node_progress REFERENCING NEW TABLE AS new_progress FOR EACH STATEMENT EXECUTE FUNCTION public.insert_vault_migration_progress();


--
-- Name: vault_migration_node_progress vault_migration_progress_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER vault_migration_progress_update AFTER UPDATE ON public.vault_migration_node_progress REFERENCING OLD TABLE AS old_progress NEW TABLE AS new_progress FOR EACH STATEMENT EXECUTE FUNCTION public.change_vault_migration_progress();


--
-- Name: vault_migrations vault_migrations_progress_delete; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER vault_migrations_progress_delete AFTER DELETE ON public.vault_migrations REFERENCING OLD TABLE AS old_migrations FOR EACH STATEMENT EXECUTE FUNCTION public.track_vault_migration_progress();


--
-- Name: vault_migrations vault_migrations_progress_insert; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER vault_migrations_progress_insert AFTER INSERT ON public.vault_migrations REFERENCING NEW TABLE AS new_migrations FOR EACH STATEMENT EXECUTE FUNCTION public.track_vault_migration_progress();


--
-- Name: vault_migrations vault_migrations_progress_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER vault_migrations_progress_update AFTER UPDATE ON public.vault_migrations REFERENCING OLD TABLE AS old_migrations NEW TABLE AS new_migrations FOR EACH STATEMENT EXECUTE FUNCTION public.track_vault_migration_progress();


--
-- Name: vault_share_envelopes vault_share_envelope_epoch_guard_insert; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER vault_share_envelope_epoch_guard_insert AFTER INSERT ON public.vault_share_envelopes REFERENCING NEW TABLE AS new_share_writes FOR EACH STATEMENT EXECUTE FUNCTION public.enforce_vault_share_epoch_write();


--
-- Name: vault_share_envelopes vault_share_envelope_epoch_guard_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER vault_share_envelope_epoch_guard_update AFTER UPDATE ON public.vault_share_envelopes REFERENCING NEW TABLE AS new_share_writes FOR EACH STATEMENT EXECUTE FUNCTION public.enforce_vault_share_epoch_write();


--
-- Name: vault_share_wrappers vault_share_wrapper_epoch_guard_insert; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER vault_share_wrapper_epoch_guard_insert AFTER INSERT ON public.vault_share_wrappers REFERENCING NEW TABLE AS new_share_writes FOR EACH STATEMENT EXECUTE FUNCTION public.enforce_vault_share_epoch_write();


--
-- Name: vault_share_wrappers vault_share_wrapper_epoch_guard_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER vault_share_wrapper_epoch_guard_update AFTER UPDATE ON public.vault_share_wrappers REFERENCING NEW TABLE AS new_share_writes FOR EACH STATEMENT EXECUTE FUNCTION public.enforce_vault_share_epoch_write();


--
-- Name: vault_shares vault_shares_file_state_delete; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER vault_shares_file_state_delete AFTER DELETE ON public.vault_shares REFERENCING OLD TABLE AS old_share_rows FOR EACH STATEMENT EXECUTE FUNCTION public.update_file_vault_share_state();


--
-- Name: vault_shares vault_shares_file_state_insert; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER vault_shares_file_state_insert AFTER INSERT ON public.vault_shares REFERENCING NEW TABLE AS new_share_rows FOR EACH STATEMENT EXECUTE FUNCTION public.update_file_vault_share_state();


--
-- Name: vault_shares vault_shares_file_state_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER vault_shares_file_state_update AFTER UPDATE ON public.vault_shares REFERENCING OLD TABLE AS old_share_rows NEW TABLE AS new_share_rows FOR EACH STATEMENT EXECUTE FUNCTION public.update_file_vault_share_state();


--
-- Name: vault_shares vault_shares_tree_operation_write_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER vault_shares_tree_operation_write_guard BEFORE INSERT OR DELETE OR UPDATE ON public.vault_shares FOR EACH ROW EXECUTE FUNCTION public.guard_tree_operation_related_write('root_node_id');


--
-- Name: vault_uploads vault_upload_reservation_delete; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER vault_upload_reservation_delete AFTER DELETE ON public.vault_uploads REFERENCING OLD TABLE AS old_vault_upload_rows FOR EACH STATEMENT EXECUTE FUNCTION public.delete_vault_upload_reservations();


--
-- Name: vault_uploads vault_upload_reservation_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER vault_upload_reservation_immutable BEFORE UPDATE OF owner_id, reservation_bytes ON public.vault_uploads FOR EACH ROW EXECUTE FUNCTION public.prevent_upload_reservation_rewrite();


--
-- Name: vault_uploads vault_upload_reservation_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER vault_upload_reservation_update AFTER UPDATE ON public.vault_uploads REFERENCING OLD TABLE AS old_vault_upload_rows NEW TABLE AS new_vault_upload_rows FOR EACH STATEMENT EXECUTE FUNCTION public.update_vault_upload_reservations();


--
-- Name: vault_uploads vault_uploads_tree_operation_write_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER vault_uploads_tree_operation_write_guard BEFORE INSERT OR DELETE OR UPDATE ON public.vault_uploads FOR EACH ROW EXECUTE FUNCTION public.guard_tree_operation_related_write('node_id', 'parent_id');


--
-- Name: file_shares file_shares_file_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.file_shares
    ADD CONSTRAINT file_shares_file_id_fkey FOREIGN KEY (file_id) REFERENCES public.files(id) ON DELETE CASCADE;


--
-- Name: file_shares file_shares_owner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.file_shares
    ADD CONSTRAINT file_shares_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: file_shares file_shares_recipient_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.file_shares
    ADD CONSTRAINT file_shares_recipient_id_fkey FOREIGN KEY (recipient_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: file_uploads file_uploads_owner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.file_uploads
    ADD CONSTRAINT file_uploads_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: file_uploads file_uploads_parent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.file_uploads
    ADD CONSTRAINT file_uploads_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES public.files(id) ON DELETE SET NULL;


--
-- Name: file_uploads file_uploads_replacement_file_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.file_uploads
    ADD CONSTRAINT file_uploads_replacement_file_id_fkey FOREIGN KEY (replacement_file_id) REFERENCES public.files(id) ON DELETE SET NULL;


--
-- Name: file_uploads file_uploads_share_link_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.file_uploads
    ADD CONSTRAINT file_uploads_share_link_id_fkey FOREIGN KEY (share_link_id) REFERENCES public.share_links(id) ON DELETE SET NULL;


--
-- Name: files files_owner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.files
    ADD CONSTRAINT files_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: files files_parent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.files
    ADD CONSTRAINT files_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES public.files(id) ON DELETE CASCADE;


--
-- Name: invitations invitations_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invitations
    ADD CONSTRAINT invitations_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: repositories repositories_owner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.repositories
    ADD CONSTRAINT repositories_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: repositories repositories_root_file_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.repositories
    ADD CONSTRAINT repositories_root_file_id_fkey FOREIGN KEY (root_file_id) REFERENCES public.files(id) ON DELETE CASCADE;


--
-- Name: repository_archive_entries repository_archive_entries_manifest_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.repository_archive_entries
    ADD CONSTRAINT repository_archive_entries_manifest_id_fkey FOREIGN KEY (manifest_id) REFERENCES public.repository_archive_manifests(id) ON DELETE CASCADE;


--
-- Name: repository_archive_manifests repository_archive_manifests_owner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.repository_archive_manifests
    ADD CONSTRAINT repository_archive_manifests_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: repository_archive_manifests repository_archive_manifests_repository_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.repository_archive_manifests
    ADD CONSTRAINT repository_archive_manifests_repository_id_fkey FOREIGN KEY (repository_id) REFERENCES public.repositories(id) ON DELETE CASCADE;


--
-- Name: repository_pending_changes repository_pending_changes_repository_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.repository_pending_changes
    ADD CONSTRAINT repository_pending_changes_repository_id_fkey FOREIGN KEY (repository_id) REFERENCES public.repositories(id) ON DELETE CASCADE;


--
-- Name: repository_revision_shards repository_revision_shards_repository_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.repository_revision_shards
    ADD CONSTRAINT repository_revision_shards_repository_id_fkey FOREIGN KEY (repository_id) REFERENCES public.repositories(id) ON DELETE CASCADE;


--
-- Name: sessions sessions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: share_links share_links_owner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.share_links
    ADD CONSTRAINT share_links_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: share_links share_links_recipient_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.share_links
    ADD CONSTRAINT share_links_recipient_id_fkey FOREIGN KEY (recipient_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: share_links share_links_root_file_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.share_links
    ADD CONSTRAINT share_links_root_file_id_fkey FOREIGN KEY (root_file_id) REFERENCES public.files(id) ON DELETE CASCADE;


--
-- Name: trash_expiry_owners trash_expiry_owners_owner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trash_expiry_owners
    ADD CONSTRAINT trash_expiry_owners_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: tree_operation_counter_deltas tree_operation_counter_deltas_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tree_operation_counter_deltas
    ADD CONSTRAINT tree_operation_counter_deltas_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.tree_operation_jobs(id) ON DELETE CASCADE;


--
-- Name: tree_operation_counter_deltas tree_operation_counter_deltas_owner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tree_operation_counter_deltas
    ADD CONSTRAINT tree_operation_counter_deltas_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: tree_operation_jobs tree_operation_jobs_owner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tree_operation_jobs
    ADD CONSTRAINT tree_operation_jobs_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: tree_operation_nodes tree_operation_nodes_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tree_operation_nodes
    ADD CONSTRAINT tree_operation_nodes_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.tree_operation_jobs(id) ON DELETE CASCADE;


--
-- Name: tree_operation_owners tree_operation_owners_owner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tree_operation_owners
    ADD CONSTRAINT tree_operation_owners_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: user_deletion_jobs user_deletion_jobs_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_deletion_jobs
    ADD CONSTRAINT user_deletion_jobs_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: user_file_counters user_file_counters_owner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_file_counters
    ADD CONSTRAINT user_file_counters_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: user_storage_usage user_storage_usage_owner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_storage_usage
    ADD CONSTRAINT user_storage_usage_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: user_vaults user_vaults_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_vaults
    ADD CONSTRAINT user_vaults_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: vault_identity_keys vault_identity_keys_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vault_identity_keys
    ADD CONSTRAINT vault_identity_keys_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: vault_identity_trust vault_identity_trust_peer_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vault_identity_trust
    ADD CONSTRAINT vault_identity_trust_peer_user_id_fkey FOREIGN KEY (peer_user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: vault_identity_trust vault_identity_trust_peer_user_id_peer_key_version_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vault_identity_trust
    ADD CONSTRAINT vault_identity_trust_peer_user_id_peer_key_version_fkey FOREIGN KEY (peer_user_id, peer_key_version) REFERENCES public.vault_identity_keys(user_id, key_version) ON DELETE CASCADE;


--
-- Name: vault_identity_trust vault_identity_trust_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vault_identity_trust
    ADD CONSTRAINT vault_identity_trust_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: vault_migration_node_progress vault_migration_node_progress_owner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vault_migration_node_progress
    ADD CONSTRAINT vault_migration_node_progress_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: vault_migration_progress vault_migration_progress_owner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vault_migration_progress
    ADD CONSTRAINT vault_migration_progress_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: vault_migrations vault_migrations_node_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vault_migrations
    ADD CONSTRAINT vault_migrations_node_id_fkey FOREIGN KEY (node_id) REFERENCES public.files(id) ON DELETE CASCADE;


--
-- Name: vault_migrations vault_migrations_owner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vault_migrations
    ADD CONSTRAINT vault_migrations_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: vault_node_heads vault_node_heads_node_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vault_node_heads
    ADD CONSTRAINT vault_node_heads_node_id_fkey FOREIGN KEY (node_id) REFERENCES public.files(id) ON DELETE CASCADE;


--
-- Name: vault_node_heads vault_node_heads_node_id_record_version_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vault_node_heads
    ADD CONSTRAINT vault_node_heads_node_id_record_version_fkey FOREIGN KEY (node_id, record_version) REFERENCES public.vault_node_records(node_id, record_version);


--
-- Name: vault_node_heads vault_node_heads_owner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vault_node_heads
    ADD CONSTRAINT vault_node_heads_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: vault_node_records vault_node_records_node_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vault_node_records
    ADD CONSTRAINT vault_node_records_node_id_fkey FOREIGN KEY (node_id) REFERENCES public.files(id) ON DELETE CASCADE;


--
-- Name: vault_node_records vault_node_records_owner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vault_node_records
    ADD CONSTRAINT vault_node_records_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: vault_node_records vault_node_records_owner_id_signer_key_version_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vault_node_records
    ADD CONSTRAINT vault_node_records_owner_id_signer_key_version_fkey FOREIGN KEY (owner_id, signer_key_version) REFERENCES public.vault_identity_keys(user_id, key_version);


--
-- Name: vault_object_generations vault_object_generations_node_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vault_object_generations
    ADD CONSTRAINT vault_object_generations_node_id_fkey FOREIGN KEY (node_id) REFERENCES public.files(id) ON DELETE CASCADE;


--
-- Name: vault_object_generations vault_object_generations_owner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vault_object_generations
    ADD CONSTRAINT vault_object_generations_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: vault_revocation_cutoffs vault_revocation_cutoffs_revoked_recipient_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vault_revocation_cutoffs
    ADD CONSTRAINT vault_revocation_cutoffs_revoked_recipient_id_fkey FOREIGN KEY (revoked_recipient_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: vault_revocation_cutoffs vault_revocation_cutoffs_share_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vault_revocation_cutoffs
    ADD CONSTRAINT vault_revocation_cutoffs_share_id_fkey FOREIGN KEY (share_id) REFERENCES public.vault_shares(id) ON DELETE CASCADE;


--
-- Name: vault_share_envelopes vault_share_envelopes_node_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vault_share_envelopes
    ADD CONSTRAINT vault_share_envelopes_node_id_fkey FOREIGN KEY (node_id) REFERENCES public.files(id) ON DELETE CASCADE;


--
-- Name: vault_share_envelopes vault_share_envelopes_recipient_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vault_share_envelopes
    ADD CONSTRAINT vault_share_envelopes_recipient_id_fkey FOREIGN KEY (recipient_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: vault_share_envelopes vault_share_envelopes_recipient_id_recipient_key_version_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vault_share_envelopes
    ADD CONSTRAINT vault_share_envelopes_recipient_id_recipient_key_version_fkey FOREIGN KEY (recipient_id, recipient_key_version) REFERENCES public.vault_identity_keys(user_id, key_version);


--
-- Name: vault_share_envelopes vault_share_envelopes_sender_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vault_share_envelopes
    ADD CONSTRAINT vault_share_envelopes_sender_id_fkey FOREIGN KEY (sender_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: vault_share_envelopes vault_share_envelopes_sender_id_sender_key_version_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vault_share_envelopes
    ADD CONSTRAINT vault_share_envelopes_sender_id_sender_key_version_fkey FOREIGN KEY (sender_id, sender_key_version) REFERENCES public.vault_identity_keys(user_id, key_version);


--
-- Name: vault_share_envelopes vault_share_envelopes_share_id_epoch_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vault_share_envelopes
    ADD CONSTRAINT vault_share_envelopes_share_id_epoch_fkey FOREIGN KEY (share_id, epoch) REFERENCES public.vault_share_epochs(share_id, epoch);


--
-- Name: vault_share_epochs vault_share_epochs_share_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vault_share_epochs
    ADD CONSTRAINT vault_share_epochs_share_id_fkey FOREIGN KEY (share_id) REFERENCES public.vault_shares(id) ON DELETE CASCADE;


--
-- Name: vault_share_owner_keys vault_share_owner_keys_share_id_epoch_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vault_share_owner_keys
    ADD CONSTRAINT vault_share_owner_keys_share_id_epoch_fkey FOREIGN KEY (share_id, epoch) REFERENCES public.vault_share_epochs(share_id, epoch) ON DELETE CASCADE;


--
-- Name: vault_share_pending_revocations vault_share_pending_revocations_recipient_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vault_share_pending_revocations
    ADD CONSTRAINT vault_share_pending_revocations_recipient_id_fkey FOREIGN KEY (recipient_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: vault_share_pending_revocations vault_share_pending_revocations_share_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vault_share_pending_revocations
    ADD CONSTRAINT vault_share_pending_revocations_share_id_fkey FOREIGN KEY (share_id) REFERENCES public.vault_shares(id) ON DELETE CASCADE;


--
-- Name: vault_share_recipients vault_share_recipients_recipient_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vault_share_recipients
    ADD CONSTRAINT vault_share_recipients_recipient_id_fkey FOREIGN KEY (recipient_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: vault_share_recipients vault_share_recipients_recipient_id_recipient_key_version_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vault_share_recipients
    ADD CONSTRAINT vault_share_recipients_recipient_id_recipient_key_version_fkey FOREIGN KEY (recipient_id, recipient_key_version) REFERENCES public.vault_identity_keys(user_id, key_version);


--
-- Name: vault_share_recipients vault_share_recipients_share_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vault_share_recipients
    ADD CONSTRAINT vault_share_recipients_share_id_fkey FOREIGN KEY (share_id) REFERENCES public.vault_shares(id) ON DELETE CASCADE;


--
-- Name: vault_share_sync_jobs vault_share_sync_jobs_node_id_record_version_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vault_share_sync_jobs
    ADD CONSTRAINT vault_share_sync_jobs_node_id_record_version_fkey FOREIGN KEY (node_id, record_version) REFERENCES public.vault_node_records(node_id, record_version) ON DELETE CASCADE;


--
-- Name: vault_share_sync_jobs vault_share_sync_jobs_owner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vault_share_sync_jobs
    ADD CONSTRAINT vault_share_sync_jobs_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: vault_share_wrapper_directories vault_share_wrapper_directorie_owner_id_signer_key_version_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vault_share_wrapper_directories
    ADD CONSTRAINT vault_share_wrapper_directorie_owner_id_signer_key_version_fkey FOREIGN KEY (owner_id, signer_key_version) REFERENCES public.vault_identity_keys(user_id, key_version);


--
-- Name: vault_share_wrapper_directories vault_share_wrapper_directories_node_id_record_version_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vault_share_wrapper_directories
    ADD CONSTRAINT vault_share_wrapper_directories_node_id_record_version_fkey FOREIGN KEY (node_id, record_version) REFERENCES public.vault_node_records(node_id, record_version) ON DELETE CASCADE;


--
-- Name: vault_share_wrapper_directories vault_share_wrapper_directories_owner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vault_share_wrapper_directories
    ADD CONSTRAINT vault_share_wrapper_directories_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: vault_share_wrappers vault_share_wrappers_node_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vault_share_wrappers
    ADD CONSTRAINT vault_share_wrappers_node_id_fkey FOREIGN KEY (node_id) REFERENCES public.files(id) ON DELETE CASCADE;


--
-- Name: vault_share_wrappers vault_share_wrappers_share_id_epoch_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vault_share_wrappers
    ADD CONSTRAINT vault_share_wrappers_share_id_epoch_fkey FOREIGN KEY (share_id, epoch) REFERENCES public.vault_share_epochs(share_id, epoch);


--
-- Name: vault_shares vault_shares_owner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vault_shares
    ADD CONSTRAINT vault_shares_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: vault_shares vault_shares_root_node_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vault_shares
    ADD CONSTRAINT vault_shares_root_node_id_fkey FOREIGN KEY (root_node_id) REFERENCES public.files(id) ON DELETE CASCADE;


--
-- Name: vault_uploads vault_uploads_owner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vault_uploads
    ADD CONSTRAINT vault_uploads_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: vault_uploads vault_uploads_parent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vault_uploads
    ADD CONSTRAINT vault_uploads_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES public.files(id) ON DELETE CASCADE;


--
-- Name: vault_wrappers vault_wrappers_node_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vault_wrappers
    ADD CONSTRAINT vault_wrappers_node_id_fkey FOREIGN KEY (node_id) REFERENCES public.files(id) ON DELETE CASCADE;


--
-- Name: vault_wrappers vault_wrappers_owner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vault_wrappers
    ADD CONSTRAINT vault_wrappers_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: vault_wrappers vault_wrappers_parent_node_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vault_wrappers
    ADD CONSTRAINT vault_wrappers_parent_node_id_fkey FOREIGN KEY (parent_node_id) REFERENCES public.files(id) ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--

\unrestrict cqKPS4mDB2oph8CTQPaiTqWnRkbmCUJccfMudEXubfXu4tUnaEEr2iNsEHHFrKP

