-- Exact E2EE migration-path indexes and case-insensitive username identity.

\set ON_ERROR_STOP on

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

SELECT pg_advisory_lock(hashtextextended('aeralyth:migration:013-migration-identity-performance', 0));

SELECT EXISTS (
  SELECT 1
  FROM pg_class AS indexes
  INNER JOIN pg_index ON pg_index.indexrelid = indexes.oid
  WHERE indexes.relname = 'users_username_ci_idx'
    AND indexes.relnamespace = 'public'::regnamespace
    AND pg_index.indrelid = 'public.users'::regclass
    AND pg_index.indisvalid
    AND pg_index.indisunique
) AS username_index_valid \gset

\if :username_index_valid
\else
DROP INDEX CONCURRENTLY IF EXISTS users_username_ci_idx;
CREATE UNIQUE INDEX CONCURRENTLY users_username_ci_idx
  ON users (lower(username));
\endif

SELECT EXISTS (
  SELECT 1
  FROM pg_class AS indexes
  INNER JOIN pg_index ON pg_index.indexrelid = indexes.oid
  WHERE indexes.relname = 'files_e2ee_migration_claim_idx'
    AND indexes.relnamespace = 'public'::regnamespace
    AND pg_index.indrelid = 'public.files'::regclass
    AND pg_index.indisvalid
) AS file_claim_index_valid \gset

\if :file_claim_index_valid
\else
DROP INDEX CONCURRENTLY IF EXISTS files_e2ee_migration_claim_idx;
CREATE INDEX CONCURRENTLY files_e2ee_migration_claim_idx
  ON files (owner_id, created_at, id)
  INCLUDE (e2ee_state)
  WHERE e2ee_state IN ('legacy', 'staged');
\endif

SELECT EXISTS (
  SELECT 1
  FROM pg_class AS indexes
  INNER JOIN pg_index ON pg_index.indexrelid = indexes.oid
  WHERE indexes.relname = 'vault_migrations_incomplete_owner_idx'
    AND indexes.relnamespace = 'public'::regnamespace
    AND pg_index.indrelid = 'public.vault_migrations'::regclass
    AND pg_index.indisvalid
) AS incomplete_migration_index_valid \gset

\if :incomplete_migration_index_valid
\else
DROP INDEX CONCURRENTLY IF EXISTS vault_migrations_incomplete_owner_idx;
CREATE INDEX CONCURRENTLY vault_migrations_incomplete_owner_idx
  ON vault_migrations (owner_id, node_id)
  WHERE state <> 'complete';
\endif

SELECT EXISTS (
  SELECT 1
  FROM pg_class AS indexes
  INNER JOIN pg_index ON pg_index.indexrelid = indexes.oid
  WHERE indexes.relname = 'vault_migrations_cleanup_object_idx'
    AND indexes.relnamespace = 'public'::regnamespace
    AND pg_index.indrelid = 'public.vault_migrations'::regclass
    AND pg_index.indisvalid
) AS migration_cleanup_index_valid \gset

\if :migration_cleanup_index_valid
\else
DROP INDEX CONCURRENTLY IF EXISTS vault_migrations_cleanup_object_idx;
CREATE INDEX CONCURRENTLY vault_migrations_cleanup_object_idx
  ON vault_migrations (legacy_object_key)
  WHERE state = 'cleanup_queued' AND legacy_object_key IS NOT NULL;
\endif

BEGIN;

INSERT INTO schema_migrations (version)
VALUES ('013-migration-identity-performance')
ON CONFLICT (version) DO NOTHING;

COMMIT;

SELECT pg_advisory_unlock(hashtextextended('aeralyth:migration:013-migration-identity-performance', 0));
