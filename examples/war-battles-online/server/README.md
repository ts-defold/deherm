# Running a server, and putting two clients in one match

The server is `deno-main.ts`: Deno's unstable QUIC endpoint terminates HTTP/3,
each accepted WebTransport session is adopted through the same `GameTransport`
boundary the unit tests use, and one `MatchServer` runs the authoritative
simulation at 60 Hz. Bots fill every slot no human has taken, so a match is
never empty and never changes size mid-round: a joining player takes a bot's
slot over exactly as it stands, score and ammunition included.

Nothing in `core/match-server.ts` is Deno-specific. Swapping this for a Quinn or
Colyseus host is a different twenty lines at the top and no change below them.

## 1. A certificate a browser will accept

WebTransport will not open a session to an untrusted certificate. For localhost
the practical route is Chrome's `serverCertificateHashes`, which requires an
ECDSA P-256 certificate valid for at most 14 days:

```sh
cd examples/war-battles-online
./server/make-cert.sh
```

That writes `server/certs/localhost.{crt,key}` (git-ignored) and prints the
certificate's SHA-256. In production you want an ordinary trusted certificate, a
real hostname, an exposed UDP port, and origin and authentication checks — none
of which this example performs.

## 2. Start the server

```sh
deno run --unstable-net --allow-net --allow-read \
  server/deno-main.ts --port 4433 --roster 8 --bot-skill 2
```

or, from this package, `pnpm serve`.

| Flag | Meaning |
| --- | --- |
| `--hostname`, `--port` | QUIC bind address; default `0.0.0.0:4433` |
| `--cert`, `--key` | PEM paths; default `server/certs/localhost.{crt,key}` |
| `--roster` | Total tanks, humans plus bots. Default 8, maximum 32 |
| `--bot-skill` | 0 recruit, 1 regular, 2 veteran, 3 nightmare |
| `--snapshot-interval` | Ticks between authoritative snapshots; 3 is 20 Hz |
| `--teams` | Two teams instead of a free-for-all |

It prints its listening address, the certificate digest and the roster, then one
line per session join and leave.

## 3. Point the game at it

Add the server to `defold/game.project`:

```ini
[war_battles]
server = https://localhost:4433/war-battles
```

Then bundle for `wasm-web` and open the bundle in a browser — see
[`../defold/README.md`](../defold/README.md) for the Bob invocation. The arena
logs `war-battles:arena-online-dialing:<url>`, then `war-battles:net:client-welcome:…`
with the player id, the server tick and the arena seed it is going to rebuild.

Chrome needs to be told to trust the certificate. Either launch it with the
public-key hash the cert script prints:

```sh
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --user-data-dir=/tmp/war-battles-profile \
  --ignore-certificate-errors-spki-list="$(openssl x509 -in server/certs/localhost.crt -pubkey -noout \
     | openssl pkey -pubin -outform der | openssl dgst -sha256 -binary | openssl enc -base64)"
```

…or install the certificate in the system trust store.

**Two clients:** open the bundle in two browser windows, or two separate Chrome
profiles. Each gets its own `WebTransport` session, its own slot and its own
resume token; the remaining six tanks stay bots. There is no matchmaking, so
both simply connect to the same URL. To watch the join and the handover, tail
the server: it prints `session-joined:<name>:slot=<n>` and the bot count drops.

**Native Defold is offline only.** A native engine has no WebTransport client
extension; `arena.script.ts` detects the missing `WebTransport` global, logs
`war-battles:arena-online-unavailable:no-webtransport` and plays the same match
against bots. Generating that extension through the normal binding pipeline is
item 3 in the README's list of next gates.

## What is proven, and what is not

Proven by `test/core.test.mjs` over the in-memory transport pair: two
clients joining one authoritative match and replacing bots; the client's local
prediction agreeing with the server's state exactly; a client that falls behind
reconciling by replaying its own inputs; a session being refused when the match
is full; a session's forged packet for another player's slot being rejected; and
an upgrade purchased over the reliable control lane.

`pnpm runtime:webtransport` separately proves the production adapter against
this Deno host with a real loopback Chrome HTTP/3/WebTransport session. It
requires a 32-player welcome, at least three authoritative snapshots on the
server reliable lane, at least three client input datagrams, and a bounded
`MatchServer` stats marker proving those inputs were accepted server-side.
`evidence/webtransport-quic-loopback.json` records the runtime and transport
boundary; it does not claim a persistent-stream open count. It does not prove
WAN ingress, native Defold transport, adverse-network behavior, 32 human
clients, or production certificate policy.

## Protocol

Tick input is one 32-byte packet per tick on the unreliable lane — latest-only,
dropped rather than queued when backpressured, and never silently promoted into
the reliable lane. Everything else crosses inside a four-byte reliable envelope
whose kind fixes the lane it is allowed on:

| Kind | Lane | Direction | Bytes |
| --- | --- | --- | --- |
| `hello` | session | client → server | 40 |
| `welcome` | session | server → client | 37 |
| `reject` | session | server → client | ≤ 102 |
| `ping` / `pong` | session | both | 12 |
| `control` | control | client → server | 8 |
| `snapshot` | snapshot | server → client | 17,768 keyframe; compact delta after join |

`PROTOCOL_VERSION` is 5: the snapshot now carries the authoritative chassis and
weapon-branch state, and the reliable control lane carries chassis and branch
selection. The
input packet is still exactly 32 bytes:
version 1 reserved byte 15 and wrote zero there, and that byte is now the weapon
request, so every other field kept its offset.

Snapshot frames have a 16-byte envelope/codec header. A keyframe carries the
17,752-byte raw world image. Established sessions receive sorted,
non-overlapping changed-byte runs against their own fixed-capacity baseline;
the server emits a keyframe at least every 20 snapshots, and a backpressured
or replaced latest-only frame forces the next one. The client rejects a delta
whose base tick is unavailable, so loss or late join cannot silently apply a
partial world. The server also permits only one snapshot send in flight and
retains one latest pending raw state; if that replacement is needed, it is a
keyframe, never a delta that depends on an undelivered frame. The codec's
encode/decode loops allocate no typed-array views or heap objects after setup;
one baseline, decode buffer, and pending raw state are allocated per client.
The final transport call still creates one bounded payload view at the send
boundary; that is transport framing and is not a codec allocation claim.
The decoder rejects nonzero reserved header fields and keyframes with a base
tick. A client that cannot decode or restore a frame latches its baseline as
unavailable, reports only the first root error, drops dependent deltas, and
recovers only from a valid keyframe.

After a welcome, each session receives a rotating 16-byte resume credential.
Closing an authenticated connection releases the transport but reserves its
slot for a bounded tick-based grace window; the world state is not reset, and
the existing bot takeover policy advances that slot while it is absent. A
current token restores the same player id and state, rotates the token, and
starts a fresh snapshot baseline whose first frame is a keyframe. A non-zero
resume attempt never falls through to an anonymous slot: unknown, stale,
active-session, and foreign-match tokens return `REJECT_BAD_RESUME`. Anonymous
joins can use only never-authenticated or expired reservations. The example
credential is deterministic and process-local rather than cryptographic; a
deployment must replace issuance and verification with its authenticated token
service. Credentials are staged for the welcome and committed only after a
`sent` disposition, so a failed welcome retains the previous token and releases
the slot for retry without extending that token's original grace deadline.
A terminal snapshot-send disposition closes the server session and releases
its claimed slot instead of leaving a disconnected human owner behind.

The 37-byte welcome ends with one `snapshotIntervalTicks` cadence byte. Readers
still accept the legacy 36-byte form and use the default three-tick cadence.

The resume token is a **placeholder**: a keyed hash of the match, the slot and a
process-lifetime salt, with no signature. It exists so the reconnect path has a
real implementation to exercise. Anyone who sees a token can reuse it. A
deployment must replace `MatchServer.issueResumeToken` with a token minted and
verified by whatever authenticates the player; the method says so at its
definition rather than leaving it to be discovered.
