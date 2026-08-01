#!/bin/zsh
set -euo pipefail

SCRIPT_DIR=${0:A:h}
APP_ROOT=${SCRIPT_DIR:h}
PORTABLE_ROOT="${APP_ROOT}/.portable"
TOOLCHAIN="${PORTABLE_ROOT}/Toolchain"
NODE_VERSION="22.16.0"
PYTHON_SERIES="3.12"
WITH_MODEL=false

if [[ "${1:-}" == "--with-model" ]]; then
  WITH_MODEL=true
fi

if [[ "$(uname -m)" != "arm64" ]]; then
  echo "Portable runtime can only be prepared on Apple Silicon." >&2
  exit 1
fi

mkdir -p "${TOOLCHAIN}"
TEMP_ROOT=$(mktemp -d /private/tmp/yla-portable.XXXXXX)
trap 'rm -rf -- "${TEMP_ROOT}"' EXIT

if [[ ! -x "${TOOLCHAIN}/node/bin/node" ]]; then
  curl -fL --retry 3 \
    "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-darwin-arm64.tar.gz" \
    -o "${TEMP_ROOT}/node.tar.gz"
  tar -xzf "${TEMP_ROOT}/node.tar.gz" -C "${TEMP_ROOT}"
  mv "${TEMP_ROOT}/node-v${NODE_VERSION}-darwin-arm64" "${TOOLCHAIN}/node"
fi

if [[ ! -x "${TOOLCHAIN}/platform-tools/adb" ]] || \
   [[ "$(/usr/bin/lipo -archs "${TOOLCHAIN}/platform-tools/adb" 2>/dev/null || true)" != "arm64" ]]; then
  ARM64_ADB_SOURCE="${YLA_ARM64_ADB_SOURCE:-/opt/homebrew/bin/adb}"
  if [[ ! -x "${ARM64_ADB_SOURCE}" ]] || \
     ! /usr/bin/lipo -archs "${ARM64_ADB_SOURCE}" 2>/dev/null | grep -qw arm64; then
    echo "An arm64 adb is required. Install android-platform-tools with native Homebrew or set YLA_ARM64_ADB_SOURCE." >&2
    exit 1
  fi
  rm -rf -- "${TOOLCHAIN}/platform-tools"
  mkdir -p "${TOOLCHAIN}/platform-tools"
  /usr/bin/lipo "${ARM64_ADB_SOURCE}" -thin arm64 -output "${TOOLCHAIN}/platform-tools/adb"
  chmod +x "${TOOLCHAIN}/platform-tools/adb"
fi

if [[ ! -x "${TOOLCHAIN}/python/bin/python3" ]]; then
  curl -fsSL --retry 3 \
    "https://api.github.com/repos/astral-sh/python-build-standalone/releases/latest" \
    -o "${TEMP_ROOT}/python-release.json"
  PYTHON_URL=$("${TOOLCHAIN}/node/bin/node" -e '
    const fs=require("fs");
    const data=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
    const asset=data.assets.find(x => x.name.includes("cpython-3.12.") && x.name.includes("aarch64-apple-darwin-install_only_stripped.tar.gz"));
    if (!asset) process.exit(2);
    process.stdout.write(asset.browser_download_url);
  ' "${TEMP_ROOT}/python-release.json")
  curl -fL --retry 3 "${PYTHON_URL}" -o "${TEMP_ROOT}/python.tar.gz"
  tar -xzf "${TEMP_ROOT}/python.tar.gz" -C "${TEMP_ROOT}"
  mv "${TEMP_ROOT}/python" "${TOOLCHAIN}/python"
  "${TOOLCHAIN}/python/bin/python3" -m pip install --upgrade pip wheel mlx-vlm huggingface_hub
fi

if [[ "${WITH_MODEL}" == true ]]; then
  MODEL_DIR="${PORTABLE_ROOT}/models/Qwen3-VL-2B-Instruct-4bit"
  mkdir -p "${MODEL_DIR}"
  HF_HUB_DISABLE_XET=1 MODEL_DIR="${MODEL_DIR}" \
    "${TOOLCHAIN}/python/bin/python3" -c \
    'import os; from huggingface_hub import snapshot_download; snapshot_download(repo_id="mlx-community/Qwen3-VL-2B-Instruct-4bit", local_dir=os.environ["MODEL_DIR"], max_workers=1)'
fi

echo "Portable arm64 runtime prepared at ${PORTABLE_ROOT}"
