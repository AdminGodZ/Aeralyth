\set ON_ERROR_STOP on
BEGIN;
INSERT INTO users(id,username,password_hash,role,status)
VALUES('tree_drain_owner','tree_drain_owner','not-a-login-hash','user','active');
INSERT INTO vault_identity_keys(user_id,key_version,x25519_public_key,ed25519_public_key,fingerprint_sha256)
VALUES('tree_drain_owner',1,decode(repeat('01',32),'hex'),decode(repeat('02',32),'hex'),decode(repeat('03',32),'hex'));
INSERT INTO files(id,owner_id,original_name,storage_name,size_bytes,entry_type,parent_id,state) VALUES
('drain_root','tree_drain_owner','root','drain/root',0,'folder',NULL,'trashed'),
('drain_leaf','tree_drain_owner','leaf','drain/leaf',1,'file','drain_root','trashed'),
('drain_survivor','tree_drain_owner','survivor','drain/survivor',1,'file',NULL,'active');
INSERT INTO vault_object_generations(node_id,owner_id,generation_number,generation_id,object_key,ciphertext_length,chunk_count,ciphertext_merkle_root)
SELECT 'drain_leaf','tree_drain_owner',i,decode(md5('generation'||i),'hex'),'drain/generation/'||i,1,1,decode(repeat('04',32),'hex')
FROM generate_series(1,1000) AS i;
INSERT INTO file_uploads(id,file_id,owner_id,parent_id,original_name,object_key,size_bytes,upload_mode,status,write_expires_at,expires_at)
SELECT 'drain_file_upload_'||i,'drain_file_unpublished_'||i,'tree_drain_owner','drain_root','pending','drain/file-upload/'||i,1,'single','pending',now()+interval '2 hours',now()+interval '3 hours'
FROM generate_series(1,1000) AS i;
INSERT INTO vault_uploads(id,node_id,owner_id,parent_id,entry_type,generation_number,generation_id,object_key,ciphertext_length,chunk_count,upload_mode,status,write_expires_at,expires_at)
SELECT 'drain_vault_upload_'||i,'drain_vault_unpublished_'||i,'tree_drain_owner','drain_root','file',1,decode(md5('upload'||i),'hex'),'drain/vault-upload/'||i,1,1,'single','pending',now()+interval '2 hours',now()+interval '3 hours'
FROM generate_series(1,1000) AS i;
INSERT INTO file_uploads(id,file_id,owner_id,parent_id,original_name,object_key,size_bytes,upload_mode,status,write_expires_at,expires_at)
VALUES('drain_file_history','drain_survivor','tree_drain_owner','drain_root','moved','drain/survivor',1,'single','completed',now()+interval '2 hours',now()+interval '3 hours');
INSERT INTO vault_uploads(id,node_id,owner_id,parent_id,entry_type,generation_number,generation_id,object_key,ciphertext_length,chunk_count,upload_mode,status,write_expires_at,expires_at) VALUES
('drain_vault_history','drain_survivor','tree_drain_owner','drain_root','file',1,decode(md5('survivor'),'hex'),'drain/survivor-vault',1,1,'single','published',now()+interval '2 hours',now()+interval '3 hours'),
('drain_vault_current','drain_leaf','tree_drain_owner','drain_root','file',1,decode(md5('published'),'hex'),'drain/generation/1',1,1,'single','published',now()+interval '2 hours',now()+interval '3 hours');
INSERT INTO vault_node_records(node_id,owner_id,record_version,record_hash,bootstrap_cbor,bootstrap_signature,encrypted_manifest,manifest_hash,signer_key_version)
SELECT 'drain_leaf','tree_drain_owner',i,decode(md5('record'||i)||md5('record'||i),'hex'),decode(repeat('05',128),'hex'),decode(repeat('06',64),'hex'),decode(repeat('07',16),'hex'),decode(repeat('08',32),'hex'),1
FROM generate_series(1,1000) AS i;
INSERT INTO vault_node_heads(node_id,owner_id,record_version,record_hash)
SELECT node_id,owner_id,record_version,record_hash FROM vault_node_records WHERE node_id='drain_leaf' AND record_version=1000;
INSERT INTO vault_share_wrapper_directories(node_id,record_version,owner_id,signer_key_version,canonical_cbor,signature,wrapper_set_root,wrapper_count)
SELECT 'drain_leaf',i,'tree_drain_owner',1,decode(repeat('01',96),'hex'),decode(repeat('02',64),'hex'),decode(repeat('03',32),'hex'),1 FROM generate_series(1,1000) AS i;
INSERT INTO vault_share_sync_jobs(node_id,owner_id,record_version) VALUES('drain_leaf','tree_drain_owner',1000);
INSERT INTO vault_shares(id,owner_id,root_node_id) VALUES('drain_share','tree_drain_owner','drain_root');
INSERT INTO vault_share_epochs(share_id,epoch,status) SELECT 'drain_share',i,'published' FROM generate_series(1,1000) AS i;
INSERT INTO vault_share_owner_keys(share_id,epoch,wrapper_id,root_ciphertext)
SELECT 'drain_share',i,decode(md5('ownerkey'||i),'hex'),decode(repeat('01',48),'hex') FROM generate_series(1,1000) AS i;
INSERT INTO vault_share_wrappers(wrapper_id,share_id,epoch,node_id,generation_id,wrapper_kind,canonical_cbor,wrapper_hash)
SELECT decode(md5('wrapper'||i),'hex'),'drain_share',1,'drain_leaf',decode(md5('wrappergeneration'||i),'hex'),'generation_dek',decode(repeat('01',64),'hex'),decode(md5('wrapperhash'||i)||md5('wrapperhash'||i),'hex') FROM generate_series(1,1000) AS i;
INSERT INTO vault_share_envelopes(envelope_id,share_id,epoch,sender_id,sender_key_version,recipient_id,recipient_key_version,node_id,permissions,record_version,encapsulated_key,ciphertext,canonical_cbor,signature,envelope_hash)
SELECT decode(md5('envelope'||i),'hex'),'drain_share',1,'tree_drain_owner',1,'tree_drain_owner',1,'drain_leaf','read',1,decode(repeat('01',32),'hex'),decode(repeat('02',48),'hex'),decode(repeat('03',128),'hex'),decode(repeat('04',64),'hex'),decode(md5('envelopehash'||i)||md5('envelopehash'||i),'hex') FROM generate_series(1,1000) AS i;
INSERT INTO share_links(id,token_hash,owner_id,root_file_id,access_scope,permission)
VALUES('drain_link','drain_link_hash','tree_drain_owner','drain_root','public','editor');
UPDATE file_uploads SET share_link_id='drain_link' WHERE id='drain_file_history';
INSERT INTO file_uploads(id,file_id,owner_id,share_link_id,original_name,object_key,size_bytes,upload_mode,status,write_expires_at,expires_at)
SELECT 'drain_link_upload_'||i,'drain_link_unpublished_'||i,'tree_drain_owner','drain_link','pending','drain/link-upload/'||i,1,'single','pending',now()+interval '2 hours',now()+interval '3 hours'
FROM generate_series(1,10) AS i;
-- The HTTP reservation path increments this ledger before inserting intents.
UPDATE user_storage_usage SET pending_uploads=2010 WHERE owner_id='tree_drain_owner';
INSERT INTO tree_operation_jobs(owner_id,root_id,action) VALUES('tree_drain_owner','drain_root','delete') RETURNING id AS job \gset
SELECT set_config('aeralyth.tree_job_id',:'job',true);
CREATE FUNCTION pg_temp.dependency_count() RETURNS bigint LANGUAGE sql AS $$
  SELECT (SELECT count(*) FROM file_uploads WHERE owner_id='tree_drain_owner' AND
      (file_id IN ('drain_root','drain_leaf') OR parent_id IN ('drain_root','drain_leaf') OR replacement_file_id IN ('drain_root','drain_leaf') OR share_link_id='drain_link'))+
    (SELECT count(*) FROM vault_uploads WHERE owner_id='tree_drain_owner' AND
      (node_id IN ('drain_root','drain_leaf') OR parent_id IN ('drain_root','drain_leaf')))+
    (SELECT count(*) FROM vault_object_generations WHERE owner_id='tree_drain_owner')+
    (SELECT count(*) FROM vault_node_records WHERE owner_id='tree_drain_owner')+
    (SELECT count(*) FROM vault_node_heads WHERE owner_id='tree_drain_owner')+
    (SELECT count(*) FROM vault_share_wrapper_directories WHERE owner_id='tree_drain_owner')+
    (SELECT count(*) FROM vault_share_sync_jobs WHERE owner_id='tree_drain_owner')+
    (SELECT count(*) FROM vault_shares WHERE owner_id='tree_drain_owner')+
    (SELECT count(*) FROM vault_share_epochs WHERE share_id='drain_share')+
    (SELECT count(*) FROM vault_share_owner_keys WHERE share_id='drain_share')+
    (SELECT count(*) FROM vault_share_wrappers WHERE share_id='drain_share')+
    (SELECT count(*) FROM vault_share_envelopes WHERE share_id='drain_share')+
    (SELECT count(*) FROM share_links WHERE id='drain_link');
$$;
DO $$
DECLARE before_count bigint; after_count bigint; ready boolean; pages integer:=0;
BEGIN
  LOOP
    before_count:=pg_temp.dependency_count();
    ready:=tree_operation_drain_dependencies('tree_drain_owner',ARRAY['drain_leaf','drain_root'],256);
    after_count:=pg_temp.dependency_count();
    IF before_count-after_count>256 THEN RAISE EXCEPTION 'unbounded dependency page: %',before_count-after_count; END IF;
    IF ready THEN
      IF after_count<>0 THEN RAISE EXCEPTION 'ready with dependencies remaining %',after_count; END IF;
      EXIT;
    END IF;
    -- Detaching a surviving intent's parent can leave its link reference for
    -- the later link phase, so that bounded page need not reduce this count.
    pages:=pages+1;
    IF pages>100 THEN RAISE EXCEPTION 'too many pages'; END IF;
  END LOOP;
  IF (SELECT count(*) FROM storage_deletion_jobs WHERE object_key LIKE 'drain/%')<>3010 THEN
    RAISE EXCEPTION 'missing or extra object deletion jobs';
  END IF;
  IF EXISTS(SELECT 1 FROM storage_deletion_jobs WHERE object_key IN ('drain/survivor','drain/survivor-vault')) THEN
    RAISE EXCEPTION 'published moved survivor queued for deletion';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM file_uploads WHERE id='drain_file_history' AND parent_id IS NULL AND share_link_id IS NULL
    AND write_expires_at=now()+interval '2 hours')
    OR NOT EXISTS(SELECT 1 FROM vault_uploads WHERE id='drain_vault_history' AND parent_id IS NULL
      AND write_expires_at=now()+interval '2 hours') THEN
    RAISE EXCEPTION 'survivor intents or write deadline were lost';
  END IF;
  IF EXISTS(SELECT 1 FROM storage_deletion_jobs WHERE
    (object_key LIKE 'drain/file-upload/%' OR object_key LIKE 'drain/vault-upload/%' OR object_key LIKE 'drain/link-upload/%' OR object_key='drain/generation/1')
    AND available_at<now()+interval '2 hours') THEN
    RAISE EXCEPTION 'single upload write expiry safety lost';
  END IF;
  RAISE NOTICE 'Drained node and share dependencies in % bounded pages; 3010 object jobs preserved write expiry and surviving files',pages;
END;
$$;
DELETE FROM files WHERE id='drain_leaf';
DELETE FROM files WHERE id='drain_root';
UPDATE tree_operation_jobs SET status='complete' WHERE id=:job;
INSERT INTO tree_operation_jobs(owner_id,root_id,action) VALUES('tree_drain_owner','drain_survivor','delete') RETURNING id AS later_job \gset
SELECT set_config('aeralyth.tree_job_id',:'later_job',true);
DO $$ DECLARE calls integer:=0; BEGIN
  WHILE NOT tree_operation_drain_dependencies('tree_drain_owner',ARRAY['drain_survivor'],256) LOOP
    calls:=calls+1;
    IF calls>5 THEN RAISE EXCEPTION 'survivor did not drain'; END IF;
  END LOOP;
  IF (SELECT count(*) FROM storage_deletion_jobs WHERE object_key IN('drain/survivor','drain/survivor-vault')
    AND available_at>=now()+interval '2 hours')<>2 THEN
    RAISE EXCEPTION 'later survivor deletion lost the original write deadline';
  END IF;
END $$;
DELETE FROM files WHERE id='drain_survivor';
UPDATE tree_operation_jobs SET status='complete' WHERE id=:later_job;
ROLLBACK;
