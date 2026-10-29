\set ON_ERROR_STOP on
BEGIN;
CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
SELECT pg_advisory_xact_lock(hashtextextended('aeralyth:migration:039-trashed-parent-child-counts', 0));
SELECT NOT EXISTS (
  SELECT 1 FROM schema_migrations WHERE version = '039-trashed-parent-child-counts'
) AS apply_migration \gset
\if :apply_migration

-- trash_child_count only feeds the trashed-leaf expiry index, whose predicate
-- requires state = 'trashed'. Maintaining it on active parents rewrote the
-- parent row on every child insert, delete and move. trash_child_count is in
-- that index predicate, so those rewrites were never HOT: each one touched
-- every files index and re-ran every files statement trigger.
--
-- The count is now exact only while a row is trashed:
-- * child edge changes adjust trashed parents only;
-- * a folder that becomes trashed is recounted in the same statement;
-- * a restored folder keeps a stale value until it is trashed again.
--
-- A folder's state change holds its exclusive parent-lifecycle lock (see the
-- 029 write guard). Edge writers take the shared side before adjusting
-- parents, so a parent is either recounted after an edge commits or adjusted
-- by that edge after the parent is trashed, never neither. The recount reads
-- a fresh READ COMMITTED snapshot. The application changes tree state only in
-- READ COMMITTED transactions under the owner's exclusive tree-operation lock.

-- Edge writers usually touch active parents only. An indexed probe on the
-- distinct parent ids lets them skip the counter UPDATE, whose join against an
-- unanalyzed transition table otherwise dominates a single-file insert.
-- parent_ids must be distinct. Shared locks never wait on each other and
-- lifecycle writers only try-lock, so acquisition order cannot deadlock.
CREATE FUNCTION adjust_trashed_parent_counts(parent_ids TEXT[], deltas BIGINT[]) RETURNS VOID
LANGUAGE plpgsql AS $$
BEGIN
  -- PERFORM runs to completion; a VOID SQL function would stop at one row.
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('aeralyth:file-parent-lifecycle:' || parent_id, 0))
  FROM unnest(parent_ids) AS parent_id;
  -- A separate statement takes a fresh READ COMMITTED snapshot after the locks.
  IF EXISTS (SELECT 1 FROM files WHERE id = ANY(parent_ids) AND state = 'trashed') THEN
    UPDATE files AS parents SET trash_child_count = parents.trash_child_count + delta.count
    FROM unnest(parent_ids, deltas) AS delta(parent_id, count)
    WHERE parents.id = ANY(parent_ids) AND parents.id = delta.parent_id AND parents.state = 'trashed';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION maintain_trash_expiry_insert() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE parent_ids TEXT[]; deltas BIGINT[]; trashed_owners TEXT[];
BEGIN
  SELECT array_agg(parent_id ORDER BY parent_id), array_agg(count ORDER BY parent_id) INTO parent_ids, deltas
  FROM (SELECT parent_id, count(*) AS count FROM trash_new WHERE parent_id IS NOT NULL GROUP BY parent_id) AS children;
  IF parent_ids IS NOT NULL THEN
    PERFORM adjust_trashed_parent_counts(parent_ids, deltas);
  END IF;
  SELECT array_agg(DISTINCT owner_id) INTO trashed_owners
  FROM trash_new WHERE state = 'trashed' AND trashed_at IS NOT NULL;
  IF trashed_owners IS NOT NULL THEN
    PERFORM refresh_trash_expiry_owners(trashed_owners);
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION maintain_trash_expiry_delete() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE parent_ids TEXT[]; deltas BIGINT[]; trashed_owners TEXT[];
BEGIN
  SELECT array_agg(parent_id ORDER BY parent_id), array_agg(-count ORDER BY parent_id) INTO parent_ids, deltas
  FROM (SELECT parent_id, count(*) AS count FROM trash_old WHERE parent_id IS NOT NULL GROUP BY parent_id) AS children;
  IF parent_ids IS NOT NULL THEN
    PERFORM adjust_trashed_parent_counts(parent_ids, deltas);
  END IF;
  SELECT array_agg(DISTINCT owner_id) INTO trashed_owners
  FROM trash_old WHERE state = 'trashed' AND trashed_at IS NOT NULL;
  IF trashed_owners IS NOT NULL THEN
    PERFORM refresh_trash_expiry_owners(trashed_owners);
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION maintain_trash_expiry_update() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE affected_owners TEXT[]; parent_ids TEXT[]; deltas BIGINT[]; newly_trashed TEXT[];
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
  SELECT array_agg(parent_id ORDER BY parent_id), array_agg(count ORDER BY parent_id) INTO parent_ids, deltas
  FROM (
    SELECT parent_id, sum(count)::bigint AS count FROM (
      SELECT parent_id, -1::bigint AS count FROM trash_old WHERE parent_id IS NOT NULL
      UNION ALL
      SELECT parent_id, 1::bigint FROM trash_new WHERE parent_id IS NOT NULL
    ) AS changes GROUP BY parent_id HAVING sum(count) <> 0
  ) AS delta;
  IF parent_ids IS NOT NULL THEN
    PERFORM adjust_trashed_parent_counts(parent_ids, deltas);
  END IF;

  -- Active folders do not track children, so a folder entering the trash is
  -- counted from scratch. Its own lifecycle lock is already held exclusively.
  SELECT array_agg(id) INTO newly_trashed FROM (
    SELECT id FROM trash_new WHERE state = 'trashed' AND entry_type = 'folder'
    EXCEPT SELECT id FROM trash_old WHERE state = 'trashed'
  ) AS entering;
  IF newly_trashed IS NOT NULL THEN
    UPDATE files AS folders SET trash_child_count = recount.count
    FROM (
      SELECT entering.id, (SELECT count(*) FROM files AS children WHERE children.parent_id = entering.id) AS count
      FROM unnest(newly_trashed) AS entering(id)
    ) AS recount
    WHERE folders.id = ANY(newly_trashed) AND folders.id = recount.id AND folders.state = 'trashed'
      AND folders.trash_child_count <> recount.count;
    affected_owners := ARRAY(
      SELECT DISTINCT owner_id FROM (
        SELECT unnest(affected_owners) AS owner_id
        UNION ALL SELECT owner_id FROM trash_new WHERE id = ANY(newly_trashed)
      ) AS owners WHERE owner_id IS NOT NULL
    );
  END IF;
  IF cardinality(affected_owners) > 0 THEN
    PERFORM refresh_trash_expiry_owners(affected_owners);
  END IF;
  RETURN NULL;
END;
$$;

INSERT INTO schema_migrations (version) VALUES ('039-trashed-parent-child-counts');
\else
\echo 'Skipping already-applied migration 039-trashed-parent-child-counts'
\endif
COMMIT;
