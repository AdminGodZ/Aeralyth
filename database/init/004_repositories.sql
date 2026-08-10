CREATE TABLE IF NOT EXISTS repositories (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  root_file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  description TEXT CONSTRAINT repositories_description_length_check
    CHECK (char_length(description) <= 350),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (owner_id, root_file_id)
);

CREATE INDEX IF NOT EXISTS repositories_owner_updated_idx
  ON repositories (owner_id, updated_at DESC, id);
