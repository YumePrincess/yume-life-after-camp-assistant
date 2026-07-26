#!/bin/zsh
set -euo pipefail

LABEL="zone.yume.mrzh-agent"
SERVICE_TARGET="gui/${UID}/${LABEL}"
PLIST_PATH="${HOME}/Library/LaunchAgents/${LABEL}.plist"
SCRIPT_DIR=${0:A:h}
MAC_ROOT=${SCRIPT_DIR:h}

require_plist() {
  if [[ ! -f "${PLIST_PATH}" ]]; then
    echo "LaunchAgent is not installed. Run: npm run agent:install" >&2
    exit 1
  fi
}

is_loaded() {
  launchctl print "${SERVICE_TARGET}" >/dev/null 2>&1
}

start_agent() {
  require_plist
  if ! is_loaded; then
    launchctl bootstrap "gui/${UID}" "${PLIST_PATH}"
  fi
  launchctl kickstart -k "${SERVICE_TARGET}"
  echo "Started ${LABEL}"
}

stop_agent() {
  if is_loaded; then
    launchctl bootout "${SERVICE_TARGET}"
    echo "Stopped ${LABEL}; it will start again at the next macOS login."
  else
    echo "${LABEL} is already stopped."
  fi
}

case "${1:-status}" in
  start)
    start_agent
    ;;
  stop)
    stop_agent
    ;;
  restart)
    stop_agent
    start_agent
    ;;
  status)
    if is_loaded; then
      echo "${LABEL} is running."
      launchctl print "${SERVICE_TARGET}" | sed -n \
        -e '/state =/p' \
        -e '/pid =/p' \
        -e '/last exit code =/p'
    else
      echo "${LABEL} is stopped."
    fi
    ;;
  logs)
    mkdir -p "${MAC_ROOT}/logs"
    touch "${MAC_ROOT}/logs/agent.log" "${MAC_ROOT}/logs/agent-error.log"
    tail -n 80 "${MAC_ROOT}/logs/agent.log" "${MAC_ROOT}/logs/agent-error.log"
    ;;
  *)
    echo "Usage: $0 {start|stop|restart|status|logs}" >&2
    exit 2
    ;;
esac
