CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'user')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS display_name TEXT;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS theme_preference TEXT NOT NULL DEFAULT 'system';

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS accent_color TEXT NOT NULL DEFAULT '#3088f0';

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS folder_zip_prompt_enabled BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS profile_image_bytes BYTEA;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS profile_image_mime_type TEXT;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS profile_image_size_bytes BIGINT;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS profile_image_updated_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'users_status_check'
  ) THEN
    ALTER TABLE users
      ADD CONSTRAINT users_status_check CHECK (status IN ('active', 'disabled'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'users_theme_preference_check'
  ) THEN
    ALTER TABLE users
      ADD CONSTRAINT users_theme_preference_check CHECK (theme_preference IN ('system', 'light', 'dark'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'users_accent_color_check'
  ) THEN
    ALTER TABLE users
      ADD CONSTRAINT users_accent_color_check CHECK (accent_color ~ '^#[0-9a-fA-F]{6}$');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'users_profile_image_size_check'
  ) THEN
    ALTER TABLE users
      ADD CONSTRAINT users_profile_image_size_check CHECK (
        profile_image_size_bytes IS NULL
        OR profile_image_size_bytes BETWEEN 0 AND 2097152
      );
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  csrf_token TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS csrf_token TEXT;

CREATE TABLE IF NOT EXISTS invitations (
  id TEXT PRIMARY KEY,
  invited_username TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'user')),
  token_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'revoked', 'expired')),
  created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  original_name TEXT NOT NULL,
  storage_name TEXT NOT NULL UNIQUE,
  mime_type TEXT,
  size_bytes BIGINT NOT NULL CHECK (size_bytes >= 0),
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'trashed')),
  favorite BOOLEAN NOT NULL DEFAULT false,
  trashed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE files
  ADD COLUMN IF NOT EXISTS entry_type TEXT NOT NULL DEFAULT 'file';

ALTER TABLE files
  ADD COLUMN IF NOT EXISTS parent_id TEXT;

ALTER TABLE files
  ADD COLUMN IF NOT EXISTS checksum_sha256 TEXT;

ALTER TABLE files
  ADD COLUMN IF NOT EXISTS object_etag TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'files_entry_type_check'
  ) THEN
    ALTER TABLE files
      ADD CONSTRAINT files_entry_type_check CHECK (entry_type IN ('file', 'folder'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'files_parent_id_fkey'
  ) THEN
    ALTER TABLE files
      ADD CONSTRAINT files_parent_id_fkey
      FOREIGN KEY (parent_id) REFERENCES files(id) ON DELETE CASCADE;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS file_shares (
  id TEXT PRIMARY KEY,
  file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  counts_toward_shared BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE (file_id, recipient_id),
  CHECK (owner_id <> recipient_id)
);

ALTER TABLE file_shares
  ADD COLUMN IF NOT EXISTS counts_toward_shared BOOLEAN NOT NULL DEFAULT TRUE;

UPDATE file_shares
SET counts_toward_shared = EXISTS (
  SELECT 1
  FROM files
  WHERE files.id = file_shares.file_id
    AND files.state = 'active'
    AND files.entry_type = 'file'
);

CREATE TABLE IF NOT EXISTS file_uploads (
  id TEXT PRIMARY KEY,
  file_id TEXT NOT NULL UNIQUE,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  parent_id TEXT REFERENCES files(id) ON DELETE SET NULL,
  original_name TEXT NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  mime_type TEXT,
  size_bytes BIGINT NOT NULL CHECK (size_bytes BETWEEN 0 AND 2147483648),
  upload_mode TEXT NOT NULL CHECK (upload_mode IN ('local', 'single', 'multipart')),
  multipart_upload_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  checksum_sha256 TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE file_uploads
  ADD COLUMN IF NOT EXISTS checksum_sha256 TEXT;

ALTER TABLE file_uploads
  DROP CONSTRAINT IF EXISTS file_uploads_status_check;

ALTER TABLE file_uploads
  ADD CONSTRAINT file_uploads_status_check
  CHECK (status IN ('pending', 'completing', 'completed', 'aborted'));

CREATE TABLE IF NOT EXISTS user_file_counters (
  owner_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  total_files BIGINT NOT NULL DEFAULT 0 CHECK (total_files >= 0),
  total_folders BIGINT NOT NULL DEFAULT 0 CHECK (total_folders >= 0),
  active_files BIGINT NOT NULL DEFAULT 0 CHECK (active_files >= 0),
  trashed_files BIGINT NOT NULL DEFAULT 0 CHECK (trashed_files >= 0),
  favorite_files BIGINT NOT NULL DEFAULT 0 CHECK (favorite_files >= 0),
  shared_files BIGINT NOT NULL DEFAULT 0 CHECK (shared_files >= 0),
  used_bytes BIGINT NOT NULL DEFAULT 0 CHECK (used_bytes >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS storage_deletion_jobs (
  id BIGSERIAL PRIMARY KEY,
  object_key TEXT NOT NULL UNIQUE,
  multipart_upload_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_until TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE storage_deletion_jobs
  ADD COLUMN IF NOT EXISTS multipart_upload_id TEXT;

CREATE TABLE IF NOT EXISTS admin_directory_counters (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  total_users BIGINT NOT NULL DEFAULT 0 CHECK (total_users >= 0),
  active_users BIGINT NOT NULL DEFAULT 0 CHECK (active_users >= 0),
  active_admins BIGINT NOT NULL DEFAULT 0 CHECK (active_admins >= 0),
  pending_invitations BIGINT NOT NULL DEFAULT 0 CHECK (pending_invitations >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO admin_directory_counters (singleton)
VALUES (TRUE)
ON CONFLICT (singleton) DO NOTHING;

INSERT INTO user_file_counters (owner_id)
SELECT id FROM users
ON CONFLICT (owner_id) DO NOTHING;

CREATE OR REPLACE FUNCTION ensure_user_file_counter()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO user_file_counters (owner_id)
  VALUES (NEW.id)
  ON CONFLICT (owner_id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS users_file_counter_insert ON users;
CREATE TRIGGER users_file_counter_insert
AFTER INSERT ON users
FOR EACH ROW EXECUTE FUNCTION ensure_user_file_counter();

CREATE OR REPLACE FUNCTION update_admin_user_counters()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  old_total BIGINT := 0;
  new_total BIGINT := 0;
  old_active BIGINT := 0;
  new_active BIGINT := 0;
  old_admin BIGINT := 0;
  new_admin BIGINT := 0;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    old_total := 1;
    old_active := CASE WHEN OLD.status = 'active' THEN 1 ELSE 0 END;
    old_admin := CASE WHEN OLD.status = 'active' AND OLD.role = 'admin' THEN 1 ELSE 0 END;
  END IF;

  IF TG_OP <> 'DELETE' THEN
    new_total := 1;
    new_active := CASE WHEN NEW.status = 'active' THEN 1 ELSE 0 END;
    new_admin := CASE WHEN NEW.status = 'active' AND NEW.role = 'admin' THEN 1 ELSE 0 END;
  END IF;

  UPDATE admin_directory_counters
  SET total_users = GREATEST(0, total_users + new_total - old_total),
      active_users = GREATEST(0, active_users + new_active - old_active),
      active_admins = GREATEST(0, active_admins + new_admin - old_admin),
      updated_at = now()
  WHERE singleton = TRUE;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS users_admin_counter_change ON users;
CREATE TRIGGER users_admin_counter_change
AFTER INSERT OR UPDATE OR DELETE ON users
FOR EACH ROW EXECUTE FUNCTION update_admin_user_counters();

CREATE OR REPLACE FUNCTION update_admin_invitation_counters()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  old_pending BIGINT := 0;
  new_pending BIGINT := 0;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    old_pending := CASE WHEN OLD.status = 'pending' THEN 1 ELSE 0 END;
  END IF;

  IF TG_OP <> 'DELETE' THEN
    new_pending := CASE WHEN NEW.status = 'pending' THEN 1 ELSE 0 END;
  END IF;

  UPDATE admin_directory_counters
  SET pending_invitations = GREATEST(
        0,
        pending_invitations + new_pending - old_pending
      ),
      updated_at = now()
  WHERE singleton = TRUE;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS invitations_admin_counter_change ON invitations;
CREATE TRIGGER invitations_admin_counter_change
AFTER INSERT OR UPDATE OR DELETE ON invitations
FOR EACH ROW EXECUTE FUNCTION update_admin_invitation_counters();

CREATE OR REPLACE FUNCTION update_file_counters()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  owner TEXT;
  old_total_files BIGINT := 0;
  new_total_files BIGINT := 0;
  old_total_folders BIGINT := 0;
  new_total_folders BIGINT := 0;
  old_trashed_files BIGINT := 0;
  new_trashed_files BIGINT := 0;
  old_favorites BIGINT := 0;
  new_favorites BIGINT := 0;
  old_bytes BIGINT := 0;
  new_bytes BIGINT := 0;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    owner := OLD.owner_id;
    old_total_files := CASE WHEN OLD.entry_type = 'file' AND OLD.state = 'active' THEN 1 ELSE 0 END;
    old_total_folders := CASE WHEN OLD.entry_type = 'folder' AND OLD.state = 'active' THEN 1 ELSE 0 END;
    old_trashed_files := CASE WHEN OLD.entry_type = 'file' AND OLD.state = 'trashed' THEN 1 ELSE 0 END;
    old_favorites := CASE WHEN OLD.state = 'active' AND OLD.favorite THEN 1 ELSE 0 END;
    old_bytes := CASE WHEN OLD.entry_type = 'file' THEN OLD.size_bytes ELSE 0 END;
  END IF;

  IF TG_OP <> 'DELETE' THEN
    owner := NEW.owner_id;
    new_total_files := CASE WHEN NEW.entry_type = 'file' AND NEW.state = 'active' THEN 1 ELSE 0 END;
    new_total_folders := CASE WHEN NEW.entry_type = 'folder' AND NEW.state = 'active' THEN 1 ELSE 0 END;
    new_trashed_files := CASE WHEN NEW.entry_type = 'file' AND NEW.state = 'trashed' THEN 1 ELSE 0 END;
    new_favorites := CASE WHEN NEW.state = 'active' AND NEW.favorite THEN 1 ELSE 0 END;
    new_bytes := CASE WHEN NEW.entry_type = 'file' THEN NEW.size_bytes ELSE 0 END;
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
  VALUES (
    owner,
    new_total_files,
    new_total_folders,
    new_total_files,
    new_trashed_files,
    new_favorites,
    new_bytes
  )
  ON CONFLICT (owner_id) DO UPDATE SET
    total_files = GREATEST(0, user_file_counters.total_files + new_total_files - old_total_files),
    total_folders = GREATEST(0, user_file_counters.total_folders + new_total_folders - old_total_folders),
    active_files = GREATEST(0, user_file_counters.active_files + new_total_files - old_total_files),
    trashed_files = GREATEST(0, user_file_counters.trashed_files + new_trashed_files - old_trashed_files),
    favorite_files = GREATEST(0, user_file_counters.favorite_files + new_favorites - old_favorites),
    used_bytes = GREATEST(0, user_file_counters.used_bytes + new_bytes - old_bytes),
    updated_at = now();

  IF TG_OP = 'UPDATE' AND OLD.state IS DISTINCT FROM NEW.state AND NEW.entry_type = 'file' THEN
    UPDATE user_file_counters
    SET shared_files = GREATEST(
          0,
          shared_files + CASE WHEN NEW.state = 'active' THEN 1 ELSE -1 END
        ),
        updated_at = now()
    WHERE owner_id IN (
      SELECT recipient_id FROM file_shares WHERE file_id = NEW.id
    );

    UPDATE file_shares
    SET counts_toward_shared = (NEW.state = 'active')
    WHERE file_id = NEW.id;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS files_counter_change ON files;
CREATE TRIGGER files_counter_change
AFTER INSERT OR UPDATE OR DELETE ON files
FOR EACH ROW EXECUTE FUNCTION update_file_counters();

CREATE OR REPLACE FUNCTION update_share_counters()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  recipient TEXT;
  shared_file_id TEXT;
  delta BIGINT;
BEGIN
  IF TG_OP = 'INSERT' THEN
    recipient := NEW.recipient_id;
    shared_file_id := NEW.file_id;
    delta := CASE WHEN NEW.counts_toward_shared THEN 1 ELSE 0 END;
  ELSE
    recipient := OLD.recipient_id;
    shared_file_id := OLD.file_id;
    delta := CASE WHEN OLD.counts_toward_shared THEN -1 ELSE 0 END;
  END IF;

  IF delta <> 0 AND (TG_OP = 'DELETE' OR EXISTS (
    SELECT 1 FROM files
    WHERE id = shared_file_id
      AND state = 'active'
      AND entry_type = 'file'
  )) THEN
    INSERT INTO user_file_counters (owner_id, shared_files)
    VALUES (recipient, GREATEST(0, delta))
    ON CONFLICT (owner_id) DO UPDATE SET
      shared_files = GREATEST(0, user_file_counters.shared_files + delta),
      updated_at = now();
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS file_shares_counter_change ON file_shares;
CREATE TRIGGER file_shares_counter_change
AFTER INSERT OR DELETE ON file_shares
FOR EACH ROW EXECUTE FUNCTION update_share_counters();

UPDATE invitations
SET status = 'expired'
WHERE status = 'pending' AND expires_at <= now();

WITH duplicate_pending AS (
  SELECT id
  FROM (
    SELECT
      id,
      row_number() OVER (
        PARTITION BY lower(invited_username)
        ORDER BY created_at DESC, id DESC
      ) AS duplicate_rank
    FROM invitations
    WHERE status = 'pending'
  ) AS ranked
  WHERE duplicate_rank > 1
)
UPDATE invitations
SET status = 'revoked'
FROM duplicate_pending
WHERE invitations.id = duplicate_pending.id;

INSERT INTO user_file_counters (
  owner_id,
  total_files,
  total_folders,
  active_files,
  trashed_files,
  favorite_files,
  shared_files,
  used_bytes,
  updated_at
)
SELECT
  users.id,
  count(files.id) FILTER (WHERE files.state = 'active' AND files.entry_type = 'file'),
  count(files.id) FILTER (WHERE files.state = 'active' AND files.entry_type = 'folder'),
  count(files.id) FILTER (WHERE files.state = 'active' AND files.entry_type = 'file'),
  count(files.id) FILTER (WHERE files.state = 'trashed' AND files.entry_type = 'file'),
  count(files.id) FILTER (WHERE files.state = 'active' AND files.favorite),
  (
    SELECT count(*)
    FROM file_shares
    INNER JOIN files AS shared_files ON shared_files.id = file_shares.file_id
    WHERE file_shares.recipient_id = users.id
      AND shared_files.state = 'active'
      AND shared_files.entry_type = 'file'
  ),
  COALESCE(sum(files.size_bytes) FILTER (WHERE files.entry_type = 'file'), 0)::bigint,
  now()
FROM users
LEFT JOIN files ON files.owner_id = users.id
GROUP BY users.id
ON CONFLICT (owner_id) DO UPDATE SET
  total_files = EXCLUDED.total_files,
  total_folders = EXCLUDED.total_folders,
  active_files = EXCLUDED.active_files,
  trashed_files = EXCLUDED.trashed_files,
  favorite_files = EXCLUDED.favorite_files,
  shared_files = EXCLUDED.shared_files,
  used_bytes = EXCLUDED.used_bytes,
  updated_at = now();

UPDATE admin_directory_counters
SET total_users = (SELECT count(*) FROM users),
    active_users = (SELECT count(*) FROM users WHERE status = 'active'),
    active_admins = (
      SELECT count(*) FROM users WHERE status = 'active' AND role = 'admin'
    ),
    pending_invitations = (
      SELECT count(*) FROM invitations WHERE status = 'pending'
    ),
    updated_at = now()
WHERE singleton = TRUE;

CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions(user_id);
CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS invitations_created_by_idx ON invitations(created_by);
CREATE INDEX IF NOT EXISTS invitations_created_cursor_idx
  ON invitations(created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS invitations_status_idx ON invitations(status);
CREATE INDEX IF NOT EXISTS invitations_expires_at_idx ON invitations(expires_at);
CREATE INDEX IF NOT EXISTS invitations_pending_expiry_idx
  ON invitations(expires_at, id)
  WHERE status = 'pending';
CREATE UNIQUE INDEX IF NOT EXISTS invitations_pending_username_idx
  ON invitations (lower(invited_username))
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS files_owner_id_idx ON files(owner_id);
CREATE INDEX IF NOT EXISTS users_created_cursor_idx ON users(created_at ASC, id ASC);
CREATE INDEX IF NOT EXISTS files_parent_id_idx ON files(parent_id);
CREATE INDEX IF NOT EXISTS files_state_idx ON files(state);
CREATE INDEX IF NOT EXISTS files_updated_at_idx ON files(updated_at);
CREATE INDEX IF NOT EXISTS files_favorite_idx ON files(favorite);
CREATE INDEX IF NOT EXISTS file_shares_file_id_idx ON file_shares(file_id);
CREATE INDEX IF NOT EXISTS file_shares_owner_id_idx ON file_shares(owner_id);
CREATE INDEX IF NOT EXISTS file_shares_recipient_id_idx ON file_shares(recipient_id);
CREATE INDEX IF NOT EXISTS file_uploads_owner_status_expiry_idx
  ON file_uploads(owner_id, status, expires_at);
CREATE INDEX IF NOT EXISTS storage_deletion_jobs_available_idx
  ON storage_deletion_jobs(available_at, locked_until, id);
CREATE INDEX IF NOT EXISTS files_active_browse_name_idx
  ON files (owner_id, parent_id, ((CASE WHEN entry_type = 'folder' THEN 0 ELSE 1 END)), lower(original_name), id)
  WHERE state = 'active';
CREATE INDEX IF NOT EXISTS files_active_browse_name_desc_idx
  ON files (owner_id, parent_id, ((CASE WHEN entry_type = 'folder' THEN 0 ELSE 1 END)), lower(original_name) DESC, id)
  WHERE state = 'active';
CREATE INDEX IF NOT EXISTS files_active_browse_size_idx
  ON files (owner_id, parent_id, ((CASE WHEN entry_type = 'folder' THEN 0 ELSE 1 END)), size_bytes, lower(original_name), id)
  WHERE state = 'active';
CREATE INDEX IF NOT EXISTS files_active_browse_size_desc_idx
  ON files (owner_id, parent_id, ((CASE WHEN entry_type = 'folder' THEN 0 ELSE 1 END)), size_bytes DESC, lower(original_name), id)
  WHERE state = 'active';
CREATE INDEX IF NOT EXISTS files_active_browse_updated_idx
  ON files (owner_id, parent_id, ((CASE WHEN entry_type = 'folder' THEN 0 ELSE 1 END)), updated_at, lower(original_name), id)
  WHERE state = 'active';
CREATE INDEX IF NOT EXISTS files_active_browse_updated_desc_idx
  ON files (owner_id, parent_id, ((CASE WHEN entry_type = 'folder' THEN 0 ELSE 1 END)), updated_at DESC, lower(original_name), id)
  WHERE state = 'active';
CREATE INDEX IF NOT EXISTS files_recent_owner_idx
  ON files (owner_id, updated_at DESC, id)
  WHERE state = 'active';
CREATE INDEX IF NOT EXISTS files_active_owner_name_idx
  ON files (owner_id, ((CASE WHEN entry_type = 'folder' THEN 0 ELSE 1 END)), lower(original_name), id)
  WHERE state = 'active';
CREATE INDEX IF NOT EXISTS files_active_owner_name_desc_idx
  ON files (owner_id, ((CASE WHEN entry_type = 'folder' THEN 0 ELSE 1 END)), lower(original_name) DESC, id)
  WHERE state = 'active';
CREATE INDEX IF NOT EXISTS files_active_owner_size_idx
  ON files (owner_id, ((CASE WHEN entry_type = 'folder' THEN 0 ELSE 1 END)), size_bytes, lower(original_name), id)
  WHERE state = 'active';
CREATE INDEX IF NOT EXISTS files_active_owner_size_desc_idx
  ON files (owner_id, ((CASE WHEN entry_type = 'folder' THEN 0 ELSE 1 END)), size_bytes DESC, lower(original_name), id)
  WHERE state = 'active';
CREATE INDEX IF NOT EXISTS files_active_owner_updated_idx
  ON files (owner_id, ((CASE WHEN entry_type = 'folder' THEN 0 ELSE 1 END)), updated_at, lower(original_name), id)
  WHERE state = 'active';
CREATE INDEX IF NOT EXISTS files_active_owner_updated_desc_idx
  ON files (owner_id, ((CASE WHEN entry_type = 'folder' THEN 0 ELSE 1 END)), updated_at DESC, lower(original_name), id)
  WHERE state = 'active';
CREATE INDEX IF NOT EXISTS files_favorites_owner_page_idx
  ON files (owner_id, ((CASE WHEN entry_type = 'folder' THEN 0 ELSE 1 END)), updated_at DESC, lower(original_name), id)
  WHERE state = 'active' AND favorite;
CREATE INDEX IF NOT EXISTS files_trash_owner_page_idx
  ON files (owner_id, ((CASE WHEN entry_type = 'folder' THEN 0 ELSE 1 END)), trashed_at DESC, lower(original_name), id)
  WHERE state = 'trashed';
CREATE INDEX IF NOT EXISTS file_shares_recipient_created_idx
  ON file_shares (recipient_id, created_at DESC, file_id);

INSERT INTO users (id, username, password_hash, role)
VALUES ('usr_admingod', 'admingod', crypt('admingod', gen_salt('bf')), 'admin')
ON CONFLICT (username) DO NOTHING;
