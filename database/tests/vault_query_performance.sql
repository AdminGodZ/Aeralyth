\set ON_ERROR_STOP on

BEGIN;

SET LOCAL synchronous_commit = off;

DO $schema_assertions$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE NOT tgisinternal
      AND tgname IN (
        'vault_share_envelope_epoch_guard',
        'vault_share_wrapper_epoch_guard'
      )
  ) THEN
    RAISE EXCEPTION 'legacy row-level share epoch guard still exists';
  END IF;

  IF (
    SELECT count(*)
    FROM pg_trigger
    WHERE NOT tgisinternal
      AND tgname IN (
        'vault_share_envelope_epoch_guard_insert',
        'vault_share_envelope_epoch_guard_update',
        'vault_share_wrapper_epoch_guard_insert',
        'vault_share_wrapper_epoch_guard_update'
      )
      AND (tgtype & 1) = 0
  ) <> 4 THEN
    RAISE EXCEPTION 'share epoch guards are not four statement-level triggers';
  END IF;

  IF (
    SELECT count(*)
    FROM pg_index
    INNER JOIN pg_class AS indexes ON indexes.oid = pg_index.indexrelid
    WHERE indexes.relname IN (
      'file_uploads_global_expiry_idx',
      'vault_uploads_global_expiry_idx',
      'vault_share_envelopes_recipient_latest_idx'
    )
      AND pg_index.indisvalid
  ) <> 3 THEN
    RAISE EXCEPTION 'one or more vault hot-path indexes are missing or invalid';
  END IF;
END
$schema_assertions$;

INSERT INTO users (id, username, password_hash, role, status)
VALUES ('usr_vault_perf', 'vault_perf_recipient', 'not-a-login-hash', 'user', 'active');

INSERT INTO files (
  id, owner_id, original_name, storage_name, size_bytes, entry_type
) VALUES (
  'fil_vault_perf_root',
  'usr_admingod',
  'vault-performance-root',
  'vault-performance/root',
  0,
  'folder'
);

INSERT INTO files (
  id, owner_id, original_name, storage_name, size_bytes, entry_type
)
SELECT
  'fil_vault_perf_' || value,
  'usr_admingod',
  'node-' || value,
  'vault-performance/node-' || value,
  0,
  'folder'
FROM generate_series(1, 10002) AS value;

INSERT INTO vault_identity_keys (
  user_id, key_version, x25519_public_key, ed25519_public_key,
  fingerprint_sha256, status
) VALUES
  (
    'usr_admingod', 1,
    digest('vault-perf-owner-x25519', 'sha256'),
    digest('vault-perf-owner-ed25519', 'sha256'),
    digest('vault-perf-owner-fingerprint', 'sha256'),
    'active'
  ),
  (
    'usr_vault_perf', 1,
    digest('vault-perf-recipient-x25519', 'sha256'),
    digest('vault-perf-recipient-ed25519', 'sha256'),
    digest('vault-perf-recipient-fingerprint', 'sha256'),
    'active'
  );

INSERT INTO vault_shares (
  id, owner_id, root_node_id, active_epoch, status
) VALUES (
  'shr_vault_perf', 'usr_admingod', 'fil_vault_perf_root', 1, 'active'
);

INSERT INTO vault_share_epochs (share_id, epoch, status, published_at)
VALUES ('shr_vault_perf', 1, 'published', now());

DO $wrapper_statement_test$
DECLARE
  insert_plan JSON;
  guard_calls INTEGER;
BEGIN
  EXECUTE $explain$
    EXPLAIN (ANALYZE, FORMAT JSON, COSTS OFF, TIMING OFF, SUMMARY OFF)
    INSERT INTO vault_share_wrappers (
      wrapper_id, share_id, epoch, node_id, generation_id,
      wrapper_kind, record_version, canonical_cbor, wrapper_hash
    )
    SELECT
      decode(md5('vault-perf-wrapper-' || value), 'hex'),
      'shr_vault_perf',
      1,
      'fil_vault_perf_' || value,
      NULL,
      'metadata',
      1,
      decode(repeat('ab', 64), 'hex'),
      digest('vault-perf-wrapper-hash-' || value, 'sha256')
    FROM generate_series(1, 10000) AS value
  $explain$
  INTO insert_plan;

  SELECT count(*)
  INTO guard_calls
  FROM json_array_elements(COALESCE(insert_plan->0->'Triggers', '[]'::json)) AS trigger_data
  WHERE trigger_data->>'Trigger Name' = 'vault_share_wrapper_epoch_guard_insert'
    AND (trigger_data->>'Calls')::integer = 1;

  IF guard_calls <> 1 THEN
    RAISE EXCEPTION '10,000 wrappers did not invoke one statement epoch guard: %', insert_plan;
  END IF;
  IF (SELECT count(*) FROM vault_share_wrappers WHERE share_id = 'shr_vault_perf') <> 10000 THEN
    RAISE EXCEPTION 'bulk wrapper fixture was not inserted completely';
  END IF;
END
$wrapper_statement_test$;

DO $envelope_statement_test$
DECLARE
  insert_plan JSON;
  guard_calls INTEGER;
BEGIN
  EXECUTE $explain$
    EXPLAIN (ANALYZE, FORMAT JSON, COSTS OFF, TIMING OFF, SUMMARY OFF)
    INSERT INTO vault_share_envelopes (
      envelope_id, share_id, epoch, sender_id, sender_key_version,
      recipient_id, recipient_key_version, node_id, permissions,
      generation_scope, record_version, previous_record_hash,
      encapsulated_key, ciphertext, canonical_cbor, signature,
      envelope_hash, created_at
    )
    SELECT
      decode(md5('vault-perf-envelope-' || value), 'hex'),
      'shr_vault_perf',
      1,
      'usr_admingod',
      1,
      'usr_vault_perf',
      1,
      'fil_vault_perf_root',
      'read',
      NULL,
      1,
      NULL,
      digest('vault-perf-encapsulated-key', 'sha256'),
      decode(repeat('cd', 48), 'hex'),
      decode(repeat('ef', 128), 'hex'),
      decode(repeat('12', 64), 'hex'),
      digest('vault-perf-envelope-hash-' || value, 'sha256'),
      timestamptz '2026-01-01 00:00:00+00' + value * interval '1 microsecond'
    FROM generate_series(1, 100000) AS value
  $explain$
  INTO insert_plan;

  SELECT count(*)
  INTO guard_calls
  FROM json_array_elements(COALESCE(insert_plan->0->'Triggers', '[]'::json)) AS trigger_data
  WHERE trigger_data->>'Trigger Name' = 'vault_share_envelope_epoch_guard_insert'
    AND (trigger_data->>'Calls')::integer = 1;

  IF guard_calls <> 1 THEN
    RAISE EXCEPTION '100,000 envelopes did not invoke one statement epoch guard: %', insert_plan;
  END IF;
END
$envelope_statement_test$;

ANALYZE vault_share_envelopes;

DO $envelope_lookup_plan$
DECLARE
  lookup_plan JSON;
BEGIN
  EXECUTE $explain$
    EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON, COSTS OFF, TIMING OFF, SUMMARY OFF)
    SELECT envelopes.canonical_cbor, envelopes.signature,
           envelopes.envelope_hash, envelopes.sender_key_version,
           envelopes.recipient_key_version, envelopes.sender_id,
           envelopes.recipient_id, envelopes.node_id,
           envelopes.record_version, envelopes.previous_record_hash,
           sender.x25519_public_key, sender.ed25519_public_key,
           sender.fingerprint_sha256
    FROM vault_share_envelopes AS envelopes
    INNER JOIN vault_identity_keys AS sender
      ON sender.user_id = envelopes.sender_id
     AND sender.key_version = envelopes.sender_key_version
    WHERE envelopes.share_id = 'shr_vault_perf'
      AND envelopes.epoch = 1
      AND envelopes.recipient_id = 'usr_vault_perf'
    ORDER BY envelopes.created_at DESC, envelopes.envelope_id DESC
    LIMIT 1
  $explain$
  INTO lookup_plan;

  IF lookup_plan::text NOT LIKE '%vault_share_envelopes_recipient_latest_idx%' THEN
    RAISE EXCEPTION 'latest-envelope lookup missed its composite index: %', lookup_plan;
  END IF;
  IF lookup_plan::text ~ '"Node Type"\s*:\s*"Sort"' THEN
    RAISE EXCEPTION 'latest-envelope lookup still performs a sort: %', lookup_plan;
  END IF;
END
$envelope_lookup_plan$;

UPDATE vault_shares
SET publication_fenced = TRUE
WHERE id = 'shr_vault_perf';

DO $fenced_guard_test$
BEGIN
  BEGIN
    INSERT INTO vault_share_wrappers (
      wrapper_id, share_id, epoch, node_id, wrapper_kind,
      record_version, canonical_cbor, wrapper_hash
    ) VALUES (
      decode(md5('vault-perf-fenced-wrapper'), 'hex'),
      'shr_vault_perf', 1, 'fil_vault_perf_10001', 'metadata', 1,
      decode(repeat('34', 64), 'hex'),
      digest('vault-perf-fenced-wrapper-hash', 'sha256')
    );
    RAISE EXCEPTION 'fenced active-epoch wrapper was accepted';
  EXCEPTION
    WHEN raise_exception THEN
      IF SQLERRM <> 'old share epoch is fenced' THEN
        RAISE;
      END IF;
  END;
END
$fenced_guard_test$;

UPDATE vault_shares
SET publication_fenced = FALSE,
    pending_epoch = 2,
    status = 'rotating'
WHERE id = 'shr_vault_perf';

INSERT INTO vault_share_epochs (share_id, epoch, status)
VALUES
  ('shr_vault_perf', 2, 'pending'),
  ('shr_vault_perf', 3, 'pending');

INSERT INTO vault_share_wrappers (
  wrapper_id, share_id, epoch, node_id, wrapper_kind,
  record_version, canonical_cbor, wrapper_hash
) VALUES (
  decode(md5('vault-perf-pending-wrapper'), 'hex'),
  'shr_vault_perf', 2, 'fil_vault_perf_10001', 'metadata', 1,
  decode(repeat('56', 64), 'hex'),
  digest('vault-perf-pending-wrapper-hash', 'sha256')
);

DO $invalid_epoch_test$
BEGIN
  BEGIN
    INSERT INTO vault_share_wrappers (
      wrapper_id, share_id, epoch, node_id, wrapper_kind,
      record_version, canonical_cbor, wrapper_hash
    ) VALUES (
      decode(md5('vault-perf-invalid-epoch-wrapper'), 'hex'),
      'shr_vault_perf', 3, 'fil_vault_perf_10002', 'metadata', 1,
      decode(repeat('78', 64), 'hex'),
      digest('vault-perf-invalid-epoch-wrapper-hash', 'sha256')
    );
    RAISE EXCEPTION 'non-active, non-pending share epoch was accepted';
  EXCEPTION
    WHEN raise_exception THEN
      IF SQLERRM <> 'share epoch is not active or pending' THEN
        RAISE;
      END IF;
  END;
END
$invalid_epoch_test$;

UPDATE vault_shares
SET status = 'revoked'
WHERE id = 'shr_vault_perf';

DO $revoked_update_test$
BEGIN
  BEGIN
    UPDATE vault_share_wrappers
    SET canonical_cbor = canonical_cbor
    WHERE wrapper_id = decode(md5('vault-perf-wrapper-1'), 'hex');
    RAISE EXCEPTION 'revoked share wrapper update was accepted';
  EXCEPTION
    WHEN raise_exception THEN
      IF SQLERRM <> 'share is not writable' THEN
        RAISE;
      END IF;
  END;
END
$revoked_update_test$;

INSERT INTO file_uploads (
  id, file_id, owner_id, original_name, object_key,
  size_bytes, upload_mode, status, expires_at
)
SELECT
  'upl_expiry_perf_' || value,
  'fil_expiry_perf_' || value,
  'usr_admingod',
  'expiry-' || value,
  'vault-query-performance/file-upload-' || value,
  0,
  'local',
  CASE
    WHEN value <= 1000 THEN
      (ARRAY['initializing', 'pending', 'aborting'])[((value - 1) % 3) + 1]
    ELSE 'completed'
  END,
  CASE
    WHEN value <= 1000 THEN now() - value * interval '1 second'
    ELSE now() + interval '1 day'
  END
FROM generate_series(1, 100000) AS value;

INSERT INTO vault_uploads (
  id, node_id, owner_id, entry_type, generation_number,
  generation_id, ciphertext_length, chunk_count, upload_mode,
  status, expires_at
)
SELECT
  'vup_expiry_perf_' || value,
  'nod_expiry_perf_' || value,
  'usr_admingod',
  'folder',
  1,
  decode(md5('vault-expiry-generation-' || value), 'hex'),
  0,
  0,
  'none',
  CASE
    WHEN value <= 1000 THEN
      (ARRAY['initializing', 'pending', 'completing', 'aborting'])[((value - 1) % 4) + 1]
    ELSE 'published'
  END,
  CASE
    WHEN value <= 1000 THEN now() - value * interval '1 second'
    ELSE now() + interval '1 day'
  END
FROM generate_series(1, 100000) AS value;

ANALYZE file_uploads;
ANALYZE vault_uploads;

DO $expiry_plans$
DECLARE
  file_plan JSON;
  vault_plan JSON;
BEGIN
  EXECUTE $explain$
    EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON, COSTS OFF, TIMING OFF, SUMMARY OFF)
    SELECT id
    FROM file_uploads
    WHERE status IN ('initializing', 'pending', 'aborting')
      AND expires_at <= now()
    ORDER BY expires_at, id
    LIMIT 25
    FOR UPDATE SKIP LOCKED
  $explain$
  INTO file_plan;

  EXECUTE $explain$
    EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON, COSTS OFF, TIMING OFF, SUMMARY OFF)
    SELECT id
    FROM vault_uploads
    WHERE status IN ('initializing', 'pending', 'completing', 'aborting')
      AND expires_at <= now()
    ORDER BY expires_at, id
    LIMIT 25
    FOR UPDATE SKIP LOCKED
  $explain$
  INTO vault_plan;

  IF file_plan::text NOT LIKE '%file_uploads_global_expiry_idx%'
     OR file_plan::text ~ '"Node Type"\s*:\s*"Sort"' THEN
    RAISE EXCEPTION 'file upload expiry claim is not a narrow ordered index scan: %', file_plan;
  END IF;
  IF vault_plan::text NOT LIKE '%vault_uploads_global_expiry_idx%'
     OR vault_plan::text ~ '"Node Type"\s*:\s*"Sort"' THEN
    RAISE EXCEPTION 'vault upload expiry claim is not a narrow ordered index scan: %', vault_plan;
  END IF;
END
$expiry_plans$;

ROLLBACK;
