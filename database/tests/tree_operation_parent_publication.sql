\set ON_ERROR_STOP on
BEGIN;
INSERT INTO users(id,username,password_hash,role,status)
VALUES('parent_guard_owner','parent_guard_owner','not-a-login-hash','user','active');
INSERT INTO files(id,owner_id,original_name,storage_name,size_bytes,entry_type,parent_id) VALUES
('parent_guard_root','parent_guard_owner','root','parent-guard/root',0,'folder',NULL),
('parent_guard_child','parent_guard_owner','child','parent-guard/child',1,'file','parent_guard_root'),
('parent_guard_sibling','parent_guard_owner','sibling','parent-guard/sibling',0,'folder',NULL),
('parent_guard_move','parent_guard_owner','move','parent-guard/move',1,'file','parent_guard_sibling');
INSERT INTO file_uploads(id,file_id,owner_id,parent_id,original_name,object_key,size_bytes,upload_mode,status,expires_at)
VALUES('parent_guard_upload','parent_guard_late','parent_guard_owner','parent_guard_root','reserved','parent-guard/late',1,'single','pending',now()+interval '1 hour');
INSERT INTO tree_operation_jobs(owner_id,root_id,action) VALUES('parent_guard_owner','parent_guard_root','trash') RETURNING id AS job \gset
SELECT set_config('aeralyth.tree_job_id',:'job',true);
UPDATE files SET state='trashed',trashed_at=now() WHERE id IN ('parent_guard_root','parent_guard_child');
UPDATE tree_operation_jobs SET status='complete' WHERE id=:job;
SELECT set_config('aeralyth.tree_job_id','',true);
DO $$ BEGIN
  BEGIN
    INSERT INTO files(id,owner_id,original_name,storage_name,size_bytes,entry_type,parent_id)
      SELECT file_id,owner_id,original_name,object_key,size_bytes,'file',parent_id FROM file_uploads WHERE id='parent_guard_upload';
    RAISE EXCEPTION 'late upload published into a trashed parent';
  EXCEPTION WHEN SQLSTATE '23514' THEN NULL; END;
  BEGIN
    UPDATE files SET parent_id='parent_guard_root' WHERE id='parent_guard_move';
    RAISE EXCEPTION 'active entry moved into a trashed parent';
  EXCEPTION WHEN SQLSTATE '23514' THEN NULL; END;
  INSERT INTO files(id,owner_id,original_name,storage_name,size_bytes,entry_type,parent_id)
    VALUES('parent_guard_allowed','parent_guard_owner','allowed','parent-guard/allowed',1,'file','parent_guard_sibling');
END $$;
INSERT INTO tree_operation_jobs(owner_id,root_id,action) VALUES('parent_guard_owner','parent_guard_root','restore') RETURNING id AS restore_job \gset
SELECT set_config('aeralyth.tree_job_id',:'restore_job',true);
-- The worker restores descendants before their parent; state-only updates
-- must remain valid while the parent is still physically trashed and fenced.
UPDATE files SET state='active',trashed_at=NULL WHERE id='parent_guard_child';
UPDATE files SET state='active',trashed_at=NULL WHERE id='parent_guard_root';
UPDATE tree_operation_jobs SET status='complete' WHERE id=:restore_job;
ROLLBACK;
\echo 'Late upload and move into trashed parent rejected; active sibling and leaf-first restore passed'
