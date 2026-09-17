#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
action="${1:-build}"
log_file="$repo_root/build/extender-local.log"
extender_pid=""

cleanup() {
  if [[ -n "$extender_pid" ]] && kill -0 "$extender_pid" 2>/dev/null; then
    kill "$extender_pid" 2>/dev/null || true
    wait "$extender_pid" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

if ! curl --silent --fail --max-time 1 http://localhost:9010/actuator/health >/dev/null; then
  mkdir -p "$(dirname "$log_file")"
  "$repo_root/scripts/extender-local.sh" foreground >"$log_file" 2>&1 &
  extender_pid=$!
  for _ in {1..60}; do
    if curl --silent --fail --max-time 1 http://localhost:9010/actuator/health >/dev/null; then
      break
    fi
    if ! kill -0 "$extender_pid" 2>/dev/null; then
      echo "Local Extender exited during startup; inspect $log_file" >&2
      exit 1
    fi
    sleep 1
  done
fi

if ! curl --silent --fail --max-time 2 http://localhost:9010/actuator/health >/dev/null; then
  echo "Local Extender did not become healthy; inspect $log_file" >&2
  exit 1
fi

DEFOLD_HERMES_BUILD_SERVER=http://localhost:9010 "$repo_root/scripts/bob.sh" "$action"
