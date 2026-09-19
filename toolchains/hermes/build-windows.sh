#!/usr/bin/env bash
# Build the Windows Hermes archive on a native Windows runner.
#
#   build-windows.sh <hermes-source> <work-dir> <output.tar.gz>
#
# ── Why this is not the Docker lane ──────────────────────────────────────────
#
# The win32 target was built from Dockerfile.win32, which starts FROM Defold's
# extender-winsdk image. That image cannot be used here: the registry denies
# unauthenticated pulls despite being named "extender-public-registry", and the
# same denial is returned for a tag that does not exist, so it is repository
# scope rather than a bad pin. It also cannot be rebuilt from extender's own
# Dockerfile, which needs DM_PACKAGES_URL - Defold's private package host.
#
# ── Why this is simpler than the cross build it replaces ─────────────────────
#
# Hermes compiles its own internal JavaScript to bytecode during the build, so
# the Linux-hosted cross build had to build host compilers first and import them
# through IMPORT_HOST_COMPILERS. Building Windows on Windows is a NATIVE build:
# host and target are the same, CMake builds whatever host tool it needs itself,
# and the two-pass structure and toolchain file both fall away.
#
# "CMake builds whatever host tool it needs" is only true if the tool has a
# rule. hermesc lives under `tools/`, which the pinned tree adds only when
# HERMES_ENABLE_TOOLS is ON, and this lane had it OFF - so the build died at
# ninja graph load:
#
#   ninja: error: 'bin/hermesc', needed by
#   'API/hermes/extensions/ExtensionsBytecode.hbc', missing and no known rule
#   to make it
#
# TOOLS is ON below for that reason. It was OFF because `$<TARGET_FILE:hermes>`
# failed to evaluate; that expression appears only under
# `external/node-api-tests` and `external/node-api-cts`, both reached through
# Node-API, and HERMES_ENABLE_NAPI is OFF here - so the reason is gone and only
# the workaround remained. A host pass would be the other fix and is the wrong
# one for a native build: it would compile the same hermesc into a second tree
# and give the lane two flag sets to keep in agreement.

# ── Why two builds ───────────────────────────────────────────────────────────
#
# The archive carries a release library and a debugger-enabled one. That is a
# second COMPILATION, not a link-time switch: HERMES_ENABLE_DEBUGGER changes
# what the VM is built to do and chains on HERMES_MEMORY_INSTRUMENTATION at the
# pinned tree's CMakeLists.txt:245. The debugger belongs to development builds
# only - a JS debugger needs interpreter frames to stop in, and release lowers
# reachable routes to typed-native AOT C where those frames do not exist.
#
# ── What the image is for, and the caveat of not having it ───────────────────
#
# Extender COMPILES defold_hermes/src/*.cpp and then LINKS this archive into the
# engine, so the archive must be ABI-compatible with Extender's toolchain.
# Building inside Extender's own image is what guaranteed that.
#
# The compatibility target is therefore the EXTENDER IMAGE SET DEFOLD PINS, not
# build.defold.com in particular. Most users bundle through the hosted builder,
# but self-hosting Extender is a supported Defold deployment - teams run their
# own for private sources, compliance, build speed, or custom SDKs - and a
# déherm archive has to link correctly under theirs too. Matching the image is
# what makes one archive satisfy both, and it is an independent reason the
# container lane is the one that should ship.
#
# Note for anyone self-hosting: they hit this same registry wall. Standing up
# Extender's Windows builder requires an authenticated Google identity to pull
# extender-winsdk, exactly as building this archive from it does.
#
# Building against the runner's MSVC and Windows SDK instead guarantees no such
# thing, and the
# binding constraint is not the core C++ ABI - that has been stable since
# VS2015. It is that Hermes's JSI surface passes std::string, std::shared_ptr
# and other standard-library types across the boundary, so both sides must also
# agree on the MSVC STL version and on CRT linkage (/MT versus /MD). A mismatch
# there is an ODR violation or heap corruption, not a clean link error, which
# makes it a bad thing to discover from a user's crash report.
#
# This is the release-producing lane until the Extender-image cross toolchain's
# standard-library probe is proven. Dockerfile.win32 remains a manually
# dispatched advisory canary; it must not replace this path merely because a
# registry credential is present.
set -euo pipefail

hermes_source="$1"
work="$2"
output="$3"

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
staging="$(mktemp -d)"
trap 'rm -rf -- "$staging"' EXIT

build_variant() {
  local suffix="$1" debugger="$2" library="$3"
  cmake -S "$hermes_source" -B "$work$suffix" -G Ninja \
    -DCMAKE_BUILD_TYPE=Release \
    -DHERMES_ENABLE_TEST_SUITE=OFF \
    -DHERMES_ENABLE_TOOLS=ON \
    -DHERMES_ENABLE_NAPI=OFF \
    -DHERMES_ENABLE_DEBUGGER="$debugger" \
    -DHERMES_ENABLE_INTL=OFF \
    -DHERMES_BUILD_SHARED_JSI=OFF
  cmake --build "$work$suffix" --target hermesvm_a jsi --parallel
  # lib.exe is MSVC's archiver and takes llvm-lib's argument form, so the
  # packaging step is shared with the container build unchanged.
  LIB_TOOL="${LIB_TOOL:-lib}" bash "$here/package-msvc.sh" "$work$suffix" "$staging/$library"
}

# Separate build trees, so neither variant can pick up the other's objects.
build_variant "" OFF hermes.lib
build_variant "-debug" ON hermes.debug.lib

bash "$here/package-archive.sh" "$output" "$staging/hermes.lib" "$staging/hermes.debug.lib"
