#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
if [ ! -f .env ]; then
  cp .env.example .env
fi
echo "Starting MySQL sync door (3002)..."
exec node scripts/launch-remote.js
