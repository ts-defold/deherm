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
# that copy is uploaded. That name comes from
# `scripts/lib/artifact-releases.mjs`, which is the same listing the download
# side requests and the CI completeness check compares against; it is also the
# last path segment of the download URL, so it is load-bearing rather than
# cosmetic. Renaming here is free: the archive's BYTES are fixed by
# package-archive.sh, and a copy under a different name is the same file.
#
# ── Why the title and notes are passed in ────────────────────────────────────
#
# The release used to be created with `--title "$tag"`, which made the title a
# restatement of the tag: a release list where every row reads
# `native-artifacts-<digest>` is a list of digests. The human title and the
# release notes are derived once, with the tag, in
# scripts/lib/artifact-releases.mjs, and the plan job passes them here - so
# there is no second place that decides what a release is called.
#
# RELEASE_FINGERPRINT is the FULL 64-hex digest. The tag carries a 16-hex
# prefix of it so it can be read and quoted; the notes carry all of it, because
# that is where provenance is asserted.
#
# Usage: upload-release-asset.sh <tag> <repo> <file> <asset-name>
#   env: RELEASE_TITLE, RELEASE_FINGERPRINT, RELEASE_NOTES, RELEASE_TARGET
set -euo pipefail

tag="$1"
repo="$2"
file="$3"
asset_name="$4"

release_title="${RELEASE_TITLE:?RELEASE_TITLE is required; the plan job derives it with the tag}"
release_fingerprint="${RELEASE_FINGERPRINT:?RELEASE_FINGERPRINT is required; it is the full digest the tag truncates}"
release_notes="${RELEASE_NOTES:-Input fingerprint (SHA-256): \`${release_fingerprint}\`}"
release_target="${RELEASE_TARGET:-}"

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
  local target_args=()
  if [[ -n "$release_target" ]]; then
    target_args=(--target "$release_target")
  fi
  gh release create "$tag" \
    --repo "$repo" \
    --title "$release_title" \
    --notes "$release_notes" \
    "${target_args[@]}" \
    --prerelease >/dev/null 2>&1 || true
  gh release view "$tag" --repo "$repo" >/dev/null 2>&1
}

if ! ensure_release; then
  echo "Could not create or find release $tag" >&2
  exit 1
fi

# The plan normally filters this row out before a runner is allocated. Check
# again at the mutation boundary: a manually dispatched run or an external
# publisher may have filled the row after planning, and immutable
# content-addressed assets must never be overwritten in either case.
asset_exists() {
  gh release view "$tag" --repo "$repo" --json assets \
    --jq ".assets[] | select(.name == \"$asset_name\") | .name" 2>/dev/null \
    | grep -Fxq "$asset_name"
}

verify_existing_asset() {
  if [[ "${VERIFY_EXISTING_ASSET:-0}" != "1" ]]; then
    return 0
  fi
  local existing_dir="$staging/existing"
  mkdir -p "$existing_dir"
  gh release download "$tag" --repo "$repo" --pattern "$asset_name" --dir "$existing_dir"
  if cmp --silent "$staged" "$existing_dir/$asset_name"; then
    echo "$tag already carries byte-identical immutable $asset_name"
    return 0
  fi
  local local_sha published_sha
  local_sha="$(sha256sum "$staged" | awk '{print $1}')"
  published_sha="$(sha256sum "$existing_dir/$asset_name" | awk '{print $1}')"
  echo "$tag already carries corrupt/foreign immutable $asset_name" >&2
  echo "local SHA-256:     $local_sha" >&2
  echo "published SHA-256: $published_sha" >&2
  echo "The asset will not be overwritten. Quarantine/delete the bad release asset or rotate a real fingerprint input before publishing." >&2
  return 1
}

if asset_exists; then
  verify_existing_asset
  echo "$tag already carries $asset_name; fingerprinted row is current, skipping upload"
  exit 0
fi

for attempt in $(seq 1 "$attempts"); do
  if gh release upload "$tag" "$staged" --repo "$repo"; then
    exit 0
  fi

  # If another publisher won the exact-name race, its immutable asset is now
  # authoritative. Do not delete and replace it with --clobber.
  if asset_exists; then
    verify_existing_asset
    echo "$tag acquired byte-identical $asset_name while this upload was in flight; keeping the published asset"
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
