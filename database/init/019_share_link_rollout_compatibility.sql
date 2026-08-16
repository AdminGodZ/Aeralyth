-- Keep writes from an older binary compatible during a rolling deploy or
-- rollback. The new binary explicitly writes version one for new links;
-- older binaries omit the column and must therefore remain on version zero.

\set ON_ERROR_STOP on

BEGIN;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

SELECT pg_advisory_xact_lock(hashtextextended('aeralyth:migration:019-share-link-rollout-compatibility', 0));

SELECT NOT EXISTS (
  SELECT 1 FROM schema_migrations
  WHERE version = '019-share-link-rollout-compatibility'
) AS apply_migration \gset

\if :apply_migration

ALTER TABLE share_links
  ALTER COLUMN token_version SET DEFAULT 0;

COMMENT ON COLUMN share_links.token_version IS
  'Version zero preserves legacy writers and URLs; current writers explicitly use version one and rotations increment it.';

INSERT INTO schema_migrations (version)
VALUES ('019-share-link-rollout-compatibility');

\else
\echo 'Skipping already-applied migration 019-share-link-rollout-compatibility'
\endif

COMMIT;
