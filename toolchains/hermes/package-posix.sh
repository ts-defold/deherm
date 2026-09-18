#!/usr/bin/env bash
set -euo pipefail

build_root="$1"
output="$2"
temporary="$(mktemp -d)"
trap 'rm -rf -- "$temporary"' EXIT
mkdir -p "$(dirname "$output")"
cp "$build_root/lib/libhermesvm_a.a" "$temporary/hermes.a"
if ar -t "$temporary/hermes.a" | grep -q '^zip\.c\.o$'; then
  ar -d "$temporary/hermes.a" zip.c.o
fi
cat >"$temporary/archive.mri" <<EOF
CREATE $output
ADDLIB $temporary/hermes.a
ADDLIB $build_root/jsi/libjsi.a
ADDLIB $build_root/external/boost/boost_1_86_0/libs/context/libboost_context.a
SAVE
END
EOF
ar -M <"$temporary/archive.mri"
