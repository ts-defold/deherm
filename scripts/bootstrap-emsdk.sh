#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=/dev/null
source "$repo_root/upstream.lock"

destination="$repo_root/upstream/extender/platformsdk/emsdk-$EMSDK_VERSION"

if [[ ! -d "$destination/.git" ]]; then
  mkdir -p "$destination"
  git -C "$destination" init
  git -C "$destination" remote add origin "$EMSDK_URL"
fi

actual_revision="$(git -C "$destination" rev-parse HEAD 2>/dev/null || true)"
if [[ "$actual_revision" != "$EMSDK_REV" ]]; then
  if [[ -n "$(git -C "$destination" status --porcelain --untracked-files=no)" ]]; then
    echo "Refusing to replace a modified Emscripten checkout at $destination" >&2
    exit 1
  fi
  git -C "$destination" remote set-url origin "$EMSDK_URL"
  git -C "$destination" fetch --depth=1 origin "$EMSDK_REV"
  git -C "$destination" checkout --detach "$EMSDK_REV"
fi

node_path="$(find "$destination/node" -type f -path '*/bin/node' -perm -111 -print -quit 2>/dev/null || true)"
python_path="$(find -L "$destination/python" -type f -path '*/bin/python3' -perm -111 -print -quit 2>/dev/null || true)"
if [[ ! -x "$destination/upstream/emscripten/emcc" || -z "$node_path" || -z "$python_path" ]] || \
   ! "$destination/upstream/emscripten/emcc" --version 2>/dev/null | head -1 | grep -q "$EMSDK_VERSION"; then
  "$destination/emsdk" install "$EMSDK_VERSION"
  "$destination/emsdk" activate "$EMSDK_VERSION"
fi

echo "Emscripten $EMSDK_VERSION is ready at $destination."
