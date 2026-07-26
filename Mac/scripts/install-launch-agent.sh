#!/bin/zsh
set -euo pipefail

SCRIPT_DIR=${0:A:h}
MAC_ROOT=${SCRIPT_DIR:h}
PLIST_PATH="${HOME}/Library/LaunchAgents/zone.yume.mrzh-agent.plist"
NODE_PATH=$(command -v node)

mkdir -p "${HOME}/Library/LaunchAgents" "${MAC_ROOT}/logs"
/usr/libexec/PlistBuddy -c "Clear dict" "${PLIST_PATH}" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Add :Label string zone.yume.mrzh-agent" "${PLIST_PATH}"
/usr/libexec/PlistBuddy -c "Add :ProgramArguments array" "${PLIST_PATH}"
/usr/libexec/PlistBuddy -c "Add :ProgramArguments:0 string ${NODE_PATH}" "${PLIST_PATH}"
/usr/libexec/PlistBuddy -c "Add :ProgramArguments:1 string ${MAC_ROOT}/src/main.mjs" "${PLIST_PATH}"
/usr/libexec/PlistBuddy -c "Add :WorkingDirectory string ${MAC_ROOT}" "${PLIST_PATH}"
/usr/libexec/PlistBuddy -c "Add :RunAtLoad bool true" "${PLIST_PATH}"
/usr/libexec/PlistBuddy -c "Add :KeepAlive bool true" "${PLIST_PATH}"
/usr/libexec/PlistBuddy -c "Add :ThrottleInterval integer 10" "${PLIST_PATH}"
/usr/libexec/PlistBuddy -c "Add :StandardOutPath string ${MAC_ROOT}/logs/agent.log" "${PLIST_PATH}"
/usr/libexec/PlistBuddy -c "Add :StandardErrorPath string ${MAC_ROOT}/logs/agent-error.log" "${PLIST_PATH}"

launchctl bootout "gui/${UID}/zone.yume.mrzh-agent" 2>/dev/null || true
launchctl bootstrap "gui/${UID}" "${PLIST_PATH}"
launchctl kickstart -k "gui/${UID}/zone.yume.mrzh-agent"
echo "Installed and started zone.yume.mrzh-agent"
