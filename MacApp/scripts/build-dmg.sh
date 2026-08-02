#!/bin/zsh
set -euo pipefail

SCRIPT_DIR=${0:A:h}
APP_ROOT=${SCRIPT_DIR:h}
DIST_ROOT="${APP_ROOT}/dist"
APP_NAME="Yume Life After Mac Agent.app"
APP_BUNDLE="${DIST_ROOT}/${APP_NAME}"
VOLUME_NAME="Yume Life After Mac Agent 27.0.0"
STAGING="/private/tmp/yla-dmg-root"
RW_IMAGE="/private/tmp/Yume-Life-After-Mac-Agent-rw.dmg"
FINAL_IMAGE="${DIST_ROOT}/Yume Life After Mac Agent 27.0.0.dmg"
PYTHON_BIN="${APP_ROOT}/.portable/Toolchain/python/bin/python3"

[[ -d "${APP_BUNDLE}" ]] || { echo "Build the App first: ./scripts/build-app.sh" >&2; exit 1; }
[[ -x "${PYTHON_BIN}" ]] || { echo "Portable Python is missing." >&2; exit 1; }

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

osascript <<APPLESCRIPT
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

sync
hdiutil detach -quiet "${DEVICE}"
hdiutil convert -quiet "${RW_IMAGE}" -format UDZO -imagekey zlib-level=9 -o "${FINAL_IMAGE}"
codesign --force --sign "${YLA_CODESIGN_IDENTITY:--}" "${FINAL_IMAGE}"
rm -rf -- "${STAGING}"
rm -f -- "${RW_IMAGE}"
echo "Built ${FINAL_IMAGE}"
