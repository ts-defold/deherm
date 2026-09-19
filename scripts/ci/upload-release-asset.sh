#!/usr/bin/env bash
# Upload one asset to a release, retrying transient remote failures.
#
# Every build lane in the native-artifacts workflow uploads to the same release
# concurrently. GitHub's asset endpoint intermittently answers a concurrent
# write with 404 or 5xx even though the release exists - the first run of this
# workflow saw exactly one of five otherwise identical matrix lanes fail that
# way, on a name no other lane writes. Retrying is the correct response to a
# transient remote condition; the alternative, serialising the lanes, would
# trade the whole point of the matrix for it.
#
# Usage: upload-release-asset.sh <tag> <repo> <file> <asset-name>
set -euo pipefail

tag="$1"
repo="$2"
file="$3"
asset_name="$4"

attempts=5
delay=5

for attempt in $(seq 1 "$attempts"); do
  if gh release upload "$tag" "$file#$asset_name" --repo "$repo" --clobber; then
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
