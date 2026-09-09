#!/usr/bin/env bash
set -euo pipefail
test_database="aeralyth_settings_${$}"
test_log="$(mktemp)"
cleanup() {
  docker compose exec -T postgres dropdb -U aeralyth --if-exists "${test_database}" >/dev/null
  rm -f "${test_log}"
}
trap cleanup EXIT
docker compose exec -T postgres createdb -U aeralyth "${test_database}"
sql() {
  docker compose exec -T postgres psql -XqAt -v ON_ERROR_STOP=1 -U aeralyth -d "${test_database}" "$@"
}
for migration in database/init/[0-9][0-9][0-9]_*.sql; do
  [[ "${migration}" == *027_* ]] && break
  if ! sql -f "/docker-entrypoint-initdb.d/$(basename "${migration}")" >"${test_log}" 2>&1; then
    cat "${test_log}"
    exit 1
  fi
done
sql <<'SQL'
INSERT INTO users (id, username, password_hash, role, trash_retention_days, vault_auto_lock_minutes)
VALUES ('usr_settings_test', 'settings_test', 'test-only', 'user', 7, 60);
SQL
sql -f /docker-entrypoint-initdb.d/027_flexible_retention_and_vault_lock.sql >"${test_log}" 2>&1
sql <<'SQL'
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM users WHERE id = 'usr_settings_test' AND trash_retention_minutes = 10080 AND vault_auto_lock_minutes = 60)
  THEN RAISE EXCEPTION 'migration changed an existing preference'; END IF;
END $$;
UPDATE users SET trash_retention_minutes = 1, vault_auto_lock_minutes = 0 WHERE id = 'usr_settings_test';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM users WHERE id = 'usr_settings_test' AND trash_retention_minutes = 1 AND trash_retention_days = 1 AND vault_auto_lock_minutes = 0)
  THEN RAISE EXCEPTION 'one-minute or Never preference failed'; END IF;
END $$;
UPDATE users SET trash_retention_minutes = 525600 WHERE id = 'usr_settings_test';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM users WHERE id = 'usr_settings_test' AND trash_retention_days = 365)
  THEN RAISE EXCEPTION 'year retention must remain safe for an old worker'; END IF;
  BEGIN
    UPDATE users SET trash_retention_minutes = 525601 WHERE id = 'usr_settings_test';
    RAISE EXCEPTION 'accepted retention over one year';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    UPDATE users SET trash_retention_minutes = 0 WHERE id = 'usr_settings_test';
    RAISE EXCEPTION 'accepted zero-minute retention';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    UPDATE users SET vault_auto_lock_minutes = -1 WHERE id = 'usr_settings_test';
    RAISE EXCEPTION 'accepted invalid lock setting';
  EXCEPTION WHEN check_violation THEN NULL; END;
END $$;
UPDATE users SET trash_retention_days = 7 WHERE id = 'usr_settings_test';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM users WHERE id = 'usr_settings_test' AND trash_retention_minutes = 10080)
  THEN RAISE EXCEPTION 'legacy writer compatibility failed'; END IF;
END $$;
UPDATE users SET trash_retention_minutes = 61 WHERE id = 'usr_settings_test';
SQL
sql -f /docker-entrypoint-initdb.d/027_flexible_retention_and_vault_lock.sql >"${test_log}" 2>&1
test "$(sql -c "SELECT trash_retention_minutes || ':' || vault_auto_lock_minutes FROM users WHERE id = 'usr_settings_test'")" = "61:0"
echo "Flexible settings checks passed: migration preservation/replay, minute/year bounds, Never, and legacy writers."
