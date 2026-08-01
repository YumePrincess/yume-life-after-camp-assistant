#!/bin/zsh
set -euo pipefail

SCRIPT_DIR=${0:A:h}
APP_ROOT=${SCRIPT_DIR:h}
PROJECT_ROOT=${APP_ROOT:h}
MAC_ROOT="${PROJECT_ROOT}/Mac"
PORTABLE_ROOT="${APP_ROOT}/.portable"
DIST_ROOT="${APP_ROOT}/dist"
APP_BUNDLE="${DIST_ROOT}/Yume Life After Mac Agent.app"
SWIFT_SCRATCH="/private/tmp/yla-mac-app-build"
BUILD_CONFIGURATION="${YLA_BUILD_CONFIGURATION:-release}"
PRODUCT_CONFIGURATION="Debug"
if [[ "${BUILD_CONFIGURATION}" == "release" ]]; then
  PRODUCT_CONFIGURATION="Release"
fi

if [[ "$(uname -m)" != "arm64" ]]; then
  echo "Yume Life After Mac Agent only builds for Apple Silicon." >&2
  exit 1
fi

# OCR and pixel inspection helpers are generated artifacts and intentionally
# not committed to Git. Build them from the tracked Swift sources on every App
# build so a clean clone can produce the same self-contained runtime.
"${MAC_ROOT}/scripts/build-vision.sh"
for helper in mrzh-vision-ocr mrzh-pixel-probe; do
  helper_path="${MAC_ROOT}/bin/${helper}"
  [[ -x "${helper_path}" ]] || { echo "Missing generated helper: ${helper_path}" >&2; exit 1; }
  helper_archs=$(/usr/bin/lipo -archs "${helper_path}" 2>/dev/null || true)
  [[ " ${helper_archs} " == *" arm64 "* ]] || {
    echo "Generated helper must contain arm64: ${helper_path}" >&2
    exit 1
  }
done
if [[ ! -x "${PORTABLE_ROOT}/Toolchain/node/bin/node" || ! -x "${PORTABLE_ROOT}/Toolchain/platform-tools/adb" ]]; then
  echo "Portable toolchain is missing. Run: ./scripts/prepare-portable-runtime.sh" >&2
  exit 1
fi
if [[ "$(/usr/bin/lipo -archs "${PORTABLE_ROOT}/Toolchain/platform-tools/adb")" != "arm64" ]]; then
  echo "Bundled adb must be arm64-only. Re-run prepare-portable-runtime.sh." >&2
  exit 1
fi

# A development build may still be running directly from dist. Stop it before
# replacing the bundle so a stale process cannot write Python bytecode into the
# newly signed portable runtime.
killall YumeLifeAfterMacAgent 2>/dev/null || true

env CLANG_MODULE_CACHE_PATH=/private/tmp/yla-clang-cache \
  swift build --disable-sandbox -c "${BUILD_CONFIGURATION}" --arch arm64 \
  --scratch-path "${SWIFT_SCRATCH}" \
  --cache-path /private/tmp/yla-swift-cache \
  --config-path /private/tmp/yla-swift-config \
  --security-path /private/tmp/yla-swift-security

rm -rf -- "${APP_BUNDLE}"
mkdir -p "${APP_BUNDLE}/Contents/MacOS" "${APP_BUNDLE}/Contents/Resources/Runtime"
cp "${SWIFT_SCRATCH}/out/Products/${PRODUCT_CONFIGURATION}/YumeLifeAfterMacAgent" \
  "${APP_BUNDLE}/Contents/MacOS/YumeLifeAfterMacAgent"
cp "${APP_ROOT}/Info.plist" "${APP_BUNDLE}/Contents/Info.plist"
cp "${APP_ROOT}/AppIcon.icns" "${APP_BUNDLE}/Contents/Resources/AppIcon.icns"
cp -R "${SWIFT_SCRATCH}/out/Products/${PRODUCT_CONFIGURATION}/YumeLifeAfterMacAgent_YumeLifeAfterMacAgent.bundle" \
  "${APP_BUNDLE}/Contents/Resources/"
RESOURCE_BUNDLE="${APP_BUNDLE}/Contents/Resources/YumeLifeAfterMacAgent_YumeLifeAfterMacAgent.bundle/Contents/Resources"
for localization in en fr ja zh-Hans zh-Hant; do
  cp -R "${RESOURCE_BUNDLE}/${localization}.lproj" "${APP_BUNDLE}/Contents/Resources/"
done

rsync -a \
  --exclude '.DS_Store' --exclude '.local-model' --exclude 'config.json' \
  --exclude 'logs' --exclude 'snapshots' --exclude 'node_modules' \
  "${MAC_ROOT}/" "${APP_BUNDLE}/Contents/Resources/Runtime/"
cp -R "${PORTABLE_ROOT}/Toolchain" "${APP_BUNDLE}/Contents/Resources/Runtime/Toolchain"
if [[ -d "${PORTABLE_ROOT}/models" ]]; then
  mkdir -p "${APP_BUNDLE}/Contents/Resources/Runtime/.local-model"
  cp -R "${PORTABLE_ROOT}/models" "${APP_BUNDLE}/Contents/Resources/Runtime/.local-model/models"
fi
if [[ "${YLA_REQUIRE_BUNDLED_MODEL:-1}" == "1" ]]; then
  [[ -f "${APP_BUNDLE}/Contents/Resources/Runtime/.local-model/models/Qwen3-VL-2B-Instruct-4bit/config.json" ]] || {
    echo "Bundled local model is required. Run: ./scripts/prepare-portable-runtime.sh --with-model" >&2
    exit 1
  }
  [[ -f "${APP_BUNDLE}/Contents/Resources/Runtime/.local-model/models/Qwen3-VL-2B-Instruct-4bit/model.safetensors" ]] || {
    echo "Bundled local model weights are incomplete." >&2
    exit 1
  }
fi

# Host-level ` / ~ cannot be delivered by ADB. Package the System Events call
# in a signed, localized helper App so macOS attributes Automation and
# Accessibility permission to “Yume Life After Mac Agent”, never to node or
# osascript. The helper remains part of the portable runtime after installation.
HOST_INPUT_SOURCE="${APP_ROOT}/Helpers/HostInputHelper"
HOST_INPUT_APP="${APP_BUNDLE}/Contents/Resources/Runtime/bin/Yume Life After Mac Agent Input Helper.app"
HOST_INPUT_EXECUTABLE="${HOST_INPUT_APP}/Contents/MacOS/YumeLifeAfterMacAgentInputHelper"
mkdir -p "${HOST_INPUT_APP}/Contents/MacOS" "${HOST_INPUT_APP}/Contents/Resources"
env CLANG_MODULE_CACHE_PATH=/private/tmp/yla-clang-cache \
  /usr/bin/swiftc -O -target arm64-apple-macos14 \
  "${HOST_INPUT_SOURCE}/main.swift" -o "${HOST_INPUT_EXECUTABLE}"
cp "${HOST_INPUT_SOURCE}/Info.plist" "${HOST_INPUT_APP}/Contents/Info.plist"
cp "${APP_ROOT}/AppIcon.icns" "${HOST_INPUT_APP}/Contents/Resources/AppIcon.icns"
for localization in en fr ja zh-Hans zh-Hant; do
  cp -R "${HOST_INPUT_SOURCE}/${localization}.lproj" \
    "${HOST_INPUT_APP}/Contents/Resources/${localization}.lproj"
done
chmod +x "${HOST_INPUT_EXECUTABLE}"
helper_archs=$(/usr/bin/lipo -archs "${HOST_INPUT_EXECUTABLE}")
[[ " ${helper_archs} " == *" arm64 "* && " ${helper_archs} " != *" x86_64 "* ]] || {
  echo "Host input helper must be arm64-only: ${helper_archs}" >&2
  exit 1
}
codesign --force --options runtime --sign "${YLA_CODESIGN_IDENTITY:--}" "${HOST_INPUT_APP}"

# Remove Intel slices from universal dependencies so the delivered app is
# genuinely Apple-Silicon-only and never needs Rosetta on a clean Mac.
while IFS= read -r -d '' mach_file; do
  architectures=$(/usr/bin/lipo -archs "${mach_file}" 2>/dev/null || true)
  [[ -z "${architectures}" ]] && continue
  if [[ " ${architectures} " == *" arm64 "* && " ${architectures} " == *" x86_64 "* ]]; then
    thinned="${mach_file}.arm64"
    original_mode=$(/usr/bin/stat -f '%Lp' "${mach_file}")
    /usr/bin/lipo "${mach_file}" -thin arm64 -output "${thinned}"
    chmod "${original_mode}" "${thinned}"
    mv "${thinned}" "${mach_file}"
  elif [[ " ${architectures} " != *" arm64 "* ]]; then
    echo "Non-arm64 Mach-O found in app runtime: ${mach_file}" >&2
    exit 1
  fi
done < <(find "${APP_BUNDLE}/Contents/Resources/Runtime/Toolchain" -type f -print0)

chmod +x "${APP_BUNDLE}/Contents/MacOS/YumeLifeAfterMacAgent"
/usr/bin/strip -x "${APP_BUNDLE}/Contents/MacOS/YumeLifeAfterMacAgent" || true
find "${APP_BUNDLE}/Contents/Resources/Runtime/scripts" -type f -name '*.sh' -exec chmod +x {} +
chmod +x "${APP_ROOT}/scripts/verify-app-runtime.sh"
"${APP_ROOT}/scripts/verify-app-runtime.sh" "${APP_BUNDLE}"
SIGNING_IDENTITY="${YLA_CODESIGN_IDENTITY:--}"
codesign --force --deep --options runtime --sign "${SIGNING_IDENTITY}" "${APP_BUNDLE}"
# APFS volumes hosted on removable media can make the first deep seal observe
# nested portable-runtime metadata before it is fully flushed. Re-sealing is
# deterministic and prevents a false "file modified" result during DMG copy.
sync
sleep 2
codesign --force --deep --options runtime --sign "${SIGNING_IDENTITY}" "${APP_BUNDLE}"
sync
sleep 2
# A final seal after the external APFS metadata settles is required for this
# portable runtime (it contains thousands of nested Python/Node resources).
codesign --force --deep --options runtime --sign "${SIGNING_IDENTITY}" "${APP_BUNDLE}"
sync
codesign --verify --deep --strict "${APP_BUNDLE}"
file "${APP_BUNDLE}/Contents/MacOS/YumeLifeAfterMacAgent"
echo "Built ${APP_BUNDLE}"
