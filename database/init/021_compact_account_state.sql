\set ON_ERROR_STOP on

BEGIN;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

SELECT pg_advisory_xact_lock(hashtextextended('aeralyth:migration:021-compact-account-state', 0));

SELECT NOT EXISTS (
  SELECT 1 FROM schema_migrations
  WHERE version = '021-compact-account-state'
) AS apply_migration \gset

\if :apply_migration

ALTER TABLE user_vaults
  DROP CONSTRAINT IF EXISTS user_vaults_compact_account_state;

ALTER TABLE user_vaults
  ADD CONSTRAINT user_vaults_compact_account_state
  CHECK (octet_length(encrypted_account_state) <= 16384)
  NOT VALID;

INSERT INTO schema_migrations (version)
VALUES ('021-compact-account-state');

\else
\echo 'Skipping already-applied migration 021-compact-account-state'
\endif

COMMIT;
