#!/usr/bin/env bash
set -euo pipefail
container="${AERALYTH_TEST_CONTAINER:-aeralyth-postgres}"
test_database="aeralyth_repository_tracking_${$}"
template="${AERALYTH_TEST_TEMPLATE:-}"
runner=(docker exec -i "$container")
cleanup() { "${runner[@]}" dropdb -U aeralyth --if-exists "$test_database" >/dev/null; }
trap cleanup EXIT
if [[ -n "$template" ]]; then
  "${runner[@]}" createdb -U aeralyth -T "$template" "$test_database"
else
  "${runner[@]}" createdb -U aeralyth "$test_database"
  for migration in database/init/0{0,1,2}[0-9]_*.sql; do
    [[ "$migration" == database/init/029_* ]] && continue
    "${runner[@]}" psql -X -q -v ON_ERROR_STOP=1 -U aeralyth -d "$test_database" < "$migration" >/dev/null
  done
fi
for migration in database/init/029_durable_tree_operations.sql database/init/030_repository_change_tracking.sql; do
  "${runner[@]}" psql -X -q -v ON_ERROR_STOP=1 -U aeralyth -d "$test_database" < "$migration" >/dev/null
done
# Prepare the actual route SQL so schema/type drift fails this test.
python3 - <<'PY' | "${runner[@]}" psql -X -q -v ON_ERROR_STOP=1 -U aeralyth -d "$test_database"
import re
s=open('backend/src/routes/repositories.rs').read()
for name,query in re.findall(r'const (\w+): &str = r#"(.*?)"#;',s,re.S):
    print('PREPARE '+name+' AS '+query+';')
print(open('database/tests/repository_change_tracking.sql').read())
print("SELECT repository_content_version('track_repo_b') AS actual_version \\gset")
print("EXECUTE PREPARE_REPOSITORY_ARCHIVE_QUERY('track_repo_b','tracking_owner','track_b',:actual_version) \\gset")
print("SELECT 1 / (:total_entries::int=50001)::int AS actual_preparation_bounded;")
PY
# A ledger-protected replay must not invoke the full-table validator. A fresh
# install above already ran the original hierarchy validation before replacement.
"${runner[@]}" psql -X -q -v ON_ERROR_STOP=1 -U aeralyth -d "$test_database" <<'SQL'
CREATE OR REPLACE FUNCTION assert_file_hierarchy_valid(changed_ids TEXT[]) RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'replay unexpectedly revalidated hierarchy'; END $$;
SQL
"${runner[@]}" psql -X -q -v ON_ERROR_STOP=1 -U aeralyth -d "$test_database" < database/init/015_collection_hierarchy_performance.sql >/dev/null
"${runner[@]}" psql -X -q -v ON_ERROR_STOP=1 -U aeralyth -d "$test_database" < database/init/015_collection_hierarchy_performance.sql >/dev/null
printf '%s\n' 'PASS repository revisions, async timestamps/counts, manifest plans, migration015 replay'
