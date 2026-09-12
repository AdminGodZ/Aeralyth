#!/usr/bin/env bash
set -euo pipefail

# PG_CONTAINER / MIGRATION_TEST_TEMPLATE allow the same test to use an isolated
# audit container. The default matches the repository's Docker Compose checks.
test_database="aeralyth_migration_progress_${$}"
pg_exec() {
  if [[ -n "${PG_CONTAINER:-}" ]]; then
    docker exec -i "${PG_CONTAINER}" "$@"
  else
    docker compose exec -T postgres "$@"
  fi
}
psql_test() {
  pg_exec psql -X -q -v ON_ERROR_STOP=1 -U aeralyth -d "${test_database}" "$@"
}
cleanup() {
  pg_exec dropdb -U aeralyth --if-exists --force "${test_database}" >/dev/null
}
trap cleanup EXIT

if [[ -n "${MIGRATION_TEST_TEMPLATE:-}" ]]; then
  pg_exec createdb -U aeralyth -T "${MIGRATION_TEST_TEMPLATE}" "${test_database}"
else
  pg_exec createdb -U aeralyth "${test_database}"
  for migration in database/init/[0-9][0-9][0-9]_*.sql; do
    [[ "${migration##*/}" < '028_' ]] || break
    psql_test < "${migration}" >/dev/null
  done
fi

# Seed pre-migration data so backfill is tested separately from live triggers.
psql_test <<'SQL'
INSERT INTO users (id, username, password_hash, role, status)
VALUES ('usr_progress_backfill', 'progress-backfill', 'not-a-login-hash', 'user', 'active');
INSERT INTO files (id, owner_id, original_name, storage_name, size_bytes, entry_type, e2ee_state)
VALUES
  ('fil_progress_backfill_legacy', 'usr_progress_backfill', 'legacy', 'progress/backfill/legacy', 0, 'folder', 'legacy'),
  ('fil_progress_backfill_staged', 'usr_progress_backfill', 'staged', 'progress/backfill/staged', 0, 'file', 'staged'),
  ('fil_progress_backfill_cleanup', 'usr_progress_backfill', 'cleanup', 'progress/backfill/cleanup', 0, 'file', 'encrypted');
INSERT INTO vault_migrations (node_id, owner_id, state) VALUES
  ('fil_progress_backfill_staged', 'usr_progress_backfill', 'failed'),
  ('fil_progress_backfill_cleanup', 'usr_progress_backfill', 'cleanup_queued');
SQL
psql_test < database/init/028_migration_progress.sql >/dev/null
psql_test < database/init/028_migration_progress.sql >/dev/null
psql_test <<'SQL'
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM vault_migration_progress
    WHERE owner_id = 'usr_progress_backfill' AND legacy_nodes = 1 AND incomplete_nodes = 2) THEN
    RAISE EXCEPTION 'backfill/replay did not retain exact legacy and pending counts';
  END IF;
  IF (SELECT count(*) FROM schema_migrations WHERE version = '028-migration-progress') <> 1 THEN
    RAISE EXCEPTION 'migration replay ledger is incorrect';
  END IF;
END $$;
SQL
psql_test < database/tests/migration_progress.sql

# Two source tables can change the same node concurrently. Keep the file writer
# open briefly so migration completion waits on the node tracker, then verify
# the final union and its counter after both writers commit.
psql_test <<'SQL'
INSERT INTO users (id, username, password_hash, role, status)
VALUES ('usr_progress_concurrent', 'progress-concurrent', 'not-a-login-hash', 'user', 'active');
INSERT INTO files (id, owner_id, original_name, storage_name, size_bytes, entry_type, e2ee_state)
VALUES ('fil_progress_concurrent', 'usr_progress_concurrent', 'concurrent', 'progress/concurrent', 0, 'file', 'staged');
INSERT INTO vault_migrations (node_id, owner_id, state)
VALUES ('fil_progress_concurrent', 'usr_progress_concurrent', 'cleanup_queued');
SQL
psql_test <<'SQL' &
BEGIN;
UPDATE files SET e2ee_state = 'encrypted' WHERE id = 'fil_progress_concurrent';
SELECT pg_sleep(0.5);
COMMIT;
SQL
file_writer=$!
psql_test <<'SQL' &
BEGIN;
UPDATE vault_migrations SET state = 'complete' WHERE node_id = 'fil_progress_concurrent';
COMMIT;
SQL
migration_writer=$!
wait "${file_writer}"
wait "${migration_writer}"
psql_test <<'SQL'
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM vault_migration_progress
    WHERE owner_id = 'usr_progress_concurrent' AND legacy_nodes = 0 AND incomplete_nodes = 0)
    OR EXISTS (SELECT 1 FROM vault_migration_node_progress WHERE owner_id = 'usr_progress_concurrent') THEN
    RAISE EXCEPTION 'concurrent file and migration completion left incorrect progress';
  END IF;
END $$;
SQL
echo 'fresh/backfill/replay and concurrent migration progress checks passed'
