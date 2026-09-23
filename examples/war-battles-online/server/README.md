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
| `welcome` | session | server → client | 36 |
| `reject` | session | server → client | ≤ 102 |
| `ping` / `pong` | session | both | 12 |
| `control` | control | client → server | 8 |
| `snapshot` | snapshot | server → client | 17,568 |

`PROTOCOL_VERSION` moved to 2. The input packet is still exactly 32 bytes:
version 1 reserved byte 15 and wrote zero there, and that byte is now the weapon
request, so every other field kept its offset.

The resume token is a **placeholder**: a keyed hash of the match, the slot and a
process-lifetime salt, with no signature. It exists so the reconnect path has a
real implementation to exercise. Anyone who sees a token can reuse it. A
deployment must replace `MatchServer.issueResumeToken` with a token minted and
verified by whatever authenticates the player; the method says so at its
definition rather than leaving it to be discovered.
