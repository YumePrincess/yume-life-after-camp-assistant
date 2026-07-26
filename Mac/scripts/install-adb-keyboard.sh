#!/bin/zsh
set -euo pipefail

SCRIPT_DIR=${0:A:h}
MAC_ROOT=${SCRIPT_DIR:h}
APK_PATH="${MAC_ROOT}/downloads/ADBKeyboard.apk"
ADB_SERIAL=${MRZH_ADB_SERIAL:-127.0.0.1:26688}
APK_URL="https://f-droid.org/repo/com.android.adbkeyboard_2.apk"

mkdir -p "${MAC_ROOT}/downloads"
curl --fail --location --proto '=https' --tlsv1.2 "${APK_URL}" --output "${APK_PATH}"
adb connect "${ADB_SERIAL}"
adb -s "${ADB_SERIAL}" install -r "${APK_PATH}"
adb -s "${ADB_SERIAL}" shell ime enable com.android.adbkeyboard/.AdbIME
echo "ADB Keyboard installed and enabled. The Agent restores the previous IME after every message."
