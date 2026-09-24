#!/usr/bin/env sh
set -eu

state_dir=${1:?state directory is required}
key_path="$state_dir/resume-key.hex"

# The key is deployment state, not image state. Keep the directory and file
# private even when the named volume was created by an earlier container.
umask 077
mkdir -p "$state_dir"
chmod 700 "$state_dir"

if [ ! -e "$key_path" ]; then
  openssl rand -hex 32 > "$key_path"
else
  if [ ! -f "$key_path" ] || ! awk 'NR == 1 && $0 ~ /^[[:xdigit:]]{64}$/ { valid = 1 } END { exit !(NR == 1 && valid == 1) }' "$key_path"; then
    echo "resume key must be one line of exactly 64 hexadecimal characters: $key_path" >&2
    exit 1
  fi
fi

chmod 600 "$key_path"
