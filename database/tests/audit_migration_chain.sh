#!/usr/bin/env bash
set -euo pipefail

# This audit must never fall back to the project's development Compose database.
test_container="${AERALYTH_TEST_CONTAINER:-aeralyth-audit-db-suite-20260912}"
case "${test_container}" in
  aeralyth-audit-db-*) ;;
  *) echo 'AERALYTH_TEST_CONTAINER must name an isolated aeralyth-audit-db-* container' >&2; exit 2 ;;
esac

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "${repo_root}"
test_database="aeralyth_audit_chain_$(date +%Y%m%d%H%M%S)_$$_${RANDOM}"
result_dir="${repo_root}/performance/results/database-audit-2026-09-12"
mkdir -p "${result_dir}"
scratch_dir="$(mktemp -d "${TMPDIR:-/tmp}/aeralyth-audit-chain.XXXXXX")"
exec > >(tee "${result_dir}/chain.log") 2>&1
database_created=false
worker_pids=()

pg_exec() {
  docker exec -i "${test_container}" "$@"
}
psql_test() {
  pg_exec psql -X -q -v ON_ERROR_STOP=1 -U aeralyth -d "${test_database}" "$@"
}
cleanup() {
  local status=$?
  trap - EXIT
  for worker_pid in "${worker_pids[@]:-}"; do
    [[ -n "${worker_pid}" ]] && kill "${worker_pid}" 2>/dev/null || true
  done
  if [[ "${database_created}" == true && "${test_database}" == aeralyth_audit_chain_* ]]; then
    if ! pg_exec dropdb -U aeralyth --if-exists --force "${test_database}"; then
      echo "ERROR: could not remove generated audit database ${test_database}" >&2
      status=1
    fi
  fi
  rm -rf "${scratch_dir}"
  exit "${status}"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

ready=false
for _ in {1..30}; do
  if pg_exec pg_isready -U aeralyth -d postgres >/dev/null 2>&1; then
    ready=true
    break
  fi
  sleep 1
done
[[ "${ready}" == true ]] || { echo 'Isolated audit database did not become ready'; exit 1; }

printf 'Container: %s\nDatabase: %s\nStarted: %s\n' "${test_container}" "${test_database}" "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
pg_exec createdb -U aeralyth "${test_database}"
database_created=true
migrations=(database/init/[0-9][0-9][0-9]_*.sql)
if command -v sha256sum >/dev/null 2>&1; then
  checksum_command=(sha256sum)
else
  checksum_command=(shasum -a 256)
fi
"${checksum_command[@]}" "${migrations[@]}" > "${result_dir}/chain-sources.sha256"
numbered_count="${#migrations[@]}"
expected_count=0
for migration in "${migrations[@]}"; do
  if rg -qi 'INSERT INTO schema_migrations' "${migration}"; then
    expected_count=$((expected_count + 1))
  else
    printf 'NOTICE: legacy migration has no ledger entry: %s\n' "${migration##*/}"
  fi
done
rg -Uo --no-filename --replace '$1' \
  "INSERT INTO schema_migrations\\s*\\(\\s*version\\s*\\)\\s*VALUES\\s*\\(\\s*'([^']+)'" \
  "${migrations[@]}" | LC_ALL=C sort > "${scratch_dir}/expected-versions"
[[ "$(wc -l < "${scratch_dir}/expected-versions" | tr -d ' ')" == "${expected_count}" ]] || {
  echo 'Could not extract exactly one declared version for each ledger-backed migration' >&2
  exit 1
}

apply_chain() {
  local migration
  for migration in "${migrations[@]}"; do
    printf 'Applying %s\n' "${migration##*/}"
    psql_test < "${migration}"
  done
}
assert_ledger() {
  local actual_count
  actual_count="$(psql_test -At -c 'SELECT count(*) FROM schema_migrations')"
  psql_test -At -c 'SELECT version FROM schema_migrations ORDER BY version COLLATE "C"' > "${scratch_dir}/actual-versions"
  [[ "${actual_count}" == "${expected_count}" ]] || {
    echo "Ledger mismatch: ${actual_count} rows for ${expected_count} ledger-backed migrations among ${numbered_count} numbered files" >&2
    exit 1
  }
  if ! cmp -s "${scratch_dir}/expected-versions" "${scratch_dir}/actual-versions"; then
    diff -u "${scratch_dir}/expected-versions" "${scratch_dir}/actual-versions" || true
    echo 'Migration ledger differs from the exact versions declared by the SQL files' >&2
    exit 1
  fi
  printf 'PASS: migration ledger contains %s rows for %s ledger-backed migrations among %s numbered files\n' "${actual_count}" "${expected_count}" "${numbered_count}"
}

apply_chain
assert_ledger

# Use a tiny fixture that exercises populated hierarchy and durable worker state.
psql_test <<'SQL'
INSERT INTO users (id, username, password_hash, role, status)
VALUES ('usr_chain_audit', 'chain-audit', 'not-a-login-hash', 'user', 'active');
INSERT INTO files (id, owner_id, original_name, storage_name, size_bytes, entry_type)
VALUES ('fil_chain_root', 'usr_chain_audit', 'Root', 'audit/root', 0, 'folder');
INSERT INTO files (id, owner_id, parent_id, original_name, storage_name, size_bytes, entry_type)
VALUES ('fil_chain_child', 'usr_chain_audit', 'fil_chain_root', 'Child.txt', 'audit/child', 17, 'file');
INSERT INTO bucket_usage_snapshots (
  namespace, used_bytes, object_count, measured_at, completed_at,
  scan_token, scan_used_bytes, scan_object_count, scan_pages,
  lease_token, lease_until
) VALUES (
  'audit-chain-bucket', 1234, 7, now(), now(),
  'saved-provider-token', 567, 3, 1, 'saved-worker-lease', now() + interval '1 hour'
);
INSERT INTO multipart_reconciliation_progress (
  namespace, lease_token, lease_until, key_marker, upload_id_marker, next_scan_at
) VALUES (
  'audit-chain-multipart', 'saved-sweep-lease', now() + interval '1 hour',
  'saved-key', 'saved-upload-id', now() + interval '2 hours'
);
INSERT INTO multipart_orphan_abort_claims (namespace, object_key, upload_id, attempts)
VALUES ('audit-chain-multipart', 'users/audit/orphan', 'saved-orphan-id', 4);

CREATE SCHEMA audit_chain_checks;
CREATE TABLE audit_chain_checks.writes (relation_name TEXT, operation TEXT);
CREATE FUNCTION audit_chain_checks.record_write() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO audit_chain_checks.writes VALUES (TG_TABLE_NAME, TG_OP);
  RETURN NULL;
END;
$$;
DO $$ DECLARE relation RECORD; BEGIN
  FOR relation IN SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> 'schema_migrations' ORDER BY tablename LOOP
    EXECUTE format(
      'CREATE TRIGGER audit_chain_write AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON public.%I '
      'FOR EACH STATEMENT EXECUTE FUNCTION audit_chain_checks.record_write()', relation.tablename
    );
  END LOOP;
END; $$;

-- Any hierarchy revalidation on replay must fail, even for a tiny hierarchy.
-- A migration replacing this sentinel is caught by the definition snapshot too.
CREATE OR REPLACE FUNCTION assert_file_hierarchy_valid(changed_ids TEXT[])
RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Migration replay unexpectedly invoked full hierarchy validation';
END;
$$;

CREATE FUNCTION audit_chain_checks.row_snapshot() RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE relation RECORD; contents JSONB; result JSONB := '{}'::jsonb;
BEGIN
  FOR relation IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename LOOP
    EXECUTE format(
      'SELECT COALESCE(jsonb_agg(to_jsonb(item) ORDER BY to_jsonb(item)::text), ''[]''::jsonb) FROM public.%I item',
      relation.tablename
    ) INTO contents;
    result := result || jsonb_build_object(relation.tablename, contents);
  END LOOP;
  RETURN result;
END;
$$;
CREATE FUNCTION audit_chain_checks.sequence_snapshot() RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE sequence RECORD; contents JSONB; result JSONB := '{}'::jsonb;
BEGIN
  FOR sequence IN SELECT sequencename FROM pg_sequences WHERE schemaname = 'public' ORDER BY sequencename LOOP
    EXECUTE format('SELECT jsonb_build_object(''last_value'', last_value, ''is_called'', is_called) FROM public.%I', sequence.sequencename)
      INTO contents;
    result := result || jsonb_build_object(sequence.sequencename, contents);
  END LOOP;
  RETURN result;
END;
$$;
SQL

snapshot() {
  local destination="$1"
  # pg_dump includes type modifiers, sequence definitions/ownership, triggers'
  # enabled modes and other schema details a hand-picked catalog list can miss.
  # Newer pg_dump versions choose a random psql restriction key on each run.
  pg_exec pg_dump -U aeralyth -d "${test_database}" --schema-only --schema=public \
    --no-owner --no-privileges | sed '/^\\restrict /d; /^\\unrestrict /d' > "${destination}.schema"
  psql_test -At -c 'SELECT audit_chain_checks.row_snapshot()' > "${destination}.rows"
  psql_test -At -c 'SELECT audit_chain_checks.sequence_snapshot()' >> "${destination}.rows"
}
assert_preserved() {
  local phase="$1"
  snapshot "${scratch_dir}/${phase}"
  if ! cmp -s "${scratch_dir}/before.schema" "${scratch_dir}/${phase}.schema"; then
    echo "ERROR: ${phase} changed database definitions" >&2
    diff -u "${scratch_dir}/before.schema" "${scratch_dir}/${phase}.schema" || true
    exit 1
  fi
  if ! cmp -s "${scratch_dir}/before.rows" "${scratch_dir}/${phase}.rows"; then
    echo "ERROR: ${phase} changed application rows, ledger timestamps or worker checkpoints" >&2
    diff -u "${scratch_dir}/before.rows" "${scratch_dir}/${phase}.rows" || true
    exit 1
  fi
  local writes
  writes="$(psql_test -At -c 'SELECT count(*) FROM audit_chain_checks.writes')"
  if [[ "${writes}" != 0 ]]; then
    psql_test -c 'TABLE audit_chain_checks.writes'
    echo "ERROR: ${phase} executed ${writes} application DML statements" >&2
    exit 1
  fi
  assert_ledger
  printf 'PASS: %s preserved definitions, all application rows and worker checkpoints; zero application DML; hierarchy validator was not called\n' "${phase}"
}

snapshot "${scratch_dir}/before"
apply_chain
assert_preserved full_replay

concurrent_replay() {
  local migration="$1" version="$2" key="$3"
  local gate_pid first_pid second_pid lock_ready=false waiting=0 concurrent_status=0
  mkfifo "${scratch_dir}/${key}.gate"
  exec 3<> "${scratch_dir}/${key}.gate"
  psql_test < "${scratch_dir}/${key}.gate" > "${scratch_dir}/${key}.gate.log" 2>&1 &
  gate_pid=$!
  worker_pids+=("${gate_pid}")
  printf '%s\n' "SELECT pg_advisory_lock(hashtextextended('aeralyth:migration:${version}', 0));" \
    '\echo AUDIT_CHAIN_LOCK_READY' >&3
  for _ in {1..100}; do
    if rg -q 'AUDIT_CHAIN_LOCK_READY' "${scratch_dir}/${key}.gate.log"; then
      lock_ready=true
      break
    fi
    kill -0 "${gate_pid}" 2>/dev/null || break
    sleep 0.05
  done
  [[ "${lock_ready}" == true ]] || { cat "${scratch_dir}/${key}.gate.log"; echo 'Concurrent replay gate failed'; exit 1; }
  {
    printf "SET application_name = 'audit_chain_one_%s';\n" "${key}"
    cat "${migration}"
  } | psql_test > "${scratch_dir}/${key}.one.log" 2>&1 &
  first_pid=$!
  worker_pids+=("${first_pid}")
  {
    printf "SET application_name = 'audit_chain_two_%s';\n" "${key}"
    cat "${migration}"
  } | psql_test > "${scratch_dir}/${key}.two.log" 2>&1 &
  second_pid=$!
  worker_pids+=("${second_pid}")
  for _ in {1..100}; do
    waiting="$(psql_test -At -c "SELECT count(*) FROM pg_stat_activity
      WHERE datname = current_database()
        AND application_name IN ('audit_chain_one_${key}', 'audit_chain_two_${key}')
        AND wait_event_type = 'Lock' AND wait_event = 'advisory'")"
    [[ "${waiting}" == 2 ]] && break
    kill -0 "${first_pid}" 2>/dev/null && kill -0 "${second_pid}" 2>/dev/null || break
    sleep 0.05
  done
  [[ "${waiting}" == 2 ]] || {
    cat "${scratch_dir}/${key}.one.log" "${scratch_dir}/${key}.two.log"
    echo "ERROR: two ${version} migrations were not observed waiting together on the advisory gate" >&2
    exit 1
  }
  printf 'Observed two %s migration sessions blocked together on their advisory lock\n' "${version}"
  printf '%s\n' "SELECT pg_advisory_unlock(hashtextextended('aeralyth:migration:${version}', 0));" '\q' >&3
  exec 3>&-
  wait "${first_pid}" || concurrent_status=1
  wait "${second_pid}" || concurrent_status=1
  wait "${gate_pid}" || concurrent_status=1
  worker_pids=()
  cat "${scratch_dir}/${key}.gate.log" "${scratch_dir}/${key}.one.log" "${scratch_dir}/${key}.two.log"
  [[ "${concurrent_status}" == 0 ]] || { echo "Concurrent ${version} migration replay failed"; exit 1; }
  assert_preserved "concurrent_${key}_replay"
}
concurrent_replay database/init/032_bucket_usage_snapshots.sql 032-bucket-usage-snapshots 032
concurrent_replay database/init/035_multipart_reconciliation.sql 035-multipart-reconciliation 035
concurrent_replay database/init/037_bounded_hierarchy_updates.sql 037-bounded-hierarchy-updates 037
concurrent_replay database/init/038_quiet_maintenance_notifications.sql 038-quiet-maintenance-notifications 038
concurrent_replay database/init/039_trashed_parent_child_counts.sql 039-trashed-parent-child-counts 039
"${checksum_command[@]}" -c "${result_dir}/chain-sources.sha256"
printf 'PASS: full migration chain audit completed at %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
