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

if [[ "${DEFOLD_HERMES_ALLOW_REMOTE_BUILD:-}" != "1" ]]; then
  cat >&2 <<'MESSAGE'
This project contains a native extension. Bob sends its extension sources and
packaged libraries to the configured Defold build server. Re-run with
DEFOLD_HERMES_ALLOW_REMOTE_BUILD=1 after approving that upload.
MESSAGE
  exit 2
fi

platform="${DEFOLD_HERMES_PLATFORM:-arm64-osx}"
variant="${DEFOLD_HERMES_VARIANT:-debug}"
build_server="${DEFOLD_HERMES_BUILD_SERVER:-https://build.defold.com}"

npm --prefix "$repo_root" run package:defold

arguments=(
  --root "$repo_root/defold"
  --output "$repo_root/build/bob"
  --bundle-output "$repo_root/build/bundle"
  --platform "$platform"
  --architectures "$platform"
  --variant "$variant"
  --build-server "$build_server"
  --verbose
)

case "$action" in
  build)
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
