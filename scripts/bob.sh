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

# The smoke project under defold/ is the default Bob root. A product example is
# an ordinary Defold project with the same extension link, so the same wrapper
# builds it when DEFOLD_HERMES_PROJECT names its directory. The value is a path
# relative to the repository root or an absolute path; nothing else changes.
project_root="${DEFOLD_HERMES_PROJECT:-defold}"
case "$project_root" in
  /*) ;;
  *) project_root="$repo_root/$project_root" ;;
esac
if [[ ! -f "$project_root/game.project" ]]; then
  echo "No game.project under $project_root." >&2
  exit 1
fi

# A `shermes -emit-c` unit is a transport of the Hermes runtime. Bob discovers
# extensions by walking the project, and an ext.manifest cannot exclude a
# platform, so a unit a previous native build materialised would otherwise be
# uploaded for wasm-web too and fail the link on undefined _sh_* symbols. This
# reconciles the project's .defignore against the selected target before Bob
# walks it; it never deletes the unit.
node "$repo_root/scripts/assemble-typed-native-extension.mjs" \
  --project "$project_root" --target "$platform" --reconcile

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

# Bob archives whatever /deherm/app.dehermc is on disk as a custom_resources
# entry, and nothing in Bob relates that file to the TypeScript beside it. The
# freshness gate compares the bundle against the sources deherm.lock records it
# was built from, so a build that never runs deherm interactively cannot package
# a bundle older than its sources. It is a hash comparison, not a rebuild.
# --allow-unbound reports, without failing, an artifact that predates the
# fingerprint binding - this project's smoke bundle is one; a recorded bundle
# that disagrees with its sources still fails the build.
if [[ "${DEFOLD_HERMES_SKIP_BUNDLE_CHECK:-0}" != "1" ]]; then
  node "$repo_root/bin/deherm.mjs" verify-bundle --project "$project_root" --allow-unbound
fi

arguments=(
  --root "$project_root"
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
