#!/usr/bin/env bash
# Package build outputs into one reproducible .tar.gz release asset.
#
#   package-archive.sh <output.tar.gz> <file> [<file> ...]
#
# ── Why an archive and not loose files ───────────────────────────────────────
#
# A target ships TWO libraries - the release archive and the debugger-enabled
# one - and a GitHub release asset is a single file. Loose assets also lose the
# executable bit, which GitHub does not store, and lose any directory structure,
# which is why the download side used to reconstruct layout by parsing flat
# names. One archive per target carries both, keeps the modes, and makes the
# published URL name a unit rather than a fragment.
#
# ── Why the flags ────────────────────────────────────────────────────────────
#
# The release tag is a fingerprint of the inputs that determine these bytes, so
# repackaging identical inputs MUST produce an identical file or the pinned
# digest can never hold. tar and gzip both default to embedding
# non-reproducible state:
#
#   --sort=name          filesystem readdir order is not stable across machines
#   --mtime              file timestamps would stamp the build time in
#   --owner/--group/     the building user would end up in the archive
#     --numeric-owner
#   --format=ustar       pax headers carry sub-second atime/ctime
#   gzip -n              gzip otherwise stores the source filename and mtime
#
# The epoch is fixed rather than taken from SOURCE_DATE_EPOCH because there is
# no source date here: the inputs are already content-addressed by the tag.
set -euo pipefail

output="$1"
shift

if [[ $# -eq 0 ]]; then
  echo "package-archive.sh: no files to package" >&2
  exit 2
fi

for file in "$@"; do
  if [[ ! -f "$file" ]]; then
    echo "package-archive.sh: $file does not exist" >&2
    exit 1
  fi
done

staging="$(mktemp -d)"
trap 'rm -rf -- "$staging"' EXIT

# Flat by basename: the archive is the unit, so nesting the build tree's
# directories inside it would leak this machine's layout into the artifact.
for file in "$@"; do
  cp "$file" "$staging/$(basename "$file")"
done

mkdir -p "$(dirname "$output")"

# GNU tar and bsdtar spell the reproducibility flags differently. bsdtar (macOS,
# and Windows since 10) has no --sort or --owner, so entries are fed in sorted
# order and ownership is cleared with --uid/--gid instead.
if tar --version 2>/dev/null | grep -q "GNU tar"; then
  tar --sort=name \
      --mtime="@0" \
      --owner=0 --group=0 --numeric-owner \
      --format=ustar \
      -cf - -C "$staging" $(cd "$staging" && ls | sort) \
    | gzip -n -9 > "$output"
else
  tar --uid 0 --gid 0 \
      --numeric-owner \
      --format ustar \
      -cf - -C "$staging" $(cd "$staging" && ls | sort) \
    | gzip -n -9 > "$output"
fi

echo "package-archive.sh: wrote $output from $# file(s)"
