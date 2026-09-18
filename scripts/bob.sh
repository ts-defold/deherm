#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
bob_jar="$repo_root/build/tooling/bob.jar"
action="${1:-build}"
shift || true

java_bin="${JAVA_HOME:+$JAVA_HOME/bin/java}"
if [[ -z "$java_bin" || ! -x "$java_bin" ]]; then
  java_bin="/opt/homebrew/opt/openjdk@25/bin/java"
fi
if [[ ! -x "$java_bin" ]]; then
  echo "JDK 25 is required. Set JAVA_HOME or install Homebrew openjdk@25." >&2
  exit 1
fi
if [[ ! -f "$bob_jar" ]]; then
  echo "Pinned Bob is missing; run npm run bootstrap:bob first." >&2
  exit 1
fi

if [[ "$action" == "version" ]]; then
  exec "$java_bin" -jar "$bob_jar" --version
fi

build_server="${DEFOLD_HERMES_BUILD_SERVER:-http://localhost:9010}"
case "$build_server" in
  http://localhost:*|http://127.0.0.1:*|http://\[::1\]:*)
    local_build=1
    ;;
  *)
    local_build=0
    ;;
esac

if [[ "$local_build" == "0" && "${DEFOLD_HERMES_ALLOW_REMOTE_BUILD:-}" != "1" ]]; then
  cat >&2 <<'MESSAGE'
This project contains a native extension. Bob sends its extension sources and
packaged libraries to the configured remote Defold build server. Re-run with
DEFOLD_HERMES_ALLOW_REMOTE_BUILD=1 after approving that upload. Local Extender
at http://localhost:9010 is the default and never requires this opt-in.
MESSAGE
  exit 2
fi

if [[ "$local_build" == "1" ]] && ! curl --silent --fail --max-time 2 "$build_server/actuator/health" >/dev/null; then
  echo "Local Extender is not healthy at $build_server." >&2
  echo "Run npm run extender:prepare && npm run extender:start first." >&2
  exit 1
fi

platform="${DEFOLD_HERMES_PLATFORM:-arm64-macos}"
variant="${DEFOLD_HERMES_VARIANT:-debug}"

case "$platform" in
  *-web)
    # HTML5 executes authored JavaScript in the browser. The extension's
    # lib/web Emscripten libraries are source files and need no Hermes archive.
    npm --prefix "$repo_root" run package:defold:web
    ;;
  *)
    npm --prefix "$repo_root" run package:defold
    ;;
esac

arguments=(
  --root "$repo_root/defold"
  --output build/bob
  --bundle-output build/bundle
  --platform "$platform"
  --architectures "$platform"
  --variant "$variant"
  --build-server "$build_server"
  --verbose
)

case "$action" in
  build)
    # The checked-in runtime workflow launches dmengine from build/bob. Without
    # --archive Bob updates loose custom resources but can leave an older
    # game.arcd in place; dmengine then preferentially loads that stale archive.
    # Always refresh the archive so runtime evidence corresponds to this build.
    arguments+=(--archive)
    commands=(resolve build)
    ;;
  bundle)
    arguments+=(--archive)
    commands=(resolve build bundle)
    ;;
  *)
    echo "Usage: $0 {version|build|bundle} [additional Bob arguments]" >&2
    exit 2
    ;;
esac

exec "$java_bin" -jar "$bob_jar" "${arguments[@]}" "$@" "${commands[@]}"
