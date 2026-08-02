#!/bin/zsh
set -euo pipefail

LABEL="zone.yume.lifeafter.macagent.runtime"
SERVICE_TARGET="gui/${UID}/${LABEL}"
PLIST_PATH="${HOME}/Library/LaunchAgents/${LABEL}.plist"
SCRIPT_DIR=${0:A:h}
MAC_ROOT=${SCRIPT_DIR:h}
LOG_DIR="${MAC_ROOT}/logs"

require_plist() {
  if [[ ! -f "${PLIST_PATH}" ]]; then
    echo "LaunchAgent is not installed. Run: npm run agent:install" >&2
    exit 1
  fi
}

is_loaded() {
  launchctl print "${SERVICE_TARGET}" >/dev/null 2>&1
}

wait_until_unloaded() {
  for _ in {1..80}; do
    if ! is_loaded; then
      return 0
    fi
    sleep 0.25
  done
  echo "${LABEL} did not finish unloading from launchd." >&2
  return 1
}

bootstrap_agent() {
  local attempt bootstrap_error=""
  for attempt in {1..40}; do
    if bootstrap_error=$(launchctl bootstrap "gui/${UID}" "${PLIST_PATH}" 2>&1); then
      return 0
    fi
    if is_loaded; then
      return 0
    fi
    sleep 0.5
  done
  [[ -n "${bootstrap_error}" ]] && echo "${bootstrap_error}" >&2
  echo "Failed to register ${LABEL} after waiting for the previous launchd transition." >&2
  return 1
}

service_field() {
  local field=$1
  launchctl print "${SERVICE_TARGET}" 2>/dev/null |
    awk -v field="${field}" '
      $0 ~ "^\t" field " = " {
        sub("^\t" field " = ", "")
        print
        exit
      }
    '
}

wait_until_running() {
  local state pid
  for _ in {1..20}; do
    state=$(service_field "state")
    pid=$(service_field "pid")
    if [[ "${state}" == "running" && -n "${pid}" ]]; then
      echo "${LABEL} is running (pid ${pid})."
      return 0
    fi
    sleep 0.5
  done
  state=$(service_field "state")
  echo "${LABEL} was loaded but did not reach the running state (state: ${state:-unknown})." >&2
  local last_exit
  last_exit=$(service_field "last exit code")
  [[ -n "${last_exit}" ]] && echo "last exit code: ${last_exit}" >&2
  echo "Inspect external-volume logs with: npm run agent:logs" >&2
  return 1
}

start_agent() {
  require_plist
  if ! is_loaded; then
    bootstrap_agent
  fi
  launchctl kickstart -k "${SERVICE_TARGET}"
  wait_until_running
}

stop_agent() {
  if is_loaded; then
    launchctl bootout "${SERVICE_TARGET}"
    wait_until_unloaded
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
      state=$(service_field "state")
      pid=$(service_field "pid")
      if [[ "${state}" == "running" && -n "${pid}" ]]; then
        echo "${LABEL} is running (pid ${pid})."
      else
        echo "${LABEL} is loaded but not running."
        echo "state = ${state:-unknown}"
        last_exit=$(service_field "last exit code")
        [[ -n "${last_exit}" ]] && echo "last exit code = ${last_exit}"
        exit 1
      fi
    else
      echo "${LABEL} is stopped."
      exit 1
    fi
    ;;
  logs)
    mkdir -p "${LOG_DIR}"
    touch "${LOG_DIR}/agent.log" "${LOG_DIR}/agent-error.log"
    tail -n 80 "${LOG_DIR}/agent.log" "${LOG_DIR}/agent-error.log"
    ;;
  *)
    echo "Usage: $0 {start|stop|restart|status|logs}" >&2
    exit 2
    ;;
esac
