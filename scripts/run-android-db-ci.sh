#!/usr/bin/env bash

set -euo pipefail

readonly APP_PACKAGE='com.bluegreengatorapps.messages'
readonly APK_PATH='android/app/build/outputs/apk/debug/app-debug.apk'
: "${ANDROID_SERIAL:?ANDROID_SERIAL must identify the CI emulator.}"
: "${RUNNER_TEMP:?RUNNER_TEMP must be set by GitHub Actions.}"
readonly METRO_LOG="$RUNNER_TEMP/gator-metro.log"

metro_pid=''

cleanup() {
  adb -s "$ANDROID_SERIAL" shell am force-stop "$APP_PACKAGE" >/dev/null 2>&1 || :
  adb -s "$ANDROID_SERIAL" reverse --remove tcp:8081 >/dev/null 2>&1 || :
  if [[ -n "$metro_pid" ]]; then
    kill "$metro_pid" >/dev/null 2>&1 || :
    wait "$metro_pid" 2>/dev/null || :
  fi
}

show_metro_failure() {
  echo '::group::Last 80 lines from Metro startup'
  tail -n 80 "$METRO_LOG" 2>/dev/null || :
  echo '::endgroup::'
}

trap cleanup EXIT

adb -s "$ANDROID_SERIAL" install -r "$APK_PATH"
CI=1 EXPO_UNSTABLE_HEADLESS=1 NODE_OPTIONS=--dns-result-order=ipv4first npm start -- --dev-client --localhost >"$METRO_LOG" 2>&1 &
metro_pid=$!

metro_ready=0
for _attempt in {1..90}; do
  metro_status=$(curl --silent --fail --max-time 2 http://127.0.0.1:8081/status 2>/dev/null || :)
  if [[ "$metro_status" == 'packager-status:running' ]]; then
    metro_ready=1
    break
  fi
  if ! kill -0 "$metro_pid" 2>/dev/null; then
    echo '::error::Metro exited before becoming ready.'
    show_metro_failure
    exit 1
  fi
  sleep 1
done

if [[ "$metro_ready" -ne 1 ]]; then
  echo '::error::Metro did not become ready within 90 seconds.'
  show_metro_failure
  exit 1
fi

npm run test:android:db
npm run test:android:db:relaunch
npm run test:android:db:wal-write-death
npm run test:android:db:active-migration-death
