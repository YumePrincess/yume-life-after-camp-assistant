#!/bin/zsh
set -euo pipefail

SCRIPT_DIR=${0:A:h}
APP_ROOT=${SCRIPT_DIR:h}
PROJECT_ROOT=${APP_ROOT:h}
MAC_ROOT="${PROJECT_ROOT}/Mac"
# Match the DMG installation result by default: a build is placed directly in
# /Applications. Override with YLA_DIST_ROOT for CI or a non-destructive local
# build (for example YLA_DIST_ROOT="${APP_ROOT}/dist").
DIST_ROOT="${YLA_DIST_ROOT:-/Applications}"
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

# A development build may still be running directly from dist. Stop it before
# replacing the bundle so a stale process cannot write into the new runtime.
killall YumeLifeAfterMacAgent 2>/dev/null || true

cd "${APP_ROOT}"
env CLANG_MODULE_CACHE_PATH=/private/tmp/yla-clang-cache \
  EnableSDKStatCaching=0 \
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
  --prune-empty-dirs \
  --exclude '.DS_Store' --exclude 'config.json' --exclude '.local-model' \
  --exclude 'bin/module-cache' --exclude 'module-cache' \
  --exclude 'logs' --exclude 'snapshots' --exclude 'node_modules' \
  "${MAC_ROOT}/" "${APP_BUNDLE}/Contents/Resources/Runtime/"
# A Core ML glyph model is optional at source checkout time. When the trained
# symbol classifier is supplied, keep it beside the OCR helper so the native
# Vision pipeline can load it without adding a model path to user config.
SYMBOL_MODEL_SOURCE="${MAC_ROOT}/vision/SymbolClassifier.mlmodelc"
if [[ -d "${SYMBOL_MODEL_SOURCE}" ]]; then
  cp -R "${SYMBOL_MODEL_SOURCE}" "${APP_BUNDLE}/Contents/Resources/Runtime/bin/SymbolClassifier.mlmodelc"
fi
# Remove Intel slices from universal dependencies so the delivered app is
# genuinely Apple-Silicon-only and never needs Rosetta on a clean Mac.
if [[ -d "${APP_BUNDLE}/Contents/Resources/Runtime/Toolchain" ]]; then
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
fi

chmod +x "${APP_BUNDLE}/Contents/MacOS/YumeLifeAfterMacAgent"
/usr/bin/strip -x "${APP_BUNDLE}/Contents/MacOS/YumeLifeAfterMacAgent" || true
find "${APP_BUNDLE}/Contents/Resources/Runtime/scripts" -type f -name '*.sh' -exec chmod +x {} +
chmod +x "${APP_ROOT}/scripts/verify-app-runtime.sh"
"${APP_ROOT}/scripts/verify-app-runtime.sh" "${APP_BUNDLE}"
SIGNING_IDENTITY="${YLA_CODESIGN_IDENTITY:--}"
codesign --force --deep --options runtime --sign "${SIGNING_IDENTITY}" "${APP_BUNDLE}"
# APFS volumes hosted on removable media can make the first deep seal observe
# nested runtime metadata before it is fully flushed. Re-sealing is
# deterministic and prevents a false "file modified" result during DMG copy.
sync
sleep 2
codesign --force --deep --options runtime --sign "${SIGNING_IDENTITY}" "${APP_BUNDLE}"
sync
sleep 2
# A final seal after the external APFS metadata settles is required for this
# runtime, which contains nested arm64 ADB resources.
codesign --force --deep --options runtime --sign "${SIGNING_IDENTITY}" "${APP_BUNDLE}"
sync
codesign --verify --deep --strict "${APP_BUNDLE}"
file "${APP_BUNDLE}/Contents/MacOS/YumeLifeAfterMacAgent"
echo "Built ${APP_BUNDLE}"
