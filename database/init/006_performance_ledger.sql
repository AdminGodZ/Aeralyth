-- One-time storage-ledger backfill plus durable statement-level accounting.
-- Catalog definitions below remain idempotent; the data backfill is guarded by
-- schema_migrations so normal deploys do not rescan upload or file tables.

BEGIN;

SELECT pg_advisory_xact_lock(hashtextextended('aeralyth:migration:006-performance-ledger', 0));

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS user_storage_usage (
  owner_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  used_bytes BIGINT NOT NULL DEFAULT 0 CHECK (used_bytes >= 0),
  reserved_bytes BIGINT NOT NULL DEFAULT 0 CHECK (reserved_bytes >= 0),
  pending_uploads BIGINT NOT NULL DEFAULT 0 CHECK (pending_uploads >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE file_uploads
  ADD COLUMN IF NOT EXISTS reservation_bytes BIGINT NOT NULL DEFAULT 0;

ALTER TABLE vault_uploads
  ADD COLUMN IF NOT EXISTS reservation_bytes BIGINT NOT NULL DEFAULT 0;

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM schema_migrations
    WHERE version = '006-performance-ledger'
  ) THEN
    INSERT INTO user_storage_usage (owner_id, used_bytes)
    SELECT users.id, COALESCE(counters.used_bytes, 0)
    FROM users
    LEFT JOIN user_file_counters AS counters ON counters.owner_id = users.id
    ON CONFLICT (owner_id) DO UPDATE SET
      used_bytes = EXCLUDED.used_bytes,
      updated_at = now();

    UPDATE file_uploads
    SET reservation_bytes = CASE
      WHEN status IN ('initializing', 'pending', 'completing', 'aborting')
        THEN size_bytes
      ELSE 0
    END;

    UPDATE vault_uploads
    SET reservation_bytes = CASE
      WHEN status IN ('initializing', 'pending', 'completing', 'aborting')
        THEN ciphertext_length
      ELSE 0
    END;

    WITH reservations AS (
      SELECT owner_id,
             sum(reservation_bytes)::bigint AS reserved_bytes,
             count(*)::bigint AS pending_uploads
      FROM (
        SELECT owner_id, reservation_bytes
        FROM file_uploads
        WHERE status IN ('initializing', 'pending', 'completing', 'aborting')
        UNION ALL
        SELECT owner_id, reservation_bytes
        FROM vault_uploads
        WHERE status IN ('initializing', 'pending', 'completing', 'aborting')
      ) AS active_uploads
      GROUP BY owner_id
    )
    UPDATE user_storage_usage AS usage
    SET reserved_bytes = COALESCE(reservations.reserved_bytes, 0),
        pending_uploads = COALESCE(reservations.pending_uploads, 0),
        updated_at = now()
    FROM users
    LEFT JOIN reservations ON reservations.owner_id = users.id
    WHERE usage.owner_id = users.id;

    INSERT INTO schema_migrations (version)
    VALUES ('006-performance-ledger');
  END IF;
END
$migration$;

DO $constraints$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'file_uploads_reservation_bytes_check'
      AND conrelid = 'file_uploads'::regclass
  ) THEN
    ALTER TABLE file_uploads
      ADD CONSTRAINT file_uploads_reservation_bytes_check
      CHECK (reservation_bytes >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'vault_uploads_reservation_bytes_check'
      AND conrelid = 'vault_uploads'::regclass
  ) THEN
    ALTER TABLE vault_uploads
      ADD CONSTRAINT vault_uploads_reservation_bytes_check
      CHECK (reservation_bytes >= 0);
  END IF;
END
$constraints$;

CREATE OR REPLACE FUNCTION ensure_user_storage_usage()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $function$
BEGIN
  INSERT INTO user_storage_usage (owner_id)
  VALUES (NEW.id)
  ON CONFLICT (owner_id) DO NOTHING;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS users_storage_usage_insert ON users;
CREATE TRIGGER users_storage_usage_insert
AFTER INSERT ON users
FOR EACH ROW EXECUTE FUNCTION ensure_user_storage_usage();

CREATE OR REPLACE FUNCTION apply_file_counter_delta(
  owner TEXT,
  total_files_delta BIGINT,
  total_folders_delta BIGINT,
  trashed_files_delta BIGINT,
  favorites_delta BIGINT,
  bytes_delta BIGINT
)
RETURNS VOID
LANGUAGE plpgsql
AS $function$
BEGIN
  IF total_files_delta = 0
     AND total_folders_delta = 0
     AND trashed_files_delta = 0
     AND favorites_delta = 0
     AND bytes_delta = 0 THEN
    RETURN;
  END IF;

  INSERT INTO user_file_counters (
    owner_id,
    total_files,
    total_folders,
    active_files,
    trashed_files,
    favorite_files,
    used_bytes
  )
  SELECT
    owner,
    GREATEST(0, total_files_delta),
    GREATEST(0, total_folders_delta),
    GREATEST(0, total_files_delta),
    GREATEST(0, trashed_files_delta),
    GREATEST(0, favorites_delta),
    GREATEST(0, bytes_delta)
  WHERE EXISTS (SELECT 1 FROM users WHERE id = owner)
  ON CONFLICT (owner_id) DO UPDATE SET
    total_files = GREATEST(0, user_file_counters.total_files + total_files_delta),
    total_folders = GREATEST(0, user_file_counters.total_folders + total_folders_delta),
    active_files = GREATEST(0, user_file_counters.active_files + total_files_delta),
    trashed_files = GREATEST(0, user_file_counters.trashed_files + trashed_files_delta),
    favorite_files = GREATEST(0, user_file_counters.favorite_files + favorites_delta),
    used_bytes = GREATEST(0, user_file_counters.used_bytes + bytes_delta),
    updated_at = now();

  IF bytes_delta <> 0 THEN
    INSERT INTO user_storage_usage (owner_id, used_bytes)
    SELECT owner, GREATEST(0, bytes_delta)
    WHERE EXISTS (SELECT 1 FROM users WHERE id = owner)
    ON CONFLICT (owner_id) DO UPDATE SET
      used_bytes = GREATEST(0, user_storage_usage.used_bytes + bytes_delta),
      updated_at = now();
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION update_file_counters_after_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $function$
DECLARE
  delta RECORD;
BEGIN
  FOR delta IN
    SELECT
      owner_id,
      count(*) FILTER (WHERE entry_type = 'file' AND state = 'active')::bigint AS total_files,
      count(*) FILTER (WHERE entry_type = 'folder' AND state = 'active')::bigint AS total_folders,
      count(*) FILTER (WHERE entry_type = 'file' AND state = 'trashed')::bigint AS trashed_files,
      count(*) FILTER (WHERE state = 'active' AND favorite)::bigint AS favorites,
      COALESCE(sum(size_bytes) FILTER (WHERE entry_type = 'file'), 0)::bigint AS used_bytes
    FROM new_file_rows
    GROUP BY owner_id
  LOOP
    PERFORM apply_file_counter_delta(
      delta.owner_id,
      delta.total_files,
      delta.total_folders,
      delta.trashed_files,
      delta.favorites,
      delta.used_bytes
    );
  END LOOP;
  RETURN NULL;
END;
$function$;

CREATE OR REPLACE FUNCTION update_file_counters_after_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $function$
DECLARE
  delta RECORD;
BEGIN
  FOR delta IN
    SELECT
      owner_id,
      -count(*) FILTER (WHERE entry_type = 'file' AND state = 'active')::bigint AS total_files,
      -count(*) FILTER (WHERE entry_type = 'folder' AND state = 'active')::bigint AS total_folders,
      -count(*) FILTER (WHERE entry_type = 'file' AND state = 'trashed')::bigint AS trashed_files,
      -count(*) FILTER (WHERE state = 'active' AND favorite)::bigint AS favorites,
      -COALESCE(sum(size_bytes) FILTER (WHERE entry_type = 'file'), 0)::bigint AS used_bytes
    FROM old_file_rows
    GROUP BY owner_id
  LOOP
    PERFORM apply_file_counter_delta(
      delta.owner_id,
      delta.total_files,
      delta.total_folders,
      delta.trashed_files,
      delta.favorites,
      delta.used_bytes
    );
  END LOOP;
  RETURN NULL;
END;
$function$;

CREATE OR REPLACE FUNCTION update_file_counters_after_update()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $function$
DECLARE
  delta RECORD;
BEGIN
  FOR delta IN
    WITH contributions AS (
      SELECT
        owner_id,
        -CASE WHEN entry_type = 'file' AND state = 'active' THEN 1 ELSE 0 END::bigint AS total_files,
        -CASE WHEN entry_type = 'folder' AND state = 'active' THEN 1 ELSE 0 END::bigint AS total_folders,
        -CASE WHEN entry_type = 'file' AND state = 'trashed' THEN 1 ELSE 0 END::bigint AS trashed_files,
        -CASE WHEN state = 'active' AND favorite THEN 1 ELSE 0 END::bigint AS favorites,
        -CASE WHEN entry_type = 'file' THEN size_bytes ELSE 0 END::bigint AS used_bytes
      FROM old_file_rows
      UNION ALL
      SELECT
        owner_id,
        CASE WHEN entry_type = 'file' AND state = 'active' THEN 1 ELSE 0 END::bigint,
        CASE WHEN entry_type = 'folder' AND state = 'active' THEN 1 ELSE 0 END::bigint,
        CASE WHEN entry_type = 'file' AND state = 'trashed' THEN 1 ELSE 0 END::bigint,
        CASE WHEN state = 'active' AND favorite THEN 1 ELSE 0 END::bigint,
        CASE WHEN entry_type = 'file' THEN size_bytes ELSE 0 END::bigint
      FROM new_file_rows
    )
    SELECT
      owner_id,
      sum(total_files)::bigint AS total_files,
      sum(total_folders)::bigint AS total_folders,
      sum(trashed_files)::bigint AS trashed_files,
      sum(favorites)::bigint AS favorites,
      sum(used_bytes)::bigint AS used_bytes
    FROM contributions
    GROUP BY owner_id
    HAVING sum(total_files) <> 0
        OR sum(total_folders) <> 0
        OR sum(trashed_files) <> 0
        OR sum(favorites) <> 0
        OR sum(used_bytes) <> 0
  LOOP
    PERFORM apply_file_counter_delta(
      delta.owner_id,
      delta.total_files,
      delta.total_folders,
      delta.trashed_files,
      delta.favorites,
      delta.used_bytes
    );
  END LOOP;

  FOR delta IN
    SELECT
      shares.recipient_id AS owner_id,
      sum(
        CASE WHEN new_files.entry_type = 'file' AND new_files.state = 'active' THEN 1 ELSE 0 END
        - CASE WHEN old_files.entry_type = 'file' AND old_files.state = 'active' THEN 1 ELSE 0 END
      )::bigint AS shared_files
    FROM old_file_rows AS old_files
    INNER JOIN new_file_rows AS new_files ON new_files.id = old_files.id
    INNER JOIN file_shares AS shares ON shares.file_id = new_files.id
    WHERE old_files.entry_type IS DISTINCT FROM new_files.entry_type
       OR old_files.state IS DISTINCT FROM new_files.state
    GROUP BY shares.recipient_id
    HAVING sum(
      CASE WHEN new_files.entry_type = 'file' AND new_files.state = 'active' THEN 1 ELSE 0 END
      - CASE WHEN old_files.entry_type = 'file' AND old_files.state = 'active' THEN 1 ELSE 0 END
    ) <> 0
  LOOP
    UPDATE user_file_counters
    SET shared_files = GREATEST(0, shared_files + delta.shared_files),
        updated_at = now()
    WHERE owner_id = delta.owner_id;
  END LOOP;

  UPDATE file_shares AS shares
  SET counts_toward_shared = (
    new_files.entry_type = 'file' AND new_files.state = 'active'
  )
  FROM old_file_rows AS old_files, new_file_rows AS new_files
  WHERE old_files.id = new_files.id
    AND shares.file_id = new_files.id
    AND (
      old_files.entry_type IS DISTINCT FROM new_files.entry_type
      OR old_files.state IS DISTINCT FROM new_files.state
    )
    AND shares.counts_toward_shared IS DISTINCT FROM (
      new_files.entry_type = 'file' AND new_files.state = 'active'
    );

  RETURN NULL;
END;
$function$;

DROP TRIGGER IF EXISTS files_counter_change ON files;
DROP TRIGGER IF EXISTS files_counter_insert_statement ON files;
DROP TRIGGER IF EXISTS files_counter_update_statement ON files;
DROP TRIGGER IF EXISTS files_counter_delete_statement ON files;

CREATE TRIGGER files_counter_insert_statement
AFTER INSERT ON files
REFERENCING NEW TABLE AS new_file_rows
FOR EACH STATEMENT EXECUTE FUNCTION update_file_counters_after_insert();

CREATE TRIGGER files_counter_update_statement
AFTER UPDATE ON files
REFERENCING OLD TABLE AS old_file_rows NEW TABLE AS new_file_rows
FOR EACH STATEMENT EXECUTE FUNCTION update_file_counters_after_update();

CREATE TRIGGER files_counter_delete_statement
AFTER DELETE ON files
REFERENCING OLD TABLE AS old_file_rows
FOR EACH STATEMENT EXECUTE FUNCTION update_file_counters_after_delete();

CREATE OR REPLACE FUNCTION apply_upload_reservation_delta(
  owner TEXT,
  bytes_delta BIGINT,
  pending_delta BIGINT
)
RETURNS VOID
LANGUAGE plpgsql
AS $function$
BEGIN
  IF bytes_delta = 0 AND pending_delta = 0 THEN
    RETURN;
  END IF;

  UPDATE user_storage_usage
  SET reserved_bytes = reserved_bytes + bytes_delta,
      pending_uploads = pending_uploads + pending_delta,
      updated_at = now()
  WHERE owner_id = owner;

  IF NOT FOUND AND EXISTS (
    SELECT 1 FROM users WHERE id = owner AND status <> 'deleting'
  ) THEN
    RAISE EXCEPTION 'storage usage ledger missing for user %', owner;
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION update_file_upload_reservations()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $function$
DECLARE
  delta RECORD;
BEGIN
  FOR delta IN
    WITH contributions AS (
      SELECT
        owner_id,
        -CASE WHEN status IN ('initializing', 'pending', 'completing', 'aborting')
          THEN reservation_bytes ELSE 0 END::bigint AS reserved_bytes,
        -CASE WHEN status IN ('initializing', 'pending', 'completing', 'aborting')
          THEN 1 ELSE 0 END::bigint AS pending_uploads
      FROM old_upload_rows
      UNION ALL
      SELECT
        owner_id,
        CASE WHEN status IN ('initializing', 'pending', 'completing', 'aborting')
          THEN reservation_bytes ELSE 0 END::bigint,
        CASE WHEN status IN ('initializing', 'pending', 'completing', 'aborting')
          THEN 1 ELSE 0 END::bigint
      FROM new_upload_rows
    )
    SELECT owner_id,
           sum(reserved_bytes)::bigint AS reserved_bytes,
           sum(pending_uploads)::bigint AS pending_uploads
    FROM contributions
    GROUP BY owner_id
    HAVING sum(reserved_bytes) <> 0 OR sum(pending_uploads) <> 0
  LOOP
    PERFORM apply_upload_reservation_delta(
      delta.owner_id,
      delta.reserved_bytes,
      delta.pending_uploads
    );
  END LOOP;
  RETURN NULL;
END;
$function$;

CREATE OR REPLACE FUNCTION delete_file_upload_reservations()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $function$
DECLARE
  delta RECORD;
BEGIN
  FOR delta IN
    SELECT owner_id,
           -sum(reservation_bytes)::bigint AS reserved_bytes,
           -count(*)::bigint AS pending_uploads
    FROM old_upload_rows
    WHERE status IN ('initializing', 'pending', 'completing', 'aborting')
    GROUP BY owner_id
  LOOP
    PERFORM apply_upload_reservation_delta(
      delta.owner_id,
      delta.reserved_bytes,
      delta.pending_uploads
    );
  END LOOP;
  RETURN NULL;
END;
$function$;

CREATE OR REPLACE FUNCTION update_vault_upload_reservations()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $function$
DECLARE
  delta RECORD;
BEGIN
  FOR delta IN
    WITH contributions AS (
      SELECT
        owner_id,
        -CASE WHEN status IN ('initializing', 'pending', 'completing', 'aborting')
          THEN reservation_bytes ELSE 0 END::bigint AS reserved_bytes,
        -CASE WHEN status IN ('initializing', 'pending', 'completing', 'aborting')
          THEN 1 ELSE 0 END::bigint AS pending_uploads
      FROM old_vault_upload_rows
      UNION ALL
      SELECT
        owner_id,
        CASE WHEN status IN ('initializing', 'pending', 'completing', 'aborting')
          THEN reservation_bytes ELSE 0 END::bigint,
        CASE WHEN status IN ('initializing', 'pending', 'completing', 'aborting')
          THEN 1 ELSE 0 END::bigint
      FROM new_vault_upload_rows
    )
    SELECT owner_id,
           sum(reserved_bytes)::bigint AS reserved_bytes,
           sum(pending_uploads)::bigint AS pending_uploads
    FROM contributions
    GROUP BY owner_id
    HAVING sum(reserved_bytes) <> 0 OR sum(pending_uploads) <> 0
  LOOP
    PERFORM apply_upload_reservation_delta(
      delta.owner_id,
      delta.reserved_bytes,
      delta.pending_uploads
    );
  END LOOP;
  RETURN NULL;
END;
$function$;

CREATE OR REPLACE FUNCTION delete_vault_upload_reservations()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $function$
DECLARE
  delta RECORD;
BEGIN
  FOR delta IN
    SELECT owner_id,
           -sum(reservation_bytes)::bigint AS reserved_bytes,
           -count(*)::bigint AS pending_uploads
    FROM old_vault_upload_rows
    WHERE status IN ('initializing', 'pending', 'completing', 'aborting')
    GROUP BY owner_id
  LOOP
    PERFORM apply_upload_reservation_delta(
      delta.owner_id,
      delta.reserved_bytes,
      delta.pending_uploads
    );
  END LOOP;
  RETURN NULL;
END;
$function$;

CREATE OR REPLACE FUNCTION prevent_upload_reservation_rewrite()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $function$
BEGIN
  IF OLD.owner_id IS DISTINCT FROM NEW.owner_id
     OR OLD.reservation_bytes IS DISTINCT FROM NEW.reservation_bytes THEN
    RAISE EXCEPTION 'upload reservation ownership and bytes are immutable';
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS file_upload_reservation_immutable ON file_uploads;
DROP TRIGGER IF EXISTS file_upload_reservation_update ON file_uploads;
DROP TRIGGER IF EXISTS file_upload_reservation_delete ON file_uploads;

CREATE TRIGGER file_upload_reservation_immutable
BEFORE UPDATE OF owner_id, reservation_bytes ON file_uploads
FOR EACH ROW EXECUTE FUNCTION prevent_upload_reservation_rewrite();

CREATE TRIGGER file_upload_reservation_update
AFTER UPDATE ON file_uploads
REFERENCING OLD TABLE AS old_upload_rows NEW TABLE AS new_upload_rows
FOR EACH STATEMENT EXECUTE FUNCTION update_file_upload_reservations();

CREATE TRIGGER file_upload_reservation_delete
AFTER DELETE ON file_uploads
REFERENCING OLD TABLE AS old_upload_rows
FOR EACH STATEMENT EXECUTE FUNCTION delete_file_upload_reservations();

DROP TRIGGER IF EXISTS vault_upload_reservation_immutable ON vault_uploads;
DROP TRIGGER IF EXISTS vault_upload_reservation_update ON vault_uploads;
DROP TRIGGER IF EXISTS vault_upload_reservation_delete ON vault_uploads;

CREATE TRIGGER vault_upload_reservation_immutable
BEFORE UPDATE OF owner_id, reservation_bytes ON vault_uploads
FOR EACH ROW EXECUTE FUNCTION prevent_upload_reservation_rewrite();

CREATE TRIGGER vault_upload_reservation_update
AFTER UPDATE ON vault_uploads
REFERENCING OLD TABLE AS old_vault_upload_rows NEW TABLE AS new_vault_upload_rows
FOR EACH STATEMENT EXECUTE FUNCTION update_vault_upload_reservations();

CREATE TRIGGER vault_upload_reservation_delete
AFTER DELETE ON vault_uploads
REFERENCING OLD TABLE AS old_vault_upload_rows
FOR EACH STATEMENT EXECUTE FUNCTION delete_vault_upload_reservations();

COMMIT;
