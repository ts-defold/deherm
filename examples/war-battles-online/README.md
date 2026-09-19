# War Battles Online core vertical slice

This directory contains two things: the built Defold project under `defold/`,
which is a port of the Defold **War Battles tutorial** to deherm TypeScript
components, and an engine-independent, server-authoritative TypeScript
simulation plus backend-neutral online transport boundary for a 32-player
expansion of it.

The built game is the tutorial: a tilemap level, a player game object that moves
and spawns rockets from a factory, kinematic rocket/tank collision groups, and
one GUI score node. The arm64-macOS custom engine has executed that whole loop
through Dynamic Hermes; see [defold/PLAYABLE-BLOCKERS.md](./defold/PLAYABLE-BLOCKERS.md)
for the exact observed markers. This is packaged local gameplay evidence, not
Static Hermes, HTML5 browser-host, whole-API, allocation, or QUIC deployment
evidence.

The 32-player presentation mockup that used to be the built scene is retained,
unbuilt, under [`defold/reference/`](./defold/reference/README.md).

## What is implemented

- 60 Hz integer/fixed-direction simulation with a stable player-slot iteration
  order and generation-keyed entity ids.
- Fixed-capacity structure-of-arrays stores for 32 players, 512 projectiles, and
  256 ticks of input history. `BattleWorld.step()` contains no explicit object,
  array, map, set, or closure construction. This is an architectural observation,
  not a VM allocation measurement.
- A validated 32-byte input command with match/player/tick/sequence identity,
  axes, fire sub-tick, and a 32-snapshot acknowledgement window.
- Caller-owned full snapshots for rollback/reconciliation. The fixed 13,716-byte
  snapshot includes authoritative simulation state; the external input replay log
  is intentionally separate and must be re-submitted after a rollback.
- Data-driven cannon, autocannon, and railgun definitions plus damage, mobility,
  and armor upgrade tracks.
- A transport interface, deterministic in-memory adapter, browser WebTransport
  client, Deno QUIC listener adapter, and an adoption boundary for an accepted
  server WebTransport session.
  Session/control/snapshot messages use independent reliable streams. Tick input
  uses datagrams only when runtime capability and negotiated size permit it;
  otherwise a cancellable reliable-stream fallback is explicit.
- A pinned, self-hosted Colyseus H3 Docker browser gate that exposes both TCP
  and UDP and refuses to count a WebSocket connection as a passing result.
- A generated `.script.ts`/`.gui.ts` War Battles tutorial port that runs as
  Defold game objects: tilemap, player sprite with arrow-key movement, a rocket
  factory with a typed `dir` vector3 property, kinematic `rockets`/`tanks`
  collision groups, a once-forward explosion, and a single GUI score node.
- A retained, unbuilt `reference/battle.gui` presentation mockup with WASD
  controls, independent tank turrets, 31 deterministic bots, a player-following
  camera, a 160-node projectile render pool, HUD, upgrades, and restart loop.
  It remains the visual target for a later presentation phase.
- A headless match runner with deterministic bots, all three weapons, upgrade
  purchases, snapshot restore/replay, a portable binary replay, and a 32-player
  ten-minute simulated soak fixture.
- An evidence-driven transport-selection state machine. Colyseus H3 is the
  primary evaluation target; Deno and Quinn are explicit alternatives; WebRTC,
  WebSocket, and offline modes keep their actual wire-protocol labels.

This example is a private pnpm workspace package. From this directory, install
once at the repository root and then use its own commands:

```sh
pnpm generate
pnpm check
pnpm play:headless
pnpm play
pnpm soak
pnpm bundle:size
pnpm dev
pnpm runtime:packaged
```

`pnpm generate` invokes the installed public `deherm` CLI, which generates both
the project SDK/configuration and `.script.ts` component proxies, then refreshes
the example's checked source snapshots. `pnpm dev` starts the compiler/watcher/
hot-reload control plane. Run `pnpm play` in a second terminal to keep the
already-built arm64-macOS game open while the watcher rebuilds its development
resource. `pnpm runtime:packaged` launches the same engine as a bounded evidence
probe; it is not the interactive play command. The evidence probe observes the
exact runtime markers, rejects known failures, settles for 1.5 seconds, and
terminates the engine.

The headless runner also accepts `--replay-out PATH` and `--replay-in PATH`.
Writing and reading the same replay reproduces the same state and body hashes;
the runner exits nonzero if its rollback result differs from uninterrupted play.

## Current integration evidence

The checked ten-minute simulation evidence is in
[`evidence/headless-soak.json`](./evidence/headless-soak.json). At 60 Hz it runs
36,000 ticks for 32 bots, processes a 36,864,032-byte replay, performs an
authoritative restore/replay, and finishes both paths at state hash `238808479`.
This is an in-process deterministic soak, not a network, Defold, rendering, or
allocation-profile result.

[`evidence/bundle-size.json`](./evidence/bundle-size.json) is regenerated by the
measurement command and asserted byte-for-byte by the integration tests. With
esbuild 0.25.10, the minified headless Node bundle is 21,229 bytes (6,049 gzip)
and the diagnostic Defold-GUI bundle is 21,465 bytes (6,550 gzip). These
are JavaScript bundle measurements only. No Defold package or Hermes bytecode
size is claimed by this file.

[`evidence/packaged-runtime-arm64-macos.json`](./evidence/packaged-runtime-arm64-macos.json)
binds the successful run to the exact custom engine, archive index/data,
compiled project, manifest, JavaScript bundle, complete packaged extension
tree, authored Defold project tree, upstream/déherm locks, component manifest,
and lowering-plan sentinel hashes. Its game-owned initialization marker is
emitted only after TypeScript `init` resolves the 32 tank bodies, 32 turrets,
160 projectile nodes and HUD nodes, performs the first render through
`gui`/`vmath`, and posts input focus. A second game-owned marker follows the
first TypeScript update and render. The harness then rejects
error/fatal/script/traceback/bundle and
component-runtime diagnostics during a bounded settling window, records the
actual exit status/signal and canonical transcript digest, and records no
volatile timestamp.

The Defold frontend lives in [`defold`](./defold/README.md). The public CLI
generates its single GUI proxy and passes shared, game-object, GUI, and render
typechecking, generated-state verification, and a one-shot headless development
build. Pinned Bob compiles the collection, GUI scene, input, font, and proxy into
an arm64-macOS resource archive. Its current native-extension upload also
contains the extension manifest, sources, headers, and packaged Hermes archive;
the current custom engine build and launch passed the scoped packaged runtime
gate. The generated global capability manifest still records
`native-dynamic-hermes-harness-executable`/`runtimeConformant: false`, and the
War Battles evidence intentionally does not rewrite that broader claim. Exact
executed routes and remaining blockers are in
[`defold/PLAYABLE-BLOCKERS.md`](./defold/PLAYABLE-BLOCKERS.md).

## Transport architecture

`GameTransport` is the seam between simulation protocol and a concrete network
runtime. It deliberately describes semantics instead of naming a vendor:

- reliable messages have a typed lane (`session`, `control`, `snapshot`, or
  cancellable `input-fallback`);
- latest-only input datagrams return `backpressured` instead of accumulating an
  unbounded stale queue;
- the negotiated maximum datagram size is checked for every send;
- unsupported datagrams never silently become “UDP”; and
- reconnect/session resume lives above the connection. A new connection presents
  a signed resume token plus the last acknowledged authoritative snapshot, then
  the server either restores the player slot and sends a fresh full snapshot or
  refuses the resume. A transport connection itself is never assumed resumable.

The browser adapter places each reliable protocol message on an independent
unidirectional stream. That avoids cross-lane ordered head-of-line blocking and
lets a caller abort an obsolete reliable input fallback. Its stream receive path
buffers arbitrary read fragmentation and validates a fixed length prefix before
delivery. Transport receive allocations and browser/runtime queues are outside
the simulation allocation boundary.

Deployments must terminate HTTP/3 with a certificate browsers accept. For local
development, compatible browser clients can use a short-lived self-signed
certificate hash. Production needs a normal trusted certificate, an exposed UDP
port, correct HTTP/3/WebTransport settings and origin/authentication checks.
The server must bound concurrent sessions, streams, message sizes, queued bytes,
input lead/lag, and per-player packet rate.

QUIC datagrams are encrypted and congestion-controlled, but unreliable,
unordered, not flow-controlled, and limited by the negotiated path/peer maximum.
The moq-dev documentation calls out an approximately 1.2 KB minimum MTU floor;
the protocol still uses the runtime-reported limit and does not hard-code 1,200.
Input packets carry tick and sequence numbers, so duplicates, loss, and reordering
are harmless. The 32-bit acknowledgement window supports snapshot delta choice,
but delta encoding itself is not in this slice.

## Server/runtime decision matrix (validated 2026-09-18)

| Candidate | Actual transport semantics | 32-player/server fit | Defold/native and TypeScript fit | Status here |
| --- | --- | --- | --- | --- |
| Deno `QuicEndpoint` + `upgradeWebTransport` | Genuine HTTP/3 WebTransport over QUIC. Official example shows server and client, streams, datagrams, TLS, and `--unstable-net`. | Direct authoritative loop in TypeScript; easiest low-level way to share this pure TS core. Must build admission, scheduling, metrics, persistence, and abuse controls. | Browser client is direct. Native Defold still needs a WebTransport extension/binding. | **Lower-level TypeScript alternative** if Colyseus H3 fails its browser/WAN gate or its framework contract is too restrictive. The server API is explicitly unstable. |
| moq-dev `web-transport` over Quinn | Genuine WebTransport with reliable ordered flow-controlled streams and unreliable unordered congestion-controlled datagrams; native and WASM crates plus UniFFI. | Strong low-level Rust foundation and explicit transport semantics, but room/session services are application work. | Less TS reuse on the server. UniFFI covers Python/Kotlin/Swift, not Defold; a dmSDK binding or sidecar is still required. | **Production/hardened alternative** after measuring Deno; no adapter linked yet. |
| Colyseus `@colyseus/h3-transport` | Genuine HTTP/3/WebTransport, reliable lane plus QUIC datagrams. Official docs call it experimental and not battle tested. | Best room/schema/reconnect/server ergonomics of these candidates. H3 issue #946 documented room-path and fragmented-read failures in old 0.16.x packages; 0.17.11 release notes confirm the stream/datagram frame-reassembly fix, while room-path behavior still needs a current real-browser test. | Client-side H3 is currently JS/TS only. Official `colyseus-defold` uses `extension-websocket`; that path is WebSocket, not H3. Our protocol remains independent of Colyseus schema. | **Default self-hosted server candidate**, gated by the pinned Docker browser/WAN probe and 32-client soak before gameplay integration. |
| Bun PR #40027 | The open PR adds server WebTransport **datagrams only** to experimental Bun HTTP/3. It explicitly refuses peer streams. | Attractive API and reported tests, but cannot carry this design's reliable session/control/snapshot lanes by itself. | TypeScript-friendly; no Defold H3 client. PR was still open and Linux x64 runtime-tested, with macOS/Windows compile-only, when checked. | **Not selected** until merged, streams exist, and target runtime tests pass. |
| WebRTC data channels | SCTP over DTLS over ICE (normally UDP; TURN may relay via UDP/TCP/TLS), not raw UDP and not QUIC. Separate ordered/reliable and unordered `maxRetransmits: 0` channels can provide reliable and UDP-like application lanes. SCTP streams reduce ordering coupling, but congestion, buffering, message interleaving, and one association still need measurement. | An authoritative Node server can use `node-datachannel`/libdatachannel, but every player needs a peer connection plus signaling, ICE credentials, STUN, and usually TURN capacity. | The community `extension-webrtc` reports WASM/Windows/Linux support but no stable release and heavy development. The Poki extension is HTML5-only, peer-to-peer, and alpha. Neither is a proven all-target authoritative client. | **Fallback research path**, not the default. Promote only after native target, TURN, signaling, loss and load tests. |
| Colyseus Defold over WebSocket | Reliable ordered WebSocket/TCP only; official H3 docs say WebSockets have no real unreliable channel. | Mature room and state tooling. | Existing Defold SDK and native WebSocket extension are the easiest current engine path. | **Compatibility fallback only** and always labeled WebSocket, never QUIC. |

Primary evidence:

- [Deno official WebTransport client/server example](https://docs.deno.com/examples/web_transport/)
- [Deno `upgradeWebTransport` API](https://docs.deno.com/api/deno/~/Deno.upgradeWebTransport)
- [moq-dev WebTransport repository](https://github.com/moq-dev/web-transport)
- [Colyseus experimental WebTransport documentation](https://github.com/colyseus/docs/blob/master/pages/server/transport/webtransport.mdx)
- [Current Colyseus SDK H3 selection and endpoint construction](https://github.com/colyseus/colyseus/blob/master/packages/sdk/src/Client.ts)
- [Colyseus 0.17.11 H3 frame-reassembly release](https://github.com/colyseus/colyseus/releases/tag/%40colyseus%2Fh3-transport%400.17.11)
- [Colyseus real-browser H3 issue #946](https://github.com/colyseus/colyseus/issues/946)
- [Official Colyseus Defold client](https://github.com/colyseus/colyseus-defold)
- [Open Bun WebTransport PR #40027](https://github.com/oven-sh/bun/pull/40027)
- [WebRTC data-channel RFC 8831](https://www.rfc-editor.org/rfc/rfc8831)
- [W3C WebRTC data channel API](https://www.w3.org/TR/webrtc/#rtcdatachannel)
- [Defold community WebRTC extension](https://github.com/VitusVeit/extension-webrtc)
- [Defold Poki Netlib extension](https://github.com/indiesoftby/defold-poki-netlib)
- [node-datachannel/libdatachannel bindings](https://github.com/murat-dogan/node-datachannel)

The requested X post was blocked by X with HTTP 403. A third-party mirror exposed
its attached article, which reports a 128-tick authoritative browser game, compact
input/replay records, datagram queue growth under induced loss, one cancellable
stream per packet with a 300 ms cutoff, and moving the network clock to a Web
Worker. These are useful design hypotheses, not promoted primary evidence. In
particular, this slice still requires browser impairment tests to decide whether
datagrams, expiring streams, or a hybrid perform best under congestion.

## Colyseus H3 Docker gate

[`deployment/colyseus-h3`](./deployment/colyseus-h3/README.md) contains a pinned
`0.18.2` self-hosted setup and browser probe. Compose publishes `2567/tcp` for
HTTPS matchmaking/probe assets and `2567/udp` for HTTP/3/QUIC. The probe passes
only after inspecting the JS/TS SDK's selected H3 transport, round-tripping a
reliable message, and observing at least one client-to-server QUIC datagram. It
contains no WebSocket transport and therefore cannot silently downgrade while
reporting a WebTransport success.

The first `0.18.2` browser run failed with `Opening handshake failed` while the
package generated a certificate for bind host `0.0.0.0`; the reservation did
contain its fingerprint. Current SDK source reduces the room endpoint to its
origin before creating `WebTransport`, so this run did not reproduce the old
room-path behavior from issue #946. The gate now uses a ten-day P-256 ECDSA
certificate with an explicit `localhost` SAN and injects its computed hash into the local seat
reservation, isolating certificate identity from stream/datagram behavior.

That setup is the first server-integration candidate, not proof that the current
machine, browser, ingress, or Defold client has passed it. The local core tests
remain backend-neutral and run entirely in memory. The Deno adapter remains the
lower-level TypeScript option; moq-dev/Quinn remains the native-oriented option.
On this arm64 Docker Desktop/Colima host, the image and HTTPS matchmaking path
were verified, but both Chrome and the in-app Chromium browser rejected
`WebTransport.ready` with `Opening handshake failed`; therefore no real stream
or datagram exchange is claimed. Colyseus H3 remains the default **evaluation**
candidate, blocked from gameplay promotion until that gate passes.

## Exact Defold attachment evidence and remaining blockers

The API readiness gate remains a generation artifact and deliberately says
`gameplayExecutionObserved: false`; it is not mutated by runtime observation.
The separate hash-bound packaged evidence now proves the actual example's GUI
component attachment, Dynamic Hermes load, TypeScript initialization, first
render, and bounded update survival. It does not prove the older five-route
fixture scenarios or every generated API.

The next truthful product gates are:

1. broaden packaged-engine probes beyond this GUI scene to game-object/render
   contexts, teardown/detach, reload, properties, factories, asynchronous
   deletion, and all current-instance rules;
2. a Defold/HTML5 adapter that pumps input into `BattleWorld`, renders snapshots,
   and maps authoritative events to factories, sprites, collision/FX, and GUI;
3. a native Defold WebTransport client extension (HTTP/3/QUIC, streams, datagrams,
   TLS and callbacks) generated through the normal binding pipeline; browser-host
   JavaScript may use the browser adapter only after that host bridge is proven;
4. the selected server adapter, authentication/resume token service, snapshot
   delta codec, interest management, persistence/matchmaking, and rate limits;
5. loopback plus real-browser/native QUIC runs, certificate/origin tests, induced
   loss/reorder/MTU/backpressure tests, 32-bot soak metrics, and allocation traces.

The in-process 32-bot deterministic soak is now present; item 5 still requires
the network/engine variants and allocation profiling.

The runtime marker belongs to the example only and is not an input to the core
binding generator.
