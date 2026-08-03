CREATE TABLE IF NOT EXISTS share_links (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  root_file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  access_scope TEXT NOT NULL CHECK (access_scope IN ('public', 'account')),
  permission TEXT NOT NULL CHECK (permission IN ('viewer', 'editor')),
  recipient_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (
    (access_scope = 'public' AND recipient_id IS NULL)
    OR (access_scope = 'account' AND recipient_id IS NOT NULL)
  ),
  CHECK (recipient_id IS NULL OR owner_id <> recipient_id)
);

CREATE INDEX IF NOT EXISTS share_links_owner_root_idx
  ON share_links (owner_id, root_file_id, created_at DESC);

CREATE INDEX IF NOT EXISTS share_links_recipient_idx
  ON share_links (recipient_id, expires_at)
  WHERE revoked_at IS NULL;

ALTER TABLE share_links
  ALTER COLUMN expires_at DROP NOT NULL;

ALTER TABLE file_uploads
  ADD COLUMN IF NOT EXISTS share_link_id TEXT REFERENCES share_links(id) ON DELETE SET NULL;

ALTER TABLE file_uploads
  ADD COLUMN IF NOT EXISTS replacement_file_id TEXT REFERENCES files(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS file_uploads_share_link_idx
  ON file_uploads (share_link_id, status, expires_at);
