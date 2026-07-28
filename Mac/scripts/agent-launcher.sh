#!/bin/zsh
set -euo pipefail

if (( $# != 2 )); then
  echo "Usage: $0 <mac-root> <node-path>" >&2
  exit 64
fi

MAC_ROOT=$1
NODE_PATH=$2
LOG_DIR="${MAC_ROOT}/logs"

mkdir -p "${LOG_DIR}"
exec >>"${LOG_DIR}/agent.log" 2>>"${LOG_DIR}/agent-error.log"

if [[ ! -x "${NODE_PATH}" ]]; then
  echo "Agent launcher: Node.js is not executable: ${NODE_PATH}" >&2
  exit 69
fi

for attempt in {1..60}; do
  if [[ -f "${MAC_ROOT}/src/main.mjs" ]]; then
    cd "${MAC_ROOT}"
    exec "${NODE_PATH}" "${MAC_ROOT}/src/main.mjs"
  fi
  echo "Agent launcher: waiting for external project volume (${attempt}/60)." >&2
  sleep 5
done

echo "Agent launcher: project is unavailable after 300 seconds: ${MAC_ROOT}" >&2
exit 75
