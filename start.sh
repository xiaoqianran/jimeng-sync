#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
if [ ! -f .env ]; then
  cp .env.example .env
fi
echo "Starting local gallery helper (3001)..."
exec node scripts/launch.js
