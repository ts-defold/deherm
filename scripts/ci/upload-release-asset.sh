#!/usr/bin/env bash
# Upload one asset to a release under a chosen name, retrying transient failures.
#
# ── Why the file is staged rather than uploaded in place ─────────────────────
#
# `gh release upload <file>#<text>` does NOT name the asset; the `#` suffix sets
# a display LABEL, and the asset name is always the file's basename. Every lane
# here relied on it to disambiguate, so all five host lanes uploaded one asset
# named after the tool's own basename and all ten target lanes would have uploaded
# `libhermes.a`. With `--clobber` that is not a collision that fails loudly - the
# lanes delete and overwrite each other, and the release ends up holding one
# arbitrary survivor per basename. The first run left two assets of fifteen
# behind, which is exactly this.
#
# It is also the real cause of the 404 that looked like flakiness: five jobs
# racing delete-then-upload against ONE asset name, not a busy endpoint. The
# retry below is still worth having, but it was treating a symptom.
#
# So the file is copied to a staging directory under the name it must carry, and
# that copy is uploaded. The download side already expects these flat names -
# `manage-native-artifacts.mjs pull` parses `hermes-<target>-<library>` - so this
# restores the contract the rest of the tooling was already written against.
#
# Usage: upload-release-asset.sh <tag> <repo> <file> <asset-name>
set -euo pipefail

tag="$1"
repo="$2"
file="$3"
asset_name="$4"

if [[ ! -f "$file" ]]; then
  echo "upload-release-asset: $file does not exist" >&2
  exit 1
fi

staging="$(mktemp -d)"
trap 'rm -rf "$staging"' EXIT
staged="$staging/$asset_name"
cp "$file" "$staged"

attempts=5
delay=5

for attempt in $(seq 1 "$attempts"); do
  if gh release upload "$tag" "$staged" --repo "$repo" --clobber; then
    exit 0
  fi

  if [[ "$attempt" -eq "$attempts" ]]; then
    echo "Upload of $asset_name failed after $attempts attempts." >&2
    exit 1
  fi

  echo "Upload of $asset_name failed (attempt $attempt/$attempts); retrying in ${delay}s." >&2
  sleep "$delay"
  delay=$((delay * 2))
done
