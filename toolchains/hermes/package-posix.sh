#!/usr/bin/env bash
# Merge a Hermes build's VM, JSI and Boost.Context archives into the single
# libhermes.a Extender force-loads, dropping the one object that would collide
# with Defold's own zip implementation.
#
# The macOS lane does the same thing with `libtool -D` in
# scripts/package-defold-extension.sh; this is the ar-based equivalent used by
# every container and cross build. AR/NM may be overridden so a cross build uses
# its own binutils rather than the builder's.
set -euo pipefail

build_root="$1"
output="$2"
shift 2
ar_tool="${AR:-ar}"
nm_tool="${NM:-nm}"
temporary="$(mktemp -d)"
trap 'rm -rf -- "$temporary"' EXIT
mkdir -p "$(dirname "$output")"

vm_archive="$build_root/lib/libhermesvm_a.a"
jsi_archive="$build_root/jsi/libjsi.a"
for archive in "$vm_archive" "$jsi_archive"; do
  if [[ ! -f "$archive" ]]; then
    echo "package-posix: missing $archive" >&2
    exit 1
  fi
done

cp "$vm_archive" "$temporary/hermes.a"

# hermesvm_a carries the compiler-side zip implementation even though no VM
# object references it. Defold links its own zip library, so retaining the
# unused member produces duplicate global symbols when Extender force-loads
# extension archives. Removing it is only safe while nothing references it, so
# prove that before removing rather than assuming it.
if "$ar_tool" -t "$temporary/hermes.a" | grep -q '^zip\.c\.o$'; then
  if "$nm_tool" "$temporary/hermes.a" 2>/dev/null | grep -qE ' U _?zip_'; then
    echo "package-posix: Hermes VM now references zip symbols; refusing to strip zip.c.o." >&2
    exit 1
  fi
  "$ar_tool" -d "$temporary/hermes.a" zip.c.o
  if "$ar_tool" -t "$temporary/hermes.a" | grep -q '^zip\.c\.o$'; then
    echo "package-posix: unable to remove unused zip.c.o from the packaged Hermes VM archive." >&2
    exit 1
  fi
fi

members=("$temporary/hermes.a" "$jsi_archive")
# Boost.Context is only built where Hermes selects fiber-based stacks
# (HERMES_ALLOW_BOOST_CONTEXT auto). Its absence is a build configuration, not
# an error, so merge it when it exists and say which archives went in either way.
boost_archive="$build_root/external/boost/boost_1_86_0/libs/context/libboost_context.a"
if [[ -f "$boost_archive" ]]; then
  members+=("$boost_archive")
fi

# Static libraries do not absorb their link dependencies. A target build may
# therefore name the exact static runtime archives Hermes was compiled against
# after <build-root> and <output>; merge those into the one archive Extender
# force-loads. Linux uses this for ICU. The paths are explicit rather than
# rediscovered here so a cross/native recipe remains the authority for its SDK.
for dependency in "$@"; do
  if [[ ! -f "$dependency" ]]; then
    echo "package-posix: missing runtime dependency $dependency" >&2
    exit 1
  fi
  members+=("$dependency")
done

{
  echo "CREATE $output"
  for member in "${members[@]}"; do
    echo "ADDLIB $member"
  done
  echo "SAVE"
  echo "END"
} >"$temporary/archive.mri"
"$ar_tool" -M <"$temporary/archive.mri"

# MRI ADDLIB copies member headers through from the source archives, which
# llvm-ar and modern GNU ar already write with zeroed mtime/uid/gid/mode. Rewrite
# the symbol table in deterministic mode so the merge step cannot reintroduce a
# timestamp of its own; the pinned digest is what actually proves this held.
"$ar_tool" -D -s "$output" 2>/dev/null || "$ar_tool" -s "$output"

echo "package-posix: wrote $output from ${#members[@]} archive(s)"
