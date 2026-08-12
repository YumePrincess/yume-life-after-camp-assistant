#!/bin/zsh
set -euo pipefail

SCRIPT_DIR=${0:A:h}
MAC_ROOT=${SCRIPT_DIR:h}
LABEL="zone.yume.lifeafter.macagent.runtime"
LEGACY_LABEL="zone.yume.mrzh-agent"
SERVICE_TARGET="gui/${UID}/${LABEL}"
PLIST_PATH="${HOME}/Library/LaunchAgents/${LABEL}.plist"
LAUNCHER_PATH="${SCRIPT_DIR}/agent-launcher.sh"
CREDENTIALS_PATH="${HOME}/Library/Application Support/Yume Life After Mac Agent/credentials.json"
if [[ -x "${MAC_ROOT}/Toolchain/node/bin/node" ]]; then
  NODE_PATH="${MAC_ROOT}/Toolchain/node/bin/node"
else
  NODE_PATH=$(command -v node)
fi

mkdir -p "${HOME}/Library/LaunchAgents" "${MAC_ROOT}/logs"
chmod 755 "${LAUNCHER_PATH}"

# The native App owns the new runtime label. Retire the historical service
# before loading the replacement so an old process cannot keep reading legacy
# Keychain credentials or polling Workers under the retired Agent identity.
launchctl bootout "gui/${UID}/${LEGACY_LABEL}" 2>/dev/null || true
rm -f -- "${HOME}/Library/LaunchAgents/${LEGACY_LABEL}.plist"

PLIST_STAGING=$(mktemp -t yla-launch-agent)
trap 'rm -f -- "${PLIST_STAGING}"' EXIT
/usr/bin/plutil -create xml1 "${PLIST_STAGING}"
/usr/libexec/PlistBuddy -c "Add :Label string ${LABEL}" "${PLIST_STAGING}"
/usr/libexec/PlistBuddy -c "Add :ProgramArguments array" "${PLIST_STAGING}"
/usr/libexec/PlistBuddy -c "Add :ProgramArguments:0 string ${NODE_PATH}" "${PLIST_STAGING}"
/usr/libexec/PlistBuddy -c "Add :ProgramArguments:1 string ${MAC_ROOT}/src/main.mjs" "${PLIST_STAGING}"
/usr/libexec/PlistBuddy -c "Add :EnvironmentVariables dict" "${PLIST_STAGING}"
/usr/libexec/PlistBuddy -c "Add :EnvironmentVariables:YUME_AGENT_FILE_LOG string 1" "${PLIST_STAGING}"
/usr/libexec/PlistBuddy -c "Add :EnvironmentVariables:YLA_CREDENTIALS_FILE string ${CREDENTIALS_PATH}" "${PLIST_STAGING}"
/usr/libexec/PlistBuddy -c "Add :EnvironmentVariables:PATH string ${MAC_ROOT}/Toolchain/node/bin:${MAC_ROOT}/Toolchain/platform-tools:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" "${PLIST_STAGING}"
/usr/libexec/PlistBuddy -c "Add :RunAtLoad bool true" "${PLIST_STAGING}"
/usr/libexec/PlistBuddy -c "Add :KeepAlive bool true" "${PLIST_STAGING}"
/usr/libexec/PlistBuddy -c "Add :ThrottleInterval integer 10" "${PLIST_STAGING}"
/usr/libexec/PlistBuddy -c "Add :StandardOutPath string /dev/null" "${PLIST_STAGING}"
/usr/libexec/PlistBuddy -c "Add :StandardErrorPath string /dev/null" "${PLIST_STAGING}"
/usr/bin/plutil -lint "${PLIST_STAGING}" >/dev/null
/bin/chmod 644 "${PLIST_STAGING}"
/bin/mv -f -- "${PLIST_STAGING}" "${PLIST_PATH}"
trap - EXIT

launchctl bootout "${SERVICE_TARGET}" 2>/dev/null || true
for _ in {1..80}; do
  if ! launchctl print "${SERVICE_TARGET}" >/dev/null 2>&1; then
    break
  fi
  sleep 0.25
done

bootstrap_succeeded=false
bootstrap_error=""
for attempt in {1..40}; do
  if bootstrap_error=$(launchctl bootstrap "gui/${UID}" "${PLIST_PATH}" 2>&1); then
    bootstrap_succeeded=true
    break
  fi
  if launchctl print "${SERVICE_TARGET}" >/dev/null 2>&1; then
    bootstrap_succeeded=true
    break
  fi
  sleep 0.5
done
if [[ "${bootstrap_succeeded}" != true ]]; then
  [[ -n "${bootstrap_error}" ]] && echo "${bootstrap_error}" >&2
  echo "Unable to register ${LABEL} after waiting for launchd to finish the previous per-user service transition." >&2
  echo "Do not retry as root. Wait a moment and use Repair Agent again; if launchd remains stuck, log out and back in once." >&2
  exit 1
fi
# launchctl can return successfully before the per-user domain exposes the
# service to print/kickstart. Wait for that registration boundary explicitly;
# otherwise repair reports a misleading "Could not find service ... gui:501".
service_loaded=false
for _ in {1..40}; do
  if launchctl print "${SERVICE_TARGET}" >/dev/null 2>&1; then
    service_loaded=true
    break
  fi
  sleep 0.25
done
if [[ "${service_loaded}" != true ]]; then
  echo "${LABEL} was bootstrapped but did not appear in the user launchd domain." >&2
  echo "Do not retry as root; wait briefly and use Repair Agent again." >&2
  exit 1
fi
echo "Installed ${LABEL}; runtime and logs remain with this managed Agent installation."
# A successful bootstrap can still need a few moments before launchd exposes
# the process state. Reuse the bounded start/wait path instead of sampling
# `status` immediately and reporting a false repair failure.
"${SCRIPT_DIR}/agent-control.sh" start
