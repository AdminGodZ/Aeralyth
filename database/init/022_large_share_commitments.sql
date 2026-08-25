\set ON_ERROR_STOP on

BEGIN;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

SELECT pg_advisory_xact_lock(hashtextextended('aeralyth:migration:022-large-share-commitments', 0));

SELECT NOT EXISTS (
  SELECT 1 FROM schema_migrations
  WHERE version = '022-large-share-commitments'
) AS apply_migration \gset

\if :apply_migration

ALTER TABLE vault_share_epochs
  DROP CONSTRAINT IF EXISTS vault_share_epochs_wrapper_commitment_check;

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

ALTER TABLE vault_share_wrapper_directories
  DROP CONSTRAINT IF EXISTS vault_share_wrapper_directories_wrapper_count_check;

ALTER TABLE vault_share_wrapper_directories
  ADD CONSTRAINT vault_share_wrapper_directories_wrapper_count_check
  CHECK (wrapper_count BETWEEN 1 AND 100000);

INSERT INTO schema_migrations (version)
VALUES ('022-large-share-commitments');

\else
\echo 'Skipping already-applied migration 022-large-share-commitments'
\endif

COMMIT;
