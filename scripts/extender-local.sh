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
emsdk_root="$platformsdk_dir/emsdk-$EMSDK_VERSION"
java_home="${JAVA_HOME:-/opt/homebrew/opt/openjdk@25/libexec/openjdk.jdk/Contents/Home}"
action="${1:-status}"
staged_env=""

cleanup_staged_env() {
  if [[ -n "$staged_env" && -f "$staged_env" ]]; then
    rm -f "$staged_env"
  fi
}
trap cleanup_staged_env EXIT

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

write_env() {
  local destination="$1" name="$2" value="$3"
  printf '%s=%q\n' "$name" "$value" >> "$destination"
}

configure_apple_sdk() {
  local destination="$1"
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
  : > "$destination"
  write_env "$destination" IOS_VERSION_MIN "15.0"
  write_env "$destination" MACOS_VERSION_MIN "11.5"
  write_env "$destination" XCODE_VERSION "$sdk_version"
  write_env "$destination" XCODE_CLANG_VERSION "$clang_version"
  write_env "$destination" MACOS_VERSION "$sdk_version"
  write_env "$destination" IOS_VERSION "$ios_version"
  write_env "$destination" SWIFT_VERSION "$swift_version"
  write_env "$destination" XCTOOLCHAIN_PATH "$platformsdk_dir/XcodeDefault${sdk_version}.xctoolchain"
  printf 'PATH=%q:${PATH}\n' "$platformsdk_dir/XcodeDefault${sdk_version}.xctoolchain/usr/bin:/opt/homebrew/bin:/usr/local/bin" >> "$destination"

  echo "Configured Xcode SDK $sdk_version, iOS SDK $ios_version, clang $clang_version, Swift ABI $swift_version."
}

configure_emscripten_sdk() {
  local destination="$1"
  local emscripten_bin emscripten_cache emscripten_temp node_path node_bin python_bin
  "$repo_root/scripts/bootstrap-emsdk.sh"
  emscripten_bin="$emsdk_root/upstream/emscripten"
  emscripten_cache="$platformsdk_dir/emcache_$EMSDK_VERSION"
  emscripten_temp="$platformsdk_dir/ems_temp"
  node_path="$(find "$emsdk_root/node" -type f -path '*/bin/node' -perm -111 -print -quit 2>/dev/null || true)"
  [[ -n "$node_path" ]] || fail "Emscripten $EMSDK_VERSION did not install its matching Node runtime."
  node_bin="$(dirname "$node_path")"
  python_bin="$(find -L "$emsdk_root/python" -type f -path '*/bin/python3' -perm -111 -print -quit 2>/dev/null || true)"
  [[ -x "$emscripten_bin/em++" && -n "$node_bin" && -x "$python_bin" ]] || fail "Emscripten $EMSDK_VERSION activation is incomplete."
  mkdir -p "$emscripten_cache" "$emscripten_temp"

  write_env "$destination" EMSCRIPTEN_HOME "$emsdk_root"
  write_env "$destination" EMSCRIPTEN_CACHE "$emscripten_cache"
  write_env "$destination" EMSCRIPTEN_CONFIG "$emsdk_root/.emscripten"
  write_env "$destination" EMSCRIPTEN_PYTHON "$python_bin"
  write_env "$destination" EMSCRIPTEN_BIN "$emscripten_bin"
  write_env "$destination" EMCC_TEMP_DIR "$emscripten_temp"
  write_env "$destination" EMSCRIPTEN_PATH "$emsdk_root:$emsdk_root/upstream/bin:$node_bin:$emscripten_bin"
  # Native Extender commands invoke clang++ by name. Preserve the Apple
  # toolchain at the front of PATH; Emscripten locates its LLVM via its own
  # config and remains available later in PATH for HTML5 commands.
  printf 'PATH=${PATH}:%q\n' "$emsdk_root:$emsdk_root/upstream/bin:$node_bin:$emscripten_bin" >> "$destination"

  echo "Configured Emscripten SDK $EMSDK_VERSION at $emsdk_root."
}

prepare() {
  require_checkout
  staged_env="$(mktemp "$env_dir/.deherm-macos.env.XXXXXX")"
  configure_apple_sdk "$staged_env"
  configure_emscripten_sdk "$staged_env"
  mv "$staged_env" "$override_env"
  staged_env=""
  if ! grep -qxF '/server/envs/deherm-macos.env' "$extender_root/.git/info/exclude"; then
    printf '%s\n' '/server/envs/deherm-macos.env' >> "$extender_root/.git/info/exclude"
  fi
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

foreground_prepared() {
  require_checkout
  [[ -f "$override_env" && -f "$app_dir/extender.jar" ]] || fail "Local Extender is not prepared; run npm run extender:prepare."
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

foreground() {
  prepare
  foreground_prepared
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
  foreground-prepared) foreground_prepared ;;
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
    echo "Usage: $0 {prepare|start|foreground|foreground-prepared|stop|restart|status|logs}" >&2
    exit 2
    ;;
esac
