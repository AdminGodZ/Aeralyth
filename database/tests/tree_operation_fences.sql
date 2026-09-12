\set ON_ERROR_STOP on
BEGIN;
INSERT INTO users(id,username,password_hash,role,status) VALUES
('tree_guard_owner','tree_guard_owner','not-a-login-hash','user','active'),
('tree_guard_recipient','tree_guard_recipient','not-a-login-hash','user','active');
INSERT INTO files(id,owner_id,original_name,storage_name,size_bytes,entry_type,parent_id) VALUES
('guard_top','tree_guard_owner','top','guard/top',0,'folder',NULL),
('guard_root','tree_guard_owner','root','guard/root',0,'folder','guard_top'),
('guard_child','tree_guard_owner','child','guard/child',123,'file','guard_root'),
('guard_sibling','tree_guard_owner','sibling','guard/sibling',456,'file','guard_top');
INSERT INTO file_shares(id,file_id,owner_id,recipient_id) VALUES
('guard_share','guard_child','tree_guard_owner','tree_guard_recipient');
INSERT INTO file_uploads(id,file_id,owner_id,parent_id,original_name,object_key,size_bytes,
  reservation_bytes,upload_mode,status,expires_at,completion_attempts,completion_available_at,
  completion_locked_until,completion_lease_token,completion_last_error)
VALUES('guard_upload','guard_upload_node','tree_guard_owner','guard_root','reserved','guard/upload',23,
  23,'single','completing',now()+interval '1 hour',2,now()+interval '5 minutes',
  now()+interval '5 minutes','guard-lease','old transient error');
-- The application reserves this ledger before inserting an upload intent.
UPDATE user_storage_usage SET reserved_bytes=reserved_bytes+23,pending_uploads=pending_uploads+1
WHERE owner_id='tree_guard_owner';
INSERT INTO tree_operation_jobs(owner_id,root_id,action,child_state)
VALUES('tree_guard_owner','guard_root','trash','active') RETURNING id AS job \gset
DO $$
BEGIN
  IF (SELECT count(*) FROM visible_files WHERE owner_id='tree_guard_owner') <> 2 THEN
    RAISE EXCEPTION 'fence does not hide exactly its subtree';
  END IF;
  BEGIN
    UPDATE files SET original_name='blocked' WHERE id='guard_child';
    RAISE EXCEPTION 'descendant mutation was allowed';
  EXCEPTION WHEN SQLSTATE '55000' THEN NULL; END;
  BEGIN
    INSERT INTO files(id,owner_id,original_name,storage_name,size_bytes,entry_type,parent_id)
    VALUES('guard_new','tree_guard_owner','new','guard/new',0,'file','guard_root');
    RAISE EXCEPTION 'descendant insert was allowed';
  EXCEPTION WHEN SQLSTATE '55000' THEN NULL; END;
  BEGIN
    UPDATE files SET parent_id=NULL WHERE id='guard_child';
    RAISE EXCEPTION 'move outside fence was allowed';
  EXCEPTION WHEN SQLSTATE '55000' THEN NULL; END;
  BEGIN
    UPDATE files SET parent_id='guard_root' WHERE id='guard_sibling';
    RAISE EXCEPTION 'move inside fence was allowed';
  EXCEPTION WHEN SQLSTATE '55000' THEN NULL; END;
  BEGIN
    UPDATE files SET state='trashed' WHERE id='guard_top';
    RAISE EXCEPTION 'ancestor state mutation was allowed';
  EXCEPTION WHEN SQLSTATE '55000' THEN NULL; END;
  BEGIN
    DELETE FROM files WHERE id='guard_top';
    RAISE EXCEPTION 'ancestor delete was allowed';
  EXCEPTION WHEN SQLSTATE '55000' THEN NULL; END;
  BEGIN
    DELETE FROM file_shares WHERE id='guard_share';
    RAISE EXCEPTION 'share mutation was allowed';
  EXCEPTION WHEN SQLSTATE '55000' THEN NULL; END;
  UPDATE file_uploads SET completion_available_at=now()+interval '1 second',
    completion_locked_until=NULL,completion_lease_token=NULL,completion_last_error=NULL
  WHERE id='guard_upload' AND completion_lease_token='guard-lease';
  IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM file_uploads WHERE id='guard_upload'
    AND status='completing' AND parent_id='guard_root' AND owner_id='tree_guard_owner'
    AND object_key='guard/upload' AND reservation_bytes=23 AND completion_attempts=2
    AND completion_dead_lettered_at IS NULL AND completion_locked_until IS NULL
    AND completion_lease_token IS NULL AND completion_last_error IS NULL
    AND completion_available_at=now()+interval '1 second') THEN
    RAISE EXCEPTION 'fenced completion lease did not release without altering upload or retry budget';
  END IF;
  BEGIN
    UPDATE file_uploads SET completion_available_at=now(),status='completed' WHERE id='guard_upload';
    RAISE EXCEPTION 'lease metadata exemption allowed a status change';
  EXCEPTION WHEN SQLSTATE '55000' THEN NULL; END;
  BEGIN
    UPDATE file_uploads SET completion_available_at=now(),parent_id=NULL WHERE id='guard_upload';
    RAISE EXCEPTION 'lease metadata exemption allowed a parent change';
  EXCEPTION WHEN SQLSTATE '55000' THEN NULL; END;
  BEGIN
    UPDATE file_uploads SET completion_available_at=now(),object_key='guard/changed' WHERE id='guard_upload';
    RAISE EXCEPTION 'lease metadata exemption allowed an object change';
  EXCEPTION WHEN SQLSTATE '55000' THEN NULL; END;
  BEGIN
    UPDATE file_uploads SET completion_available_at=now(),completion_attempts=completion_attempts+1 WHERE id='guard_upload';
    RAISE EXCEPTION 'lease metadata exemption allowed an attempt charge';
  EXCEPTION WHEN SQLSTATE '55000' THEN NULL; END;
  BEGIN
    UPDATE file_uploads SET completion_available_at=now(),completion_dead_lettered_at=now() WHERE id='guard_upload';
    RAISE EXCEPTION 'lease metadata exemption allowed dead lettering';
  EXCEPTION WHEN SQLSTATE '55000' THEN NULL; END;
  UPDATE files SET original_name='sibling still works' WHERE id='guard_sibling';
END;
$$;
SELECT set_config('aeralyth.tree_job_id', :'job', true);
UPDATE tree_operation_jobs SET status='running',phase='mutate' WHERE id=:job;
UPDATE files SET state='trashed',trashed_at=now() WHERE id='guard_child';
DO $$
BEGIN
  IF (SELECT total_files FROM user_file_counters WHERE owner_id='tree_guard_owner') <> 1 THEN
    RAISE EXCEPTION 'base owner counter did not advance';
  END IF;
  IF (SELECT total_files FROM visible_user_file_counters WHERE owner_id='tree_guard_owner') <> 2 THEN
    RAISE EXCEPTION 'visible owner snapshot exposed intermediate counters';
  END IF;
  IF (SELECT shared_files FROM visible_user_file_counters WHERE owner_id='tree_guard_recipient') <> 1 THEN
    RAISE EXCEPTION 'visible recipient snapshot exposed intermediate counters';
  END IF;
END;
$$;
UPDATE files SET state='trashed',trashed_at=now() WHERE id='guard_root';
UPDATE tree_operation_jobs SET status='complete',completed_at=now() WHERE id=:job;
SELECT set_config('aeralyth.tree_job_id', '', true);
DO $$
BEGIN
  IF (SELECT count(*) FROM visible_files WHERE owner_id='tree_guard_owner') <> 4 THEN
    RAISE EXCEPTION 'completed fence was not removed';
  END IF;
  IF (SELECT total_files FROM visible_user_file_counters WHERE owner_id='tree_guard_owner') <> 1 THEN
    RAISE EXCEPTION 'completion did not publish counter totals';
  END IF;
  IF (SELECT shared_files FROM visible_user_file_counters WHERE owner_id='tree_guard_recipient') <> 0 THEN
    RAISE EXCEPTION 'completion did not publish recipient totals';
  END IF;
END;
$$;
INSERT INTO tree_operation_jobs(owner_id,root_id,action)
VALUES('tree_guard_owner','guard_root','delete') RETURNING id AS delete_job \gset
SELECT set_config('aeralyth.tree_job_id', :'delete_job', true);
DELETE FROM files WHERE id='guard_child';
DELETE FROM files WHERE id='guard_root';
UPDATE tree_operation_jobs SET status='complete',completed_at=now() WHERE id=:delete_job;
DO $$
BEGIN
  IF (SELECT count(*) FROM visible_files WHERE owner_id='tree_guard_owner') <> 2 THEN
    RAISE EXCEPTION 'delete did not remove its subtree';
  END IF;
END;
$$;
ROLLBACK;
\echo 'tree fence, ancestor writes, share guard, completion lease release, worker bypass, counter snapshots, root deletion passed'
