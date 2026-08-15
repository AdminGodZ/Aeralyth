-- Indexed admin substring search and a durable native-identifier policy.

\set ON_ERROR_STOP on

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

SELECT pg_advisory_lock(hashtextextended('aeralyth:migration:016-admin-search-identifier-policy', 0));

CREATE EXTENSION IF NOT EXISTS pg_trgm;

SELECT EXISTS (
  SELECT 1 FROM pg_class AS indexes
  INNER JOIN pg_index ON pg_index.indexrelid = indexes.oid
  WHERE indexes.relname = 'users_username_trgm_idx'
    AND indexes.relnamespace = 'public'::regnamespace
    AND pg_index.indisvalid
) AS users_username_trgm_valid \gset
\if :users_username_trgm_valid
\else
DROP INDEX CONCURRENTLY IF EXISTS users_username_trgm_idx;
CREATE INDEX CONCURRENTLY users_username_trgm_idx
  ON users USING gin (username gin_trgm_ops)
  WHERE status <> 'deleting';
\endif

SELECT EXISTS (
  SELECT 1 FROM pg_class AS indexes
  INNER JOIN pg_index ON pg_index.indexrelid = indexes.oid
  WHERE indexes.relname = 'users_display_name_trgm_idx'
    AND indexes.relnamespace = 'public'::regnamespace
    AND pg_index.indisvalid
) AS users_display_name_trgm_valid \gset
\if :users_display_name_trgm_valid
\else
DROP INDEX CONCURRENTLY IF EXISTS users_display_name_trgm_idx;
CREATE INDEX CONCURRENTLY users_display_name_trgm_idx
  ON users USING gin ((COALESCE(display_name, '')) gin_trgm_ops)
  WHERE status <> 'deleting';
\endif

SELECT EXISTS (
  SELECT 1 FROM pg_class AS indexes
  INNER JOIN pg_index ON pg_index.indexrelid = indexes.oid
  WHERE indexes.relname = 'invitations_username_trgm_idx'
    AND indexes.relnamespace = 'public'::regnamespace
    AND pg_index.indisvalid
) AS invitations_username_trgm_valid \gset
\if :invitations_username_trgm_valid
\else
DROP INDEX CONCURRENTLY IF EXISTS invitations_username_trgm_idx;
CREATE INDEX CONCURRENTLY invitations_username_trgm_idx
  ON invitations USING gin (invited_username gin_trgm_ops);
\endif

BEGIN;

-- Snapshot the legacy TEXT primary/foreign-key surface once. Regression tests
-- compare the live schema with this allowlist, so new high-volume relations
-- must use UUID (or another deliberately compact native type) internally.
CREATE TABLE IF NOT EXISTS legacy_text_identifier_columns (
  table_name NAME NOT NULL,
  column_name NAME NOT NULL,
  constraint_kind "char" NOT NULL CHECK (constraint_kind IN ('p', 'f')),
  captured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (table_name, column_name, constraint_kind)
);

DO $snapshot$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM schema_migrations
    WHERE version = '016-admin-search-identifier-policy'
  ) THEN
    INSERT INTO legacy_text_identifier_columns (
      table_name, column_name, constraint_kind
    )
    SELECT DISTINCT
      relation.relname,
      attribute.attname,
      constraint_record.contype
    FROM pg_constraint AS constraint_record
    INNER JOIN pg_class AS relation
      ON relation.oid = constraint_record.conrelid
    INNER JOIN LATERAL unnest(constraint_record.conkey) AS key(attnum) ON TRUE
    INNER JOIN pg_attribute AS attribute
      ON attribute.attrelid = relation.oid
     AND attribute.attnum = key.attnum
    WHERE relation.relnamespace = 'public'::regnamespace
      AND constraint_record.contype IN ('p', 'f')
      AND attribute.atttypid = 'text'::regtype
    ON CONFLICT DO NOTHING;
  END IF;
END
$snapshot$;

COMMENT ON TABLE legacy_text_identifier_columns IS
  'Frozen allowlist of pre-016 TEXT PK/FK columns; new internal identifiers must use compact native types.';

INSERT INTO schema_migrations (version)
VALUES ('016-admin-search-identifier-policy')
ON CONFLICT (version) DO NOTHING;

COMMIT;

SELECT pg_advisory_unlock(hashtextextended('aeralyth:migration:016-admin-search-identifier-policy', 0));
