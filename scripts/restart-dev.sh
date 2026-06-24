#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

ports=("${DETACHES_SERVER_PORT:-38888}" "${DETACHES_WEB_PORT:-5173}")

stop_port() {
  local port="$1"
  local pids
  pids="$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
  if [[ -z "$pids" ]]; then
    echo "port $port is free"
    return
  fi

  echo "stopping listeners on port $port: $pids"
  kill $pids 2>/dev/null || true

  local deadline=$((SECONDS + 5))
  while [[ $SECONDS -lt $deadline ]]; do
    pids="$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
    [[ -z "$pids" ]] && return
    sleep 0.2
  done

  pids="$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
  if [[ -n "$pids" ]]; then
    echo "force stopping listeners on port $port: $pids"
    kill -9 $pids 2>/dev/null || true
  fi
}

for port in "${ports[@]}"; do
  stop_port "$port"
done

exec pnpm dev
