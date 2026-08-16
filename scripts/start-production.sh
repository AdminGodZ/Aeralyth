#!/usr/bin/env bash
set -uo pipefail

api_pid=""
frontend_pid=""
proxy_pid=""

stop_children() {
  trap - TERM INT
  for child_pid in "${api_pid}" "${frontend_pid}" "${proxy_pid}"; do
    if [[ -n "${child_pid}" ]] && kill -0 "${child_pid}" 2>/dev/null; then
      kill -TERM "${child_pid}" 2>/dev/null || true
    fi
  done
  for child_pid in "${api_pid}" "${frontend_pid}" "${proxy_pid}"; do
    if [[ -n "${child_pid}" ]]; then
      wait "${child_pid}" 2>/dev/null || true
    fi
  done
}

handle_signal() {
  stop_children
  exit 0
}

trap handle_signal TERM INT

public_port="${PORT:-8080}"
frontend_port="${AERALYTH_FRONTEND_PORT:-3000}"
if [[ "${frontend_port}" == "${public_port}" ]]; then
  for candidate in 3000 3001 3002; do
    if [[ "${candidate}" != "${public_port}" ]]; then
      frontend_port="${candidate}"
      break
    fi
  done
fi

api_port=""
for candidate in "${AERALYTH_API_PORT:-8081}" 8081 18080 18081; do
  if [[ "${candidate}" != "${public_port}" && "${candidate}" != "${frontend_port}" ]]; then
    api_port="${candidate}"
    break
  fi
done
if [[ -z "${api_port}" ]]; then
  echo "No collision-free internal API port is available" >&2
  exit 1
fi

export AERALYTH_API_HOST=127.0.0.1
export AERALYTH_API_PORT="${api_port}"
export AERALYTH_API_ORIGIN="http://127.0.0.1:${api_port}"
export AERALYTH_FRONTEND_PORT="${frontend_port}"

/app/bin/aeralyth-api &
api_pid=$!

HOSTNAME=127.0.0.1 PORT="${frontend_port}" node /app/frontend/server.js &
frontend_pid=$!

/usr/bin/caddy run --config /etc/caddy/Caddyfile --adapter caddyfile &
proxy_pid=$!

wait -n "${api_pid}" "${frontend_pid}" "${proxy_pid}"
exit_code=$?
if [[ "${exit_code}" -eq 0 ]]; then
  exit_code=1
fi
stop_children
exit "${exit_code}"
