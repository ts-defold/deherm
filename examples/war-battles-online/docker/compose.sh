#!/usr/bin/env sh
set -eu

here="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
compose_file="$here/compose.yaml"

if docker compose version >/dev/null 2>&1; then
  exec docker compose -f "$compose_file" "$@"
fi
if command -v docker-compose >/dev/null 2>&1; then
  exec docker-compose -f "$compose_file" "$@"
fi

echo "Docker Compose is required (docker compose or docker-compose)." >&2
exit 1
