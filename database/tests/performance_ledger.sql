\set ON_ERROR_STOP on

BEGIN;

SELECT
  'usr_perf_ledger_' || pg_backend_pid()::text AS test_user_id,
  'perf_ledger_' || pg_backend_pid()::text AS test_username
\gset

INSERT INTO users (id, username, password_hash, role)
VALUES (:'test_user_id', :'test_username', 'not-a-login-hash', 'user');

SELECT set_config('aeralyth.test_user_id', :'test_user_id', true);

CREATE TEMP TABLE accounting_writes (
  relation_name TEXT NOT NULL
) ON COMMIT DROP;

CREATE FUNCTION pg_temp.capture_accounting_write()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $function$
BEGIN
  INSERT INTO accounting_writes (relation_name) VALUES (TG_TABLE_NAME);
  RETURN NEW;
END;
$function$;

CREATE TRIGGER test_file_counter_writes
AFTER UPDATE ON user_file_counters
FOR EACH ROW EXECUTE FUNCTION pg_temp.capture_accounting_write();

CREATE TRIGGER test_storage_usage_writes
AFTER UPDATE ON user_storage_usage
FOR EACH ROW EXECUTE FUNCTION pg_temp.capture_accounting_write();

INSERT INTO files (
  id, owner_id, original_name, storage_name, size_bytes, entry_type
)
SELECT
  'fil_perf_ledger_' || pg_backend_pid()::text || '_' || value,
  :'test_user_id',
  'file-' || value,
  'perf-ledger/' || pg_backend_pid()::text || '/' || value,
  1,
  'file'
FROM generate_series(1, 10000) AS value;

DO $assertion$
DECLARE
  counters user_file_counters%ROWTYPE;
  usage user_storage_usage%ROWTYPE;
BEGIN
  SELECT * INTO STRICT counters
  FROM user_file_counters
  WHERE owner_id = current_setting('aeralyth.test_user_id');
  SELECT * INTO STRICT usage
  FROM user_storage_usage
  WHERE owner_id = current_setting('aeralyth.test_user_id');

  IF counters.total_files <> 10000 OR counters.active_files <> 10000
     OR counters.used_bytes <> 10000 OR usage.used_bytes <> 10000 THEN
    RAISE EXCEPTION 'bulk insert counters are incorrect';
  END IF;
  IF (SELECT count(*) FROM accounting_writes WHERE relation_name = 'user_file_counters') <> 1
     OR (SELECT count(*) FROM accounting_writes WHERE relation_name = 'user_storage_usage') <> 1 THEN
    RAISE EXCEPTION 'bulk insert did not aggregate to one accounting write per table';
  END IF;
END
$assertion$;

TRUNCATE accounting_writes;

UPDATE files
SET updated_at = clock_timestamp()
WHERE owner_id = :'test_user_id';

DO $assertion$
BEGIN
  IF EXISTS (SELECT 1 FROM accounting_writes) THEN
    RAISE EXCEPTION 'metadata-only update rewrote an accounting row';
  END IF;
END
$assertion$;

UPDATE files
SET state = 'trashed', trashed_at = now()
WHERE owner_id = :'test_user_id';

DO $assertion$
DECLARE
  counters user_file_counters%ROWTYPE;
BEGIN
  SELECT * INTO STRICT counters
  FROM user_file_counters
  WHERE owner_id = current_setting('aeralyth.test_user_id');
  IF counters.active_files <> 0 OR counters.trashed_files <> 10000
     OR counters.used_bytes <> 10000 THEN
    RAISE EXCEPTION 'bulk trash counters are incorrect';
  END IF;
  IF (SELECT count(*) FROM accounting_writes WHERE relation_name = 'user_file_counters') <> 1
     OR EXISTS (
       SELECT 1 FROM accounting_writes WHERE relation_name = 'user_storage_usage'
     ) THEN
    RAISE EXCEPTION 'bulk trash did not aggregate to one UI-counter write';
  END IF;
END
$assertion$;

TRUNCATE accounting_writes;

UPDATE files
SET state = 'active', trashed_at = NULL, size_bytes = 2
WHERE owner_id = :'test_user_id';

DO $assertion$
DECLARE
  counters user_file_counters%ROWTYPE;
  usage user_storage_usage%ROWTYPE;
BEGIN
  SELECT * INTO STRICT counters
  FROM user_file_counters
  WHERE owner_id = current_setting('aeralyth.test_user_id');
  SELECT * INTO STRICT usage
  FROM user_storage_usage
  WHERE owner_id = current_setting('aeralyth.test_user_id');
  IF counters.active_files <> 10000 OR counters.trashed_files <> 0
     OR counters.used_bytes <> 20000 OR usage.used_bytes <> 20000 THEN
    RAISE EXCEPTION 'bulk restore/resize counters are incorrect';
  END IF;
  IF (SELECT count(*) FROM accounting_writes WHERE relation_name = 'user_file_counters') <> 1
     OR (SELECT count(*) FROM accounting_writes WHERE relation_name = 'user_storage_usage') <> 1 THEN
    RAISE EXCEPTION 'bulk restore/resize was not aggregated';
  END IF;
END
$assertion$;

TRUNCATE accounting_writes;

DELETE FROM files WHERE owner_id = :'test_user_id';

DO $assertion$
DECLARE
  counters user_file_counters%ROWTYPE;
  usage user_storage_usage%ROWTYPE;
BEGIN
  SELECT * INTO STRICT counters
  FROM user_file_counters
  WHERE owner_id = current_setting('aeralyth.test_user_id');
  SELECT * INTO STRICT usage
  FROM user_storage_usage
  WHERE owner_id = current_setting('aeralyth.test_user_id');
  IF counters.total_files <> 0 OR counters.active_files <> 0
     OR counters.used_bytes <> 0 OR usage.used_bytes <> 0 THEN
    RAISE EXCEPTION 'bulk delete counters are incorrect';
  END IF;
  IF (SELECT count(*) FROM accounting_writes WHERE relation_name = 'user_file_counters') <> 1
     OR (SELECT count(*) FROM accounting_writes WHERE relation_name = 'user_storage_usage') <> 1 THEN
    RAISE EXCEPTION 'bulk delete was not aggregated';
  END IF;
END
$assertion$;

TRUNCATE accounting_writes;

DO $reservation_test$
DECLARE
  value INTEGER;
  affected BIGINT;
BEGIN
  FOR value IN 1..20 LOOP
    UPDATE user_storage_usage
    SET reserved_bytes = reserved_bytes + 10,
        pending_uploads = pending_uploads + 1
    WHERE owner_id = current_setting('aeralyth.test_user_id')
      AND pending_uploads < 20
      AND used_bytes + reserved_bytes <= 1000 - 10;
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 1 THEN
      RAISE EXCEPTION 'reservation % was unexpectedly rejected', value;
    END IF;

    IF value <= 10 THEN
      INSERT INTO file_uploads (
        id, file_id, owner_id, original_name, object_key,
        size_bytes, upload_mode, reservation_bytes, status, expires_at
      ) VALUES (
        'upl_perf_ledger_' || pg_backend_pid()::text || '_' || value,
        'fil_perf_reservation_' || pg_backend_pid()::text || '_' || value,
        current_setting('aeralyth.test_user_id'),
        'reservation-' || value,
        'perf-ledger/reservation/' || pg_backend_pid()::text || '/' || value,
        10,
        'local',
        10,
        'initializing',
        now() + interval '1 hour'
      );
    ELSE
      INSERT INTO vault_uploads (
        id, node_id, owner_id, entry_type, generation_number, generation_id,
        object_key, ciphertext_length, chunk_count, upload_mode,
        reservation_bytes, status, expires_at
      ) VALUES (
        'vup_perf_ledger_' || pg_backend_pid()::text || '_' || value,
        'nod_perf_reservation_' || pg_backend_pid()::text || '_' || value,
        current_setting('aeralyth.test_user_id'),
        'file',
        value,
        decode(lpad(to_hex(value), 32, '0'), 'hex'),
        'perf-ledger/vault-reservation/' || pg_backend_pid()::text || '/' || value,
        10,
        1,
        'single',
        10,
        'initializing',
        now() + interval '1 hour'
      );
    END IF;
  END LOOP;

  UPDATE user_storage_usage
  SET reserved_bytes = reserved_bytes + 10,
      pending_uploads = pending_uploads + 1
  WHERE owner_id = current_setting('aeralyth.test_user_id')
    AND pending_uploads < 20
    AND used_bytes + reserved_bytes <= 1000 - 10;
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 0 THEN
    RAISE EXCEPTION 'twenty-first pending upload was not rejected';
  END IF;
END
$reservation_test$;

TRUNCATE accounting_writes;

UPDATE file_uploads
SET expires_at = expires_at + interval '1 minute'
WHERE owner_id = :'test_user_id';

UPDATE vault_uploads
SET expires_at = expires_at + interval '1 minute'
WHERE owner_id = :'test_user_id';

DO $assertion$
BEGIN
  IF EXISTS (SELECT 1 FROM accounting_writes) THEN
    RAISE EXCEPTION 'non-state upload update rewrote the storage ledger';
  END IF;
END
$assertion$;

UPDATE file_uploads
SET status = 'aborted'
WHERE owner_id = :'test_user_id';

UPDATE vault_uploads
SET status = 'aborted'
WHERE owner_id = :'test_user_id';

DO $assertion$
DECLARE
  usage user_storage_usage%ROWTYPE;
BEGIN
  SELECT * INTO STRICT usage
  FROM user_storage_usage
  WHERE owner_id = current_setting('aeralyth.test_user_id');
  IF usage.reserved_bytes <> 0 OR usage.pending_uploads <> 0 THEN
    RAISE EXCEPTION 'terminal transition did not release reservations';
  END IF;
  IF (SELECT count(*) FROM accounting_writes WHERE relation_name = 'user_storage_usage') <> 2 THEN
    RAISE EXCEPTION 'file and vault terminal transitions were not aggregated per statement';
  END IF;
END
$assertion$;

DO $immutability_test$
BEGIN
  BEGIN
    UPDATE file_uploads
    SET reservation_bytes = reservation_bytes + 1
    WHERE owner_id = current_setting('aeralyth.test_user_id');
    RAISE EXCEPTION 'reservation rewrite unexpectedly succeeded';
  EXCEPTION
    WHEN raise_exception THEN
      IF SQLERRM <> 'upload reservation ownership and bytes are immutable' THEN
        RAISE;
      END IF;
  END;

  BEGIN
    UPDATE vault_uploads
    SET reservation_bytes = reservation_bytes + 1
    WHERE owner_id = current_setting('aeralyth.test_user_id');
    RAISE EXCEPTION 'vault reservation rewrite unexpectedly succeeded';
  EXCEPTION
    WHEN raise_exception THEN
      IF SQLERRM <> 'upload reservation ownership and bytes are immutable' THEN
        RAISE;
      END IF;
  END;
END
$immutability_test$;

UPDATE user_storage_usage
SET reserved_bytes = reserved_bytes + 15,
    pending_uploads = pending_uploads + 2
WHERE owner_id = :'test_user_id';

INSERT INTO file_uploads (
  id, file_id, owner_id, original_name, object_key,
  size_bytes, upload_mode, reservation_bytes, status, expires_at
) VALUES (
  'upl_perf_delete_' || pg_backend_pid()::text,
  'fil_perf_delete_' || pg_backend_pid()::text,
  :'test_user_id',
  'delete-release',
  'perf-ledger/delete-release/' || pg_backend_pid()::text,
  7,
  'local',
  7,
  'initializing',
  now() + interval '1 hour'
);

INSERT INTO vault_uploads (
  id, node_id, owner_id, entry_type, generation_number, generation_id,
  object_key, ciphertext_length, chunk_count, upload_mode,
  reservation_bytes, status, expires_at
) VALUES (
  'vup_perf_delete_' || pg_backend_pid()::text,
  'nod_perf_delete_' || pg_backend_pid()::text,
  :'test_user_id',
  'file',
  100,
  decode('ffffffffffffffffffffffffffffffff', 'hex'),
  'perf-ledger/vault-delete-release/' || pg_backend_pid()::text,
  8,
  1,
  'single',
  8,
  'initializing',
  now() + interval '1 hour'
);

TRUNCATE accounting_writes;

DELETE FROM file_uploads
WHERE id = 'upl_perf_delete_' || pg_backend_pid()::text;

DELETE FROM vault_uploads
WHERE id = 'vup_perf_delete_' || pg_backend_pid()::text;

DO $assertion$
DECLARE
  usage user_storage_usage%ROWTYPE;
BEGIN
  SELECT * INTO STRICT usage
  FROM user_storage_usage
  WHERE owner_id = current_setting('aeralyth.test_user_id');
  IF usage.reserved_bytes <> 0 OR usage.pending_uploads <> 0 THEN
    RAISE EXCEPTION 'active upload deletion did not release reservations';
  END IF;
  IF (SELECT count(*) FROM accounting_writes WHERE relation_name = 'user_storage_usage') <> 2 THEN
    RAISE EXCEPTION 'file and vault deletion releases were not aggregated per statement';
  END IF;
END
$assertion$;

ROLLBACK;

SELECT 'performance ledger regression checks passed' AS result;
