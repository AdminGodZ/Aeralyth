#!/usr/bin/env bash
set -euo pipefail

cleanup() {
  docker compose exec -T postgres psql -q -v ON_ERROR_STOP=1 -U aeralyth -d aeralyth <<'SQL'
DROP TRIGGER IF EXISTS perf_reservation_counter_write_audit ON user_file_counters;
DROP FUNCTION IF EXISTS capture_perf_reservation_counter_write();
DROP TABLE IF EXISTS perf_reservation_counter_writes;
DELETE FROM users WHERE id = 'usr_perf_reservation_concurrency';
SQL
}

trap cleanup EXIT
cleanup

docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U aeralyth -d aeralyth <<'SQL'
INSERT INTO users (id, username, password_hash, role)
VALUES (
  'usr_perf_reservation_concurrency',
  'perf_reservation_concurrency',
  'not-a-login-hash',
  'user'
);

CREATE UNLOGGED TABLE perf_reservation_counter_writes (
  owner_id TEXT NOT NULL
);

CREATE FUNCTION capture_perf_reservation_counter_write()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $function$
BEGIN
  INSERT INTO perf_reservation_counter_writes (owner_id) VALUES (NEW.owner_id);
  RETURN NEW;
END;
$function$;

CREATE TRIGGER perf_reservation_counter_write_audit
AFTER UPDATE ON user_file_counters
FOR EACH ROW EXECUTE FUNCTION capture_perf_reservation_counter_write();

SELECT pg_stat_statements_reset();
SQL

docker compose exec -T postgres pgbench \
  -U aeralyth \
  -d aeralyth \
  -n \
  -c 40 \
  -j 8 \
  -t 1 \
  -f /docker-entrypoint-initdb.d/performance_reservation.pgbench

docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U aeralyth -d aeralyth <<'SQL'
DO $assertion$
DECLARE
  usage user_storage_usage%ROWTYPE;
  uploads BIGINT;
  counter_writes BIGINT;
  statement_calls BIGINT;
  mean_statement_ms DOUBLE PRECISION;
  max_statement_ms DOUBLE PRECISION;
BEGIN
  SELECT * INTO STRICT usage
  FROM user_storage_usage
  WHERE owner_id = 'usr_perf_reservation_concurrency';

  SELECT count(*) INTO uploads
  FROM file_uploads
  WHERE owner_id = 'usr_perf_reservation_concurrency'
    AND status = 'initializing';

  SELECT count(*) INTO counter_writes
  FROM perf_reservation_counter_writes
  WHERE owner_id = 'usr_perf_reservation_concurrency';

  SELECT calls, mean_exec_time, max_exec_time
  INTO STRICT statement_calls, mean_statement_ms, max_statement_ms
  FROM pg_stat_statements
  WHERE query LIKE 'WITH reserved AS (%'
    AND query LIKE '%INSERT INTO file_uploads%'
  ORDER BY calls DESC
  LIMIT 1;

  IF usage.reserved_bytes <> 100
     OR usage.pending_uploads <> 10
     OR uploads <> 10
     OR counter_writes <> 0 THEN
    RAISE EXCEPTION
      'concurrent quota reservation failed: bytes %, pending %, uploads %, UI counter writes %',
      usage.reserved_bytes,
      usage.pending_uploads,
      uploads,
      counter_writes;
  END IF;

  IF statement_calls IS NULL OR statement_calls <> 40 THEN
    RAISE EXCEPTION 'expected 40 measured reservation statements, found %', statement_calls;
  END IF;
  IF mean_statement_ms > 50 OR max_statement_ms > 250 THEN
    RAISE EXCEPTION
      'reservation critical section regressed: mean % ms, max % ms',
      round(mean_statement_ms::numeric, 3),
      round(max_statement_ms::numeric, 3);
  END IF;

  RAISE NOTICE 'reservation SQL latency: mean % ms, max % ms across % calls',
    round(mean_statement_ms::numeric, 3),
    round(max_statement_ms::numeric, 3),
    statement_calls;

  UPDATE file_uploads
  SET status = 'aborted'
  WHERE owner_id = 'usr_perf_reservation_concurrency';

  SELECT * INTO STRICT usage
  FROM user_storage_usage
  WHERE owner_id = 'usr_perf_reservation_concurrency';
  IF usage.reserved_bytes <> 0 OR usage.pending_uploads <> 0 THEN
    RAISE EXCEPTION 'reservation release failed after concurrent test';
  END IF;
END
$assertion$;

SELECT 'concurrent reservation regression checks passed' AS result;
SQL
