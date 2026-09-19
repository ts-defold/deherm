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

# Create the release on first use rather than ahead of the build lanes.
#
# A dedicated `releases` job used to create both releases before anything was
# built, so every failed run stranded an empty release under a tag that then
# looked published - and the plan job's completeness check kept it alive
# forever. Creating it here means no successful upload, no release.
#
# The lanes race each other to this, which is fine: the create is attempted,
# and a failure because it already exists is indistinguishable from success for
# our purposes, so the result is only checked by asking again.
ensure_release() {
  if gh release view "$tag" --repo "$repo" >/dev/null 2>&1; then
    return 0
  fi
  gh release create "$tag" \
    --repo "$repo" \
    --title "$tag" \
    --notes "Content-addressed build artifacts. The tag is the SHA-256 fingerprint of the inputs that determine these bytes - the pinned upstream revisions AND the build recipe, because the recipe changes the output - so many deherm versions share one release and a rebuild with unchanged inputs is a no-op. Vendor with \`node scripts/manage-native-artifacts.mjs pull\` or \`node scripts/manage-host-compilers.mjs pull\`, which resolve assets by URL and need no gh." \
    --prerelease >/dev/null 2>&1 || true
  gh release view "$tag" --repo "$repo" >/dev/null 2>&1
}

if ! ensure_release; then
  echo "Could not create or find release $tag" >&2
  exit 1
fi

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
