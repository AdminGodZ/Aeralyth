\set ON_ERROR_STOP on
BEGIN;
CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
SELECT pg_advisory_xact_lock(hashtextextended('aeralyth:migration:035-multipart-reconciliation', 0));
SELECT NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = '035-multipart-reconciliation') AS apply_migration \gset
\if :apply_migration
CREATE TABLE multipart_reconciliation_progress (
  namespace TEXT PRIMARY KEY,
  lease_token TEXT,
  lease_until TIMESTAMPTZ,
  key_marker TEXT,
  upload_id_marker TEXT,
  next_scan_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE multipart_orphan_abort_claims (
  namespace TEXT NOT NULL,
  object_key TEXT NOT NULL,
  upload_id TEXT NOT NULL,
  lease_token TEXT,
  lease_until TIMESTAMPTZ,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (namespace, object_key, upload_id)
);
CREATE INDEX multipart_orphan_abort_claims_due_idx
  ON multipart_orphan_abort_claims (namespace, next_attempt_at);
CREATE INDEX multipart_orphan_abort_claims_object_idx
  ON multipart_orphan_abort_claims (object_key, upload_id);

-- The fence remains until the provider confirms abort, even if its worker dies.
-- All writers and the orphan transition lock the same object identity. A lease
-- expiry lets a new worker retry cleanup; it never reopens the upload for adoption.
CREATE FUNCTION fence_multipart_orphan_adoption() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.object_key IS NULL OR NEW.status NOT IN ('initializing', 'pending', 'completing', 'aborting') THEN
    RETURN NEW;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('aeralyth:multipart-object:' || NEW.object_key, 0));
  IF EXISTS (
    SELECT 1 FROM multipart_orphan_abort_claims AS claims
    WHERE claims.object_key = NEW.object_key
      AND (NEW.multipart_upload_id IS NULL OR claims.upload_id = NEW.multipart_upload_id)
  ) THEN
    RAISE EXCEPTION 'multipart upload is fenced for orphan cleanup' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER fence_multipart_orphan_adoption
BEFORE INSERT OR UPDATE OF object_key, multipart_upload_id, status, expires_at, write_expires_at
ON file_uploads FOR EACH ROW EXECUTE FUNCTION fence_multipart_orphan_adoption();
CREATE TRIGGER fence_multipart_orphan_adoption
BEFORE INSERT OR UPDATE OF object_key, multipart_upload_id, status, expires_at, write_expires_at
ON vault_uploads FOR EACH ROW EXECUTE FUNCTION fence_multipart_orphan_adoption();

-- A bounded listing group has one network round trip. Adoption and the final
-- eligibility check see current state under the object fence, not a page-old snapshot.
CREATE FUNCTION prepare_multipart_orphan_group(
  sweep_namespace TEXT, sweep_token TEXT, keys TEXT[], upload_ids TEXT[]
) RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE queued bigint;
BEGIN
  IF cardinality(keys) <> cardinality(upload_ids) OR cardinality(keys) > 64 THEN
    RAISE EXCEPTION 'invalid multipart reconciliation group';
  END IF;
  UPDATE multipart_reconciliation_progress
    SET lease_until = now() + interval '120 seconds', updated_at = now()
    WHERE namespace = sweep_namespace AND lease_token = sweep_token AND lease_until > now();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'multipart reconciliation lease was lost' USING ERRCODE = '55000';
  END IF;
  -- Upload UPDATE acquires its row lock before running the identity trigger.
  -- Follow that order so an in-flight initializer never deadlocks against adoption.
  PERFORM id FROM file_uploads WHERE object_key = ANY(keys) ORDER BY id FOR UPDATE;
  PERFORM id FROM vault_uploads WHERE object_key = ANY(keys) ORDER BY id FOR UPDATE;
  PERFORM pg_advisory_xact_lock(hashtextextended('aeralyth:multipart-object:' || object_key, 0))
    FROM (SELECT DISTINCT unnest(keys) AS object_key ORDER BY object_key) AS ordered_keys;
  -- An insertion may have committed between the row scan and identity lock.
  -- Retry this maintenance group if its new row is already being updated, rather
  -- than reversing lock order and forcing that interactive writer to fail.
  PERFORM id FROM file_uploads WHERE object_key = ANY(keys) ORDER BY id FOR UPDATE NOWAIT;
  PERFORM id FROM vault_uploads WHERE object_key = ANY(keys) ORDER BY id FOR UPDATE NOWAIT;

  WITH candidates AS (
    SELECT DISTINCT ON (object_key) object_key, upload_id
    FROM unnest(keys, upload_ids) AS items(object_key, upload_id)
    ORDER BY object_key, upload_id
  )
  UPDATE file_uploads AS intents SET multipart_upload_id = candidates.upload_id,
    status = 'pending', expires_at = now() + interval '24 hours'
  FROM candidates WHERE intents.object_key = candidates.object_key
    AND position('/files/' IN intents.object_key) > 0
    AND intents.status = 'initializing' AND intents.multipart_upload_id IS NULL
    AND intents.expires_at > now()
    AND NOT EXISTS (SELECT 1 FROM multipart_orphan_abort_claims AS claims
                    WHERE claims.object_key = candidates.object_key);

  WITH candidates AS (
    SELECT DISTINCT ON (object_key) object_key, upload_id
    FROM unnest(keys, upload_ids) AS items(object_key, upload_id)
    ORDER BY object_key, upload_id
  )
  UPDATE vault_uploads AS intents SET multipart_upload_id = candidates.upload_id,
    status = 'pending', expires_at = now() + interval '1 hour'
  FROM candidates WHERE intents.object_key = candidates.object_key
    AND position('/vault/' IN intents.object_key) > 0
    AND intents.status = 'initializing' AND intents.multipart_upload_id IS NULL
    AND intents.expires_at > now()
    AND NOT EXISTS (SELECT 1 FROM multipart_orphan_abort_claims AS claims
                    WHERE claims.object_key = candidates.object_key);

  INSERT INTO multipart_orphan_abort_claims (namespace, object_key, upload_id)
  SELECT sweep_namespace, candidates.object_key, candidates.upload_id
  FROM unnest(keys, upload_ids) AS candidates(object_key, upload_id)
  WHERE NOT EXISTS (
    SELECT 1 FROM file_uploads AS intents
    WHERE intents.object_key = candidates.object_key
      AND intents.status IN ('initializing', 'pending', 'completing', 'aborting')
      AND (intents.multipart_upload_id = candidates.upload_id
        OR GREATEST(intents.expires_at, COALESCE(intents.write_expires_at, intents.expires_at)) > now())
  ) AND NOT EXISTS (
    SELECT 1 FROM vault_uploads AS intents
    WHERE intents.object_key = candidates.object_key
      AND intents.status IN ('initializing', 'pending', 'completing', 'aborting')
      AND (intents.multipart_upload_id = candidates.upload_id
        OR GREATEST(intents.expires_at, COALESCE(intents.write_expires_at, intents.expires_at)) > now())
  ) ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS queued = ROW_COUNT;
  RETURN queued;
END;
$$;
INSERT INTO schema_migrations (version) VALUES ('035-multipart-reconciliation');
\endif
COMMIT;
