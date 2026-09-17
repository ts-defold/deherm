#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
extension_root="$repo_root/defold/defold_hermes"
hermes_source="$repo_root/upstream/hermes"
hermes_build="$repo_root/build/native/hermes"
library_dir="$extension_root/lib/arm64-osx"

if [[ "$(uname -m)" != "arm64" ]]; then
  echo "This spike packager currently supports arm64 macOS only." >&2
  exit 1
fi

required_archives=(
  "$hermes_build/lib/libhermesvm_a.a"
  "$hermes_build/jsi/libjsi.a"
  "$hermes_build/external/boost/boost_1_86_0/libs/context/libboost_context.a"
)
for archive in "${required_archives[@]}"; do
  if [[ ! -f "$archive" ]]; then
    echo "Missing $archive; run npm run build:native first." >&2
    exit 1
  fi
done

mkdir -p "$library_dir"
libtool -static -o "$library_dir/libhermes.a" "${required_archives[@]}"

mkdir -p "$extension_root/include/hermes/Public" "$extension_root/include/jsi"
cp "$hermes_source/API/hermes/hermes.h" "$extension_root/include/hermes/hermes.h"
cp "$hermes_source/API/jsi/jsi/"*.h "$extension_root/include/jsi/"
cp "$hermes_source/public/hermes/Public/"*.h "$extension_root/include/hermes/Public/"

echo "Packaged arm64-osx Hermes extension artifacts in $extension_root"
