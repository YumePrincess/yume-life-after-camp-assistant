#!/bin/zsh
set -euo pipefail

LABEL="zone.yume.lifeafter.macagent.runtime"
SERVICE_TARGET="gui/${UID}/${LABEL}"
PLIST_PATH="${HOME}/Library/LaunchAgents/${LABEL}.plist"

if launchctl print "${SERVICE_TARGET}" >/dev/null 2>&1; then
  launchctl bootout "${SERVICE_TARGET}"
  echo "Stopped ${LABEL}"
else
  echo "${LABEL} is not currently loaded."
fi

if [[ -f "${PLIST_PATH}" ]]; then
  rm -f -- "${PLIST_PATH}"
  echo "Removed ${PLIST_PATH}"
else
  echo "LaunchAgent plist is already absent."
fi

echo "Uninstalled ${LABEL}."
echo "Project files, config.json, logs, OCR tools, and downloaded APKs were preserved."
