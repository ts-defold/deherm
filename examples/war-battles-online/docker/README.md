# Local self-hosted server

From `examples/war-battles-online`, start the Deno WebTransport server with a
stable local certificate and a readiness check:

```sh
pnpm docker:up
curl http://127.0.0.1:8080/readyz
```

The service publishes UDP `4433` for HTTP/3/WebTransport and binds TCP `8080`
to host loopback only for `/healthz`, `/readyz`, and the `/ws` reliable fallback.
The named certificate volume is reused on restart so Chrome's pinned certificate
hash remains valid. A separate named state volume owns a generated 256-bit resume
key and the fixed-capacity authenticated session ledger, so browser sessions can
resume their player identity after a container restart. It will
fail closed when that certificate expires instead of silently invalidating the
client pin. Rotate it deliberately and update every configured SHA-256 together:

```sh
WAR_BATTLES_ROTATE_CERT=1 ./docker/compose.sh up -d --build
```

For a clean stop use `pnpm docker:down`. The local multiplayer acceptance can
run against this service after it is healthy with:

```sh
pnpm runtime:multiplayer -- --external \
  --quic-port 4433 --health-port 8080
```

That acceptance requires a container backend which actually forwards published
UDP ports. Colima's default macOS user-mode network exposes the TCP health port
but does not carry this QUIC path; use Colima's network-address mode, another
UDP-capable backend, or run `pnpm runtime:multiplayer` against the host Deno
server. A passing `/readyz` is process/readiness evidence, not proof that UDP
ingress works.

The TCP fallback can still be exercised when a local container backend cannot
forward QUIC/UDP. It is labelled `websocket-tcp`, carries inputs on the reliable
fallback lane, and is not evidence for WebTransport or datagrams.

The owner check is deterministic and does not require a running daemon:
`node --test test/docker-durability.test.mjs` validates the rendered Compose
mounts, readiness wiring, restart policy, and resume-key lifecycle. The
end-to-end `pnpm runtime:websocket` gate separately exercises the Deno TCP
fallback with a real browser; `pnpm runtime:websocket:docker` runs the same
browser gate against the Compose service's published TCP port, restarts the
container, and verifies that the authenticated slot resumes from the persisted
ledger.

This is a development deployment. Production still needs a trusted certificate,
origin/authentication checks, bounded admission and queues, and an ingress that
preserves HTTP/3 UDP.
