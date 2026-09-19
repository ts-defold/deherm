#!/usr/bin/env bash
# Build the Windows Hermes archive on a native Windows runner.
#
#   build-windows.sh <hermes-source> <work-dir> <output>
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
# ── The provenance caveat ────────────────────────────────────────────────────
#
# The archive is now built against the runner's Windows SDK and MSVC rather than
# the versions Defold pins in build_tools/sdk.py. MSVC has held its C++ ABI
# stable since VS2015 and Extender links this archive rather than rebuilding it,
# so this is compatible in practice - but it is a weaker claim than "built with
# the toolchain Defold declares", and it is the one thing in this lane that
# would be fixed by registry access rather than by more code here.
set -euo pipefail

hermes_source="$1"
work="$2"
output="$3"

cmake -S "$hermes_source" -B "$work" -G Ninja \
  -DCMAKE_BUILD_TYPE=Release \
  -DHERMES_ENABLE_TEST_SUITE=OFF \
  -DHERMES_ENABLE_TOOLS=OFF \
  -DHERMES_ENABLE_DEBUGGER=OFF \
  -DHERMES_ENABLE_INTL=OFF \
  -DHERMES_BUILD_SHARED_JSI=OFF
cmake --build "$work" --target hermesvm_a jsi --parallel

# lib.exe is MSVC's archiver and takes llvm-lib's argument form, so the
# packaging step is shared with the container build unchanged.
LIB_TOOL="${LIB_TOOL:-lib}" bash "$(dirname "${BASH_SOURCE[0]}")/package-msvc.sh" "$work" "$output"
