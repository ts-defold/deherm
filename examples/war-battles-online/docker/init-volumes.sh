#!/usr/bin/env sh
set -eu

# Named volumes are created as root-owned directories by Docker. This bounded
# one-shot migrator is the only runtime container that needs uid 0; the game
# server itself always runs as the fixed unprivileged uid/gid below.
install -d -m 0700 -o 10001 -g 10001 \
  /srv/war-battles-online/server/certs \
  /srv/war-battles-online/server/state
chmod 0700 \
  /srv/war-battles-online/server/certs \
  /srv/war-battles-online/server/state

# The service owns a fixed file set. Name every member instead of recursively
# walking an operator-controlled volume; interrupted durable writes may leave
# only the bounded `.tmp` siblings.
for path in \
  /srv/war-battles-online/server/certs/localhost.crt \
  /srv/war-battles-online/server/certs/localhost.key \
  /srv/war-battles-online/server/certs/fingerprint.txt \
  /srv/war-battles-online/server/state/resume-key.hex \
  /srv/war-battles-online/server/state/sessions.bin \
  /srv/war-battles-online/server/state/sessions.bin.tmp \
  /srv/war-battles-online/server/state/world.bin \
  /srv/war-battles-online/server/state/world.bin.tmp
do
  if [ -L "$path" ]; then
    echo "refusing symbolic link in War Battles volume: $path" >&2
    exit 1
  fi
  if [ -e "$path" ]; then
    chown 10001:10001 "$path"
    case "$path" in
      *.key|*.hex|*.bin|*.tmp) chmod 0600 "$path" ;;
      *) chmod 0644 "$path" ;;
    esac
  fi
done
