#!/bin/zsh
set -euo pipefail

SCRIPT_DIR=${0:A:h}
APP_ROOT=${SCRIPT_DIR:h}
DIST_ROOT="${APP_ROOT}/dist"
APP_NAME="Yume Life After Mac Agent.app"
APP_BUNDLE="${DIST_ROOT}/${APP_NAME}"
VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "${APP_BUNDLE}/Contents/Info.plist")"
BUILD="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "${APP_BUNDLE}/Contents/Info.plist")"
RELEASE_LABEL="Yume Life After Mac Agent ${VERSION} Build ${BUILD}"
# Keep the mounted volume name distinct from older open release windows. This
# prevents Finder from reusing a stale window and writing its .DS_Store to the
# wrong image while retaining the release name in the DMG filename.
VOLUME_NAME="${RELEASE_LABEL} Installer"
STAGING="/private/tmp/yla-dmg-root"
RW_IMAGE="/private/tmp/Yume-Life-After-Mac-Agent-rw.dmg"
FINAL_IMAGE="${DIST_ROOT}/${RELEASE_LABEL}.dmg"
PYTHON_BIN="${YLA_DMG_PYTHON:-$(command -v python3 || true)}"

[[ -d "${APP_BUNDLE}" ]] || { echo "Build the App first: ./scripts/build-app.sh" >&2; exit 1; }
[[ -x "${PYTHON_BIN}" ]] || { echo "A host Python 3 with Pillow is required for the DMG background. Set YLA_DMG_PYTHON." >&2; exit 1; }

detach_existing_image() {
  local image_path="$1"
  while true; do
    local device
    device="$(hdiutil info | awk -v image="${image_path}" '
      $1 == "image-path" {
        line = $0
        sub(/^image-path[[:space:]]*:[[:space:]]*/, "", line)
        found = (line == image)
        next
      }
      found && $1 ~ /^\/dev\/disk/ { print $1; exit }
    ')"
    [[ -n "${device}" ]] || break
    hdiutil detach -quiet "${device}" || hdiutil detach -force "${device}"
  done
}

detach_existing_image "${RW_IMAGE}"
detach_existing_image "${FINAL_IMAGE}"
rm -rf -- "${STAGING}"
rm -f -- "${RW_IMAGE}" "${FINAL_IMAGE}"
mkdir -p "${STAGING}/.background"
ditto "${APP_BUNDLE}" "${STAGING}/${APP_NAME}"
ln -s /Applications "${STAGING}/Applications"
"${PYTHON_BIN}" "${SCRIPT_DIR}/build-dmg-background.py" "${STAGING}/.background/background.png"

hdiutil create -quiet -srcfolder "${STAGING}" -volname "${VOLUME_NAME}" -fs HFS+ -format UDRW "${RW_IMAGE}"
ATTACH_OUTPUT=$(hdiutil attach -readwrite -noverify -noautoopen "${RW_IMAGE}")
DEVICE=$(echo "${ATTACH_OUTPUT}" | awk '/Apple_HFS/ {print $1; exit}')
MOUNT_POINT=$(echo "${ATTACH_OUTPUT}" | awk -F '\t' '/Apple_HFS/ {print $3; exit}')
[[ -n "${MOUNT_POINT}" ]] || { echo "Could not determine the mounted DMG path." >&2; exit 1; }
MOUNT_NAME="${MOUNT_POINT##*/}"

if ! osascript <<APPLESCRIPT
tell application "Finder"
  set targetDisk to disk "${MOUNT_NAME}"
  open targetDisk
  delay 2
  set targetWindow to container window of targetDisk
  set opts to the icon view options of targetWindow
  set arrangement of opts to not arranged
  set icon size of opts to 128
  set text size of opts to 14
  set background picture of opts to POSIX file "${MOUNT_POINT}/.background/background.png"
  set position of item "${APP_NAME}" of targetWindow to {225, 340}
  set position of item "Applications" of targetWindow to {675, 340}
  delay 3
  -- Keep the Finder window open until hdiutil detaches the image. Closing a
  -- disk window can be interpreted as an eject on some macOS Finder builds.
end tell
APPLESCRIPT
then
  # Finder can return -1728 when the temporary volume is already closing or
  # another Finder window owns the eject transition. The icon layout is
  # optional; the image must still be detached, compressed, and signed.
  echo "Finder could not finish the optional DMG layout; continuing with the default layout." >&2
fi

sync
sleep 2
hdiutil detach -quiet "${DEVICE}" || hdiutil detach -force "${DEVICE}"
hdiutil convert -quiet "${RW_IMAGE}" -format UDZO -imagekey zlib-level=9 -o "${FINAL_IMAGE}"
codesign --force --sign "${YLA_CODESIGN_IDENTITY:--}" "${FINAL_IMAGE}"
rm -rf -- "${STAGING}"
rm -f -- "${RW_IMAGE}"
echo "Built ${FINAL_IMAGE}"
