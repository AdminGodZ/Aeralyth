#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "DATABASE_URL is required for database migrations" >&2
  exit 1
fi

project_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
shopt -s nullglob
migrations=("${project_root}"/database/init/[0-9][0-9][0-9]_*.sql)

if [[ "${#migrations[@]}" -eq 0 ]]; then
  echo "No database migrations were found" >&2
  exit 1
fi

migration_pgoptions="${PGOPTIONS:+${PGOPTIONS} }-c client_min_messages=warning"

for migration in "${migrations[@]}"; do
  echo "Applying $(basename -- "${migration}")"
  PGOPTIONS="${migration_pgoptions}" \
    psql "${DATABASE_URL}" -X -v ON_ERROR_STOP=1 -f "${migration}"
done

if [[ -n "${AERALYTH_BOOTSTRAP_ADMIN_PASSWORD:-}" ]]; then
  if [[ "${#AERALYTH_BOOTSTRAP_ADMIN_PASSWORD}" -lt 32 ]]; then
    echo "AERALYTH_BOOTSTRAP_ADMIN_PASSWORD must contain at least 32 characters" >&2
    exit 1
  fi
  echo "Replacing the local seed administrator password"
  PGOPTIONS="${migration_pgoptions}" \
    psql "${DATABASE_URL}" -X -q -v ON_ERROR_STOP=1 \
    -f "${project_root}/database/production/bootstrap_admin.sql"
fi

# The image is a production artifact, so the seed credential check never
# depends on deployment-specific environment labels.
echo "Running production data preflight"
PGOPTIONS="${migration_pgoptions}" \
  psql "${DATABASE_URL}" -X -v ON_ERROR_STOP=1 \
  -f "${project_root}/database/production/preflight.sql"
