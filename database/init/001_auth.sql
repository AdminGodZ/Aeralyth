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

CREATE TABLE IF NOT EXISTS file_shares (
  id TEXT PRIMARY KEY,
  file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (file_id, recipient_id),
  CHECK (owner_id <> recipient_id)
);

CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions(user_id);
CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS invitations_created_by_idx ON invitations(created_by);
CREATE INDEX IF NOT EXISTS invitations_status_idx ON invitations(status);
CREATE INDEX IF NOT EXISTS invitations_expires_at_idx ON invitations(expires_at);
CREATE UNIQUE INDEX IF NOT EXISTS invitations_pending_username_idx
  ON invitations (lower(invited_username))
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS files_owner_id_idx ON files(owner_id);
CREATE INDEX IF NOT EXISTS files_state_idx ON files(state);
CREATE INDEX IF NOT EXISTS files_updated_at_idx ON files(updated_at);
CREATE INDEX IF NOT EXISTS files_favorite_idx ON files(favorite);
CREATE INDEX IF NOT EXISTS file_shares_file_id_idx ON file_shares(file_id);
CREATE INDEX IF NOT EXISTS file_shares_owner_id_idx ON file_shares(owner_id);
CREATE INDEX IF NOT EXISTS file_shares_recipient_id_idx ON file_shares(recipient_id);

INSERT INTO users (id, username, password_hash, role)
VALUES ('usr_admingod', 'admingod', crypt('admingod', gen_salt('bf')), 'admin')
ON CONFLICT (username) DO UPDATE
SET password_hash = EXCLUDED.password_hash,
    role = EXCLUDED.role,
    status = 'active',
    updated_at = now();
