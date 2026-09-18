# Colyseus H3 local browser gate

This is an isolated self-hosted Colyseus `H3Transport` experiment. It is not a
WebSocket setup: Compose publishes the same port over TCP for HTTPS matchmaking
and over UDP for HTTP/3/WebTransport.

Run it from this directory:

```sh
docker compose up --build
```

Then open `http://localhost:8080` and press **Run H3 probe**. The local HTTP
helper proxies only the matchmaking POST inside the container, so the browser
does not need to bypass a certificate warning. The returned seat reservation
contains the development certificate fingerprint used by browser WebTransport.
A pass requires all three statements:

1. the SDK-selected connection is `H3TransportTransport` backed by a browser
   `WebTransport` object;
2. a reliable Colyseus message round-trips; and
3. at least one of eight `sendUnreliable()` calls reaches the room through a
   QUIC datagram and is acknowledged on the reliable lane.

The image pins the server, H3 transport, and JS/TS client to `0.18.2`. At each
start it generates a ten-day P-256 ECDSA certificate with an explicit
`localhost` SAN, then
the local proxy adds its SHA-256 fingerprint to the reservation and the H3 SDK
supplies it through `serverCertificateHashes`. This is for local probing only.
Production must use a trusted certificate (and no HTTP bootstrap proxy), expose
UDP through every firewall/load balancer, bound
sessions/streams/queues/rates, and test renewal and multi-node routing.

The pinned server still registers only `sessionStream("/")`, but the current
`0.18.2` SDK now reduces the room endpoint to `url.origin` before connecting, so
the historical room-path half of issue #946 is not reproduced by current SDK
source. Its first container run nevertheless failed with `Opening handshake
failed` while using the package-generated certificate for bind host `0.0.0.0`;
that ambiguous certificate identity is why this setup supplies the explicit
localhost SAN certificate instead of claiming the old path bug persisted.

This loopback check is necessary but not sufficient. Before treating the
backend as production-ready, repeat it through the intended ingress and a WAN
impairment proxy, verify fragmented reliable frames and room-path routing, and
soak 32 bot clients under loss/reorder/MTU pressure. The Colyseus documentation
still labels H3 experimental and not battle tested. The official H3 client is
currently JS/TS-only; official Defold uses WebSocket and cannot run this probe.

## Observed result on 2026-09-18

The arm64 image builds and starts both the HTTPS/TCP and HTTP/3/UDP listeners;
the HTTP health and matchmaking endpoints respond and reservations contain the
expected 32-byte certificate fingerprint. The current real-browser gate still
fails at `WebTransport.ready` with `Opening handshake failed` in both Chrome and
the Codex in-app Chromium browser, including with the explicit short-lived
P-256 localhost certificate. No reliable stream or datagram exchange was
observed, so this setup is presently a reproducible failing interop test—not
evidence of a working QUIC gameplay deployment. Docker Desktop/Colima UDP
forwarding, the Node quiche backend, and browser/server HTTP/3 interop remain the
next isolation points. The pinned image build also reported 14 low and 3
moderate npm audit findings; dependency review/remediation is required before a
production image. On arm64 the quiche native prebuild requires glibc 2.38+, so
the Dockerfile uses Debian Trixie rather than Bookworm.
