#!/usr/bin/env bash
# Merge a Windows Hermes build into the single hermes.lib Extender force-loads.
#
#   package-msvc.sh <build-root> <output>
#
# Runs inside the Defold Windows SDK container, where llvm-lib is the archiver
# that understands the COFF objects the MSVC-targeting clang produced. Without
# this step the workflow would upload loose .lib parts and
# manage-native-artifacts.mjs would have nothing named hermes.lib to install.
set -euo pipefail

build_root="$1"
output="$2"
lib_tool="${LIB_TOOL:-llvm-lib}"
mkdir -p "$(dirname "$output")"

members=("$build_root/lib/hermesvm_a.lib" "$build_root/jsi/jsi.lib")
for member in "${members[@]}"; do
  if [[ ! -f "$member" ]]; then
    echo "package-msvc: missing $member" >&2
    exit 1
  fi
done

# Boost.Context only exists where Hermes selected fiber-based stacks. Windows
# normally uses its own fibers instead, so absence is a configuration rather
# than an error.
boost_archive="$build_root/external/boost/boost_1_86_0/libs/context/boost_context.lib"
if [[ -f "$boost_archive" ]]; then
  members+=("$boost_archive")
fi

# COFF archives carry no member timestamps of their own, so the merge is already
# byte-reproducible; the pinned digest is what proves it. Hermes' VM archive also
# carries its compiler-side zip implementation even though the runtime does not
# use it. Defold force-loads both extension archives and its own zip.lib, so the
# duplicate member must be removed here just as package-posix.sh removes zip.c.o.
#
# Under Git Bash, MSYS2 mistakes MSVC's `/OUT:` and `/REMOVE:` options for POSIX
# paths and rewrites the tokens. Convert only the output value ourselves, then
# exempt both option prefixes; member paths remain eligible for normal conversion.
lib_output="$output"
if command -v cygpath >/dev/null 2>&1; then
  lib_output="$(cygpath -w "$output")"
fi
MSYS2_ARG_CONV_EXCL="/OUT:;/REMOVE:" "$lib_tool" \
  "/OUT:$lib_output" "/REMOVE:zip.c.obj" "${members[@]}"
echo "package-msvc: wrote $output from ${#members[@]} library file(s)"
