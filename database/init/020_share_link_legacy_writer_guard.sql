-- Prevent an older binary from replacing a versioned share token without also
-- advancing its version during a rolling deployment or rollback.

\set ON_ERROR_STOP on

BEGIN;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

SELECT pg_advisory_xact_lock(hashtextextended('aeralyth:migration:020-share-link-legacy-writer-guard', 0));

SELECT NOT EXISTS (
  SELECT 1 FROM schema_migrations
  WHERE version = '020-share-link-legacy-writer-guard'
) AS apply_migration \gset

\if :apply_migration

ALTER TABLE share_links
  ALTER COLUMN token_version SET DEFAULT 0;

CREATE OR REPLACE FUNCTION guard_share_link_legacy_token_rotation()
RETURNS trigger
LANGUAGE plpgsql
AS $guard$
BEGIN
  IF OLD.token_version >= 1
     AND NEW.token_hash IS DISTINCT FROM OLD.token_hash
     AND NEW.token_version = OLD.token_version THEN
    RAISE EXCEPTION 'legacy share-link rotation cannot modify a versioned token'
      USING ERRCODE = '55000',
            HINT = 'Drain or upgrade older Aeralyth instances before rotating this link.';
  END IF;

  RETURN NEW;
END
$guard$;

DROP TRIGGER IF EXISTS share_links_legacy_token_rotation_guard ON share_links;
CREATE TRIGGER share_links_legacy_token_rotation_guard
BEFORE UPDATE OF token_hash, token_version ON share_links
FOR EACH ROW
EXECUTE FUNCTION guard_share_link_legacy_token_rotation();

COMMENT ON FUNCTION guard_share_link_legacy_token_rotation() IS
  'Rejects old-writer token replacements on versioned share links during rolling deployments.';

INSERT INTO schema_migrations (version)
VALUES ('020-share-link-legacy-writer-guard');

\else
\echo 'Skipping already-applied migration 020-share-link-legacy-writer-guard'
\endif

COMMIT;
