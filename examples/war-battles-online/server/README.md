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
  server/deno-main.ts --port 4433 --health-port 8080 --roster 8 --bot-skill 2
```

or, from this package, `pnpm serve`.

| Flag                          | Meaning                                                             |
| ----------------------------- | ------------------------------------------------------------------- |
| `--hostname`, `--port`        | QUIC bind address; default `0.0.0.0:4433`                           |
| `--health-port`               | Plain HTTP liveness/readiness port; default `8080`                  |
| `--cert`, `--key`             | PEM paths; default `server/certs/localhost.{crt,key}`               |
| `--roster`                    | Total tanks, humans plus bots. Default 8, maximum 32                |
| `--bot-skill`                 | 0 recruit, 1 regular, 2 veteran, 3 nightmare                        |
| `--snapshot-interval`         | Ticks between authoritative snapshots; default 4 is 15 Hz           |
| `--teams`                     | Two teams instead of a free-for-all                                 |
| `--world-checkpoint`          | Fixed authoritative state file; also `WAR_BATTLES_WORLD_CHECKPOINT` |
| `--world-checkpoint-interval` | Ticks between control-plane world writes; default 60                |

It prints its listening address, the certificate digest and the roster, then one
line per session join and leave.

`GET /healthz` is a liveness check and `GET /readyz` is a readiness check. Both
return JSON with the certificate digest, the `websocket-tcp` fallback label and
a snapshot of authoritative server stats; `/readyz` returns HTTP 503 during
shutdown or while durable session persistence is unhealthy. New QUIC and
WebSocket admissions are rejected in that state; existing sessions are allowed
to finish. `GET /ws` is a WebSocket upgrade on this same TCP listener. It uses
the reliable protocol envelope and routes tick inputs through the explicit
reliable input-fallback channel; it is never labelled WebTransport or QUIC.
Keep this control port private and configure `war_battles.server_websocket`
when needed. The primary gameplay transport remains HTTP/3/WebTransport over
UDP.

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

The wire lanes are deliberately asymmetric. Client hello, welcome-ack, and
control frames share one ordered bidirectional QUIC stream; input commands use
unreliable datagrams. Server welcome/control frames share one ordered
unidirectional stream, while every replaceable snapshot owns a separate stream
that is retired after its one frame or reset after 300 ms. Both peers keep a
64-entry acknowledged snapshot history (about 4.27 seconds at 15 Hz), while the server
allows at most eight unsettled snapshot streams. Several out-of-order deltas
can therefore use the same exact base without making the stream window grow.

**Two clients:** open the bundle in two browser windows, or two separate Chrome
profiles. Each gets its own `WebTransport` session, its own slot and its own
resume token; the remaining six tanks stay bots. There is no matchmaking, so
both simply connect to the same URL. To watch the join and the handover, tail
the server: it prints `session-joined:<name>:slot=<n>` and the bot count drops.

**Network bots:** keep the match server running, then start the separate bot
command dashboard:

```sh
pnpm bots:dashboard
```

Open `http://127.0.0.1:8090`, choose a count and difficulty, and deploy. Every
row is a separate browser WebTransport session that takes an authoritative
player slot and drives the same `BotController` used by local/server bots
through the ordinary predictive `BattleClient`. The dashboard reports live
slots, snapshots, inputs, drops, protocol-ping RTT, and errors. Changing bot
count or skill against the same endpoint retains existing sessions instead of
replacing the whole wave; saved resume tokens cover an explicit stop/restart.
The same adapter forwards bot-selected chassis and weapon upgrades through the
authoritative reliable control lane; focused client and server tests prove that
mapping because the short live gate does not inject purchase credits.
`pnpm runtime:network-bots` proves every
bot independently receives snapshots, sends inputs, and makes non-idle shared
brain decisions, then proves a same-endpoint redeploy keeps its player slots;
`DEHERM_NETWORK_BOTS=32 pnpm runtime:network-bots` fills and proves the complete
32-player network roster.

For the ordinary local demo, the single supervisor command owns all of those
pieces and their teardown:

```sh
pnpm stack
```

It starts this server, launches the packaged native game with the local
certificate pin, hosts the Deno dashboard, opens it in the default browser, and
autodeploys the remaining 31 real browser clients for a 32-player match. It
waits for native roster presentation, authoritative input, and movement from
every browser client before reporting ready. Closing the game or pressing
Ctrl-C stops the complete owned process tree. Use
`pnpm stack -- --headless --exit-when-ready` for a finite local acceptance run.

The repeatable synthetic-browser acceptance for this same production adapter is
`pnpm runtime:multiplayer`. It opens two independent Chrome pages, verifies
distinct player ids and one shared match id, applies authoritative snapshots,
sends input datagrams, and confirms `MatchServer.stats.humans >= 2`. It proves
the browser transport and server orchestration; it does not claim packaged
Defold-engine execution. A Docker deployment can be checked with
`pnpm runtime:multiplayer -- --external --quic-port 4433 --health-port 8080`.

`pnpm runtime:browser:online` is the stronger packaged-game boundary. It starts
the same Deno server, loads the Bob-produced Defold/Wasm bundle in Chrome,
injects only the development server/certificate configuration before engine
startup, and waits for the real `arena.script.ts` component to report an online
welcome, authoritative snapshots, and sent input datagrams. It does not replace
the two-client gate: together they prove packaged-engine integration and real
multi-session admission, respectively.

HTML5 prefers browser WebTransport/HTTP3 and now falls back explicitly to
WebSocket/TCP; both paths are exercised against the Bob-produced game. Native
Defold selects the generated WebTransport-shaped façade backed by the managed
`defold_webtransport` extension, while HTML5 selects the browser constructor;
game code does not contain a platform transport split.

When `--world-checkpoint` (or `WAR_BATTLES_WORLD_CHECKPOINT`) is configured,
the host restores the fixed authoritative world image before opening either
transport listener. It checkpoints once per configured interval (60 ticks by
default) and again during orderly shutdown; these writes are outside
`BattleWorld.step()`. A slow store retains one active write and one coalesced
latest image rather than an unbounded queue. The file is a versioned, fixed-size envelope around the
canonical world snapshot, with repeated match/arena/roster/team-mode identity
and a CRC guard. Corrupt, truncated, foreign-match, foreign-arena,
foreign-roster, and foreign-team-mode files fail closed before session
admission. After restore, the admission clock is rebased against the
session-ledger checkpoint so the restored world tick is not counted twice. The
Deno adapter writes a sibling temporary file and renames it atomically, and
Docker mounts `server/state/world.bin` beside the resume ledger.

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

Snapshot state is sent on independent cancellable WebTransport streams, capped
at eight unsettled packets per session with a 300 ms stale deadline. This gives
state partial-reliability semantics: a delayed packet may be reset and a newer
packet may complete first. Delta frames use only a snapshot tick the client has
applied and acknowledged. Session and control messages remain reliable ordered
events; input bundles remain unreliable QUIC datagrams.

## Protocol

Tick input is one datagram per 60 Hz simulation tick on the unreliable lane.
Each datagram carries one to three complete 32-byte commands, newest plus up to
two predecessors. It is dropped rather than queued when backpressured and never
silently promoted into the reliable lane. The server stages still-future
commands oldest-first and ignores already-consumed redundant copies. Everything
else crosses inside a four-byte reliable envelope
whose kind fixes the lane it is allowed on:

| Kind            | Lane     | Direction       | Bytes                                     |
| --------------- | -------- | --------------- | ----------------------------------------- |
| `hello`         | session  | client → server | 68                                        |
| `welcome`       | session  | server → client | 61                                        |
| `welcome-ack`   | session  | client → server | 44                                        |
| `reject`        | session  | server → client | ≤ 102                                     |
| `ping` / `pong` | session  | both            | 12                                        |
| `control`       | control  | client → server | 8                                         |
| `snapshot`      | snapshot | server → client | 17,776 keyframe; compact delta after join |

`PROTOCOL_VERSION` is 10: bounded input-command redundancy remains on the wire,
and simulation tick ordering plus last-input validity are now unambiguously
uint32 across wrap. Snapshots carry the authoritative command-beacon
state, while hello/welcome frames carry 40-byte authenticated
resume credentials, the client echoes the exact welcome credential before its
rotation becomes current, and the snapshot carries the authoritative chassis and
weapon-branch state, and the reliable control lane carries chassis and branch
selection. The
input packet is still exactly 32 bytes:
version 1 reserved byte 15 and wrote zero there, and that byte is now the weapon
request, so every other field kept its offset.

Snapshot frames have a 16-byte envelope/codec header. A keyframe carries the
17,888-byte raw world image. Established sessions receive sorted,
non-overlapping changed-byte runs against their own fixed-capacity baseline;
the server emits a keyframe at least every 20 snapshots. The client rejects a delta
whose base tick is unavailable, so loss or late join cannot silently apply a
partial world. The match owns one 1,144,832-byte/64-frame raw history, each
server session owns one 17,888-byte acknowledged baseline plus eight bounded
stream slots, and each predicting client owns its own 1,144,832-byte exact-base
history. The codec's encode/decode loops allocate no typed-array views or heap
objects after setup; transport streams still have their explicitly bounded
host resources.
The final transport call still creates one bounded payload view at the send
boundary; that is transport framing and is not a codec allocation claim.
The decoder rejects nonzero reserved header fields and keyframes with a base
tick. A client that cannot decode or restore a frame latches its baseline as
unavailable, reports only the first root error, drops dependent deltas, and
recovers only from a valid keyframe.

After a welcome, each session receives a rotating 40-byte HMAC-SHA-256 resume
credential. The protocol version is bumped when this layout changes.
Closing an authenticated connection releases the transport but reserves its
slot for a bounded tick-based grace window; the world state is not reset, and
the existing bot takeover policy advances that slot while it is absent. A
current token restores the same player id and state, rotates the token, and
starts a fresh snapshot baseline whose first frame is a keyframe. A non-zero
resume attempt never falls through to an anonymous slot: unknown, stale,
active-session, and foreign-match tokens return `REJECT_BAD_RESUME`. Anonymous
joins can use only never-authenticated or expired reservations. Credentials are
staged for the welcome and committed only after the client echoes that exact
credential in `welcome-ack`. A locally enqueued but lost welcome therefore
cannot revoke the last received token. Missing acknowledgements close and
release the session after five seconds; failed delivery retains the previous
token without extending its original grace deadline.
A terminal snapshot-send disposition closes the server session and releases
its claimed slot instead of leaving a disconnected human owner behind.

The welcome remains 61 bytes and ends with one
`snapshotIntervalTicks` cadence byte. Older welcome layouts fail closed.

`core/session-auth.ts` owns the fixed-size HMAC credential and bounded key
rotation. `core/session-persistence.ts` owns the versioned/checksummed fixed
capacity ledger. The Deno host restores and checkpoints that ledger only at
startup, admission/disconnect, and shutdown; no persistence occurs per tick.
Set `WAR_BATTLES_RESUME_KEY` (64 hex characters) and
`WAR_BATTLES_SESSION_STATE` or pass `--resume-key`, `--resume-key-file`, and
`--session-state` as appropriate for
restart-resumable deployments. If no key is configured, the server uses an
unpredictable local-development key, so restart resume requires explicit key
configuration. Malformed keys and corrupt state fail closed. A failed
checkpoint also fails closed for new admissions until a later checkpoint write
recovers; the serialized writer remains retryable and keeps ledger revisions
dirty until a write succeeds. Resume deadlines and credential expiry use
half-range uint32 serial-number ordering, so wrapping the fixed tick clock does
not expire a live session early or extend it indefinitely.

Browser WebSocket upgrades require an Origin. With no configuration, only
`localhost`, `127.0.0.1`, and `[::1]` HTTP(S) origins are accepted. Production
deployments must supply exact canonical origins through repeated
`--allowed-origin` arguments or comma-separated `WAR_BATTLES_ALLOWED_ORIGINS`.
