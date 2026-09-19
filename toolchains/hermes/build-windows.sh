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
# ── The provenance caveat, which is not small ────────────────────────────────
#
# Nobody here runs Extender: users bundle through remote Bob against
# build.defold.com, and that is unaffected by how this archive is produced. What
# matters is that Extender COMPILES defold_hermes/src/*.cpp and then LINKS this
# archive into the engine, so the archive must be ABI-compatible with Extender's
# toolchain. Building inside Extender's own image is what guaranteed that.
#
# Building against the runner's MSVC and Windows SDK instead does not, and the
# binding constraint is not the core C++ ABI - that has been stable since
# VS2015. It is that Hermes's JSI surface passes std::string, std::shared_ptr
# and other standard-library types across the boundary, so both sides must also
# agree on the MSVC STL version and on CRT linkage (/MT versus /MD). A mismatch
# there is an ODR violation or heap corruption, not a clean link error, which
# makes it a bad thing to discover from a user's crash report.
#
# So this lane is a FALLBACK. The registry denial that forced it reads
# "Unauthenticated request", which suggests the grant is to any authenticated
# Google identity rather than to named accounts - in which case a service
# account credential restores Dockerfile.win32 and this file stops being the
# path that ships.
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
