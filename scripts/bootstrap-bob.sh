#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=/dev/null
source "$repo_root/upstream.lock"

bob_dir="$repo_root/build/tooling"
bob_jar="$bob_dir/bob.jar"
mkdir -p "$bob_dir"

valid_bob=false
if [[ -f "$bob_jar" ]]; then
  actual_sha="$(shasum -a 256 "$bob_jar" | awk '{print $1}')"
  if [[ "$actual_sha" == "$DEFOLD_BOB_SHA256" ]]; then
    valid_bob=true
  else
    echo "Pinned Bob checksum changed; replacing $bob_jar" >&2
  fi
fi

if [[ "$valid_bob" != true ]]; then
  temporary="$bob_jar.download"
  trap 'rm -f "$temporary"' EXIT
  curl -fL --retry 3 --retry-delay 2 "$DEFOLD_BOB_URL" -o "$temporary"
  printf '%s  %s\n' "$DEFOLD_BOB_SHA256" "$temporary" | shasum -a 256 -c -
  mv "$temporary" "$bob_jar"
  trap - EXIT
fi

java_bin="${JAVA_HOME:+$JAVA_HOME/bin/java}"
if [[ -z "$java_bin" || ! -x "$java_bin" ]]; then
  java_bin="/opt/homebrew/opt/openjdk@25/bin/java"
fi
if [[ ! -x "$java_bin" ]]; then
  echo "JDK 25 is required. Set JAVA_HOME or install Homebrew openjdk@25." >&2
  exit 1
fi

version="$($java_bin -jar "$bob_jar" --version)"
if [[ "$version" != *"sha1: $DEFOLD_REV"* ]]; then
  echo "Bob does not match pinned Defold revision $DEFOLD_REV:" >&2
  echo "$version" >&2
  exit 1
fi
echo "$version"
