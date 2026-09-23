#!/usr/bin/env bash
# Produces the short-lived ECDSA P-256 certificate a browser will accept by
# SHA-256 hash, which is the only way to run WebTransport against localhost
# without a real CA.
#
#   ./server/make-cert.sh              # writes server/certs/localhost.{crt,key}
#   ./server/make-cert.sh 127.0.0.1    # add another SAN
#
# The constraints are not arbitrary: Chrome accepts a certificate supplied
# through `serverCertificateHashes` only when it is ECDSA over P-256 and valid
# for at most 14 days. Ten days leaves room for clock skew.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
out="$here/certs"
mkdir -p "$out"

force=0
if [[ "${1:-}" == "--force" ]]; then
  force=1
  shift
fi

extra_san=""
for host in "$@"; do
  case "$host" in
    *[0-9].[0-9]*) extra_san="$extra_san,IP:$host" ;;
    *) extra_san="$extra_san,DNS:$host" ;;
  esac
done

# Keep the local certificate stable across restarts. This matters for Chrome's
# WebTransport certificate pin: a browser can cache the advertised hash while
# a container is restarted. Pass --force when rotating intentionally. The
# generated certificate is ten days long. Never rotate it implicitly: clients
# pin its digest, so certificate and configured pin must change atomically.
if (( force == 0 )) && [[ -s "$out/localhost.crt" && -s "$out/localhost.key" ]] \
  && openssl x509 -in "$out/localhost.crt" -checkend 0 -checkhost localhost -noout >/dev/null 2>&1 \
  && openssl x509 -in "$out/localhost.crt" -text -noout 2>/dev/null | grep -q "Public-Key: (256 bit)"; then
  digest="$(openssl x509 -in "$out/localhost.crt" -outform der | openssl dgst -sha256 -binary | xxd -p -c 64)"
  printf '%s\n' "$digest" > "$out/fingerprint.txt"
  echo "reusing $out/localhost.crt and $out/localhost.key (currently valid)"
  echo "certificate SHA-256: $digest"
  exit 0
fi

if (( force == 0 )) && [[ -e "$out/localhost.crt" || -e "$out/localhost.key" ]]; then
  echo "existing local certificate is incomplete, invalid, or expired; rotate it explicitly with --force and update every pinned SHA-256" >&2
  exit 1
fi

openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 \
  -keyout "$out/localhost.key" -out "$out/localhost.crt" \
  -days 10 -nodes -subj "/CN=localhost" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1$extra_san" \
  -addext "basicConstraints=critical,CA:FALSE" \
  -addext "keyUsage=critical,digitalSignature" \
  -addext "extendedKeyUsage=serverAuth" 2>/dev/null

digest="$(openssl x509 -in "$out/localhost.crt" -outform der | openssl dgst -sha256 -binary | xxd -p -c 64)"
printf '%s\n' "$digest" > "$out/fingerprint.txt"

echo "wrote $out/localhost.crt and $out/localhost.key (valid 10 days)"
echo "certificate SHA-256: $digest"
echo
echo "Chrome, for a client that does not pass the hash itself:"
echo "  --origin-to-force-quic-on=localhost:4433 \\"
echo "  --ignore-certificate-errors-spki-list=\$(openssl x509 -in $out/localhost.crt -pubkey -noout \\"
echo "    | openssl pkey -pubin -outform der | openssl dgst -sha256 -binary | openssl enc -base64)"
