#!/bin/zsh
set -euo pipefail

SCRIPT_DIR=${0:A:h}
MAC_ROOT=${SCRIPT_DIR:h}
MODEL_CONTROL="${SCRIPT_DIR}/local-model.sh"
AGENT_CONTROL="${SCRIPT_DIR}/agent-control.sh"

install_dependencies() {
  if ! command -v brew >/dev/null 2>&1; then
    echo "Homebrew is required. Install it from https://brew.sh first." >&2
    exit 1
  fi
  command -v node >/dev/null 2>&1 || brew install node
  command -v adb >/dev/null 2>&1 || brew install android-platform-tools
  [[ -x "/opt/homebrew/opt/python@3.12/bin/python3.12" ]] || brew install python@3.12
  cd "${MAC_ROOT}"
  npm install
  "${SCRIPT_DIR}/build-vision.sh"
  "${MODEL_CONTROL}" deps
}

install_all() {
  install_dependencies
  "${MODEL_CONTROL}" install
  cd "${MAC_ROOT}"
  npm run doctor
  "${SCRIPT_DIR}/install-launch-agent.sh"
}

start_all() {
  "${MODEL_CONTROL}" start
  "${AGENT_CONTROL}" start
}

stop_all() {
  "${AGENT_CONTROL}" stop
  "${MODEL_CONTROL}" stop
}

status_all() {
  "${AGENT_CONTROL}" status || true
  "${MODEL_CONTROL}" status || true
}

update_all() {
  local was_loaded="no"
  if launchctl print "gui/${UID}/zone.yume.mrzh-agent" >/dev/null 2>&1; then
    was_loaded="yes"
    "${AGENT_CONTROL}" stop
  fi
  install_dependencies
  "${MODEL_CONTROL}" update
  if [[ "${was_loaded}" == "yes" ]]; then
    "${AGENT_CONTROL}" start
  fi
}

uninstall_all() {
  "${SCRIPT_DIR}/uninstall-launch-agent.sh"
  "${MODEL_CONTROL}" uninstall
  echo "Source code and config.json were preserved."
}

run_once() {
  "${MODEL_CONTROL}" start
  trap '"${MODEL_CONTROL}" stop' EXIT INT TERM
  cd "${MAC_ROOT}"
  npm run once
}

case "${1:-status}" in
  deps)
    install_dependencies
    ;;
  install)
    install_all
    ;;
  start)
    start_all
    ;;
  stop)
    stop_all
    ;;
  restart)
    stop_all
    start_all
    ;;
  status)
    status_all
    ;;
  update)
    update_all
    ;;
  uninstall)
    uninstall_all
    ;;
  doctor)
    cd "${MAC_ROOT}"
    npm run doctor
    ;;
  once)
    run_once
    ;;
  logs)
    "${AGENT_CONTROL}" logs
    "${MODEL_CONTROL}" logs
    ;;
  model)
    shift
    "${MODEL_CONTROL}" "${1:-status}"
    ;;
  *)
    echo "Usage: $0 {deps|install|start|stop|restart|status|update|uninstall|doctor|once|logs|model <command>}" >&2
    exit 2
    ;;
esac
