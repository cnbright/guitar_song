#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [ ! -x .venv/bin/python ]; then
  bash scripts/install.sh
fi
for tool in ffmpeg ffprobe; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "Missing $tool. Install FFmpeg first (see README.md)." >&2
    exit 1
  fi
done
GUITAR_HOST="${GUITAR_HOST:-127.0.0.1}"
GUITAR_PORT="${GUITAR_PORT:-8000}"
echo "Stringspace is starting on port $GUITAR_PORT. Keep this terminal open."
exec .venv/bin/python -m uvicorn app.main:app --host "$GUITAR_HOST" --port "$GUITAR_PORT"

