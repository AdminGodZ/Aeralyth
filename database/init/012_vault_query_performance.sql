-- Set-wise vault share guards plus exact hot-path indexes.

\set ON_ERROR_STOP on

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

SELECT pg_advisory_lock(hashtextextended('aeralyth:migration:012-vault-query-performance', 0));

SELECT EXISTS (
  SELECT 1
  FROM pg_class AS indexes
  INNER JOIN pg_index ON pg_index.indexrelid = indexes.oid
  WHERE indexes.relname = 'file_uploads_global_expiry_idx'
    AND pg_index.indisvalid
) AS file_expiry_index_valid \gset

\if :file_expiry_index_valid
\else
DROP INDEX CONCURRENTLY IF EXISTS file_uploads_global_expiry_idx;
CREATE INDEX CONCURRENTLY file_uploads_global_expiry_idx
  ON file_uploads (expires_at, id)
  WHERE status IN ('initializing', 'pending', 'aborting');
\endif

SELECT EXISTS (
  SELECT 1
  FROM pg_class AS indexes
  INNER JOIN pg_index ON pg_index.indexrelid = indexes.oid
  WHERE indexes.relname = 'vault_uploads_global_expiry_idx'
    AND pg_index.indisvalid
) AS vault_expiry_index_valid \gset

\if :vault_expiry_index_valid
\else
DROP INDEX CONCURRENTLY IF EXISTS vault_uploads_global_expiry_idx;
CREATE INDEX CONCURRENTLY vault_uploads_global_expiry_idx
  ON vault_uploads (expires_at, id)
  WHERE status IN ('initializing', 'pending', 'completing', 'aborting');
\endif

SELECT EXISTS (
  SELECT 1
  FROM pg_class AS indexes
  INNER JOIN pg_index ON pg_index.indexrelid = indexes.oid
  WHERE indexes.relname = 'vault_share_envelopes_recipient_latest_idx'
    AND pg_index.indisvalid
) AS envelope_lookup_index_valid \gset

\if :envelope_lookup_index_valid
\else
DROP INDEX CONCURRENTLY IF EXISTS vault_share_envelopes_recipient_latest_idx;
CREATE INDEX CONCURRENTLY vault_share_envelopes_recipient_latest_idx
  ON vault_share_envelopes (
    share_id, epoch, recipient_id, created_at DESC, envelope_id DESC
  );
\endif

BEGIN;

SELECT NOT EXISTS (
  SELECT 1 FROM schema_migrations
  WHERE version = '012-vault-query-performance'
) AS apply_migration \gset

\if :apply_migration

DROP TRIGGER IF EXISTS vault_share_envelope_epoch_guard ON vault_share_envelopes;
DROP TRIGGER IF EXISTS vault_share_wrapper_epoch_guard ON vault_share_wrappers;
DROP TRIGGER IF EXISTS vault_share_envelope_epoch_guard_insert ON vault_share_envelopes;
DROP TRIGGER IF EXISTS vault_share_envelope_epoch_guard_update ON vault_share_envelopes;
DROP TRIGGER IF EXISTS vault_share_wrapper_epoch_guard_insert ON vault_share_wrappers;
DROP TRIGGER IF EXISTS vault_share_wrapper_epoch_guard_update ON vault_share_wrappers;

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
VALUES ('012-vault-query-performance');

\else
\echo 'Skipping already-applied migration 012-vault-query-performance'
\endif

COMMIT;

SELECT pg_advisory_unlock(hashtextextended('aeralyth:migration:012-vault-query-performance', 0));
