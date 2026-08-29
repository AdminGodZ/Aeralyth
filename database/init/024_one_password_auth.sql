\set ON_ERROR_STOP on

BEGIN;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

SELECT pg_advisory_xact_lock(hashtextextended('aeralyth:migration:024-one-password-auth', 0));

SELECT NOT EXISTS (
  SELECT 1 FROM schema_migrations WHERE version = '024-one-password-auth'
) AS apply_migration \gset

\if :apply_migration

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS auth_version SMALLINT NOT NULL DEFAULT 0;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS auth_kdf_salt BYTEA;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'users_one_password_auth_check'
      AND conrelid = 'users'::regclass
  ) THEN
    ALTER TABLE users
      ADD CONSTRAINT users_one_password_auth_check CHECK (
        (auth_version = 0 AND auth_kdf_salt IS NULL)
        OR
        (auth_version = 1 AND octet_length(auth_kdf_salt) = 16)
      );
  END IF;
END $$;

INSERT INTO schema_migrations (version)
VALUES ('024-one-password-auth');

\endif

COMMIT;
