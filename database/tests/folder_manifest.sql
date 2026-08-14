\set ON_ERROR_STOP on

BEGIN;

SELECT
  'usr_folder_manifest_' || pg_backend_pid()::text AS test_user_id,
  'folder_manifest_' || pg_backend_pid()::text AS test_username
\gset

INSERT INTO users (id, username, password_hash, role)
VALUES (:'test_user_id', :'test_username', 'not-a-login-hash', 'user');

SELECT set_config('aeralyth.test_user_id', :'test_user_id', true);

CREATE TEMP TABLE folder_counter_writes (
  owner_id TEXT NOT NULL
) ON COMMIT DROP;

CREATE FUNCTION pg_temp.capture_folder_counter_write()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $function$
BEGIN
  INSERT INTO folder_counter_writes (owner_id) VALUES (NEW.owner_id);
  RETURN NEW;
END;
$function$;

CREATE TRIGGER test_folder_counter_writes
AFTER UPDATE ON user_file_counters
FOR EACH ROW EXECUTE FUNCTION pg_temp.capture_folder_counter_write();

SELECT path, id
FROM ensure_legacy_folder_level(
  :'test_user_id',
  ARRAY['project'],
  ARRAY[NULL]::TEXT[],
  ARRAY['Project']
)
\gset root_

SELECT path, id
FROM ensure_legacy_folder_level(
  :'test_user_id',
  ARRAY['project/src', 'project/docs'],
  ARRAY[:'root_id', :'root_id'],
  ARRAY['src', 'docs']
);

DO $assertion$
DECLARE
  folder_count BIGINT;
  counter_writes BIGINT;
BEGIN
  SELECT count(*) INTO folder_count
  FROM files
  WHERE owner_id = current_setting('aeralyth.test_user_id');

  SELECT count(*) INTO counter_writes
  FROM folder_counter_writes
  WHERE owner_id = current_setting('aeralyth.test_user_id');

  IF folder_count <> 3 THEN
    RAISE EXCEPTION 'folder manifest created % folders instead of 3', folder_count;
  END IF;
  IF counter_writes <> 2 THEN
    RAISE EXCEPTION
      'folder manifest should aggregate counters once per depth; observed % writes',
      counter_writes;
  END IF;
END
$assertion$;

TRUNCATE folder_counter_writes;

SELECT path, id
FROM ensure_legacy_folder_level(
  :'test_user_id',
  ARRAY['project'],
  ARRAY[NULL]::TEXT[],
  ARRAY['project']
);

SELECT path, id
FROM ensure_legacy_folder_level(
  :'test_user_id',
  ARRAY['project/src', 'project/docs'],
  ARRAY[:'root_id', :'root_id'],
  ARRAY['SRC', 'docs']
);

DO $assertion$
BEGIN
  IF (
    SELECT count(*) FROM files
    WHERE owner_id = current_setting('aeralyth.test_user_id')
      AND entry_type = 'folder'
  ) <> 3 THEN
    RAISE EXCEPTION 'idempotent manifest replay created duplicate folders';
  END IF;
  IF EXISTS (
    SELECT 1 FROM folder_counter_writes
    WHERE owner_id = current_setting('aeralyth.test_user_id')
  ) THEN
    RAISE EXCEPTION 'idempotent manifest replay rewrote the UI counter';
  END IF;
END
$assertion$;

ROLLBACK;

SELECT 'folder manifest regression checks passed' AS result;
