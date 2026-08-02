#!/bin/zsh
set -euo pipefail

APP_BUNDLE=${1:?Usage: verify-app-runtime.sh <Yume Life After Mac Agent.app>}
RUNTIME="${APP_BUNDLE}/Contents/Resources/Runtime"
NODE="${RUNTIME}/Toolchain/node/bin/node"
NPM="${RUNTIME}/Toolchain/node/bin/npm"
PYTHON="${RUNTIME}/Toolchain/python/bin/python3"
ADB="${RUNTIME}/Toolchain/platform-tools/adb"
MODEL="${RUNTIME}/.local-model/models/Qwen3-VL-2B-Instruct-4bit"
HELPER="${RUNTIME}/bin/Yume Life After Mac Agent Input Helper.app"

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

require_arm64 "${NODE}"
require_arm64 "${PYTHON}"
require_arm64 "${ADB}"
require_arm64 "${RUNTIME}/bin/mrzh-vision-ocr"
require_arm64 "${RUNTIME}/bin/mrzh-pixel-probe"
require_arm64 "${HELPER}/Contents/MacOS/YumeLifeAfterMacAgentInputHelper"

export PATH="${RUNTIME}/Toolchain/node/bin:${RUNTIME}/Toolchain/platform-tools:/usr/bin:/bin:/usr/sbin:/sbin"
[[ "$("${NODE}" --version)" == "v22.16.0" ]] || { echo "Unexpected bundled Node version" >&2; exit 1; }
[[ "$("${NPM}" --version)" == "10.9.2" ]] || { echo "Unexpected bundled npm version" >&2; exit 1; }
"${ADB}" version >/dev/null
PYTHONDONTWRITEBYTECODE=1 "${PYTHON}" -B -c 'import huggingface_hub, mlx_vlm' >/dev/null

[[ -f "${MODEL}/config.json" ]] || { echo "Bundled local model config is missing" >&2; exit 1; }
[[ -f "${MODEL}/model.safetensors" ]] || { echo "Bundled local model weights are missing" >&2; exit 1; }
model_bytes=$(/usr/bin/stat -f '%z' "${MODEL}/model.safetensors")
(( model_bytes > 1000000000 )) || { echo "Bundled local model weights are incomplete" >&2; exit 1; }

plugin_count=$(find "${RUNTIME}/plugins" -mindepth 2 -maxdepth 2 -name plugin.json | wc -l | tr -d ' ')
[[ "${plugin_count}" == "5" ]] || { echo "Expected 5 built-in plugins, found ${plugin_count}" >&2; exit 1; }
for localization in en fr ja zh-Hans zh-Hant; do
  [[ -f "${APP_BUNDLE}/Contents/Resources/${localization}.lproj/Localizable.strings" ]] || {
    echo "Missing App localization: ${localization}" >&2
    exit 1
  }
  [[ -f "${HELPER}/Contents/Resources/${localization}.lproj/InfoPlist.strings" ]] || {
    echo "Missing input-helper localization: ${localization}" >&2
    exit 1
  }
done

display_name=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleDisplayName' "${HELPER}/Contents/Info.plist")
[[ "${display_name}" == "Yume Life After Mac Agent Input Helper" ]] || {
  echo "Unexpected permission helper display name: ${display_name}" >&2
  exit 1
}

echo "Verified bundled Node/npm, Python/MLX, ADB, OCR, model, plugins, localizations and host-input helper."
