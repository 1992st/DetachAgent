#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
echo "== /api/health =="
curl -fsS http://127.0.0.1:38888/api/health
echo
echo "== /api/diagnostics =="
curl -fsS http://127.0.0.1:38888/api/diagnostics
echo
