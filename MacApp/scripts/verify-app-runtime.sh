#!/bin/zsh
set -euo pipefail

APP_BUNDLE=${1:?Usage: verify-app-runtime.sh <Yume Life After Mac Agent.app>}
RUNTIME="${APP_BUNDLE}/Contents/Resources/Runtime"
ADB="${RUNTIME}/Toolchain/platform-tools/adb"

if [[ -e "${RUNTIME}/Toolchain/node" ]]; then
  echo "The App bundle must not contain Node.js; use macOS Node or the external local runtime." >&2
  exit 1
fi

require_arm64() {
  local binary=$1
  [[ -x "${binary}" ]] || { echo "Missing executable: ${binary}" >&2; exit 1; }
  local archs
  archs=$(/usr/bin/lipo -archs "${binary}" 2>/dev/null || true)
  [[ " ${archs} " == *" arm64 "* && " ${archs} " != *" x86_64 "* ]] || {
    echo "Executable is not arm64-only: ${binary} (${archs})" >&2
    exit 1
  }
}

require_arm64 "${ADB}"
require_arm64 "${RUNTIME}/bin/mrzh-vision-ocr"
require_arm64 "${RUNTIME}/bin/mrzh-pixel-probe"

export PATH="${RUNTIME}/Toolchain/platform-tools:/usr/bin:/bin:/usr/sbin:/sbin"
"${ADB}" version >/dev/null

plugin_count=$(find "${RUNTIME}/plugins" -mindepth 2 -maxdepth 2 -name plugin.json | wc -l | tr -d ' ')
[[ "${plugin_count}" == "5" ]] || { echo "Expected 5 built-in plugins, found ${plugin_count}" >&2; exit 1; }
for localization in en fr ja zh-Hans zh-Hant; do
  [[ -f "${APP_BUNDLE}/Contents/Resources/${localization}.lproj/Localizable.strings" ]] || {
    echo "Missing App localization: ${localization}" >&2
    exit 1
  }
done

echo "Verified external-Node runtime, bundled ADB, OCR, plugins and localizations."
