\set ON_ERROR_STOP on
BEGIN;
INSERT INTO users(id, username, password_hash, role)
VALUES ('usr_multipart_audit', 'multipart_audit', 'unused', 'user');
INSERT INTO multipart_reconciliation_progress(namespace, lease_token, lease_until, key_marker, upload_id_marker)
VALUES ('audit-multipart', 'leader-one', now() + interval '120 seconds', 'saved-key', 'saved-upload');
INSERT INTO file_uploads(id, file_id, owner_id, original_name, object_key, size_bytes, upload_mode,
 multipart_upload_id, status, expires_at) VALUES
 ('up_audit_active', 'fil_audit_active', 'usr_multipart_audit', 'active', 'users/a/files/active', 1, 'multipart', 'active-id', 'pending', now() - interval '1 hour'),
 ('up_audit_protected', 'fil_audit_protected', 'usr_multipart_audit', 'protected', 'users/a/files/protected', 1, 'multipart', 'other-id', 'pending', now() + interval '1 hour'),
 ('up_audit_adopt', 'fil_audit_adopt', 'usr_multipart_audit', 'adopt', 'users/a/files/adopt', 1, 'multipart', NULL, 'initializing', now() + interval '1 hour'),
 ('up_audit_expired', 'fil_audit_expired', 'usr_multipart_audit', 'expired', 'users/a/files/expired', 1, 'multipart', 'other-id', 'pending', now() - interval '1 hour');
INSERT INTO vault_uploads(id,node_id,owner_id,entry_type,generation_number,generation_id,object_key,
 ciphertext_length,chunk_count,upload_mode,multipart_upload_id,status,expires_at,write_expires_at)
VALUES ('up_audit_vault','fil_audit_vault','usr_multipart_audit','file',1,decode(repeat('11',16),'hex'),
 'users/a/vault/adopt',1,1,'multipart',NULL,'initializing',now()+interval '1 hour',NULL),
 ('up_audit_vault_protected','fil_audit_vault_protected','usr_multipart_audit','file',1,decode(repeat('22',16),'hex'),
 'users/a/vault/protected',1,1,'multipart','other','pending',now()-interval '1 hour',now()+interval '1 hour');
DO $$
DECLARE result bigint;
BEGIN
 SELECT prepare_multipart_orphan_group('audit-multipart','leader-one',
 ARRAY['users/a/files/active','users/a/files/protected','users/a/files/adopt','users/a/files/expired',
       'users/a/files/orphan','users/a/vault/adopt','users/a/vault/protected'],
 ARRAY['active-id','orphan-id','adopt-id','orphan-id','orphan-id','vault-adopt-id','orphan-id']) INTO result;
 IF result <> 2 THEN RAISE EXCEPTION 'expected 2 true orphans, got %', result; END IF;
 IF (SELECT multipart_upload_id FROM file_uploads WHERE id='up_audit_adopt') <> 'adopt-id'
   THEN RAISE EXCEPTION 'live file intent was not adopted'; END IF;
 IF (SELECT multipart_upload_id FROM vault_uploads WHERE id='up_audit_vault') <> 'vault-adopt-id'
   THEN RAISE EXCEPTION 'live vault intent was not adopted'; END IF;
 -- A replay after crashing before page checkpoint must not duplicate queued aborts.
 SELECT prepare_multipart_orphan_group('audit-multipart','leader-one',
 ARRAY['users/a/files/orphan'], ARRAY['orphan-id']) INTO result;
 IF result <> 0 THEN RAISE EXCEPTION 'replayed page duplicated cleanup'; END IF;
 BEGIN
   INSERT INTO file_uploads(id,file_id,owner_id,original_name,object_key,size_bytes,upload_mode,status,expires_at)
   VALUES ('up_audit_late','fil_audit_late','usr_multipart_audit','late','users/a/files/orphan',1,'multipart','initializing',now()+interval '1 hour');
   RAISE EXCEPTION 'late initialization crossed orphan fence';
 EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
 END;
 -- Fence survives leader/abort lease expiry until provider abort has completed.
 UPDATE multipart_orphan_abort_claims SET lease_until=now()-interval '1 hour' WHERE namespace='audit-multipart';
 BEGIN
   UPDATE file_uploads SET multipart_upload_id='orphan-id', expires_at=now()+interval '1 hour' WHERE id='up_audit_expired';
   RAISE EXCEPTION 'expired worker lease reopened aborting upload';
 EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
 END;
 -- A live different provider upload may continue while its orphan sibling is removed.
 UPDATE file_uploads SET expires_at=now()+interval '1 hour' WHERE id='up_audit_expired';
 UPDATE multipart_reconciliation_progress SET lease_token='leader-two' WHERE namespace='audit-multipart';
 BEGIN
   PERFORM prepare_multipart_orphan_group('audit-multipart','leader-one',ARRAY['users/a/files/late'],ARRAY['late-id']);
   RAISE EXCEPTION 'stale leader prepared destructive work';
 EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
 END;
 IF (SELECT key_marker FROM multipart_reconciliation_progress WHERE namespace='audit-multipart') <> 'saved-key'
   THEN RAISE EXCEPTION 'leader failover lost checkpoint'; END IF;
 -- 64 orphans are prepared by one bounded call.
 SELECT prepare_multipart_orphan_group('audit-multipart','leader-two',
   ARRAY(SELECT 'users/a/files/many/'||id FROM generate_series(1,64) AS id),
   ARRAY(SELECT 'upload-'||id FROM generate_series(1,64) AS id)) INTO result;
 IF result<>64 THEN RAISE EXCEPTION '64-candidate batch lost work'; END IF;
 RAISE NOTICE 'PASS: mixed active/adopt/orphan decisions, replay, durable fencing, stale leader, checkpoint and 64-candidate batch';
END;
$$;
ROLLBACK;
