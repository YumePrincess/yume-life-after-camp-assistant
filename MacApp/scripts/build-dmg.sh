#!/bin/zsh
set -euo pipefail

SCRIPT_DIR=${0:A:h}
APP_ROOT=${SCRIPT_DIR:h}
DIST_ROOT="${APP_ROOT}/dist"
APP_NAME="Yume Life After Mac Agent.app"
APP_BUNDLE="${DIST_ROOT}/${APP_NAME}"
VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "${APP_BUNDLE}/Contents/Info.plist")"
BUILD="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "${APP_BUNDLE}/Contents/Info.plist")"
BETA_NUMBER=$((BUILD - 26974))
RELEASE_LABEL="Yume LA ${VERSION%.*} Beta ${BETA_NUMBER}"
VOLUME_NAME="${RELEASE_LABEL}"
STAGING="/private/tmp/yla-dmg-root"
RW_IMAGE="/private/tmp/Yume-Life-After-Mac-Agent-rw.dmg"
FINAL_IMAGE="${DIST_ROOT}/${RELEASE_LABEL}.dmg"
PYTHON_BIN="${YLA_DMG_PYTHON:-$(command -v python3 || true)}"

[[ -d "${APP_BUNDLE}" ]] || { echo "Build the App first: ./scripts/build-app.sh" >&2; exit 1; }
[[ -x "${PYTHON_BIN}" ]] || { echo "A host Python 3 with Pillow is required for the DMG background. Set YLA_DMG_PYTHON." >&2; exit 1; }

rm -rf -- "${STAGING}"
rm -f -- "${RW_IMAGE}" "${FINAL_IMAGE}"
mkdir -p "${STAGING}/.background"
ditto "${APP_BUNDLE}" "${STAGING}/${APP_NAME}"
ln -s /Applications "${STAGING}/Applications"
"${PYTHON_BIN}" "${SCRIPT_DIR}/build-dmg-background.py" "${STAGING}/.background/background.png"

hdiutil create -quiet -srcfolder "${STAGING}" -volname "${VOLUME_NAME}" -fs HFS+ -format UDRW "${RW_IMAGE}"
ATTACH_OUTPUT=$(hdiutil attach -readwrite -noverify -noautoopen "${RW_IMAGE}")
DEVICE=$(echo "${ATTACH_OUTPUT}" | awk '/Apple_HFS/ {print $1; exit}')
MOUNT_POINT="/Volumes/${VOLUME_NAME}"

if ! osascript <<APPLESCRIPT
tell application "Finder"
  tell disk "${VOLUME_NAME}"
    open
    set current view of container window to icon view
    set toolbar visible of container window to false
    set statusbar visible of container window to false
    set pathbar visible of container window to false
    set sidebar width of container window to 0
    set the bounds of container window to {120, 120, 1020, 680}
    set opts to the icon view options of container window
    set arrangement of opts to not arranged
    set icon size of opts to 128
    set text size of opts to 14
    set background picture of opts to file ".background:background.png"
    set position of item "${APP_NAME}" of container window to {225, 340}
    set position of item "Applications" of container window to {675, 340}
    close
    open
    update without registering applications
    delay 2
    close
  end tell
end tell
APPLESCRIPT
then
  # Finder can return -1728 when the temporary volume is already closing or
  # another Finder window owns the eject transition. The icon layout is
  # optional; the image must still be detached, compressed, and signed.
  echo "Finder could not finish the optional DMG layout; continuing with the default layout." >&2
fi

sync
hdiutil detach -quiet "${DEVICE}"
hdiutil convert -quiet "${RW_IMAGE}" -format UDZO -imagekey zlib-level=9 -o "${FINAL_IMAGE}"
codesign --force --sign "${YLA_CODESIGN_IDENTITY:--}" "${FINAL_IMAGE}"
rm -rf -- "${STAGING}"
rm -f -- "${RW_IMAGE}"
echo "Built ${FINAL_IMAGE}"
