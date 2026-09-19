#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=/dev/null
source "$repo_root/upstream.lock"

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
  requested=(defold hermes extender ref-doc parse-sysroot)
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
    defold | hermes | extender | ref-doc | parse-sysroot) ;;
    *)
      echo "Unknown upstream component: $candidate" >&2
      echo "Expected one or more of: defold hermes extender ref-doc parse-sysroot" >&2
      exit 2
      ;;
  esac
done

if wants defold; then checkout_revision defold "$DEFOLD_URL" "$DEFOLD_REV"; fi
if wants hermes; then checkout_revision hermes "$HERMES_URL" "$HERMES_REV"; fi
if wants extender; then checkout_revision extender "$EXTENDER_URL" "$EXTENDER_REV"; fi

if wants ref-doc; then
  ref_doc="$repo_root/upstream/ref-doc.zip"
  mkdir -p "$repo_root/upstream"
  curl -fL "$DEFOLD_REF_DOC_URL" -o "$ref_doc"
  actual_sha="$(node -e '
    const { createHash } = require("node:crypto");
    const { readFileSync } = require("node:fs");
    process.stdout.write(createHash("sha256").update(readFileSync(process.argv[1])).digest("hex"));
  ' "$ref_doc")"
  if [[ "$actual_sha" != "$DEFOLD_REF_DOC_SHA256" ]]; then
    echo "ref-doc.zip checksum mismatch: expected $DEFOLD_REF_DOC_SHA256, got $actual_sha" >&2
    exit 1
  fi
fi

# The pinned C library headers the dmSDK declaration parse resolves against.
# `scripts/import-defold-sdk.py` fetches and verifies these itself when they are
# absent, so this only front-loads the download for a machine that is being set
# up; it is the same digest either way. See
# `.agents/docs/decisions/target-directed-dmsdk-parse.md`.
if wants parse-sysroot; then
  python3 "$repo_root/scripts/import-defold-sdk.py" --sysroot-only
fi
