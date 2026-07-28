#!/bin/zsh
set -euo pipefail

SCRIPT_DIR=${0:A:h}
MAC_ROOT=${SCRIPT_DIR:h}
LABEL="zone.yume.mrzh-agent"
SERVICE_TARGET="gui/${UID}/${LABEL}"
PLIST_PATH="${HOME}/Library/LaunchAgents/${LABEL}.plist"
LAUNCHER_PATH="${SCRIPT_DIR}/agent-launcher.sh"
NODE_PATH=$(command -v node)

mkdir -p "${HOME}/Library/LaunchAgents" "${MAC_ROOT}/logs"
chmod 755 "${LAUNCHER_PATH}"
/usr/libexec/PlistBuddy -c "Clear dict" "${PLIST_PATH}" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Add :Label string ${LABEL}" "${PLIST_PATH}"
/usr/libexec/PlistBuddy -c "Add :ProgramArguments array" "${PLIST_PATH}"
/usr/libexec/PlistBuddy -c "Add :ProgramArguments:0 string ${NODE_PATH}" "${PLIST_PATH}"
/usr/libexec/PlistBuddy -c "Add :ProgramArguments:1 string ${MAC_ROOT}/src/main.mjs" "${PLIST_PATH}"
/usr/libexec/PlistBuddy -c "Add :EnvironmentVariables dict" "${PLIST_PATH}"
/usr/libexec/PlistBuddy -c "Add :EnvironmentVariables:YUME_AGENT_FILE_LOG string 1" "${PLIST_PATH}"
/usr/libexec/PlistBuddy -c "Add :EnvironmentVariables:PATH string /opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" "${PLIST_PATH}"
/usr/libexec/PlistBuddy -c "Add :RunAtLoad bool true" "${PLIST_PATH}"
/usr/libexec/PlistBuddy -c "Add :KeepAlive bool true" "${PLIST_PATH}"
/usr/libexec/PlistBuddy -c "Add :ThrottleInterval integer 10" "${PLIST_PATH}"
/usr/libexec/PlistBuddy -c "Add :StandardOutPath string /dev/null" "${PLIST_PATH}"
/usr/libexec/PlistBuddy -c "Add :StandardErrorPath string /dev/null" "${PLIST_PATH}"

launchctl bootout "${SERVICE_TARGET}" 2>/dev/null || true
launchctl bootstrap "gui/${UID}" "${PLIST_PATH}"
launchctl kickstart -k "${SERVICE_TARGET}"

echo "Installed ${LABEL}; launcher and logs remain on the external project volume."
"${SCRIPT_DIR}/agent-control.sh" status
