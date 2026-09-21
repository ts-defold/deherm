#!/usr/bin/env bash
# Build Hermes for one Apple Defold bundle target on a macOS runner and merge it
# into the single libhermes.a Extender force-loads.
#
#   build-apple.sh <target> <hermes-source> <work-dir> <output.tar.gz>
#
# <target> is the Defold bundle target: arm64-osx, x86_64-osx, arm64-ios or
# arm64_sim-ios. iOS and the iOS simulator need Xcode, so there is no container
# path for them; this runs on a macOS GitHub runner.
#
# The deployment targets are not chosen here. They are the engine's own, derived
# into packages/toolchains/defold-bundle-targets.json from
# upstream/defold/build_tools/sdk.py and passed in through the environment by
# .github/workflows/native-artifacts.yml. An archive built against a newer
# minimum than the engine links against is a load-time failure on old devices
# that nothing in this repository would catch.
set -euo pipefail

target="$1"
hermes_source="$2"
work="$3"
output="$4"

macos_version_min="${DEFOLD_MACOSX_VERSION_MIN:?DEFOLD_MACOSX_VERSION_MIN is required}"
ios_version_min="${DEFOLD_IPHONEOS_VERSION_MIN:?DEFOLD_IPHONEOS_VERSION_MIN is required}"

case "$target" in
  arm64-osx)
    sdk=macosx; architecture=arm64
    flags="-arch arm64 -mmacosx-version-min=${macos_version_min}"
    system_name=Darwin; system_processor=arm64
    ;;
  x86_64-osx)
    sdk=macosx; architecture=x86_64
    flags="-arch x86_64 -mmacosx-version-min=${macos_version_min}"
    system_name=Darwin; system_processor=x86_64
    ;;
  arm64-ios)
    sdk=iphoneos; architecture=arm64
    flags="-arch arm64 -target arm64-apple-ios${ios_version_min} -miphoneos-version-min=${ios_version_min}"
    system_name=iOS; system_processor=arm64
    ;;
  arm64_sim-ios)
    sdk=iphonesimulator; architecture=arm64
    flags="-arch arm64 -target arm64-apple-ios${ios_version_min}-simulator -mios-simulator-version-min=${ios_version_min}"
    system_name=iOS; system_processor=arm64
    ;;
  *)
    echo "build-apple.sh: $target is not an Apple Defold bundle target" >&2
    exit 1
    ;;
esac

sysroot="$(xcrun --sdk "$sdk" --show-sdk-path)"
host_build="$work/host"
cross_build="$work/build"

# Hermes compiles its own internal JavaScript to bytecode during the build, so a
# cross build needs host compilers rather than binaries it cannot execute. The
# native arm64-osx build is its own host, but importing unconditionally keeps one
# code path for all four targets.
if [[ ! -f "$host_build/ImportHostCompilers.cmake" ]]; then
  cmake -S "$hermes_source" -B "$host_build" -G Ninja \
    -DCMAKE_BUILD_TYPE=Release \
    -DHERMES_ENABLE_TEST_SUITE=OFF \
    -DHERMES_ENABLE_INTL=OFF
  cmake --build "$host_build" --target hermesc shermes --parallel
fi

temporary="$(mktemp -d)"
trap 'rm -rf -- "$temporary"' EXIT

# One archive carries BOTH the release library and a debugger-enabled one. The
# second is a second COMPILATION, not a link-time switch:
# HERMES_ENABLE_DEBUGGER changes what the VM is built to do and chains on
# HERMES_MEMORY_INSTRUMENTATION at the pinned tree's CMakeLists.txt:245. The two
# are not interchangeable - a JS debugger needs interpreter frames to stop in,
# and release lowers reachable routes to typed-native AOT C where those frames
# do not exist - so the debugger belongs to development builds only.
build_variant() {
  local suffix="$1" debugger="$2" library="$3"
  local build="$cross_build$suffix"

  cmake -S "$hermes_source" -B "$build" -G Ninja \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_SYSTEM_NAME="$system_name" \
    -DCMAKE_SYSTEM_PROCESSOR="$system_processor" \
    -DCMAKE_OSX_SYSROOT="$sysroot" \
    -DCMAKE_OSX_ARCHITECTURES="$architecture" \
    -DCMAKE_C_FLAGS="$flags" \
    -DCMAKE_CXX_FLAGS="$flags" \
    -DIMPORT_HOST_COMPILERS="$host_build/ImportHostCompilers.cmake" \
    -DHERMES_ENABLE_TEST_SUITE=OFF \
    -DHERMES_ENABLE_TOOLS=OFF \
    -DHERMES_ENABLE_NAPI=OFF \
    -DHERMES_ENABLE_DEBUGGER="$debugger" \
    -DHERMES_ENABLE_INTL=OFF \
    -DHERMES_BUILD_SHARED_JSI=OFF
  cmake --build "$build" --target hermesvm_a jsi --parallel

  local vm_archive="$temporary/vm$suffix.a"
  cp "$build/lib/libhermesvm_a.a" "$vm_archive"

  # Identical reasoning to scripts/package-defold-extension.sh: Defold links its
  # own zip, so the unreferenced compiler-side zip.c.o would collide under
  # Extender's force-load. Prove nothing references it before removing it.
  if ar -t "$vm_archive" | grep -q '^zip\.c\.o$'; then
    if nm "$vm_archive" 2>/dev/null | grep -q ' U _zip_'; then
      echo "build-apple.sh: Hermes VM now references zip symbols; refusing to strip zip.c.o." >&2
      exit 1
    fi
    ar -d "$vm_archive" zip.c.o
  fi

  local members=("$vm_archive" "$build/jsi/libjsi.a")
  local boost_archive="$build/external/boost/boost_1_86_0/libs/context/libboost_context.a"
  if [[ -f "$boost_archive" ]]; then
    members+=("$boost_archive")
  fi

  # -D zeroes archive member mtime/uid/gid/mode. Without it libtool stamps the
  # current time into every member, so repackaging identical objects produces a
  # different file and the pinned native-artifact digest can never hold.
  libtool -static -D -o "$staging/$library" "${members[@]}"
  echo "build-apple.sh: built $library for $target from ${#members[@]} archive(s)"
}

staging="$temporary/staging"
mkdir -p "$staging"
# Separate build trees, so neither variant can pick up the other's objects.
build_variant "" OFF libhermes.a
build_variant "-debug" ON libhermes.debug.a
cp "$cross_build/hermes/lib/config/libhermesvm-config.h" "$staging/libhermesvm-config.h"

bash "$(dirname "${BASH_SOURCE[0]}")/package-archive.sh" \
  "$output" "$staging/libhermes.a" "$staging/libhermes.debug.a" \
  "$staging/libhermesvm-config.h"
echo "build-apple.sh: wrote $output for $target"
