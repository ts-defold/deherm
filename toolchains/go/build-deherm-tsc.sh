#!/usr/bin/env bash
# Cross-compile deherm-tsc, déherm's TypeScript transform compiler.
#
# One job builds every host. The program is pure Go - CGO_ENABLED=0 links it
# with no C toolchain on any of the five hosts - so `GOOS`/`GOARCH` is the whole
# of cross-compilation here. That is why this is the cheapest artifact déherm
# ships: libhermes.a needs a container or an Apple SDK per target, and hermesc
# and shermes must be built on a runner of their own architecture because they
# are LLVM. This one needs a single runner and about a minute per host.
#
# Usage:
#   toolchains/go/build-deherm-tsc.sh <host key> <output bin directory>
#
#   <host key>  darwin-arm64 | darwin-x64 | linux-x64 | linux-arm64 | win32-x64
#
# Determinism is the point of the flag set, not a nicety: the digest recorded in
# packages/toolchains/host-compilers.json is only meaningful if the same inputs
# produce the same bytes.
#
#   -trimpath         strips the absolute build directory out of the binary
#   -buildvcs=false   keeps the checkout's git state out of it
#   -buildid=         removes the content-derived build id, which otherwise
#                     varies with the scratch path
#   -s -w             drops the symbol and DWARF tables, which carry paths
#   GOAMD64 / GOARM64 pinned to the baseline, so a runner that exports a
#                     microarchitecture level cannot silently produce a
#                     different binary from the same source
#
# The ttsc Go module is not vendored into this repository. It arrives with the
# npm package, pinned by pnpm-lock.yaml, and carries typescript-go with it under
# shim/. This script resolves it from node_modules rather than re-pinning it, so
# there is exactly one place the compiler's provenance is stated.
set -euo pipefail

host_key="${1:?usage: build-deherm-tsc.sh <host key> <output bin directory>}"
output_dir="${2:?usage: build-deherm-tsc.sh <host key> <output bin directory>}"

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
module_dir="${DEHERM_COMPILER_MODULE:-$repo_root/packages/compiler}"
ttsc_dir="${DEHERM_TTSC_PACKAGE:-$repo_root/node_modules/ttsc}"

case "$host_key" in
  darwin-arm64) goos=darwin;  goarch=arm64; suffix="" ;;
  darwin-x64)   goos=darwin;  goarch=amd64; suffix="" ;;
  linux-x64)    goos=linux;   goarch=amd64; suffix="" ;;
  linux-arm64)  goos=linux;   goarch=arm64; suffix="" ;;
  win32-x64)    goos=windows; goarch=amd64; suffix=".exe" ;;
  *)
    echo "build-deherm-tsc.sh: unknown host key '$host_key'" >&2
    echo "  expected one of: darwin-arm64 darwin-x64 linux-x64 linux-arm64 win32-x64" >&2
    exit 2
    ;;
esac

if [ ! -f "$ttsc_dir/go.mod" ]; then
  echo "build-deherm-tsc.sh: the ttsc Go module is not present at $ttsc_dir" >&2
  echo "  run: pnpm install --frozen-lockfile" >&2
  exit 1
fi

ttsc_version="$(node -e 'process.stdout.write(require(process.argv[1] + "/package.json").version)' "$ttsc_dir")"
deherm_version="$(node -e 'process.stdout.write(require(process.argv[1] + "/package.json").version)' "$repo_root")"

work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT
go_work="$work_dir/go.work"

# ttsc wires typescript-go's shim modules through a workspace rather than
# published versions (every `require` in its go.mod is v0.0.0 with a local
# replace). Reproduce that workspace here: the alternative is re-pinning
# typescript-go in this repository, which would be a second source of truth for
# the compiler our transforms are written against.
{
  echo "go 1.26"
  echo
  echo "use ("
  printf '\t%s\n' "$module_dir"
  printf '\t%s\n' "$ttsc_dir"
  find "$ttsc_dir/shim" -name go.mod -print0 \
    | xargs -0 -n1 dirname \
    | LC_ALL=C sort \
    | while read -r shim; do printf '\t%s\n' "$shim"; done
  echo ")"
  echo
  echo "replace github.com/samchon/ttsc/packages/ttsc v0.0.0 => $ttsc_dir"
} > "$go_work"

# `go build -C` resolves -o after changing directory, so the output path
# must be absolute before the build starts.
mkdir -p "$output_dir"
output_dir="$(cd "$output_dir" && pwd)"
binary="$output_dir/deherm-tsc$suffix"

echo "build-deherm-tsc.sh: $host_key ($goos/$goarch) from ttsc $ttsc_version"

env \
  GOWORK="$go_work" \
  GOOS="$goos" \
  GOARCH="$goarch" \
  GOAMD64=v1 \
  GOARM64=v8.0 \
  GOEXPERIMENT= \
  CGO_ENABLED=0 \
  go build \
    -C "$module_dir" \
    -trimpath \
    -buildvcs=false \
    -ldflags "-s -w -buildid= -X main.dehermVersion=$deherm_version -X main.ttscVersion=$ttsc_version -X main.hostKey=$host_key" \
    -o "$binary" \
    ./ttsc/cmd/deherm-tsc

chmod 0755 "$binary"
echo "build-deherm-tsc.sh: wrote $binary ($(wc -c < "$binary" | tr -d ' ') bytes)"
