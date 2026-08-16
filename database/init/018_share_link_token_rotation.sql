-- Make every share-link rotation produce a new bearer token while preserving
-- URLs issued before token versions existed.

\set ON_ERROR_STOP on

BEGIN;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

SELECT pg_advisory_xact_lock(hashtextextended('aeralyth:migration:018-share-link-token-rotation', 0));

SELECT NOT EXISTS (
  SELECT 1 FROM schema_migrations
  WHERE version = '018-share-link-token-rotation'
) AS apply_migration \gset

\if :apply_migration

ALTER TABLE share_links
  ADD COLUMN IF NOT EXISTS token_version BIGINT DEFAULT 0;

UPDATE share_links
SET token_version = 0
WHERE token_version IS NULL;

ALTER TABLE share_links
  ALTER COLUMN token_version SET DEFAULT 0,
  ALTER COLUMN token_version SET NOT NULL;

DO $constraints$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'share_links_token_version_check'
      AND conrelid = 'share_links'::regclass
  ) THEN
    ALTER TABLE share_links
      ADD CONSTRAINT share_links_token_version_check
      CHECK (token_version >= 0);
  END IF;
END
$constraints$;

COMMENT ON COLUMN share_links.token_version IS
  'Version zero preserves legacy writers and HMAC tokens; current writers explicitly use version one and rotations increment it.';

INSERT INTO schema_migrations (version)
VALUES ('018-share-link-token-rotation');

\else
\echo 'Skipping already-applied migration 018-share-link-token-rotation'
\endif

COMMIT;
