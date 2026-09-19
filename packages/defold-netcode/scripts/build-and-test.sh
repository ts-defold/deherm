#!/usr/bin/env bash
# Builds the defold_netcode extension sources into a static library for THIS
# host, records its digest, and runs the conformance tests against it.
#
# The library is not what ships. Extender compiles the extension's `src/` from
# source for every bundle target, which is the whole reason this package vendors
# C rather than thirteen prebuilt `.a` files. This lane exists so that the build
# is proven and digest-recorded somewhere that is not a cloud service - the same
# role `toolchains/hermes/build-*.sh` plays for Hermes.
#
# Reproducibility here is OBSERVED, not asserted: run this twice and the
# recorded digest must not move. That is what `--verify` checks. It holds only
# for the same compiler on the same host; a different clang emits different
# objects, and this script records which one it used rather than pretending
# otherwise.
#
#   ./scripts/build-and-test.sh              build, test, record the digest
#   ./scripts/build-and-test.sh --verify     build, test, fail if the digest moved
#   EMSDK_ROOT=/path/to/emsdk ./scripts/build-and-test.sh   also compile for wasm
#
set -euo pipefail

package_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
extension="$package_root/extension/defold_netcode"
build="$package_root/build"
digests="$package_root/native-lib-digests.json"

verify=0
[[ "${1:-}" == "--verify" ]] && verify=1

cc="${CC:-cc}"
uname_s="$(uname -s)"
uname_m="$(uname -m)"

case "$uname_s:$uname_m" in
  Darwin:arm64)  target="arm64-osx" ;;
  Darwin:x86_64) target="x86_64-osx" ;;
  Linux:aarch64) target="arm64-linux" ;;
  Linux:x86_64)  target="x86_64-linux" ;;
  *) echo "build-and-test.sh: unsupported host $uname_s/$uname_m" >&2; exit 1 ;;
esac

echo "==> verifying vendored sources against vendor-digests.json"
node "$package_root/scripts/vendor-netcode.mjs" --check

rm -rf "$build"
mkdir -p "$build/obj"

# -ffile-prefix-map keeps the absolute build directory out of the objects, which
# is the usual reason a rebuild in a different checkout produces different bytes.
# -g0 drops debug info for the same reason. NDEBUG selects netcode's release
# build, which is what a shipped game compiles.
cflags=(-O2 -g0 -DNDEBUG -std=gnu99 -Wall -Wextra
        "-I$extension/include"
        "-ffile-prefix-map=$package_root=.")

sources=(
  "$extension/src/vendor/sodium.c"
  "$extension/src/vendor/netcode.c"
  "$extension/src/netcode_capi.c"
)

echo "==> compiling for $target with $($cc --version | head -1)"
objects=()
for source in "${sources[@]}"; do
  object="$build/obj/$(basename "${source%.c}").o"
  # The vendored sources are upstream's, not ours. -Wall -Wextra on them is
  # noise we cannot act on without forking the vendor, so they are compiled
  # without it while our own translation unit keeps both.
  if [[ "$source" == *"/vendor/"* ]]; then
    "$cc" "${cflags[@]/-Wall}" -w -c "$source" -o "$object"
  else
    "$cc" "${cflags[@]}" -c "$source" -o "$object"
  fi
  objects+=("$object")
done

library="$build/lib/$target/libdefold_netcode.a"
mkdir -p "$(dirname "$library")"

# Deterministic archive members. Without this the archiver stamps the current
# time, uid and gid into every member and the recorded digest can never hold -
# the same trap scripts/package-defold-extension.sh documents for libhermes.a.
if [[ "$uname_s" == "Darwin" ]]; then
  libtool -static -D -o "$library" "${objects[@]}" 2>/dev/null
else
  rm -f "$library"
  ar rcsD "$library" "${objects[@]}"
fi

echo "==> building tests"
"$cc" "${cflags[@]}" -c "$package_root/tests/override_loopback.c" -o "$build/obj/override_loopback.o"
# The poisoned object drops the UDP checks: creating a UDP client opens a real
# socket by design, and the poison would - correctly - abort on it.
"$cc" "${cflags[@]}" -DDEHERM_NETCODE_TEST_NO_SOCKETS -c "$package_root/tests/override_loopback.c" \
  -o "$build/obj/override_loopback_nosockets.o"
"$cc" "${cflags[@]}" -c "$package_root/tests/poison_selftest.c" -o "$build/obj/poison_selftest.o"
"$cc" "${cflags[@]}" -w -c "$package_root/tests/socket_poison.c" -o "$build/obj/socket_poison.o"

"$cc" -o "$build/override_loopback" "$build/obj/override_loopback.o" "$library"
"$cc" -o "$build/override_loopback_poisoned" "$build/obj/override_loopback_nosockets.o" "$build/obj/socket_poison.o" "$library"
"$cc" -o "$build/poison_selftest" "$build/obj/poison_selftest.o" "$build/obj/socket_poison.o" "$library"

echo
echo "==> conformance: host datagram transport"
"$build/override_loopback"

echo
echo "==> conformance: the poison can fail (expected to abort)"
if "$build/poison_selftest" >"$build/poison_selftest.log" 2>&1; then
  echo "FAIL: poison_selftest exited 0; socket() was not interposed on this host," >&2
  echo "      so the poisoned run below would prove nothing." >&2
  cat "$build/poison_selftest.log" >&2
  exit 1
fi
if ! grep -q "netcode called socket()" "$build/poison_selftest.log"; then
  echo "FAIL: poison_selftest aborted for some other reason:" >&2
  cat "$build/poison_selftest.log" >&2
  exit 1
fi
echo "  poison_selftest aborted in socket(), as required"

echo
echo "==> conformance: no socket syscall on the host datagram path"
"$build/override_loopback_poisoned"

if [[ -n "${EMSDK_ROOT:-}" ]]; then
  echo
  echo "==> compiling the same sources for wasm32-unknown-emscripten"
  emcc="$EMSDK_ROOT/upstream/emscripten/emcc"
  node_bin="$(find "$EMSDK_ROOT/node" -maxdepth 3 -name node -type f | head -1)"
  mkdir -p "$build/wasm"
  # emcc emits CommonJS, and this repository's root package.json sets
  # "type": "module", so node refuses the output as an ES module. Scoping the
  # build directory back to commonjs is local and reversible; renaming to .cjs
  # would make emcc pick a different output mode.
  printf '{ "type": "commonjs" }\n' >"$build/wasm/package.json"
  # DEHERM_NETCODE_TEST_NO_SOCKETS for the same reason the poisoned native
  # binary sets it, and here it is not a test accommodation but the target's
  # actual constraint: a browser cannot open a UDP socket, so the UDP transport
  # is not a thing this build can exercise. Emscripten's socket layer is a stub
  # that traps rather than failing a return value, so leaving the check in
  # aborts the module before it reaches anything that matters.
  "$emcc" -O2 -DNDEBUG -w -DDEHERM_NETCODE_TEST_NO_SOCKETS "-I$extension/include" \
    "$package_root/tests/override_loopback.c" "${sources[@]}" \
    -o "$build/wasm/override_loopback.js"
  echo "==> conformance: the same session under wasm"
  "$node_bin" "$build/wasm/override_loopback.js"
fi

library_sha="$(shasum -a 256 "$library" | cut -d' ' -f1)"
library_bytes="$(wc -c <"$library" | tr -d ' ')"
compiler="$($cc --version | head -1)"

recorded="$(cat <<JSON
{
  "schemaVersion": 1,
  "scope": "Digest of the host static library built from the vendored netcode sources by scripts/build-and-test.sh. This library is a build and test artefact; Extender compiles the same sources from source for every bundle target.",
  "vendorTreeSha256": $(node -e 'process.stdout.write(JSON.stringify(require(process.argv[1]).treeSha256))' "$package_root/vendor-digests.json"),
  "evidenceBoundary": {
    "compilation": "observed",
    "linkage": "observed",
    "hostDatagramRuntime": "observed",
    "udpRuntime": "not-claimed",
    "extenderCompilation": "not-claimed",
    "engineRuntime": "not-claimed"
  },
  "host": {
    "target": "$target",
    "system": "$uname_s",
    "architecture": "$uname_m",
    "compiler": "$compiler"
  },
  "library": {
    "path": "build/lib/$target/libdefold_netcode.a",
    "bytes": $library_bytes,
    "sha256": "$library_sha"
  }
}
JSON
)"

if [[ $verify -eq 1 ]]; then
  if [[ ! -f "$digests" ]]; then
    echo "FAIL: $digests does not exist; run without --verify first" >&2
    exit 1
  fi
  if ! diff -u "$digests" <(printf '%s\n' "$recorded") >/dev/null; then
    echo "FAIL: the host library digest moved." >&2
    diff -u "$digests" <(printf '%s\n' "$recorded") >&2 || true
    exit 1
  fi
  echo
  echo "==> host library digest unchanged: ${library_sha:0:16} ($library_bytes bytes)"
else
  printf '%s\n' "$recorded" >"$digests"
  echo
  echo "==> recorded host library digest: ${library_sha:0:16} ($library_bytes bytes)"
fi
