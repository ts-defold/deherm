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
temp_dir="$(mktemp -d "${TMPDIR:-/tmp}/deherm-hermes-package.XXXXXX")"
trap 'rm -rf -- "$temp_dir"' EXIT

# hermesvm_a carries the compiler-side zip implementation even though no VM
# object references it. Defold already links its own zip library, and retaining
# the unused member produces duplicate global symbols when Extender force-loads
# extension archives. Remove precisely that unreferenced object before merging.
hermes_vm_archive="$temp_dir/libhermesvm_a.a"
cp "$hermes_build/lib/libhermesvm_a.a" "$hermes_vm_archive"
if nm "$hermes_vm_archive" | grep -q ' U _zip_'; then
  echo "Hermes VM now references zip symbols; refusing to strip zip.c.o." >&2
  exit 1
fi
ar -d "$hermes_vm_archive" zip.c.o
if ar -t "$hermes_vm_archive" | grep -q '^zip\.c\.o$'; then
  echo "Unable to remove unused zip.c.o from the packaged Hermes VM archive." >&2
  exit 1
fi

# -D zeroes archive member mtime/uid/gid/mode. Without it libtool stamps the
# current time into every member, so repackaging identical objects produces a
# different file and the pinned native-artifact digest can never hold.
libtool -static -D -o "$library_dir/libhermes.a" \
  "$hermes_vm_archive" \
  "$hermes_build/jsi/libjsi.a" \
  "$hermes_build/external/boost/boost_1_86_0/libs/context/libboost_context.a"

# The pinned native-artifact digest must describe the archive this script just
# produced; otherwise every local Hermes rebuild breaks `deherm dev`.
node "$repo_root/scripts/manage-native-artifacts.mjs" record arm64-osx

mkdir -p "$extension_root/include/hermes/Public" "$extension_root/include/jsi"
cp "$hermes_source/API/hermes/hermes.h" "$extension_root/include/hermes/hermes.h"
cp "$hermes_source/API/jsi/jsi/"*.h "$extension_root/include/jsi/"
cp "$hermes_source/public/hermes/Public/"*.h "$extension_root/include/hermes/Public/"

echo "Packaged arm64-osx Hermes extension artifacts in $extension_root"
