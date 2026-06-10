#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
find storage/uploads storage/downloads storage/cache storage/logs -type f ! -name .gitkeep -delete
