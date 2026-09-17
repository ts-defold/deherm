#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=/dev/null
source "$repo_root/upstream.lock"

extender_root="$repo_root/upstream/extender"
env_dir="$extender_root/server/envs"
app_dir="$extender_root/server/app"
platformsdk_dir="$extender_root/platformsdk"
service_script="$extender_root/server/scripts/standalone/service-standalone.sh"
override_env="$env_dir/deherm-macos.env"
java_home="${JAVA_HOME:-/opt/homebrew/opt/openjdk@25/libexec/openjdk.jdk/Contents/Home}"
action="${1:-status}"

fail() {
  echo "$*" >&2
  exit 1
}

require_checkout() {
  [[ "$(uname -s)" == "Darwin" ]] || fail "Standalone Extender currently requires macOS."
  [[ -d "$extender_root/.git" ]] || fail "Pinned Extender is missing; run npm run bootstrap:upstreams."
  local actual
  actual="$(git -C "$extender_root" rev-parse HEAD)"
  [[ "$actual" == "$EXTENDER_REV" ]] || fail "Extender revision mismatch: expected $EXTENDER_REV, got $actual"
  [[ -x "$java_home/bin/java" ]] || fail "JDK 25 is missing. Set JAVA_HOME or install Homebrew openjdk@25."
  "$java_home/bin/java" -version 2>&1 | grep -q 'version "25' || fail "JDK 25 is required: $java_home"
  command -v xcrun >/dev/null || fail "Xcode command-line tools are required."
}

configure_apple_sdk() {
  local developer_dir toolchain sdk_version ios_version clang_version swift_version
  developer_dir="$(xcode-select -p)"
  toolchain="$developer_dir/Toolchains/XcodeDefault.xctoolchain"
  sdk_version="$(xcrun --sdk macosx --show-sdk-version)"
  ios_version="$(xcrun --sdk iphoneos --show-sdk-version)"
  clang_version="$(find "$toolchain/usr/lib/clang" -mindepth 1 -maxdepth 1 -type d -exec basename {} \; | sort -V | tail -1)"
  swift_version="$(find "$toolchain/usr/lib" -mindepth 1 -maxdepth 1 -type d -name 'swift-*' -exec basename {} \; | sed 's/^swift-//' | sort -V | tail -1)"

  [[ -n "$sdk_version" && -n "$ios_version" && -n "$clang_version" && -n "$swift_version" ]] || fail "Unable to detect the installed Apple SDK/toolchain versions."

  mkdir -p "$platformsdk_dir"
  ln -sfn "$developer_dir/Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk" "$platformsdk_dir/MacOSX${sdk_version}.sdk"
  ln -sfn "$developer_dir/Platforms/iPhoneOS.platform/Developer/SDKs/iPhoneOS.sdk" "$platformsdk_dir/iPhoneOS${ios_version}.sdk"
  ln -sfn "$developer_dir/Platforms/iPhoneSimulator.platform/Developer/SDKs/iPhoneSimulator.sdk" "$platformsdk_dir/iPhoneSimulator${ios_version}.sdk"
  ln -sfn "$toolchain" "$platformsdk_dir/XcodeDefault${sdk_version}.xctoolchain"

  JAVA_HOME="$java_home" "$env_dir/generate_user_env.sh"
  cat > "$override_env" <<EOF
IOS_VERSION_MIN=15.0
MACOS_VERSION_MIN=11.5
XCODE_VERSION=$sdk_version
XCODE_CLANG_VERSION=$clang_version
MACOS_VERSION=$sdk_version
IOS_VERSION=$ios_version
SWIFT_VERSION=$swift_version
XCTOOLCHAIN_PATH=$platformsdk_dir/XcodeDefault${sdk_version}.xctoolchain
PATH="$platformsdk_dir/XcodeDefault${sdk_version}.xctoolchain/usr/bin:/opt/homebrew/bin:/usr/local/bin:\${PATH}"
EOF

  echo "Configured Xcode SDK $sdk_version, iOS SDK $ios_version, clang $clang_version, Swift ABI $swift_version."
}

prepare() {
  require_checkout
  configure_apple_sdk
  (
    cd "$extender_root"
    JAVA_HOME="$java_home" ./gradlew server:bootJar manifestmergetool:mainJar
  )
  [[ -f "$app_dir/extender.jar" && -f "$app_dir/manifestmergetool.jar" ]] || fail "Extender jars were not produced."
  echo "Local Extender is prepared at revision $EXTENDER_REV."
}

start() {
  prepare
  ENV_PROFILE=deherm-macos JAVA_HOME="$java_home" "$service_script" start standalone-dev
  for _ in {1..30}; do
    if curl --silent --fail --max-time 1 http://localhost:9010/actuator/health >/dev/null; then
      echo "Local Extender is healthy at http://localhost:9010."
      return
    fi
    sleep 1
  done
  fail "Extender did not become healthy; inspect $app_dir/logs/error.log"
}

foreground() {
  prepare
  set -a
  # shellcheck source=/dev/null
  source "$env_dir/.env"
  # shellcheck source=/dev/null
  source "$env_dir/user.env"
  # shellcheck source=/dev/null
  source "$override_env"
  set +a
  exec "$java_home/bin/java" -Xmx4g -XX:MaxDirectMemorySize=2g \
    -jar "$app_dir/extender.jar" \
    --extender.sdk.location="$app_dir/sdk" \
    --spring.config.additional-location="file:$extender_root/server/configs/" \
    --spring.profiles.active=standalone-dev
}

status() {
  require_checkout
  if curl --silent --fail --max-time 2 http://localhost:9010/actuator/health; then
    echo
    echo "Local Extender is healthy at http://localhost:9010."
  else
    fail "Local Extender is not healthy at http://localhost:9010."
  fi
}

case "$action" in
  prepare) prepare ;;
  start) start ;;
  foreground) foreground ;;
  stop)
    require_checkout
    ENV_PROFILE=deherm-macos JAVA_HOME="$java_home" "$service_script" stop standalone-dev
    ;;
  restart)
    require_checkout
    ENV_PROFILE=deherm-macos JAVA_HOME="$java_home" "$service_script" stop standalone-dev || true
    start
    ;;
  status) status ;;
  logs)
    require_checkout
    exec tail -F "$app_dir/logs/stdout.log" "$app_dir/logs/error.log"
    ;;
  *)
    echo "Usage: $0 {prepare|start|foreground|stop|restart|status|logs}" >&2
    exit 2
    ;;
esac
