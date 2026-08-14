#!/bin/zsh
set -euo pipefail

SCRIPT_DIR=${0:A:h}
APP_ROOT=${SCRIPT_DIR:h}
if [[ "$(uname -m)" != "arm64" ]]; then
  echo "Runtime can only be prepared on Apple Silicon." >&2
  exit 1
fi

echo "No portable ADB is prepared. Install Android platform-tools on this Mac; the App detects adb from PATH."
