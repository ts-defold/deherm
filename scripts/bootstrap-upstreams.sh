#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=/dev/null
source "$repo_root/upstream.lock"
# shellcheck source=/dev/null
source "$repo_root/scripts/lib/sha256.sh"

checkout_revision() {
  local name="$1"
  local url="$2"
  local revision="$3"
  local destination="$repo_root/upstream/$name"

  mkdir -p "$destination"
  if [[ ! -d "$destination/.git" ]]; then
    git -C "$destination" init
    git -C "$destination" remote add origin "$url"
  else
    if [[ -n "$(git -C "$destination" status --porcelain)" ]]; then
      echo "Refusing to update dirty upstream checkout: $destination" >&2
      return 1
    fi
    git -C "$destination" remote set-url origin "$url"
  fi

  git -C "$destination" fetch --depth=1 origin "$revision"
  git -C "$destination" checkout --detach "$revision"
  printf '%s %s\n' "$name" "$(git -C "$destination" rev-parse HEAD)"
}

# Named components may be requested individually. A CI build lane needs only
# the Hermes tree, and cloning Defold on each of fifteen lanes costs far more
# than the build it is preparing for. With no arguments every component is
# bootstrapped, which is what a developer setting up the repository wants.
if [[ $# -gt 0 ]]; then
  requested=("$@")
else
  requested=(defold hermes extender ref-doc defold-sdk parse-sysroot)
fi

wants() {
  local name="$1"
  local candidate
  for candidate in "${requested[@]}"; do
    [[ "$candidate" == "$name" ]] && return 0
  done
  return 1
}

for candidate in "${requested[@]}"; do
  case "$candidate" in
    defold | hermes | extender | ref-doc | defold-sdk | parse-sysroot) ;;
    *)
      echo "Unknown upstream component: $candidate" >&2
      echo "Expected one or more of: defold hermes extender ref-doc defold-sdk parse-sysroot" >&2
      exit 2
      ;;
  esac
done

if wants ref-doc || wants defold-sdk; then
  deherm_require_node
fi

if wants defold; then checkout_revision defold "$DEFOLD_URL" "$DEFOLD_REV"; fi
if wants hermes; then checkout_revision hermes "$HERMES_URL" "$HERMES_REV"; fi
if wants extender; then checkout_revision extender "$EXTENDER_URL" "$EXTENDER_REV"; fi

if wants ref-doc; then
  ref_doc="$repo_root/upstream/ref-doc.zip"
  mkdir -p "$repo_root/upstream"
  curl -fL "$DEFOLD_REF_DOC_URL" -o "$ref_doc"
  actual_sha="$(deherm_sha256_file "$ref_doc")"
  if [[ "$actual_sha" != "$DEFOLD_REF_DOC_SHA256" ]]; then
    echo "ref-doc.zip checksum mismatch: expected $DEFOLD_REF_DOC_SHA256, got $actual_sha" >&2
    exit 1
  fi
fi

# Defold's published SDK is the authoritative set of headers and prebuilt
# engine archives that Extender links. The headless conformance driver needs
# the actual libraries, not only the engine source checkout. Keep the archive
# cacheable independently from its extracted revision directory and verify it
# before trusting either.
if wants defold-sdk; then
  sdk_archive="$repo_root/upstream/defoldsdk.zip"
  sdk_parent="$repo_root/upstream/extender/server/app/sdk/$DEFOLD_REV"
  sdk_root="$sdk_parent/defoldsdk"
  sdk_sentinel="$sdk_root/.deherm-sdk-sha256"
  valid_sdk_archive=false
  if [[ -f "$sdk_archive" ]]; then
    actual_sha="$(deherm_sha256_file "$sdk_archive")"
    [[ "$actual_sha" == "$DEFOLD_SDK_SHA256" ]] && valid_sdk_archive=true
  fi
  if [[ "$valid_sdk_archive" != true ]]; then
    temporary="$sdk_archive.download"
    trap 'rm -f "$temporary"' EXIT
    curl -fL --retry 3 --retry-delay 2 "$DEFOLD_SDK_URL" -o "$temporary"
    actual_sha="$(deherm_sha256_file "$temporary")"
    if [[ "$actual_sha" != "$DEFOLD_SDK_SHA256" ]]; then
      echo "defoldsdk.zip checksum mismatch: expected $DEFOLD_SDK_SHA256, got $actual_sha" >&2
      exit 1
    fi
    mv "$temporary" "$sdk_archive"
    trap - EXIT
  fi
  if [[ ! -f "$sdk_sentinel" ]] || [[ "$(cat "$sdk_sentinel")" != "$DEFOLD_SDK_SHA256" ]] ||
     [[ ! -f "$sdk_root/lib/x86_64-linux/libengine.a" ]]; then
    rm -rf "$sdk_root"
    mkdir -p "$sdk_parent"
    unzip -q "$sdk_archive" -d "$sdk_parent"
    printf '%s\n' "$DEFOLD_SDK_SHA256" > "$sdk_sentinel"
  fi
  printf 'defold-sdk %s\n' "$DEFOLD_SDK_SHA256"
fi

# The pinned C library headers the dmSDK declaration parse resolves against.
# `scripts/import-defold-sdk.py` fetches and verifies these itself when they are
# absent, so this only front-loads the download for a machine that is being set
# up; it is the same digest either way. See
# `.agents/docs/decisions/target-directed-dmsdk-parse.md`.
if wants parse-sysroot; then
  python3 "$repo_root/scripts/import-defold-sdk.py" --sysroot-only
fi
