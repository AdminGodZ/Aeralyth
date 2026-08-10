ALTER TABLE repositories
  ADD COLUMN IF NOT EXISTS description TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'repositories_description_length_check'
      AND conrelid = 'repositories'::regclass
  ) THEN
    ALTER TABLE repositories
      ADD CONSTRAINT repositories_description_length_check
      CHECK (char_length(description) <= 350);
  END IF;
END
$$;
