\set ON_ERROR_STOP on
INSERT INTO users(id,username,password_hash,role,status)
VALUES('tracking_owner','tracking_owner','test','user','active');
INSERT INTO files(id,owner_id,original_name,storage_name,size_bytes,entry_type,parent_id,updated_at)
VALUES ('track_a','tracking_owner','A','test-a',0,'folder',NULL,'2020-01-01'),
 ('track_b','tracking_owner','B','test-b',0,'folder',NULL,'2020-01-01'),
 ('track_other','tracking_owner','Other','test-other',0,'folder',NULL,'2020-01-01'),
 ('track_child','tracking_owner','Child','test-child',0,'folder','track_a','2020-01-01');
INSERT INTO repositories(id,owner_id,root_file_id) VALUES
 ('track_repo_a','tracking_owner','track_a'),('track_repo_b','tracking_owner','track_b');
SELECT collection_changes_dispatch();
SELECT repository_content_version('track_repo_b') AS other_revision \gset
INSERT INTO files(id,owner_id,original_name,storage_name,size_bytes,entry_type,parent_id)
SELECT 'track_file_'||i,'tracking_owner','file-'||i,'storage-'||i,1,'file','track_child'
FROM generate_series(1,50000) i;
DO $$ BEGIN
 IF repository_content_version('track_repo_a')=0 THEN RAISE EXCEPTION 'missing content revision'; END IF;
 IF EXISTS(SELECT 1 FROM files WHERE id IN ('track_a','track_child') AND updated_at>'2020-01-01') THEN
   RAISE EXCEPTION 'foreground rewrote common ancestors'; END IF;
 IF NOT EXISTS(SELECT 1 FROM repositories WHERE id='track_repo_a' AND counts_version<>repository_content_version(id)) THEN
   RAISE EXCEPTION 'count freshness missing'; END IF;
END $$;
SELECT 1 / (repository_content_version('track_repo_b')=:'other_revision'::bigint)::int AS unrelated_repository_unchanged;
SELECT collection_changes_dispatch();
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM repositories WHERE id='track_repo_a' AND total_files=50000 AND total_folders=1 AND counts_version=repository_content_version(id)) THEN
   RAISE EXCEPTION 'background counts incorrect'; END IF;
END $$;
BEGIN;
INSERT INTO collection_timestamp_changes(owner_id,parent_id) VALUES('tracking_owner','track_child');
INSERT INTO collection_timestamp_changes(owner_id,parent_id) VALUES('tracking_owner','track_child')
 ON CONFLICT(transaction_id,owner_id,parent_id) DO NOTHING;
DO $$ BEGIN
 IF (SELECT count(*) FROM collection_timestamp_changes WHERE owner_id='tracking_owner')<>1 THEN RAISE EXCEPTION 'timestamp queue not coalesced'; END IF;
END $$;
COMMIT;
SELECT repository_content_version('track_repo_a') AS before_timestamps \gset
SELECT collection_changes_dispatch();
SELECT 1 / (repository_content_version('track_repo_a')>:'before_timestamps'::bigint)::int AS timestamp_changes_advance_validator;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM files WHERE id IN ('track_a','track_child') AND updated_at='2020-01-01') THEN RAISE EXCEPTION 'timestamps not refreshed'; END IF;
 IF EXISTS(SELECT 1 FROM files WHERE id='track_b' AND updated_at<>'2020-01-01') THEN RAISE EXCEPTION 'unrelated timestamp changed'; END IF;
END $$;
-- Both old and new ancestry must invalidate when a subtree moves.
SELECT repository_content_version('track_repo_a') AS old_a,repository_content_version('track_repo_b') AS old_b \gset
UPDATE files SET parent_id='track_b' WHERE id='track_child';
SELECT 1 / (repository_content_version('track_repo_a')>:'old_a'::bigint AND repository_content_version('track_repo_b')>:'old_b'::bigint)::int AS both_move_audiences_invalidated;
SELECT collection_changes_dispatch();
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM repositories WHERE id='track_repo_a' AND total_files=0 AND total_folders=0) OR
 NOT EXISTS(SELECT 1 FROM repositories WHERE id='track_repo_b' AND total_files=50000 AND total_folders=1) THEN RAISE EXCEPTION 'move counts wrong'; END IF;
END $$;
-- Saving a manifest is one scan; all pages use its primary-key ordinal index.
INSERT INTO repository_archive_manifests(owner_id,repository_id,content_version,total_entries,total_files,total_bytes)
VALUES('tracking_owner','track_repo_b',repository_content_version('track_repo_b'),50000,50000,50000) RETURNING id AS manifest_id \gset
INSERT INTO repository_archive_entries(manifest_id,ordinal,id,original_name,entry_type,parent_id,size_bytes,e2ee_state,updated_at)
SELECT :'manifest_id',row_number() OVER(ORDER BY id),id,original_name,entry_type,parent_id,size_bytes,e2ee_state,updated_at
FROM files WHERE parent_id='track_child';
-- Deliberately do not ANALYZE a fresh manifest: candidate bounds must hold
-- even before autovacuum has statistics.
EXPLAIN (ANALYZE,BUFFERS) SELECT * FROM repository_archive_entries WHERE manifest_id=:'manifest_id' AND ordinal>0 AND ordinal<=1001 ORDER BY ordinal LIMIT 1001;
EXPLAIN (ANALYZE,BUFFERS) SELECT * FROM repository_archive_entries WHERE manifest_id=:'manifest_id' AND ordinal>25000 AND ordinal<=26001 ORDER BY ordinal LIMIT 1001;
EXPLAIN (ANALYZE,BUFFERS) SELECT * FROM repository_archive_entries WHERE manifest_id=:'manifest_id' AND ordinal>49000 AND ordinal<=50001 ORDER BY ordinal LIMIT 1001;
SELECT content_version AS manifest_revision FROM repository_archive_manifests WHERE id=:'manifest_id' \gset
UPDATE files SET original_name='changed' WHERE id='track_file_1';
SELECT 1 / (repository_content_version('track_repo_b')>:'manifest_revision'::bigint)::int AS mutation_rejects_old_manifest;
-- Failed publications leave both file and revision unchanged.
SELECT repository_content_version('track_repo_b') AS before_rollback \gset
BEGIN;
UPDATE files SET original_name='rolled back' WHERE id='track_file_2';
ROLLBACK;
SELECT 1 / (repository_content_version('track_repo_b')=:'before_rollback'::bigint)::int AS rollback_does_not_advance_revision;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM repository_pending_changes WHERE repository_id='track_repo_b' AND counts_dirty) THEN
   RAISE EXCEPTION 'content-only update scheduled a recursive recount'; END IF;
END $$;
SELECT collection_changes_dispatch();
-- A delayed child timestamp still changes the validator when the root already
-- has a newer cosmetic timestamp and therefore its GREATEST value stays put.
UPDATE files SET updated_at=now()+interval '1 day' WHERE id='track_b';
UPDATE files SET updated_at='2020-01-01' WHERE id='track_child';
SELECT collection_changes_dispatch();
INSERT INTO collection_timestamp_changes(owner_id,parent_id) VALUES('tracking_owner','track_child');
SELECT repository_content_version('track_repo_b') AS before_delayed_timestamp \gset
SELECT collection_changes_dispatch();
SELECT 1/(repository_content_version('track_repo_b')>:'before_delayed_timestamp'::bigint)::int AS delayed_child_timestamp_invalidates;
