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
# MSVC lib.exe supports /REMOVE, but LLVM's deliberately lib.exe-compatible
# llvm-lib does not implement that option. The Defold Extender image uses
# llvm-lib, so merge first and delete the member with llvm-ar there. A native
# Visual Studio build keeps the single lib.exe invocation. Both paths list the
# result and fail closed if zip.c.obj survived.
#
# Under Git Bash, MSYS2 mistakes MSVC's `/OUT:` and `/REMOVE:` options for POSIX
# paths and rewrites the tokens. Convert only the output value ourselves, then
# exempt the option prefixes; member paths remain eligible for normal conversion.
lib_output="$output"
if command -v cygpath >/dev/null 2>&1; then
  lib_output="$(cygpath -w "$output")"
fi

lib_name="$(basename "$lib_tool" | tr '[:upper:]' '[:lower:]')"
if [[ "$lib_name" == llvm-lib* ]]; then
  ar_tool="${AR_TOOL:-llvm-ar}"
  if ! command -v "$ar_tool" >/dev/null 2>&1; then
    echo "package-msvc: $lib_tool requires llvm-ar to remove zip.c.obj" >&2
    exit 1
  fi
  MSYS2_ARG_CONV_EXCL="/OUT:" "$lib_tool" "/OUT:$lib_output" "${members[@]}"
  if "$ar_tool" t "$output" | grep -qE '^zip\.c\.obj/?$'; then
    "$ar_tool" d "$output" zip.c.obj
  fi
  if "$ar_tool" t "$output" | grep -qE '^zip\.c\.obj/?$'; then
    echo "package-msvc: unable to remove zip.c.obj from $output" >&2
    exit 1
  fi
else
  MSYS2_ARG_CONV_EXCL="/OUT:;/REMOVE:" "$lib_tool" \
    "/OUT:$lib_output" "/REMOVE:zip.c.obj" "${members[@]}"
  if MSYS2_ARG_CONV_EXCL="/LIST" "$lib_tool" "/LIST" "$lib_output" | grep -qE '(^|[\\/])zip\.c\.obj$'; then
    echo "package-msvc: unable to remove zip.c.obj from $output" >&2
    exit 1
  fi
fi
echo "package-msvc: wrote $output from ${#members[@]} library file(s)"
