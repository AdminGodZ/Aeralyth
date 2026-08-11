#!/usr/bin/env bash
set -euo pipefail

cleanup() {
  docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U aeralyth -d aeralyth \
    -c "DELETE FROM users WHERE id = 'usr_perf_reservation_concurrency'" >/dev/null
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
BEGIN
  SELECT * INTO STRICT usage
  FROM user_storage_usage
  WHERE owner_id = 'usr_perf_reservation_concurrency';

  SELECT count(*) INTO uploads
  FROM file_uploads
  WHERE owner_id = 'usr_perf_reservation_concurrency'
    AND status = 'initializing';

  IF usage.reserved_bytes <> 100
     OR usage.pending_uploads <> 10
     OR uploads <> 10 THEN
    RAISE EXCEPTION
      'concurrent quota reservation failed: bytes %, pending %, uploads %',
      usage.reserved_bytes,
      usage.pending_uploads,
      uploads;
  END IF;

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
