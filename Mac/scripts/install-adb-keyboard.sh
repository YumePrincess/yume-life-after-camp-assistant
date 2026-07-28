#!/bin/zsh
set -euo pipefail

SCRIPT_DIR=${0:A:h}
MAC_ROOT=${SCRIPT_DIR:h}
APK_PATH="${MAC_ROOT}/downloads/ADBKeyboard.apk"
APK_URL="https://f-droid.org/repo/com.android.adbkeyboard_2.apk"

if [[ -n "${MRZH_ADB_SERIAL:-}" ]]; then
  ADB_SERIAL="${MRZH_ADB_SERIAL}"
else
  TOOL_PATH=$(node -e '
    const c = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    process.stdout.write(c.mumu.toolPath);
  ' "${MAC_ROOT}/config.json")
  INSTANCE_NAME=$(node -e '
    const c = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    process.stdout.write(c.mumu.instanceName);
  ' "${MAC_ROOT}/config.json")
  INSTANCE_INDEX=$("${TOOL_PATH}" info all | node -e '
    let input = "";
    process.stdin.on("data", chunk => input += chunk);
    process.stdin.on("end", () => {
      const payload = JSON.parse(input);
      const matches = payload.return.results.filter(
        item => item.name === process.argv[1]
      );
      if (matches.length !== 1) {
        throw new Error(`Expected exactly one MuMu container named ${process.argv[1]}`);
      }
      process.stdout.write(String(matches[0].index));
    });
  ' "${INSTANCE_NAME}")
  ADB_PORT=$("${TOOL_PATH}" info "${INSTANCE_INDEX}" | node -e '
    let input = "";
    process.stdin.on("data", chunk => input += chunk);
    process.stdin.on("end", () => {
      const payload = JSON.parse(input);
      if (!payload.return.adb_port) throw new Error("MuMu container is not running");
      process.stdout.write(String(payload.return.adb_port));
    });
  ')
  ADB_SERIAL="127.0.0.1:${ADB_PORT}"
fi

mkdir -p "${MAC_ROOT}/downloads"
curl --fail --location --proto '=https' --tlsv1.2 "${APK_URL}" --output "${APK_PATH}"
adb connect "${ADB_SERIAL}"
adb -s "${ADB_SERIAL}" install -r "${APK_PATH}"
adb -s "${ADB_SERIAL}" shell ime enable com.android.adbkeyboard/.AdbIME
echo "ADB Keyboard installed and enabled. The Agent restores the previous IME after every message."
