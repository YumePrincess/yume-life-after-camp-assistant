#!/bin/sh
set -eu

APP_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

if [ -z "${JAVA_HOME:-}" ]; then
    for candidate in "$APP_ROOT"/.tooling/jdk-17*/Contents/Home; do
        if [ -x "$candidate/bin/java" ]; then
            JAVA_HOME=$candidate
            export JAVA_HOME
            break
        fi
    done
fi

if [ -n "${JAVA_HOME:-}" ]; then
    PATH="$JAVA_HOME/bin:$PATH"
    export PATH
fi

if [ -z "${ANDROID_HOME:-}" ] && [ -d "$APP_ROOT/.android-sdk/platforms/android-36" ]; then
    ANDROID_HOME="$APP_ROOT/.android-sdk"
    export ANDROID_HOME
fi

if [ -n "${ANDROID_HOME:-}" ] && [ -z "${ANDROID_SDK_ROOT:-}" ]; then
    ANDROID_SDK_ROOT=$ANDROID_HOME
    export ANDROID_SDK_ROOT
fi

if [ -z "${GRADLE_USER_HOME:-}" ]; then
    GRADLE_USER_HOME="$APP_ROOT/.gradle-home"
    export GRADLE_USER_HOME
fi

cd "$APP_ROOT"
exec ./gradlew assembleDebug "$@"
