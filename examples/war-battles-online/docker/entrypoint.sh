#!/usr/bin/env sh
set -eu

# The cert volume is intentionally separate from the image. make-cert.sh is
# idempotent, so a restart retains the certificate hash that Chrome pinned;
# set WAR_BATTLES_ROTATE_CERT=1 when a local operator explicitly wants a new
# ten-day certificate.
if [ "${WAR_BATTLES_ROTATE_CERT:-0}" = "1" ]; then
  ./server/make-cert.sh --force
else
  ./server/make-cert.sh
fi

exec deno run --unstable-net --allow-net --allow-read --allow-write ./server/deno-main.ts \
  --hostname "${WAR_BATTLES_HOSTNAME}" \
  --port "${WAR_BATTLES_PORT}" \
  --health-port "${WAR_BATTLES_HEALTH_PORT}" \
  --cert ./server/certs/localhost.crt \
  --key ./server/certs/localhost.key \
  --roster "${WAR_BATTLES_ROSTER}" \
  --bot-skill "${WAR_BATTLES_BOT_SKILL}" \
  ${WAR_BATTLES_EXTRA_ARGS:-}
