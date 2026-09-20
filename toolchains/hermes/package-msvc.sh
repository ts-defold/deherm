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
  archive_members="$("$ar_tool" t "$output")"
  if grep -E '^zip\.c\.obj/?$' <<< "$archive_members" >/dev/null; then
    "$ar_tool" d "$output" zip.c.obj
  fi
  archive_members="$("$ar_tool" t "$output")"
  if grep -E '^zip\.c\.obj/?$' <<< "$archive_members" >/dev/null; then
    echo "package-msvc: unable to remove zip.c.obj from $output" >&2
    exit 1
  fi
else
  MSYS2_ARG_CONV_EXCL="/OUT:;/REMOVE:" "$lib_tool" \
    "/OUT:$lib_output" "/REMOVE:zip.c.obj" "${members[@]}"
  archive_members="$(MSYS2_ARG_CONV_EXCL="/LIST" "$lib_tool" "/LIST" "$lib_output")"
  if grep -E '(^|[\\/])zip\.c\.obj$' <<< "$archive_members" >/dev/null; then
    echo "package-msvc: unable to remove zip.c.obj from $output" >&2
    exit 1
  fi
fi

# Defold's Windows libraries carry `/FAILIFMISMATCH` directives for the static
# release CRT. A green archive build is not evidence that Hermes matches them:
# `/MD` archives package successfully and fail only when Extender combines them
# with Defold's `/MT` engine libraries. Inspect the produced COFF members and
# refuse every dynamic or mixed runtime before publication.
directives_tool="${COFF_DIRECTIVES_TOOL:-}"
directives_mode=""
if [[ -z "$directives_tool" ]]; then
  if command -v llvm-readobj >/dev/null 2>&1; then
    directives_tool="llvm-readobj"
    directives_mode="llvm"
  elif command -v dumpbin >/dev/null 2>&1; then
    directives_tool="dumpbin"
    directives_mode="dumpbin"
  else
    echo "package-msvc: llvm-readobj or dumpbin is required to verify the COFF runtime contract" >&2
    exit 1
  fi
else
  directives_name="$(basename "$directives_tool" | tr '[:upper:]' '[:lower:]')"
  if [[ "$directives_name" == dumpbin* ]]; then
    directives_mode="dumpbin"
  else
    directives_mode="llvm"
  fi
fi

if [[ "$directives_mode" == "dumpbin" ]]; then
  coff_directives="$(MSYS2_ARG_CONV_EXCL="/DIRECTIVES;/NOLOGO" "$directives_tool" /NOLOGO /DIRECTIVES "$lib_output")"
else
  coff_directives="$("$directives_tool" --coff-directives "$output")"
fi

runtime_values="$(grep -oE 'RuntimeLibrary=[A-Za-z_]+' <<< "$coff_directives" | sort -u || true)"
if [[ "$runtime_values" != "RuntimeLibrary=MT_StaticRelease" ]]; then
  echo "package-msvc: $output has an incompatible or mixed MSVC runtime contract: ${runtime_values:-missing}" >&2
  exit 1
fi
if grep -Eiq 'DEFAULTLIB:msvcrtd?\.lib' <<< "$coff_directives"; then
  echo "package-msvc: $output still requests the dynamic MSVC runtime" >&2
  exit 1
fi
if ! grep -Eiq 'DEFAULTLIB:libcmt\.lib' <<< "$coff_directives"; then
  echo "package-msvc: $output does not request Defold's static MSVC runtime" >&2
  exit 1
fi
echo "package-msvc: wrote $output from ${#members[@]} library file(s)"
