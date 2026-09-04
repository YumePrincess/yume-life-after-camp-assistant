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
# wrong image while retaining the release name in the DMG filename. When an
# image is attached with an explicit mountpoint, Finder addresses the mounted
# disk by that mountpoint basename rather than the HFS volume name.
VOLUME_NAME="${RELEASE_LABEL} Installer"
STAGING="/private/tmp/yla-dmg-root"
RW_IMAGE="/private/tmp/Yume-Life-After-Mac-Agent-rw.dmg"
MOUNT_POINT="/private/tmp/yla-dmg-mount"
MOUNT_NAME="${MOUNT_POINT:t}"
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

# Finder can retain the previous release window after the same-named DMG was
# ejected. Close that window before attaching the new writable image; otherwise
# Finder may route the layout commands to the stale disk and return -1728.
osascript <<APPLESCRIPT >/dev/null 2>&1 || true
tell application "Finder"
  try
    set previousDisk to disk "${MOUNT_NAME}"
    try
      close container window of previousDisk
    end try
  end try
end tell
APPLESCRIPT

detach_existing_image "${RW_IMAGE}"
detach_existing_image "${FINAL_IMAGE}"
rm -rf -- "${STAGING}"
rm -f -- "${RW_IMAGE}" "${FINAL_IMAGE}"
mkdir -p "${STAGING}/.background"
mkdir -p "${MOUNT_POINT}"
ditto "${APP_BUNDLE}" "${STAGING}/${APP_NAME}"
ln -s /Applications "${STAGING}/Applications"
"${PYTHON_BIN}" "${SCRIPT_DIR}/build-dmg-background.py" "${STAGING}/.background/background.png"

hdiutil create -quiet -srcfolder "${STAGING}" -volname "${VOLUME_NAME}" -fs HFS+ -format UDRW "${RW_IMAGE}"
ATTACH_OUTPUT=$(hdiutil attach -readwrite -noverify -noautoopen -mountpoint "${MOUNT_POINT}" "${RW_IMAGE}")
DEVICE=$(echo "${ATTACH_OUTPUT}" | awk '/Apple_HFS/ {print $1; exit}')
[[ -n "${DEVICE}" ]] || { echo "Could not determine the writable DMG device." >&2; exit 1; }
if [[ "${YLA_SKIP_FINDER_LAYOUT:-0}" == "1" ]]; then
  echo "Skipping Finder DMG layout; building a verified installable image without a desktop session."
else
LAYOUT_RESULT=$(osascript <<APPLESCRIPT 2>&1 || true
tell application "Finder"
  tell disk "${MOUNT_NAME}"
    open
    delay 1
    set targetWindow to container window
    set current view of targetWindow to icon view
    set toolbar visible of targetWindow to false
    set statusbar visible of targetWindow to false
    set pathbar visible of targetWindow to false
    try
      set sidebar width of targetWindow to 0
    end try
    set the bounds of targetWindow to {120, 120, 1020, 680}
    set opts to the icon view options of targetWindow
    set arrangement of opts to not arranged
    set icon size of opts to 128
    set text size of opts to 14
    set background picture of opts to POSIX file "${MOUNT_POINT}/.background/background.png"
    set expectedAppPosition to {225, 340}
    set expectedApplicationsPosition to {675, 340}
    set positioned to false
    repeat with attempt from 1 to 8
      try
        set appItem to item "${APP_NAME}" of targetWindow
        set applicationsItem to item "Applications" of targetWindow
        set position of appItem to expectedAppPosition
        set position of applicationsItem to expectedApplicationsPosition
        delay 0.4
        if (position of appItem) is expectedAppPosition and (position of applicationsItem) is expectedApplicationsPosition then
          set positioned to true
          exit repeat
        end if
      end try
      delay 0.4
    end repeat
    if not positioned then error "Finder did not persist the requested icon positions"
    -- Setting the view options/background itself persists .DS_Store on
    -- current macOS. The older update-without-registering-applications
    -- command attempts to eject this writable image on newer Finder builds.
    delay 1
  end tell
end tell
return "ok"
APPLESCRIPT
)

if [[ "${LAYOUT_RESULT}" != "ok" || ! -f "${MOUNT_POINT}/.DS_Store" ]]; then
  echo "Finder did not persist the branded DMG layout or icon positions." >&2
  hdiutil detach -quiet "${DEVICE}" || hdiutil detach -force "${DEVICE}"
  rm -f -- "${RW_IMAGE}"
  exit 1
fi
fi

sync
sleep 2
hdiutil detach -quiet "${DEVICE}" || hdiutil detach -force "${DEVICE}"
hdiutil convert -quiet "${RW_IMAGE}" -format UDZO -imagekey zlib-level=9 -o "${FINAL_IMAGE}"
codesign --force --sign "${YLA_CODESIGN_IDENTITY:--}" "${FINAL_IMAGE}"
rm -rf -- "${STAGING}"
rm -f -- "${RW_IMAGE}"
echo "Built ${FINAL_IMAGE}"
