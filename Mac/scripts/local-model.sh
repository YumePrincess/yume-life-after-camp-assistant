#!/bin/zsh
set -euo pipefail

SCRIPT_DIR=${0:A:h}
MAC_ROOT=${SCRIPT_DIR:h}
STATE_DIR="${MAC_ROOT}/.local-model"
VENV_DIR="${STATE_DIR}/venv"
MODEL_DIR="${STATE_DIR}/models/Qwen3-VL-2B-Instruct-4bit"
PID_PATH="${STATE_DIR}/server.pid"
LOG_PATH="${STATE_DIR}/server.log"
MODEL_REPO="mlx-community/Qwen3-VL-2B-Instruct-4bit"
HOST="127.0.0.1"
PORT="8092"

python_bin() {
  if [[ -x "${VENV_DIR}/bin/python" ]]; then
    echo "${VENV_DIR}/bin/python"
    return
  fi
  if [[ -x "/opt/homebrew/opt/python@3.12/bin/python3.12" ]]; then
    echo "/opt/homebrew/opt/python@3.12/bin/python3.12"
    return
  fi
  return 1
}

server_running() {
  curl -fsS --max-time 2 "http://${HOST}:${PORT}/health" >/dev/null 2>&1
}

install_dependencies() {
  if [[ ! -x "/opt/homebrew/opt/python@3.12/bin/python3.12" ]]; then
    if ! command -v brew >/dev/null 2>&1; then
      echo "Homebrew is required to install Python 3.12." >&2
      exit 1
    fi
    brew install python@3.12
  fi
  mkdir -p "${STATE_DIR}" "${STATE_DIR}/models"
  if [[ ! -x "${VENV_DIR}/bin/python" ]]; then
    "/opt/homebrew/opt/python@3.12/bin/python3.12" -m venv "${VENV_DIR}"
  fi
  "${VENV_DIR}/bin/python" -m pip install --upgrade pip wheel
  "${VENV_DIR}/bin/python" -m pip install --upgrade mlx-vlm huggingface_hub
}

download_model() {
  install_dependencies
  mkdir -p "${MODEL_DIR}"
  HF_HUB_DISABLE_XET=1 MODEL_REPO="${MODEL_REPO}" MODEL_DIR="${MODEL_DIR}" \
    "${VENV_DIR}/bin/python" -c \
    'import os; from huggingface_hub import snapshot_download; snapshot_download(repo_id=os.environ["MODEL_REPO"], local_dir=os.environ["MODEL_DIR"], max_workers=1)'
  echo "Model is available at ${MODEL_DIR}"
}

start_server() {
  if server_running; then
    echo "Local vision model is already running at http://${HOST}:${PORT}"
    return
  fi
  if [[ ! -x "${VENV_DIR}/bin/mlx_vlm.server" || ! -f "${MODEL_DIR}/config.json" ]]; then
    echo "Local model is not installed. Run: $0 install" >&2
    exit 1
  fi
  mkdir -p "${STATE_DIR}"
  stop_server
  nohup "${VENV_DIR}/bin/mlx_vlm.server" \
    --host "${HOST}" \
    --port "${PORT}" \
    --model "${MODEL_DIR}" \
    --max-tokens 512 \
    >"${LOG_PATH}" 2>&1 &
  echo $! > "${PID_PATH}"
  local attempts=0
  while (( attempts < 120 )); do
    if server_running; then
      echo "Started local vision model at http://${HOST}:${PORT}"
      return
    fi
    local model_server_pid="$(<"${PID_PATH}")"
    if ! kill -0 "${model_server_pid}" 2>/dev/null; then
      echo "Local model exited during startup. See ${LOG_PATH}" >&2
      tail -n 40 "${LOG_PATH}" >&2 || true
      exit 1
    fi
    sleep 1
    (( attempts += 1 ))
  done
  echo "Timed out waiting for local model health endpoint. See ${LOG_PATH}" >&2
  stop_server
  exit 1
}

stop_server() {
  if [[ ! -f "${PID_PATH}" ]]; then
    echo "Local vision model is already stopped."
    return
  fi
  local model_server_pid="$(<"${PID_PATH}")"
  if [[ "${model_server_pid}" == <-> ]] && kill -0 "${model_server_pid}" 2>/dev/null; then
    local command_line
    command_line=$(ps -p "${model_server_pid}" -o command= 2>/dev/null || true)
    if [[ "${command_line}" == *"mlx_vlm.server"* ]]; then
      kill "${model_server_pid}"
      local attempts=0
      while kill -0 "${model_server_pid}" 2>/dev/null && (( attempts < 20 )); do
        sleep 0.25
        (( attempts += 1 ))
      done
    else
      echo "Refusing to stop PID ${model_server_pid}: it is not mlx_vlm.server" >&2
      exit 1
    fi
  fi
  rm -f -- "${PID_PATH}"
  echo "Stopped local vision model."
}

show_status() {
  if server_running; then
    echo "Local vision model: running at http://${HOST}:${PORT}"
  elif [[ -f "${MODEL_DIR}/config.json" ]]; then
    echo "Local vision model: installed, stopped"
  else
    echo "Local vision model: not installed"
  fi
}

case "${1:-status}" in
  deps)
    install_dependencies
    ;;
  install)
    download_model
    ;;
  update)
    stop_server
    download_model
    ;;
  start)
    start_server
    ;;
  stop)
    stop_server
    ;;
  restart)
    stop_server
    start_server
    ;;
  status)
    show_status
    ;;
  logs)
    mkdir -p "${STATE_DIR}"
    touch "${LOG_PATH}"
    tail -n 100 "${LOG_PATH}"
    ;;
  uninstall)
    stop_server
    if [[ -d "${STATE_DIR}" ]]; then
      rm -rf -- "${STATE_DIR}"
      echo "Removed local model, isolated Python environment, PID and logs."
    fi
    ;;
  *)
    echo "Usage: $0 {deps|install|update|start|stop|restart|status|logs|uninstall}" >&2
    exit 2
    ;;
esac
