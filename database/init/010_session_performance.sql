-- Move session-token hashing out of PostgreSQL and support bounded expiry cleanup.

\set ON_ERROR_STOP on

BEGIN;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

SELECT pg_advisory_xact_lock(hashtextextended('aeralyth:migration:010-session-performance', 0));

SELECT NOT EXISTS (
  SELECT 1 FROM schema_migrations WHERE version = '010-session-performance'
) AS apply_migration \gset

\if :apply_migration

DO $migration$
DECLARE
  token_hash_type TEXT;
BEGIN
  SELECT data_type
  INTO STRICT token_hash_type
  FROM information_schema.columns
  WHERE table_schema = current_schema()
    AND table_name = 'sessions'
    AND column_name = 'token_hash';

  IF token_hash_type = 'text' THEN
    ALTER TABLE sessions
      ALTER COLUMN token_hash TYPE BYTEA
      USING decode(token_hash, 'hex');
  ELSIF token_hash_type <> 'bytea' THEN
    RAISE EXCEPTION 'unsupported sessions.token_hash type: %', token_hash_type;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'sessions_token_hash_length'
      AND conrelid = 'sessions'::regclass
  ) THEN
    ALTER TABLE sessions
      ADD CONSTRAINT sessions_token_hash_length
      CHECK (octet_length(token_hash) = 32);
  END IF;
END
$migration$;

DROP INDEX IF EXISTS sessions_expires_at_idx;
CREATE INDEX IF NOT EXISTS sessions_expiry_cleanup_idx
  ON sessions (expires_at, id);

INSERT INTO schema_migrations (version)
VALUES ('010-session-performance');

\else
\echo 'Skipping already-applied migration 010-session-performance'
\endif

COMMIT;
