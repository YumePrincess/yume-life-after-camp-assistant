#!/bin/zsh
set -euo pipefail

SCRIPT_DIR=${0:A:h}
MAC_ROOT=${SCRIPT_DIR:h}
LABEL="zone.yume.lifeafter.macagent.runtime"
LEGACY_LABEL="zone.yume.mrzh-agent"
SERVICE_TARGET="gui/${UID}/${LABEL}"
PLIST_PATH="${HOME}/Library/LaunchAgents/${LABEL}.plist"
LAUNCHER_PATH="${SCRIPT_DIR}/agent-launcher.sh"
if [[ -x "${MAC_ROOT}/Toolchain/node/bin/node" ]]; then
  NODE_PATH="${MAC_ROOT}/Toolchain/node/bin/node"
else
  NODE_PATH=$(command -v node)
fi

mkdir -p "${HOME}/Library/LaunchAgents" "${MAC_ROOT}/logs"
chmod 755 "${LAUNCHER_PATH}"

# The native App owns the new runtime label. Retire only the historical
# script-installed service and plist; its external logs and configuration are
# deliberately preserved for recovery.
launchctl bootout "gui/${UID}/${LEGACY_LABEL}" 2>/dev/null || true
rm -f -- "${HOME}/Library/LaunchAgents/${LEGACY_LABEL}.plist"

/usr/libexec/PlistBuddy -c "Clear dict" "${PLIST_PATH}" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Add :Label string ${LABEL}" "${PLIST_PATH}"
/usr/libexec/PlistBuddy -c "Add :ProgramArguments array" "${PLIST_PATH}"
/usr/libexec/PlistBuddy -c "Add :ProgramArguments:0 string ${NODE_PATH}" "${PLIST_PATH}"
/usr/libexec/PlistBuddy -c "Add :ProgramArguments:1 string ${MAC_ROOT}/src/main.mjs" "${PLIST_PATH}"
/usr/libexec/PlistBuddy -c "Add :EnvironmentVariables dict" "${PLIST_PATH}"
/usr/libexec/PlistBuddy -c "Add :EnvironmentVariables:YUME_AGENT_FILE_LOG string 1" "${PLIST_PATH}"
/usr/libexec/PlistBuddy -c "Add :EnvironmentVariables:PATH string ${MAC_ROOT}/Toolchain/node/bin:${MAC_ROOT}/Toolchain/platform-tools:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" "${PLIST_PATH}"
/usr/libexec/PlistBuddy -c "Add :RunAtLoad bool true" "${PLIST_PATH}"
/usr/libexec/PlistBuddy -c "Add :KeepAlive bool true" "${PLIST_PATH}"
/usr/libexec/PlistBuddy -c "Add :ThrottleInterval integer 10" "${PLIST_PATH}"
/usr/libexec/PlistBuddy -c "Add :StandardOutPath string /dev/null" "${PLIST_PATH}"
/usr/libexec/PlistBuddy -c "Add :StandardErrorPath string /dev/null" "${PLIST_PATH}"

launchctl bootout "${SERVICE_TARGET}" 2>/dev/null || true
for _ in {1..20}; do
  if ! launchctl print "${SERVICE_TARGET}" >/dev/null 2>&1; then
    break
  fi
  sleep 0.1
done

bootstrap_succeeded=false
for attempt in {1..3}; do
  if launchctl bootstrap "gui/${UID}" "${PLIST_PATH}"; then
    bootstrap_succeeded=true
    break
  fi
  if (( attempt < 3 )); then
    sleep 1
  fi
done
if [[ "${bootstrap_succeeded}" != true ]]; then
  echo "Unable to bootstrap ${LABEL} after 3 attempts." >&2
  exit 1
fi
launchctl kickstart -k "${SERVICE_TARGET}"

echo "Installed ${LABEL}; runtime and logs remain with this managed Agent installation."
"${SCRIPT_DIR}/agent-control.sh" status
