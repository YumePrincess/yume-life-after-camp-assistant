#!/bin/zsh
set -euo pipefail
SCRIPT_DIR=${0:A:h}
APP_ROOT=${SCRIPT_DIR:h}
TEST_ROOT="$(mktemp -d /private/tmp/yla-runtime-tests.XXXXXX)"
trap 'rm -rf -- "${TEST_ROOT}"' EXIT
swiftc "${APP_ROOT}/Sources/YumeLifeAfterMacAgent/RuntimePayload.swift" \
  "${APP_ROOT}/Tests/YumeLifeAfterMacAgentTests/RuntimePayloadTests.swift" \
  -o "${TEST_ROOT}/runtime-payload-tests"
"${TEST_ROOT}/runtime-payload-tests"
