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

checkout_revision defold "$DEFOLD_URL" "$DEFOLD_REV"
checkout_revision hermes "$HERMES_URL" "$HERMES_REV"

ref_doc="$repo_root/upstream/ref-doc.zip"
curl -fL "$DEFOLD_REF_DOC_URL" -o "$ref_doc"
printf '%s  %s\n' "$DEFOLD_REF_DOC_SHA256" "$ref_doc" | shasum -a 256 -c -
