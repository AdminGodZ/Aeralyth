#!/usr/bin/env bash
set -euo pipefail

test_database="aeralyth_production_preflight_${$}"

cleanup() {
  docker compose exec -T postgres dropdb -U aeralyth --if-exists "${test_database}" >/dev/null
}

trap cleanup EXIT

docker compose exec -T postgres createdb -U aeralyth "${test_database}"
docker compose exec -T postgres psql \
  -q \
  -v ON_ERROR_STOP=1 \
  -U aeralyth \
  -d "${test_database}" \
  -f /docker-entrypoint-initdb.d/001_auth.sql >/dev/null

if docker compose exec -T postgres psql \
  -q \
  -v ON_ERROR_STOP=1 \
  -U aeralyth \
  -d "${test_database}" \
  < database/production/preflight.sql >/dev/null 2>&1
then
  echo "production preflight accepted the local seed password" >&2
  exit 1
fi

bootstrap_password="production-test-bootstrap-password-0000"
docker compose exec -T \
  -e AERALYTH_BOOTSTRAP_ADMIN_PASSWORD="${bootstrap_password}" \
  postgres psql \
  -q \
  -v ON_ERROR_STOP=1 \
  -U aeralyth \
  -d "${test_database}" \
  < database/production/bootstrap_admin.sql >/dev/null

docker compose exec -T \
  -e AERALYTH_BOOTSTRAP_ADMIN_PASSWORD="replacement-bootstrap-password-000000" \
  postgres psql \
  -q \
  -v ON_ERROR_STOP=1 \
  -U aeralyth \
  -d "${test_database}" \
  < database/production/bootstrap_admin.sql >/dev/null

bootstrap_kept="$(docker compose exec -T postgres psql \
  -tA \
  -v ON_ERROR_STOP=1 \
  -U aeralyth \
  -d "${test_database}" \
  -c "SELECT password_hash = crypt('${bootstrap_password}', password_hash) FROM users WHERE id = 'usr_admingod';")"
if [[ "${bootstrap_kept}" != "t" ]]; then
  echo "production bootstrap overwrote a password that was no longer the local seed" >&2
  exit 1
fi

docker compose exec -T postgres psql \
  -q \
  -v ON_ERROR_STOP=1 \
  -U aeralyth \
  -d "${test_database}" \
  -c "ALTER TABLE users DISABLE TRIGGER USER; UPDATE users SET role = 'user' WHERE id = 'usr_admingod'; ALTER TABLE users ENABLE TRIGGER USER;" >/dev/null

if docker compose exec -T postgres psql \
  -q \
  -v ON_ERROR_STOP=1 \
  -U aeralyth \
  -d "${test_database}" \
  < database/production/preflight.sql >/dev/null 2>&1
then
  echo "production preflight accepted a database with no active administrator" >&2
  exit 1
fi

docker compose exec -T postgres psql \
  -q \
  -v ON_ERROR_STOP=1 \
  -U aeralyth \
  -d "${test_database}" \
  -c "ALTER TABLE users DISABLE TRIGGER USER; UPDATE users SET role = 'admin' WHERE id = 'usr_admingod'; ALTER TABLE users ENABLE TRIGGER USER;" >/dev/null

docker compose exec -T postgres psql \
  -q \
  -v ON_ERROR_STOP=1 \
  -U aeralyth \
  -d "${test_database}" \
  < database/production/preflight.sql >/dev/null

echo "production preflight requires an active admin, rejects the seed password, and accepts a one-time bootstrap password"
