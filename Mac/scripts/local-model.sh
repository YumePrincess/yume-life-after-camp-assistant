#!/bin/zsh
set -euo pipefail

APP_SUPPORT="${HOME}/Library/Application Support/Yume Life After Mac Agent"
STATE_DIR="${APP_SUPPORT}/ModelRuntime"
VENV_DIR="${STATE_DIR}/venv"
MODEL_DIR="${APP_SUPPORT}/Models/Qwen3-VL-2B-Instruct-4bit"
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
  for candidate in \
    "/opt/homebrew/opt/python@3.12/bin/python3.12" \
    "/opt/homebrew/bin/python3" \
    "/usr/local/bin/python3"; do
    if [[ -x "${candidate}" ]]; then
      echo "${candidate}"
      return
    fi
  done
  return 1
}

model_installed() {
  [[ -f "${MODEL_DIR}/config.json" ]] &&
    find "${MODEL_DIR}" -type f -name '*.safetensors' -print -quit 2>/dev/null | grep -q .
}

server_running() {
  curl -fsS --max-time 2 "http://${HOST}:${PORT}/health" >/dev/null 2>&1
}

install_dependencies() {
  mkdir -p "${STATE_DIR}" "${MODEL_DIR}"
  local base
  if ! base=$(python_bin); then
    if command -v brew >/dev/null 2>&1; then
      brew install python@3.12
      base="/opt/homebrew/opt/python@3.12/bin/python3.12"
    else
      echo "Python 3.12 is required for the local Qwen model. Install Python 3.12 or Homebrew, then retry." >&2
      exit 1
    fi
  fi
  if [[ ! -x "${VENV_DIR}/bin/python" ]]; then
    "${base}" -m venv "${VENV_DIR}"
  fi
  "${VENV_DIR}/bin/python" -m pip install --upgrade pip wheel
  "${VENV_DIR}/bin/python" -m pip install --upgrade mlx-vlm huggingface_hub
}

download_model() {
  install_dependencies
  if model_installed; then
    echo "Local Qwen model is already available at ${MODEL_DIR}"
    return
  fi
  mkdir -p "${MODEL_DIR}"
  local python
  python=$(python_bin)
  HF_HUB_DISABLE_XET=1 MODEL_REPO="${MODEL_REPO}" MODEL_DIR="${MODEL_DIR}" \
    "${python}" -c \
    'import os; from huggingface_hub import snapshot_download; snapshot_download(repo_id=os.environ["MODEL_REPO"], local_dir=os.environ["MODEL_DIR"], max_workers=1)'
  model_installed || {
    echo "The Qwen model download completed without a complete model." >&2
    exit 1
  }
  echo "Model is available at ${MODEL_DIR}"
}

start_server() {
  if server_running; then
    echo "Local vision model is already running at http://${HOST}:${PORT}"
    return
  fi
  if ! model_installed; then
    echo "Local model is not installed. Run: $0 install" >&2
    exit 1
  fi
  local python
  python=$(python_bin)
  mkdir -p "${STATE_DIR}"
  stop_server
  nohup "${python}" -m mlx_vlm.server \
    --host "${HOST}" \
    --port "${PORT}" \
    --model "${MODEL_DIR}" \
    --max-tokens 512 \
    >"${LOG_PATH}" 2>&1 &
  echo $! > "${PID_PATH}"
  local attempts=0
  while (( attempts < 180 )); do
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
    if [[ "${command_line}" == *"mlx_vlm"* ]]; then
      kill "${model_server_pid}"
      local attempts=0
      while kill -0 "${model_server_pid}" 2>/dev/null && (( attempts < 20 )); do
        sleep 0.25
        (( attempts += 1 ))
      done
    else
      echo "Refusing to stop PID ${model_server_pid}: it is not mlx_vlm." >&2
      exit 1
    fi
  fi
  rm -f -- "${PID_PATH}"
  echo "Stopped local vision model."
}

show_status() {
  if server_running; then
    echo "Local vision model: running at http://${HOST}:${PORT}"
  elif model_installed; then
    echo "Local vision model: installed, stopped"
  else
    echo "Local vision model: not installed"
  fi
}

case "${1:-status}" in
  deps)
    install_dependencies
    ;;
  install|update)
    [[ "${1}" == "update" ]] && stop_server || true
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
  installed)
    model_installed
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
    fi
    if [[ -d "${MODEL_DIR}" ]]; then
      rm -rf -- "${MODEL_DIR}"
    fi
    echo "Removed the external Qwen model runtime and model."
    ;;
  *)
    echo "Usage: $0 {deps|install|update|start|stop|restart|installed|status|logs|uninstall}" >&2
    exit 2
    ;;
esac
