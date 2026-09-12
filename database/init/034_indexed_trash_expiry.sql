\set ON_ERROR_STOP on
BEGIN;
CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
SELECT pg_advisory_xact_lock(hashtextextended('aeralyth:migration:034-indexed-trash-expiry', 0));
SELECT NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = '034-indexed-trash-expiry') AS apply_migration \gset
\if :apply_migration

-- Count direct children only. Arithmetic statement deltas serialize the last
-- concurrent child removals, so an empty parent cannot miss expiry promotion.
ALTER TABLE files ADD COLUMN trash_child_count BIGINT NOT NULL DEFAULT 0
  CHECK (trash_child_count >= 0);
UPDATE files AS parents SET trash_child_count = children.count
FROM (SELECT parent_id, count(*) AS count FROM files WHERE parent_id IS NOT NULL GROUP BY parent_id) AS children
WHERE parents.id = children.parent_id;
CREATE INDEX files_trash_leaf_owner_due_idx
  ON files (owner_id, trashed_at, id)
  WHERE state = 'trashed' AND trashed_at IS NOT NULL AND trash_child_count = 0;
CREATE TABLE trash_expiry_owners (
  owner_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  next_due_at TIMESTAMPTZ
);
CREATE INDEX trash_expiry_owners_due_idx ON trash_expiry_owners (next_due_at, owner_id)
  WHERE next_due_at IS NOT NULL;
INSERT INTO trash_expiry_owners (owner_id) SELECT id FROM users;

CREATE FUNCTION refresh_trash_expiry_owners(owner_ids TEXT[]) RETURNS VOID
LANGUAGE plpgsql AS $$
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

CREATE FUNCTION maintain_trash_expiry_insert() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  UPDATE files AS parents SET trash_child_count = parents.trash_child_count + children.count
  FROM (SELECT parent_id, count(*) AS count FROM trash_new WHERE parent_id IS NOT NULL GROUP BY parent_id) AS children
  WHERE parents.id = children.parent_id;
  PERFORM refresh_trash_expiry_owners(ARRAY(SELECT DISTINCT owner_id FROM trash_new WHERE state = 'trashed' AND trashed_at IS NOT NULL));
  RETURN NULL;
END;
$$;
CREATE FUNCTION maintain_trash_expiry_delete() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  UPDATE files AS parents SET trash_child_count = parents.trash_child_count - children.count
  FROM (SELECT parent_id, count(*) AS count FROM trash_old WHERE parent_id IS NOT NULL GROUP BY parent_id) AS children
  WHERE parents.id = children.parent_id;
  PERFORM refresh_trash_expiry_owners(ARRAY(SELECT DISTINCT owner_id FROM trash_old WHERE state = 'trashed' AND trashed_at IS NOT NULL));
  RETURN NULL;
END;
$$;
CREATE FUNCTION maintain_trash_expiry_update() RETURNS TRIGGER LANGUAGE plpgsql AS $$
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
CREATE TRIGGER maintain_trash_expiry_insert AFTER INSERT ON files
  REFERENCING NEW TABLE AS trash_new FOR EACH STATEMENT EXECUTE FUNCTION maintain_trash_expiry_insert();
CREATE TRIGGER maintain_trash_expiry_update AFTER UPDATE ON files
  REFERENCING OLD TABLE AS trash_old NEW TABLE AS trash_new FOR EACH STATEMENT EXECUTE FUNCTION maintain_trash_expiry_update();
CREATE TRIGGER maintain_trash_expiry_delete AFTER DELETE ON files
  REFERENCING OLD TABLE AS trash_old FOR EACH STATEMENT EXECUTE FUNCTION maintain_trash_expiry_delete();

CREATE FUNCTION maintain_trash_expiry_policy() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO trash_expiry_owners (owner_id) VALUES (NEW.id) ON CONFLICT DO NOTHING;
  ELSIF NEW.trash_retention_minutes IS DISTINCT FROM OLD.trash_retention_minutes THEN
    PERFORM refresh_trash_expiry_owners(ARRAY[NEW.id]);
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER maintain_trash_expiry_policy AFTER INSERT OR UPDATE OF trash_retention_minutes, trash_retention_days
  ON users FOR EACH ROW EXECUTE FUNCTION maintain_trash_expiry_policy();
SELECT refresh_trash_expiry_owners(ARRAY(SELECT id FROM users));

CREATE FUNCTION expire_trash_batch(batch_size INTEGER) RETURNS BIGINT LANGUAGE plpgsql AS $$
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

-- Match the existing lease-aware next-due expressions in the other queues.
CREATE INDEX user_deletion_jobs_next_due_idx
  ON user_deletion_jobs ((GREATEST(available_at, COALESCE(locked_until, available_at)))) WHERE dead_lettered_at IS NULL;
CREATE INDEX storage_deletion_jobs_next_due_idx
  ON storage_deletion_jobs ((GREATEST(available_at, COALESCE(locked_until, available_at)))) WHERE dead_lettered_at IS NULL;
CREATE INDEX file_uploads_completion_next_due_idx
  ON file_uploads ((GREATEST(completion_available_at, COALESCE(completion_locked_until, completion_available_at))))
  WHERE status = 'completing' AND completion_dead_lettered_at IS NULL;
-- PostgreSQL expands SELECT * when a view is defined. Append this migration's
-- derived column without dropping the read fence or changing earlier columns.
CREATE OR REPLACE VIEW visible_files AS SELECT * FROM files WHERE tree_operation_visible(id, owner_id);
INSERT INTO schema_migrations (version) VALUES ('034-indexed-trash-expiry');
\else
\echo 'Skipping already-applied migration 034-indexed-trash-expiry'
\endif
COMMIT;
