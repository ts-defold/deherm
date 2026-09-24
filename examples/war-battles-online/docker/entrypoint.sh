#!/usr/bin/env sh
set -eu

# Resume credentials and the session ledger are deployment-private state.
# Keep the parent process umask restrictive so Deno creates the temporary
# ledger as 0600 before the atomic rename.
umask 077

# The cert volume is intentionally separate from the image. make-cert.sh is
# idempotent, so a restart retains the certificate hash that Chrome pinned;
# set WAR_BATTLES_ROTATE_CERT=1 when a local operator explicitly wants a new
# ten-day certificate.
if [ "${WAR_BATTLES_ROTATE_CERT:-0}" = "1" ]; then
  ./server/make-cert.sh --force
else
  ./server/make-cert.sh
fi

./server/ensure-resume-key.sh ./server/state

exec deno run --unstable-net --allow-net --allow-env --allow-read --allow-write ./server/deno-main.ts \
  --hostname "${WAR_BATTLES_HOSTNAME}" \
  --port "${WAR_BATTLES_PORT}" \
  --health-port "${WAR_BATTLES_HEALTH_PORT}" \
  --cert ./server/certs/localhost.crt \
  --key ./server/certs/localhost.key \
  --resume-key-file ./server/state/resume-key.hex \
  --session-state ./server/state/sessions.bin \
  --roster "${WAR_BATTLES_ROSTER}" \
  --bot-skill "${WAR_BATTLES_BOT_SKILL}" \
  ${WAR_BATTLES_EXTRA_ARGS:-}
