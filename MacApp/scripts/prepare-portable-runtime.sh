#!/bin/zsh
set -euo pipefail

SCRIPT_DIR=${0:A:h}
APP_ROOT=${SCRIPT_DIR:h}
PORTABLE_ROOT="${APP_ROOT}/.portable"
TOOLCHAIN="${PORTABLE_ROOT}/Toolchain"

if [[ "$(uname -m)" != "arm64" ]]; then
  echo "Portable runtime can only be prepared on Apple Silicon." >&2
  exit 1
fi

mkdir -p "${TOOLCHAIN}"

if [[ ! -x "${TOOLCHAIN}/platform-tools/adb" ]] || \
   [[ "$(/usr/bin/lipo -archs "${TOOLCHAIN}/platform-tools/adb" 2>/dev/null || true)" != "arm64" ]]; then
  ARM64_ADB_SOURCE="${YLA_ARM64_ADB_SOURCE:-/opt/homebrew/bin/adb}"
  if [[ ! -x "${ARM64_ADB_SOURCE}" ]] || \
     ! /usr/bin/lipo -archs "${ARM64_ADB_SOURCE}" 2>/dev/null | grep -qw arm64; then
    echo "An arm64 adb is required. Install android-platform-tools with native Homebrew or set YLA_ARM64_ADB_SOURCE." >&2
    exit 1
  fi
  rm -rf -- "${TOOLCHAIN}/platform-tools"
  mkdir -p "${TOOLCHAIN}/platform-tools"
  /usr/bin/lipo "${ARM64_ADB_SOURCE}" -thin arm64 -output "${TOOLCHAIN}/platform-tools/adb"
  chmod +x "${TOOLCHAIN}/platform-tools/adb"
fi

echo "Portable arm64 runtime prepared at ${PORTABLE_ROOT}"
