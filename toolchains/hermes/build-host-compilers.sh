#!/usr/bin/env bash
# Build the two host compilers déherm ships per user host.
#
#   build-host-compilers.sh <hermes-source> <work-dir> <output-dir>
#
# hermesc compiles TypeScript/JavaScript to Hermes bytecode; shermes lowers
# typed TypeScript to C. Both are pure compilers - text in, text out - so
# shipping them imposes no native toolchain requirement on the user: shermes
# only emits C, and Extender compiles it.
#
# These are indexed by the user's HOST, never by the Defold bundle target. A
# user on macOS bundling for Android needs the macOS compilers and the Android
# archive.
set -euo pipefail

hermes_source="$1"
work="$2"
output="$3"

# Each host build runs on a runner of that host's own architecture, so there is
# no cross-compilation here and nothing to import: this build *is* the one that
# produces the host compilers other builds import.
cmake -S "$hermes_source" -B "$work" -G Ninja \
  -DCMAKE_BUILD_TYPE=Release \
  -DHERMES_ENABLE_TEST_SUITE=OFF \
  -DHERMES_ENABLE_NAPI=OFF \
  -DHERMES_ENABLE_INTL=OFF
cmake --build "$work" --target hermesc shermes --parallel

mkdir -p "$output"
produced=()
for tool in hermesc shermes; do
  found=""
  for candidate in "$work/bin/$tool" "$work/bin/$tool.exe" "$work/$tool" "$work/$tool.exe"; do
    if [[ -f "$candidate" ]]; then
      found="$output/$(basename "$candidate")"
      cp "$candidate" "$found"
      break
    fi
  done
  if [[ -z "$found" ]]; then
    echo "build-host-compilers: $tool was not produced in $work" >&2
    exit 1
  fi
  produced+=("$found")
done

# A compiler that cannot answer --version is not a shippable artifact, and
# finding that out at release time is far cheaper than finding it out on a
# user's host.
for binary in "${produced[@]}"; do
  "$binary" --version >/dev/null
done
echo "build-host-compilers: wrote ${produced[*]}"
