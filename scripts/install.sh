#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
GUITAR_PYTHON="${GUITAR_PYTHON:-python3}"
"$GUITAR_PYTHON" -c 'import sys; assert sys.version_info >= (3,12), "Please install Python 3.12 or newer."'
for tool in ffmpeg ffprobe; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "Missing $tool. Install FFmpeg first (see README.md)." >&2
    exit 1
  fi
done
if [ ! -x .venv/bin/python ]; then
  "$GUITAR_PYTHON" -m venv .venv
fi
PIP_CACHE_DIR="${PIP_CACHE_DIR:-$PWD/.data/pip-cache}" .venv/bin/python -m pip install --disable-pip-version-check -r requirements.lock
.venv/bin/python -m pip check
echo 'Installation complete. Start with: bash scripts/start.sh'

