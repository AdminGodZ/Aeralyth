\set ON_ERROR_STOP on
BEGIN;
INSERT INTO users(id,username,password_hash,role,status)
VALUES('tree_depth_owner','tree_depth_owner','not-a-login-hash','user','active');
ALTER TABLE files DISABLE TRIGGER files_hierarchy_insert_guard;
INSERT INTO files(id,owner_id,original_name,storage_name,size_bytes,entry_type,parent_id)
SELECT 'depth_'||i,'tree_depth_owner','deep','depth/'||i,0,'folder',CASE WHEN i=0 THEN NULL ELSE 'depth_'||(i-1) END
FROM generate_series(0,120) AS i;
ALTER TABLE files ENABLE TRIGGER files_hierarchy_insert_guard;
INSERT INTO tree_operation_jobs(owner_id,root_id,action) VALUES('tree_depth_owner','depth_0','trash');
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM visible_files WHERE owner_id='tree_depth_owner') THEN
    RAISE EXCEPTION 'over-depth tree leaked through the fence';
  END IF;
  BEGIN
    UPDATE files SET original_name='must fail' WHERE id='depth_120';
    RAISE EXCEPTION 'over-depth file mutation bypassed the fence';
  EXCEPTION WHEN SQLSTATE '55000' THEN NULL; END;
END $$;
ROLLBACK;
\echo 'Depth120 tree remains hidden and mutations are rejected with bounded traversal'
