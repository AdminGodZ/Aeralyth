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

for migration in "${migrations[@]}"; do
  echo "Applying $(basename -- "${migration}")"
  psql "${DATABASE_URL}" -X -v ON_ERROR_STOP=1 -f "${migration}"
done

production_environment=false
case "${AERALYTH_ENV:-}" in
  [Pp][Rr][Oo][Dd][Uu][Cc][Tt][Ii][Oo][Nn]) production_environment=true ;;
esac

if [[ "${production_environment}" == "true" || -n "${RAILWAY_PROJECT_ID:-}" ]]; then
  echo "Running production data preflight"
  psql "${DATABASE_URL}" -X -v ON_ERROR_STOP=1 \
    -f "${project_root}/database/production/preflight.sql"
fi
