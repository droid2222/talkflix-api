#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

PORT="${PORT:-4000}"

if command -v lsof >/dev/null 2>&1; then
  if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "[startup] Refusing to start talkflix-api: port $PORT already has a listener." >&2
    lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >&2 || true
    exit 1
  fi
fi

exec node server.js
