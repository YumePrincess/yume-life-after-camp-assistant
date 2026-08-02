#!/bin/zsh
set -euo pipefail

SCRIPT_DIR=${0:A:h}
MAC_ROOT=${SCRIPT_DIR:h}
MODEL_CONTROL="${SCRIPT_DIR}/local-model.sh"
AGENT_CONTROL="${SCRIPT_DIR}/agent-control.sh"
INSTALL_AGENT="${SCRIPT_DIR}/install-launch-agent.sh"
UNINSTALL_AGENT="${SCRIPT_DIR}/uninstall-launch-agent.sh"

# A native .app does not run inside the user's interactive shell and therefore
# cannot assume Homebrew's npm/node are on PATH. Prefer the portable toolchain
# bundled by Yume Life After Mac Agent and fall back to system commands only
# for legacy source-tree installations.
if [[ -x "${MAC_ROOT}/Toolchain/node/bin/node" ]]; then
  NODE_BIN="${MAC_ROOT}/Toolchain/node/bin/node"
  NPM_BIN="${MAC_ROOT}/Toolchain/node/bin/npm"
  export PATH="${MAC_ROOT}/Toolchain/node/bin:${MAC_ROOT}/Toolchain/platform-tools:${PATH}"
else
  NODE_BIN="$(command -v node 2>/dev/null || true)"
  NPM_BIN="$(command -v npm 2>/dev/null || true)"
fi

run_node() {
  [[ -x "${NODE_BIN}" ]] || { echo "Portable Node.js is missing." >&2; return 127; }
  "${NODE_BIN}" "$@"
}

run_npm() {
  [[ -x "${NPM_BIN}" ]] || { echo "Portable npm is missing." >&2; return 127; }
  "${NPM_BIN}" "$@"
}

print_usage() {
  cat <<'EOF'
Yume Life After 本地 Agent 综合管理

用法：
  ./scripts/manage-local-agent.sh <命令>

命令：
  install     安装/更新依赖、视觉模型、登录自启动并启动 Agent
  uninstall   停止并卸载 Agent 与本地模型（保留源码和 config.json）
  update      更新依赖、OCR、模型和 LaunchAgent，然后恢复运行
  start       启动 Agent（本地模型会按任务自动启动）
  stop        停止 Agent 和本地模型
  restart     重启 Agent
  status      检查 launchd、PID、8091 健康端点和本地模型
  health      只检查 Agent 的 8091 健康端点
  repair      重新生成 LaunchAgent、启动并执行完整状态检查
  doctor      检查配置、ADB、Workers 与本机依赖
  logs        查看外置盘 Agent 日志和本地模型日志
  once        前台领取并执行一次任务
  deps        只安装/更新依赖
  model ...   单独管理模型
  help        显示本帮助
EOF
}

install_dependencies() {
  if [[ -x "${MAC_ROOT}/Toolchain/node/bin/node" && -x "${MAC_ROOT}/Toolchain/platform-tools/adb" ]]; then
    export PATH="${MAC_ROOT}/Toolchain/node/bin:${MAC_ROOT}/Toolchain/platform-tools:${PATH}"
    if [[ ! -x "${MAC_ROOT}/bin/mrzh-vision-ocr" ]]; then
      echo "Portable runtime is missing its prebuilt arm64 OCR helper." >&2
      exit 1
    fi
    if [[ ! -f "${MAC_ROOT}/package-lock.json" ]]; then
      echo "Portable runtime is incomplete." >&2
      exit 1
    fi
    return
  fi
  if ! command -v brew >/dev/null 2>&1; then
    echo "Portable toolchain is missing and Homebrew is unavailable." >&2
    exit 1
  fi
  command -v node >/dev/null 2>&1 || brew install node
  command -v adb >/dev/null 2>&1 || brew install android-platform-tools
  [[ -x "/opt/homebrew/opt/python@3.12/bin/python3.12" ]] || brew install python@3.12
  cd "${MAC_ROOT}"
  run_npm install
  "${SCRIPT_DIR}/build-vision.sh"
  "${MODEL_CONTROL}" deps
}

install_all() {
  install_dependencies
  "${MODEL_CONTROL}" install
  cd "${MAC_ROOT}"
  run_npm run doctor
  "${INSTALL_AGENT}"
  wait_for_health
}

start_all() {
  "${AGENT_CONTROL}" start
  wait_for_health
}

stop_all() {
  "${AGENT_CONTROL}" stop
  "${MODEL_CONTROL}" stop
}

status_all() {
  local failed=0
  "${AGENT_CONTROL}" status || failed=1
  health_agent || failed=1
  "${MODEL_CONTROL}" status || true
  return "${failed}"
}

health_agent() {
  cd "${MAC_ROOT}"
  run_node src/agent-health.mjs
}

wait_for_health() {
  local result=""
  for _ in {1..30}; do
    if result=$(health_agent 2>&1); then
      echo "${result}"
      return 0
    fi
    sleep 0.5
  done
  echo "${result}" >&2
  echo "Agent process started, but port 8091 did not become healthy within 15 seconds." >&2
  return 1
}

update_all() {
  local should_restart="no"
  if "${AGENT_CONTROL}" status >/dev/null 2>&1; then
    should_restart="yes"
    "${AGENT_CONTROL}" stop
  fi
  install_dependencies
  "${MODEL_CONTROL}" update
  if [[ -f "${HOME}/Library/LaunchAgents/zone.yume.lifeafter.macagent.runtime.plist" ]]; then
    "${INSTALL_AGENT}"
    should_restart="yes"
  fi
  if [[ "${should_restart}" == "yes" ]]; then
    status_all
  fi
}

uninstall_all() {
  "${UNINSTALL_AGENT}"
  "${MODEL_CONTROL}" uninstall
  echo "Source code and config.json were preserved."
}

repair_agent() {
  install_dependencies
  "${INSTALL_AGENT}"
  wait_for_health
}

run_once() {
  "${MODEL_CONTROL}" start
  trap '"${MODEL_CONTROL}" stop' EXIT INT TERM
  cd "${MAC_ROOT}"
  run_npm run once
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
    "${AGENT_CONTROL}" restart
    wait_for_health
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
    run_npm run doctor
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
  health)
    health_agent
    ;;
  repair)
    repair_agent
    ;;
  help|-h|--help)
    print_usage
    ;;
  *)
    print_usage >&2
    exit 2
    ;;
esac
