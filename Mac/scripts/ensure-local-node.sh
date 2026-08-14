#!/bin/zsh
set -euo pipefail

SCRIPT_DIR=${0:A:h}
MAC_ROOT=${SCRIPT_DIR:h}
TOOLCHAIN="${MAC_ROOT}/Toolchain"
NODE_ROOT="${TOOLCHAIN}/node"
NODE_VERSION="22.16.0"
UPDATE_REQUESTED="${1:-}"

if [[ "$(uname -m)" != "arm64" ]]; then
  echo "Local Node.js can only be prepared on Apple Silicon." >&2
  exit 1
fi

if [[ "${UPDATE_REQUESTED}" != "--update" && -x "${NODE_ROOT}/bin/node" ]]; then
  "${NODE_ROOT}/bin/node" --version
  exit 0
fi

mkdir -p "${TOOLCHAIN}"
TEMP_ROOT=$(mktemp -d /private/tmp/yla-node.XXXXXX)
STAGING="${TOOLCHAIN}/node.installing"
PREVIOUS="${TOOLCHAIN}/node.previous"
trap 'rm -rf -- "${TEMP_ROOT}" "${STAGING}"' EXIT

curl -fL --retry 3 \
  "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-darwin-arm64.tar.gz" \
  -o "${TEMP_ROOT}/node.tar.gz"
tar -xzf "${TEMP_ROOT}/node.tar.gz" -C "${TEMP_ROOT}"
mv "${TEMP_ROOT}/node-v${NODE_VERSION}-darwin-arm64" "${STAGING}"

rm -rf -- "${PREVIOUS}"
if [[ -e "${NODE_ROOT}" ]]; then
  mv "${NODE_ROOT}" "${PREVIOUS}"
fi
if mv "${STAGING}" "${NODE_ROOT}"; then
  rm -rf -- "${PREVIOUS}"
else
  [[ -e "${PREVIOUS}" ]] && mv "${PREVIOUS}" "${NODE_ROOT}"
  exit 1
fi

"${NODE_ROOT}/bin/node" --version
