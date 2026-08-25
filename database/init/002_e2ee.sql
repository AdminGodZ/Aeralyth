-- Aeralyth encrypted vault protocol, format version 1.
-- This migration is immutable and recorded once in schema_migrations.

\set ON_ERROR_STOP on

BEGIN;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

SELECT pg_advisory_xact_lock(hashtextextended('aeralyth:migration:002-e2ee', 0));

SELECT NOT EXISTS (
  SELECT 1 FROM schema_migrations WHERE version = '002-e2ee'
) AS apply_migration \gset

\if :apply_migration

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS vault_auto_lock_minutes INTEGER NOT NULL DEFAULT 15;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_vault_auto_lock_minutes_check'
  ) THEN
    ALTER TABLE users
      ADD CONSTRAINT users_vault_auto_lock_minutes_check
      CHECK (vault_auto_lock_minutes IN (5, 15, 30, 60));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS user_vaults (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'recovery_pending')),
  format_version SMALLINT NOT NULL DEFAULT 1 CHECK (format_version = 1),
  vault_version BIGINT NOT NULL DEFAULT 1 CHECK (vault_version > 0),
  kdf_algorithm TEXT NOT NULL CHECK (kdf_algorithm = 'argon2id13'),
  kdf_salt BYTEA NOT NULL CHECK (octet_length(kdf_salt) = 16),
  kdf_operations BIGINT NOT NULL CHECK (kdf_operations = 3),
  kdf_memory_bytes BIGINT NOT NULL CHECK (kdf_memory_bytes = 268435456),
  kdf_output_bytes INTEGER NOT NULL CHECK (kdf_output_bytes = 32),
  password_wrapper_id BYTEA NOT NULL UNIQUE CHECK (octet_length(password_wrapper_id) = 16),
  password_root_ciphertext BYTEA NOT NULL CHECK (octet_length(password_root_ciphertext) = 48),
  recovery_salt BYTEA NOT NULL CHECK (octet_length(recovery_salt) = 16),
  recovery_wrapper_id BYTEA NOT NULL UNIQUE CHECK (octet_length(recovery_wrapper_id) = 16),
  recovery_root_ciphertext BYTEA NOT NULL CHECK (octet_length(recovery_root_ciphertext) = 48),
  identity_record_id BYTEA NOT NULL UNIQUE CHECK (octet_length(identity_record_id) = 16),
  identity_private_ciphertext BYTEA NOT NULL CHECK (octet_length(identity_private_ciphertext) BETWEEN 96 AND 8192),
  encrypted_account_state BYTEA NOT NULL DEFAULT '\x'::bytea
    CHECK (octet_length(encrypted_account_state) <= 16384),
  account_state_record_id BYTEA CHECK (account_state_record_id IS NULL OR octet_length(account_state_record_id) = 16),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  recovered_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS vault_identity_keys (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key_version BIGINT NOT NULL CHECK (key_version > 0),
  x25519_public_key BYTEA NOT NULL CHECK (octet_length(x25519_public_key) = 32),
  ed25519_public_key BYTEA NOT NULL CHECK (octet_length(ed25519_public_key) = 32),
  fingerprint_sha256 BYTEA NOT NULL CHECK (octet_length(fingerprint_sha256) = 32),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired', 'revoked')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  retired_at TIMESTAMPTZ,
  PRIMARY KEY (user_id, key_version),
  UNIQUE (fingerprint_sha256)
);

CREATE UNIQUE INDEX IF NOT EXISTS vault_identity_one_active_key
  ON vault_identity_keys (user_id)
  WHERE status = 'active';

CREATE TABLE IF NOT EXISTS vault_identity_trust (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  peer_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  peer_key_version BIGINT NOT NULL,
  fingerprint_sha256 BYTEA NOT NULL CHECK (octet_length(fingerprint_sha256) = 32),
  status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'blocked')),
  accepted_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, peer_user_id),
  FOREIGN KEY (peer_user_id, peer_key_version)
    REFERENCES vault_identity_keys(user_id, key_version) ON DELETE CASCADE,
  CHECK (user_id <> peer_user_id)
);

ALTER TABLE files
  ADD COLUMN IF NOT EXISTS e2ee_state TEXT NOT NULL DEFAULT 'legacy';

ALTER TABLE files
  ADD COLUMN IF NOT EXISTS current_generation_number BIGINT;

ALTER TABLE files
  ADD COLUMN IF NOT EXISTS current_generation_id BYTEA;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'files_e2ee_state_check'
  ) THEN
    ALTER TABLE files
      ADD CONSTRAINT files_e2ee_state_check
      CHECK (e2ee_state IN ('legacy', 'staged', 'encrypted'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'files_generation_id_check'
  ) THEN
    ALTER TABLE files
      ADD CONSTRAINT files_generation_id_check
      CHECK (current_generation_id IS NULL OR octet_length(current_generation_id) = 16);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS vault_uploads (
  id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  parent_id TEXT REFERENCES files(id) ON DELETE CASCADE,
  entry_type TEXT NOT NULL CHECK (entry_type IN ('file', 'folder')),
  generation_number BIGINT NOT NULL CHECK (generation_number > 0),
  generation_id BYTEA NOT NULL CHECK (octet_length(generation_id) = 16),
  object_key TEXT UNIQUE,
  ciphertext_length BIGINT NOT NULL CHECK (ciphertext_length BETWEEN 0 AND 2415919104),
  crypto_chunk_bytes INTEGER NOT NULL DEFAULT 4194304 CHECK (crypto_chunk_bytes = 4194304),
  chunk_count INTEGER NOT NULL CHECK (chunk_count BETWEEN 0 AND 513),
  upload_mode TEXT NOT NULL CHECK (upload_mode IN ('none', 'single', 'multipart')),
  part_size_bytes BIGINT CHECK (part_size_bytes IS NULL OR part_size_bytes = 33554432),
  multipart_upload_id TEXT,
  checksum_sha256 TEXT,
  status TEXT NOT NULL DEFAULT 'initializing'
    CHECK (status IN ('initializing', 'pending', 'completing', 'published', 'aborting', 'aborted')),
  write_expires_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + interval '24 hours',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at TIMESTAMPTZ,
  UNIQUE (owner_id, node_id, generation_number),
  UNIQUE (owner_id, node_id, generation_id),
  CHECK ((entry_type = 'folder') = (upload_mode = 'none')),
  CHECK ((upload_mode = 'none') = (object_key IS NULL)),
  CHECK ((upload_mode = 'none') = (ciphertext_length = 0))
);

ALTER TABLE vault_uploads
  ADD COLUMN IF NOT EXISTS checksum_sha256 TEXT;

CREATE TABLE IF NOT EXISTS vault_node_records (
  node_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  record_version BIGINT NOT NULL CHECK (record_version > 0),
  record_hash BYTEA NOT NULL CHECK (octet_length(record_hash) = 32),
  previous_record_hash BYTEA CHECK (previous_record_hash IS NULL OR octet_length(previous_record_hash) = 32),
  bootstrap_cbor BYTEA NOT NULL CHECK (octet_length(bootstrap_cbor) BETWEEN 128 AND 65536),
  bootstrap_signature BYTEA NOT NULL CHECK (octet_length(bootstrap_signature) = 64),
  encrypted_manifest BYTEA NOT NULL CHECK (octet_length(encrypted_manifest) BETWEEN 16 AND 1048576),
  manifest_hash BYTEA NOT NULL CHECK (octet_length(manifest_hash) = 32),
  signer_key_version BIGINT NOT NULL CHECK (signer_key_version > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (node_id, record_version),
  UNIQUE (record_hash),
  FOREIGN KEY (owner_id, signer_key_version)
    REFERENCES vault_identity_keys(user_id, key_version)
);

CREATE TABLE IF NOT EXISTS vault_node_heads (
  node_id TEXT PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  record_version BIGINT NOT NULL CHECK (record_version > 0),
  record_hash BYTEA NOT NULL CHECK (octet_length(record_hash) = 32),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (node_id, record_version)
    REFERENCES vault_node_records(node_id, record_version),
  UNIQUE (node_id, record_hash)
);

CREATE TABLE IF NOT EXISTS vault_wrappers (
  wrapper_id BYTEA PRIMARY KEY CHECK (octet_length(wrapper_id) = 16),
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  parent_node_id TEXT REFERENCES files(id) ON DELETE CASCADE,
  wrapper_kind TEXT NOT NULL CHECK (wrapper_kind IN ('account_root', 'parent_node')),
  record_version BIGINT NOT NULL CHECK (record_version > 0),
  canonical_cbor BYTEA NOT NULL CHECK (octet_length(canonical_cbor) BETWEEN 64 AND 65536),
  wrapper_hash BYTEA NOT NULL CHECK (octet_length(wrapper_hash) = 32),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (node_id, record_version, wrapper_kind),
  UNIQUE (wrapper_hash)
);

CREATE TABLE IF NOT EXISTS vault_object_generations (
  node_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  generation_number BIGINT NOT NULL CHECK (generation_number > 0),
  generation_id BYTEA NOT NULL CHECK (octet_length(generation_id) = 16),
  object_key TEXT NOT NULL UNIQUE,
  ciphertext_length BIGINT NOT NULL CHECK (ciphertext_length BETWEEN 1 AND 2415919104),
  crypto_chunk_bytes INTEGER NOT NULL DEFAULT 4194304 CHECK (crypto_chunk_bytes = 4194304),
  chunk_count INTEGER NOT NULL CHECK (chunk_count BETWEEN 1 AND 513),
  ciphertext_merkle_root BYTEA NOT NULL CHECK (octet_length(ciphertext_merkle_root) = 32),
  status TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('published', 'retired')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  retired_at TIMESTAMPTZ,
  PRIMARY KEY (node_id, generation_number),
  UNIQUE (node_id, generation_id)
);

CREATE TABLE IF NOT EXISTS vault_shares (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  root_node_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  permissions TEXT NOT NULL DEFAULT 'read' CHECK (permissions = 'read'),
  active_epoch BIGINT NOT NULL DEFAULT 1 CHECK (active_epoch > 0),
  pending_epoch BIGINT CHECK (pending_epoch IS NULL OR pending_epoch > active_epoch),
  publication_fenced BOOLEAN NOT NULL DEFAULT FALSE,
  fence_snapshot_hash BYTEA CHECK (fence_snapshot_hash IS NULL OR octet_length(fence_snapshot_hash) = 32),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'rotating', 'revoked')),
  record_version BIGINT NOT NULL DEFAULT 1 CHECK (record_version > 0),
  record_hash BYTEA CHECK (record_hash IS NULL OR octet_length(record_hash) = 32),
  previous_record_hash BYTEA CHECK (previous_record_hash IS NULL OR octet_length(previous_record_hash) = 32),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ
);

ALTER TABLE vault_shares
  ADD COLUMN IF NOT EXISTS record_hash BYTEA;

CREATE TABLE IF NOT EXISTS vault_share_pending_revocations (
  share_id TEXT NOT NULL REFERENCES vault_shares(id) ON DELETE CASCADE,
  pending_epoch BIGINT NOT NULL,
  recipient_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (share_id, pending_epoch, recipient_id)
);

CREATE TABLE IF NOT EXISTS vault_share_epochs (
  share_id TEXT NOT NULL REFERENCES vault_shares(id) ON DELETE CASCADE,
  epoch BIGINT NOT NULL CHECK (epoch > 0),
  status TEXT NOT NULL CHECK (status IN ('pending', 'published', 'retired')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at TIMESTAMPTZ,
  retired_at TIMESTAMPTZ,
  PRIMARY KEY (share_id, epoch)
);

ALTER TABLE vault_share_epochs
  ADD COLUMN IF NOT EXISTS protocol_version SMALLINT NOT NULL DEFAULT 1;

ALTER TABLE vault_share_epochs
  ADD COLUMN IF NOT EXISTS wrapper_set_root BYTEA;

ALTER TABLE vault_share_epochs
  ADD COLUMN IF NOT EXISTS wrapper_count INTEGER;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'vault_share_epochs_wrapper_commitment_check'
      AND conrelid = 'vault_share_epochs'::regclass
  ) THEN
    ALTER TABLE vault_share_epochs
      ADD CONSTRAINT vault_share_epochs_wrapper_commitment_check CHECK (
        (protocol_version = 1 AND wrapper_set_root IS NULL AND wrapper_count IS NULL)
        OR (
          protocol_version = 2
          AND wrapper_set_root IS NOT NULL
          AND octet_length(wrapper_set_root) = 32
          AND wrapper_count IS NOT NULL
          AND wrapper_count BETWEEN 1 AND 100000
        )
      );
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS vault_share_owner_keys (
  share_id TEXT NOT NULL,
  epoch BIGINT NOT NULL,
  wrapper_id BYTEA NOT NULL UNIQUE CHECK (octet_length(wrapper_id) = 16),
  root_ciphertext BYTEA NOT NULL CHECK (octet_length(root_ciphertext) = 48),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (share_id, epoch),
  FOREIGN KEY (share_id, epoch)
    REFERENCES vault_share_epochs(share_id, epoch) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS vault_share_recipients (
  share_id TEXT NOT NULL REFERENCES vault_shares(id) ON DELETE CASCADE,
  recipient_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient_key_version BIGINT NOT NULL CHECK (recipient_key_version > 0),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ,
  PRIMARY KEY (share_id, recipient_id),
  FOREIGN KEY (recipient_id, recipient_key_version)
    REFERENCES vault_identity_keys(user_id, key_version)
);

CREATE TABLE IF NOT EXISTS vault_share_envelopes (
  envelope_id BYTEA PRIMARY KEY CHECK (octet_length(envelope_id) = 16),
  share_id TEXT NOT NULL,
  epoch BIGINT NOT NULL,
  sender_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sender_key_version BIGINT NOT NULL CHECK (sender_key_version > 0),
  recipient_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient_key_version BIGINT NOT NULL CHECK (recipient_key_version > 0),
  node_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  permissions TEXT NOT NULL CHECK (permissions = 'read'),
  generation_scope BIGINT,
  record_version BIGINT NOT NULL CHECK (record_version > 0),
  previous_record_hash BYTEA CHECK (previous_record_hash IS NULL OR octet_length(previous_record_hash) = 32),
  encapsulated_key BYTEA NOT NULL CHECK (octet_length(encapsulated_key) = 32),
  ciphertext BYTEA NOT NULL CHECK (octet_length(ciphertext) BETWEEN 48 AND 65536),
  canonical_cbor BYTEA NOT NULL CHECK (octet_length(canonical_cbor) BETWEEN 128 AND 131072),
  signature BYTEA NOT NULL CHECK (octet_length(signature) = 64),
  envelope_hash BYTEA NOT NULL UNIQUE CHECK (octet_length(envelope_hash) = 32),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (share_id, epoch) REFERENCES vault_share_epochs(share_id, epoch),
  FOREIGN KEY (sender_id, sender_key_version)
    REFERENCES vault_identity_keys(user_id, key_version),
  FOREIGN KEY (recipient_id, recipient_key_version)
    REFERENCES vault_identity_keys(user_id, key_version)
);

CREATE INDEX IF NOT EXISTS vault_share_envelopes_recipient_latest_idx
  ON vault_share_envelopes (
    share_id, epoch, recipient_id, created_at DESC, envelope_id DESC
  );

CREATE TABLE IF NOT EXISTS vault_share_wrappers (
  wrapper_id BYTEA PRIMARY KEY CHECK (octet_length(wrapper_id) = 16),
  share_id TEXT NOT NULL,
  epoch BIGINT NOT NULL,
  node_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  generation_id BYTEA CHECK (generation_id IS NULL OR octet_length(generation_id) = 16),
  wrapper_kind TEXT NOT NULL CHECK (wrapper_kind IN ('generation_dek', 'metadata')),
  record_version BIGINT NOT NULL DEFAULT 1 CHECK (record_version > 0),
  canonical_cbor BYTEA NOT NULL CHECK (octet_length(canonical_cbor) BETWEEN 64 AND 65536),
  wrapper_hash BYTEA NOT NULL UNIQUE CHECK (octet_length(wrapper_hash) = 32),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (share_id, epoch) REFERENCES vault_share_epochs(share_id, epoch),
  UNIQUE (share_id, epoch, node_id, generation_id, wrapper_kind)
);

ALTER TABLE vault_share_wrappers
  ADD COLUMN IF NOT EXISTS record_version BIGINT NOT NULL DEFAULT 1;

ALTER TABLE vault_share_wrappers
  ADD COLUMN IF NOT EXISTS merkle_leaf_index INTEGER;

ALTER TABLE vault_share_wrappers
  ADD COLUMN IF NOT EXISTS merkle_proof BYTEA;

ALTER TABLE vault_share_wrappers
  ADD COLUMN IF NOT EXISTS commitment_source TEXT NOT NULL DEFAULT 'epoch';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'vault_share_wrappers_merkle_proof_check'
      AND conrelid = 'vault_share_wrappers'::regclass
  ) THEN
    ALTER TABLE vault_share_wrappers
      ADD CONSTRAINT vault_share_wrappers_merkle_proof_check CHECK (
        (merkle_leaf_index IS NULL AND merkle_proof IS NULL)
        OR (
          merkle_leaf_index IS NOT NULL
          AND merkle_proof IS NOT NULL
          AND merkle_leaf_index >= 0
          AND octet_length(merkle_proof) % 32 = 0
          AND octet_length(merkle_proof) <= 448
        )
      );
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'vault_share_wrappers_commitment_source_check'
      AND conrelid = 'vault_share_wrappers'::regclass
  ) THEN
    ALTER TABLE vault_share_wrappers
      ADD CONSTRAINT vault_share_wrappers_commitment_source_check CHECK (
        commitment_source IN ('bootstrap', 'epoch', 'directory')
      );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS vault_share_wrappers_current_idx
  ON vault_share_wrappers (share_id, epoch, node_id, wrapper_kind, record_version DESC);

CREATE TABLE IF NOT EXISTS vault_share_wrapper_directories (
  node_id TEXT NOT NULL,
  record_version BIGINT NOT NULL CHECK (record_version > 0),
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  signer_key_version BIGINT NOT NULL CHECK (signer_key_version > 0),
  canonical_cbor BYTEA NOT NULL CHECK (octet_length(canonical_cbor) BETWEEN 96 AND 4096),
  signature BYTEA NOT NULL CHECK (octet_length(signature) = 64),
  wrapper_set_root BYTEA NOT NULL CHECK (octet_length(wrapper_set_root) = 32),
  wrapper_count INTEGER NOT NULL CHECK (wrapper_count BETWEEN 1 AND 100000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (node_id, record_version),
  FOREIGN KEY (node_id, record_version)
    REFERENCES vault_node_records(node_id, record_version) ON DELETE CASCADE,
  FOREIGN KEY (owner_id, signer_key_version)
    REFERENCES vault_identity_keys(user_id, key_version)
);

CREATE TABLE IF NOT EXISTS vault_share_sync_jobs (
  node_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  record_version BIGINT NOT NULL CHECK (record_version > 0),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (node_id, record_version)
    REFERENCES vault_node_records(node_id, record_version) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS vault_share_sync_jobs_owner_idx
  ON vault_share_sync_jobs (owner_id, updated_at, node_id);

CREATE TABLE IF NOT EXISTS vault_revocation_cutoffs (
  share_id TEXT NOT NULL REFERENCES vault_shares(id) ON DELETE CASCADE,
  retired_epoch BIGINT NOT NULL,
  published_epoch BIGINT NOT NULL,
  cutoff_record_version BIGINT NOT NULL,
  cutoff_record_hash BYTEA NOT NULL CHECK (octet_length(cutoff_record_hash) = 32),
  revoked_recipient_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (share_id, retired_epoch, revoked_recipient_id)
);

CREATE TABLE IF NOT EXISTS vault_migrations (
  node_id TEXT PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  legacy_object_key TEXT,
  staged_object_key TEXT,
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'encrypting', 'verifying', 'switched', 'cleanup_queued', 'complete', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS vault_migrations_owner_state_idx
  ON vault_migrations (owner_id, state, updated_at);
CREATE INDEX IF NOT EXISTS vault_migrations_incomplete_owner_idx
  ON vault_migrations (owner_id, node_id)
  WHERE state <> 'complete';
CREATE INDEX IF NOT EXISTS vault_migrations_cleanup_object_idx
  ON vault_migrations (legacy_object_key)
  WHERE state = 'cleanup_queued' AND legacy_object_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS files_e2ee_migration_claim_idx
  ON files (owner_id, created_at, id)
  INCLUDE (e2ee_state)
  WHERE e2ee_state IN ('legacy', 'staged');

CREATE INDEX IF NOT EXISTS vault_uploads_owner_status_idx
  ON vault_uploads (owner_id, status, expires_at);
CREATE INDEX IF NOT EXISTS vault_uploads_global_expiry_idx
  ON vault_uploads (expires_at, id)
  WHERE status IN ('initializing', 'pending', 'completing', 'aborting');
CREATE INDEX IF NOT EXISTS vault_node_records_owner_idx
  ON vault_node_records (owner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS vault_generations_owner_idx
  ON vault_object_generations (owner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS vault_shares_root_idx
  ON vault_shares (owner_id, root_node_id, status);
CREATE INDEX IF NOT EXISTS vault_share_recipients_user_idx
  ON vault_share_recipients (recipient_id, status);

CREATE OR REPLACE FUNCTION enforce_vault_share_epoch_write()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  share_row RECORD;
  write_epoch BIGINT;
BEGIN
  FOR share_row IN
    SELECT shares.id,
           shares.status,
           shares.active_epoch,
           shares.pending_epoch,
           shares.publication_fenced,
           writes.epochs
    FROM vault_shares AS shares
    INNER JOIN (
      SELECT share_id, array_agg(DISTINCT epoch ORDER BY epoch) AS epochs
      FROM new_share_writes
      GROUP BY share_id
    ) AS writes ON writes.share_id = shares.id
    ORDER BY shares.id
    FOR SHARE OF shares
  LOOP
    IF share_row.status = 'revoked' THEN
      RAISE EXCEPTION 'share is not writable';
    END IF;

    FOREACH write_epoch IN ARRAY share_row.epochs
    LOOP
      IF share_row.publication_fenced
         AND write_epoch = share_row.active_epoch THEN
        RAISE EXCEPTION 'old share epoch is fenced';
      END IF;

      IF write_epoch <> share_row.active_epoch
         AND write_epoch IS DISTINCT FROM share_row.pending_epoch THEN
        RAISE EXCEPTION 'share epoch is not active or pending';
      END IF;
    END LOOP;
  END LOOP;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS vault_share_envelope_epoch_guard ON vault_share_envelopes;
DROP TRIGGER IF EXISTS vault_share_wrapper_epoch_guard ON vault_share_wrappers;
DROP TRIGGER IF EXISTS vault_share_envelope_epoch_guard_insert ON vault_share_envelopes;
DROP TRIGGER IF EXISTS vault_share_envelope_epoch_guard_update ON vault_share_envelopes;
DROP TRIGGER IF EXISTS vault_share_wrapper_epoch_guard_insert ON vault_share_wrappers;
DROP TRIGGER IF EXISTS vault_share_wrapper_epoch_guard_update ON vault_share_wrappers;

CREATE TRIGGER vault_share_envelope_epoch_guard_insert
AFTER INSERT ON vault_share_envelopes
REFERENCING NEW TABLE AS new_share_writes
FOR EACH STATEMENT EXECUTE FUNCTION enforce_vault_share_epoch_write();

CREATE TRIGGER vault_share_envelope_epoch_guard_update
AFTER UPDATE ON vault_share_envelopes
REFERENCING NEW TABLE AS new_share_writes
FOR EACH STATEMENT EXECUTE FUNCTION enforce_vault_share_epoch_write();

CREATE TRIGGER vault_share_wrapper_epoch_guard_insert
AFTER INSERT ON vault_share_wrappers
REFERENCING NEW TABLE AS new_share_writes
FOR EACH STATEMENT EXECUTE FUNCTION enforce_vault_share_epoch_write();

CREATE TRIGGER vault_share_wrapper_epoch_guard_update
AFTER UPDATE ON vault_share_wrappers
REFERENCING NEW TABLE AS new_share_writes
FOR EACH STATEMENT EXECUTE FUNCTION enforce_vault_share_epoch_write();

INSERT INTO schema_migrations (version)
VALUES ('002-e2ee');

\else
\echo 'Skipping already-applied migration 002-e2ee'
\endif

COMMIT;
