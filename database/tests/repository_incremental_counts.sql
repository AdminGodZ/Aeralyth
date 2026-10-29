\set ON_ERROR_STOP on
-- Incremental repository counts must equal the full recount walk after any
-- sequence of committed changes. Run with psql outside a transaction block:
-- the procedures below commit between operations like real writers do.

-- An independent copy of the recount walk.
CREATE FUNCTION incremental_full_count(target TEXT, OUT files BIGINT, OUT folders BIGINT)
LANGUAGE sql STABLE AS $$
  WITH RECURSIVE tree AS (
    SELECT f.id,f.entry_type FROM repositories r JOIN files f ON f.id=r.root_file_id
    WHERE r.id=target AND f.state='active'
    UNION ALL
    SELECT f.id,f.entry_type FROM files f JOIN tree t ON f.parent_id=t.id
    WHERE f.owner_id=(SELECT owner_id FROM repositories WHERE id=target) AND f.state='active'
  ) SELECT count(*) FILTER (WHERE entry_type='file'),
      GREATEST(count(*) FILTER (WHERE entry_type='folder')-1,0) FROM tree
$$;

-- What the two background loops do, until no work remains.
CREATE PROCEDURE incremental_drain() LANGUAGE plpgsql AS $$
DECLARE target TEXT;
BEGIN
  WHILE collection_changes_dispatch()>0 LOOP COMMIT; END LOOP;
  COMMIT;
  LOOP
    target:=repository_counts_claim();
    COMMIT;
    EXIT WHEN target IS NULL;
    IF NOT repository_counts_recount(target) THEN RAISE EXCEPTION 'recount of % skipped', target; END IF;
    COMMIT;
  END LOOP;
  WHILE collection_changes_dispatch()>0 LOOP COMMIT; END LOOP;
  COMMIT;
END $$;

CREATE FUNCTION incremental_assert_exact(label TEXT) RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE mismatch RECORD;
BEGIN
  IF EXISTS (SELECT 1 FROM repository_pending_changes) THEN
    RAISE EXCEPTION '%: pending changes remain after drain', label;
  END IF;
  SELECT r.id,r.total_files,r.total_folders,c.files,c.folders,r.counts_version,repository_content_version(r.id) AS content
    INTO mismatch
  FROM repositories r CROSS JOIN LATERAL incremental_full_count(r.id) c
  WHERE r.owner_id='incr_owner' AND (r.total_files,r.total_folders,r.counts_version)
    IS DISTINCT FROM (c.files,c.folders,repository_content_version(r.id))
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION '%: % has files=% folders=% version=% but the walk finds files=% folders=% version=%',
      label,mismatch.id,mismatch.total_files,mismatch.total_folders,mismatch.counts_version,
      mismatch.files,mismatch.folders,mismatch.content;
  END IF;
END $$;

CREATE TABLE incremental_log (step INTEGER, operation TEXT, dirty BOOLEAN);

INSERT INTO users(id,username,password_hash,role,status) VALUES
 ('incr_owner','incr_owner','test','user','active');
INSERT INTO files(id,owner_id,original_name,storage_name,size_bytes,entry_type,parent_id)
SELECT 'incr_top_'||n,'incr_owner','top '||n,'incr-top-'||n,0,'folder',NULL FROM generate_series(1,4) n;
INSERT INTO repositories(id,owner_id,root_file_id) VALUES
 ('incr_repo_1','incr_owner','incr_top_1'),('incr_repo_2','incr_owner','incr_top_2'),('incr_repo_3','incr_owner','incr_top_3');
-- incr_top_4 is outside every repository.
DO $$ DECLARE n INTEGER; parent TEXT; BEGIN
  PERFORM setseed(0.41);
  FOR n IN 1..40 LOOP
    SELECT id INTO parent FROM files WHERE owner_id='incr_owner' AND entry_type='folder' ORDER BY random() LIMIT 1;
    INSERT INTO files(id,owner_id,original_name,storage_name,size_bytes,entry_type,parent_id)
    VALUES ('incr_seed_folder_'||n,'incr_owner','folder '||n,'incr-seed-folder-'||n,0,'folder',parent);
  END LOOP;
  FOR n IN 1..160 LOOP
    SELECT id INTO parent FROM files WHERE owner_id='incr_owner' AND entry_type='folder' ORDER BY random() LIMIT 1;
    INSERT INTO files(id,owner_id,original_name,storage_name,size_bytes,entry_type,parent_id)
    VALUES ('incr_seed_file_'||n,'incr_owner','file '||n,'incr-seed-file-'||n,1,'file',parent);
  END LOOP;
END $$;
CALL incremental_drain();
SELECT incremental_assert_exact('seed');

CREATE PROCEDURE incremental_run(steps INTEGER, seed DOUBLE PRECISION) LANGUAGE plpgsql AS $$
DECLARE step INTEGER; operation TEXT; node TEXT; target TEXT; ids TEXT[]; next_id INTEGER := 0;
  dirty BOOLEAN; drain_every INTEGER;
BEGIN
  PERFORM setseed(seed);
  drain_every:=1+floor(random()*6)::int;
  FOR step IN 1..steps LOOP
    next_id:=next_id+1;
    operation:=(ARRAY['insert_file','insert_folder','insert_trashed','delete_file','delete_folder',
      'trash_subtree','trash_top','restore_subtree','restore_top','move_file','move_folder','move_many',
      'rename','toggle_root','nest_repository','chunked_trash','delete_subtree','folder_to_file',
      'restore_touch','root_type'])
      [1+floor(random()*20)::int];
    node:=NULL; target:=NULL; ids:=NULL;
    BEGIN
      CASE operation
      WHEN 'insert_file','insert_folder' THEN
        SELECT id INTO target FROM files WHERE owner_id='incr_owner' AND entry_type='folder' AND state='active' ORDER BY random() LIMIT 1;
        INSERT INTO files(id,owner_id,original_name,storage_name,size_bytes,entry_type,parent_id)
        VALUES ('incr_'||seed||'_'||next_id,'incr_owner','new '||seed||' '||next_id,'incr-'||seed||'-'||next_id,1,
          CASE operation WHEN 'insert_file' THEN 'file' ELSE 'folder' END,target);
      WHEN 'insert_trashed' THEN
        SELECT id INTO target FROM files WHERE owner_id='incr_owner' AND entry_type='folder' ORDER BY random() LIMIT 1;
        INSERT INTO files(id,owner_id,original_name,storage_name,size_bytes,entry_type,parent_id,state,trashed_at)
        VALUES ('incr_'||seed||'_'||next_id,'incr_owner','new '||seed||' '||next_id,'incr-'||seed||'-'||next_id,1,'file',target,'trashed',now());
      WHEN 'delete_file' THEN
        DELETE FROM files WHERE id=(SELECT id FROM files WHERE owner_id='incr_owner' AND entry_type='file' ORDER BY random() LIMIT 1);
      WHEN 'delete_folder' THEN
        -- Only the top row; ON DELETE CASCADE removes the subtree.
        DELETE FROM files WHERE id=(SELECT f.id FROM files f WHERE f.owner_id='incr_owner' AND f.entry_type='folder'
          AND NOT EXISTS (SELECT 1 FROM repositories r WHERE r.root_file_id=f.id) AND f.parent_id IS NOT NULL ORDER BY random() LIMIT 1);
      WHEN 'delete_subtree' THEN
        SELECT f.id INTO node FROM files f WHERE f.owner_id='incr_owner' AND f.parent_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM repositories r WHERE r.root_file_id=f.id) ORDER BY random() LIMIT 1;
        WITH RECURSIVE subtree AS (SELECT id FROM files WHERE id=node UNION ALL SELECT f.id FROM files f JOIN subtree s ON f.parent_id=s.id)
        SELECT array_agg(id) INTO ids FROM subtree;
        IF NOT EXISTS (SELECT 1 FROM repositories r WHERE r.root_file_id=ANY(ids)) THEN
          DELETE FROM files WHERE id=ANY(ids);
        END IF;
      WHEN 'trash_subtree','chunked_trash' THEN
        SELECT id INTO node FROM files WHERE owner_id='incr_owner' AND state='active' AND parent_id IS NOT NULL ORDER BY random() LIMIT 1;
        WITH RECURSIVE subtree AS (SELECT id,0 AS depth FROM files WHERE id=node UNION ALL SELECT f.id,s.depth+1 FROM files f JOIN subtree s ON f.parent_id=s.id)
        SELECT array_agg(id ORDER BY depth,id) INTO ids FROM subtree;
        IF operation='trash_subtree' THEN
          UPDATE files SET state='trashed',trashed_at=now() WHERE id=ANY(ids) AND state='active';
        ELSE
          -- Like update_tree_state: several statements in one transaction.
          UPDATE files SET state='trashed',trashed_at=now() WHERE id=ANY(ids[1:2]) AND state='active';
          UPDATE files SET state='trashed',trashed_at=now() WHERE id=ANY(ids[3:]) AND state='active';
        END IF;
      WHEN 'trash_top' THEN
        UPDATE files SET state='trashed',trashed_at=now() WHERE id=(SELECT id FROM files WHERE owner_id='incr_owner'
          AND state='active' AND parent_id IS NOT NULL ORDER BY random() LIMIT 1);
      WHEN 'restore_subtree' THEN
        SELECT id INTO node FROM files WHERE owner_id='incr_owner' AND state='trashed' ORDER BY random() LIMIT 1;
        WITH RECURSIVE subtree AS (SELECT id FROM files WHERE id=node UNION ALL SELECT f.id FROM files f JOIN subtree s ON f.parent_id=s.id)
        SELECT array_agg(id) INTO ids FROM subtree;
        UPDATE files SET state='active',trashed_at=NULL WHERE id=ANY(ids) AND state='trashed';
      WHEN 'restore_touch' THEN
        -- Like the tree job: every row in the subtree is written, including
        -- active rows below the trashed top that only change updated_at.
        SELECT id INTO node FROM files WHERE owner_id='incr_owner' AND state='trashed' ORDER BY random() LIMIT 1;
        WITH RECURSIVE subtree AS (SELECT id FROM files WHERE id=node UNION ALL SELECT f.id FROM files f JOIN subtree s ON f.parent_id=s.id)
        SELECT array_agg(id) INTO ids FROM subtree;
        UPDATE files SET state='active',trashed_at=NULL,updated_at=clock_timestamp() WHERE id=ANY(ids);
      WHEN 'root_type' THEN
        -- A childless root may change type; the walk then counts it as a file.
        UPDATE files SET entry_type=CASE entry_type WHEN 'folder' THEN 'file' ELSE 'folder' END
        WHERE id=(SELECT r.root_file_id FROM repositories r WHERE r.owner_id='incr_owner'
          AND NOT EXISTS (SELECT 1 FROM files c WHERE c.parent_id=r.root_file_id) ORDER BY random() LIMIT 1);
      WHEN 'restore_top' THEN
        -- The parent may still be trashed; the database allows it and the
        -- restored row stays unreachable.
        UPDATE files SET state='active',trashed_at=NULL WHERE id=(SELECT id FROM files WHERE owner_id='incr_owner'
          AND state='trashed' ORDER BY random() LIMIT 1);
      WHEN 'move_file','move_folder' THEN
        SELECT id INTO node FROM files WHERE owner_id='incr_owner' AND parent_id IS NOT NULL
          AND entry_type=CASE operation WHEN 'move_file' THEN 'file' ELSE 'folder' END ORDER BY random() LIMIT 1;
        SELECT f.id INTO target FROM files f WHERE f.owner_id='incr_owner' AND f.entry_type='folder' AND f.state='active'
          AND NOT tree_operation_ancestor(f.id,'incr_owner',node) ORDER BY random() LIMIT 1;
        UPDATE files SET parent_id=target WHERE id=node AND parent_id IS DISTINCT FROM target;
      WHEN 'move_many' THEN
        SELECT id INTO target FROM files WHERE owner_id='incr_owner' AND entry_type='folder' AND state='active' ORDER BY random() LIMIT 1;
        UPDATE files SET parent_id=target WHERE id IN (SELECT id FROM files WHERE owner_id='incr_owner'
          AND entry_type='file' AND parent_id IS DISTINCT FROM target ORDER BY random() LIMIT 5);
      WHEN 'rename' THEN
        UPDATE files SET original_name='renamed '||seed||' '||next_id WHERE id=(SELECT id FROM files WHERE owner_id='incr_owner' ORDER BY random() LIMIT 1);
      WHEN 'toggle_root' THEN
        UPDATE files SET state=CASE state WHEN 'active' THEN 'trashed' ELSE 'active' END,
          trashed_at=CASE state WHEN 'active' THEN now() END
        WHERE id=(SELECT root_file_id FROM repositories WHERE owner_id='incr_owner' ORDER BY random() LIMIT 1);
      WHEN 'nest_repository' THEN
        IF (SELECT count(*) FROM repositories WHERE owner_id='incr_owner')<7 THEN
          INSERT INTO repositories(id,owner_id,root_file_id)
          SELECT 'incr_repo_'||seed||'_'||next_id,'incr_owner',f.id FROM files f
          WHERE f.owner_id='incr_owner' AND f.entry_type='folder' AND f.state='active' AND f.parent_id IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM repositories r WHERE r.root_file_id=f.id) ORDER BY random() LIMIT 1;
        END IF;
      WHEN 'folder_to_file' THEN
        UPDATE files SET entry_type='file' WHERE id=(SELECT f.id FROM files f WHERE f.owner_id='incr_owner'
          AND f.entry_type='folder' AND f.parent_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM files c WHERE c.parent_id=f.id)
          AND NOT EXISTS (SELECT 1 FROM repositories r WHERE r.root_file_id=f.id) ORDER BY random() LIMIT 1);
      END CASE;
    EXCEPTION WHEN raise_exception OR check_violation THEN
      -- Random moves can exceed the hierarchy depth limit; skip that step.
      IF SQLERRM NOT LIKE 'invalid file hierarchy%' AND SQLERRM NOT LIKE 'active entries require%' THEN RAISE; END IF;
      operation:=operation||' (rejected)';
    END;
    SELECT EXISTS (SELECT 1 FROM repository_pending_changes WHERE counts_dirty
      AND transaction_id=pg_current_xact_id_if_assigned()) INTO dirty;
    INSERT INTO incremental_log VALUES (step,operation,dirty);
    COMMIT;
    IF step%drain_every=0 THEN
      CALL incremental_drain();
      PERFORM incremental_assert_exact(format('seed %s step %s after %s',seed,step,operation));
      drain_every:=1+floor(random()*6)::int;
    END IF;
  END LOOP;
  CALL incremental_drain();
  PERFORM incremental_assert_exact(format('seed %s final',seed));
END $$;

CALL incremental_run(300,0.11);
CALL incremental_run(300,0.53);
CALL incremental_run(300,-0.77);

-- Single-file and cosmetic writes never request a recount.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM incremental_log WHERE dirty AND operation IN
    ('insert_file','insert_trashed','delete_file','move_file','move_many','rename')) THEN
    RAISE EXCEPTION 'a file-level change requested a full recount: %',
      (SELECT string_agg(DISTINCT operation,', ') FROM incremental_log WHERE dirty AND operation IN
        ('insert_file','insert_trashed','delete_file','move_file','move_many','rename'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM incremental_log WHERE dirty) THEN
    RAISE EXCEPTION 'the sequence never exercised a full recount';
  END IF;
END $$;
SELECT operation,count(*) AS steps,count(*) FILTER (WHERE dirty) AS recounts
FROM incremental_log GROUP BY operation ORDER BY operation;

-- A repository waiting for a recount does not hold back deltas elsewhere.
-- Its own deltas still apply, but its counts stay marked stale.
INSERT INTO files(id,owner_id,original_name,storage_name,size_bytes,entry_type,parent_id)
VALUES ('incr_iso_a','incr_owner','iso a','incr-iso-a',0,'folder',NULL),
 ('incr_iso_b','incr_owner','iso b','incr-iso-b',0,'folder',NULL),
 ('incr_iso_a_dir','incr_owner','dir','incr-iso-a-dir',0,'folder','incr_iso_a'),
 ('incr_iso_a_file','incr_owner','file','incr-iso-a-file',1,'file','incr_iso_a_dir');
INSERT INTO repositories(id,owner_id,root_file_id) VALUES ('incr_iso_repo_a','incr_owner','incr_iso_a'),('incr_iso_repo_b','incr_owner','incr_iso_b');
CALL incremental_drain();
-- Moving a non-empty folder out of A requires a recount of A.
UPDATE files SET parent_id='incr_top_4' WHERE id='incr_iso_a_dir';
INSERT INTO files(id,owner_id,original_name,storage_name,size_bytes,entry_type,parent_id)
VALUES ('incr_iso_b_file','incr_owner','file','incr-iso-b-file',1,'file','incr_iso_b');
INSERT INTO files(id,owner_id,original_name,storage_name,size_bytes,entry_type,parent_id)
VALUES ('incr_iso_a_file2','incr_owner','file','incr-iso-a-file2',1,'file','incr_iso_a');
SELECT collection_changes_dispatch();
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM repositories WHERE id='incr_iso_repo_b' AND total_files=1 AND counts_version=repository_content_version(id)) THEN
    RAISE EXCEPTION 'delta for B waited behind the recount of A'; END IF;
  IF NOT EXISTS (SELECT 1 FROM repositories WHERE id='incr_iso_repo_a' AND counts_version<>repository_content_version(id)) THEN
    RAISE EXCEPTION 'A was marked fresh before its recount'; END IF;
  IF (SELECT count(*) FROM repository_pending_changes WHERE repository_id='incr_iso_repo_a')<>1 THEN
    RAISE EXCEPTION 'only the recount request for A should remain'; END IF;
END $$;

-- A claimed recount that never finishes (timeout, crash) backs off: the next
-- claim does not return the same repository.
SELECT repository_counts_claim() AS first_claim \gset
SELECT 1/(:'first_claim'='incr_iso_repo_a')::int AS claimed_oldest_recount;
SELECT repository_counts_claim() IS NULL AS backing_off \gset
SELECT 1/(:'backing_off'::boolean)::int AS failed_recount_not_retried_immediately;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM repository_recount_attempts WHERE repository_id='incr_iso_repo_a'
    AND attempts=1 AND not_before>clock_timestamp()) THEN RAISE EXCEPTION 'claim did not record its backoff'; END IF;
END $$;
-- Another repository that needs a recount is not blocked by A's backoff.
UPDATE files SET state='trashed',trashed_at=now() WHERE id='incr_iso_b';
SELECT 1/(repository_counts_claim()='incr_iso_repo_b')::int AS other_repository_claimed;
SELECT 1/repository_counts_recount('incr_iso_repo_b')::int AS other_repository_recounted;
-- The second failure doubles the backoff.
UPDATE repository_recount_attempts SET not_before=clock_timestamp()-interval '1 second';
SELECT 1/(repository_counts_claim()='incr_iso_repo_a')::int AS retried_after_backoff;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM repository_recount_attempts WHERE repository_id='incr_iso_repo_a'
    AND attempts=2 AND not_before>clock_timestamp()+interval '25 seconds') THEN RAISE EXCEPTION 'backoff did not grow'; END IF;
END $$;
SELECT 1/repository_counts_recount('incr_iso_repo_a')::int AS recounted_after_backoff;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM repository_recount_attempts) THEN RAISE EXCEPTION 'successful recount kept its backoff'; END IF;
END $$;
CALL incremental_drain();
SELECT incremental_assert_exact('recount isolation');

-- Stored totals that drifted below a delta are recounted, never clamped.
UPDATE repositories SET total_files=0 WHERE id='incr_iso_repo_a';
DELETE FROM files WHERE id='incr_iso_a_file2';
SELECT collection_changes_dispatch();
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM repository_pending_changes WHERE repository_id='incr_iso_repo_a' AND counts_dirty) THEN
    RAISE EXCEPTION 'negative delta did not request a recount'; END IF;
END $$;
CALL incremental_drain();
SELECT incremental_assert_exact('drift');
