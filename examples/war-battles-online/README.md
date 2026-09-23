# War Battles Online — Ultimate Edition

A top-down arena deathmatch, authored end to end in TypeScript and running as
real Defold game objects: a tank you drive rather than a sprite you teleport,
six weapons that fight differently, Quake-style pickups on respawn timers, a
scrolling tilemap of cover and chokepoints, bots worth fighting, and a
server-authoritative online mode over the WebTransport/QUIC boundary in `core/`.

No Lua is authored anywhere in this example. Every component is a `.script.ts`
or `.gui.ts` compiled through déherm.

```
core/        the engine-independent simulation, protocol, transport, server, client
server/      a runnable Deno HTTP/3 server                    (server/README.md)
defold/      the Defold project that renders and plays it     (defold/README.md)
headless/    a deterministic match runner and replay format
tools/       the art generator and the arena tilemap generator
integration/ the runtime gates and their evidence envelopes
evidence/    what each gate actually observed
```

## Playing it

```sh
pnpm install                      # once, at the repository root
cd examples/war-battles-online
pnpm generate                     # SDK, component proxies, synced sources
pnpm check                        # generated state, art, tilemap, types, 58 tests
pnpm play                         # the built arm64-macOS engine
```

| Keys | Action |
| --- | --- |
| Arrows / WASD | Thrust. The tank has mass: it accelerates, drifts and coasts |
| Space | Fire |
| Shift | Boost — a limited, recharging burst |
| `1`–`6` | Cannon, autocannon, railgun, scatter, mortar, ricochet |
| `7`–`0` | Purchase/select scout, assault, bulwark, artillery chassis |
| `Q` / `E` | Purchase/select branch 1 / 2 for the held weapon (selection is free after purchase) |

The scene opens on the tutorial's scripted demonstration, which is what the
packaged runtime gates observe; **any key starts the match immediately**, and it
starts on its own when the demonstration ends. For online play, see
[`server/README.md`](./server/README.md).

For a match with no engine at all:

```sh
pnpm play:headless                # 32 bots, one minute, deterministic
pnpm soak                         # 32 bots, ten minutes, with a rollback check
```

## The game

**Tanks have mass.** A tank thrusts, drags and coasts; it is not repositioned.
The drive speed is enforced by refusing thrust that would exceed it, *not* by
clamping the velocity vector, so an explosion can still throw a tank well past
its own top speed — which is what makes splash knockback and rocket-jumping real
rather than cancelled on the next tick. The hull chases the direction of travel
and the turret chases the aim, at different rates, so a tank visibly drifts
through a turn while still shooting where you are pointing.

**Four chassis, four roles.** Scout is fast and light, assault is a balanced
linebreaker, bulwark trades speed for armour and knockback resistance, and
artillery is a slow siege platform with long-range slots. Their rows are
authoritative content: the HUD names the active role, bots receive deterministic
role variety, and `7`–`0` spends credits once to unlock a chassis through the
same reliable path online and offline; later switches are free.

**Six weapons, six ways to fight.** Every tank spawns with the cannon and
unlimited ammunition for it; the other five are picked up. Each weapon has two
data-driven branches: the first selection purchases that branch once with
credits, while switching between already-unlocked branches is free. Q/E exposes
the current weapon's branch choice without adding a per-frame control route.

| Weapon | Shape of the fight |
| --- | --- |
| Cannon | The floor. 30 damage, slow, always available |
| Autocannon | 9 damage every 5 ticks with a little spread: suppression, not duels |
| Railgun | 72 damage at 512 units a tick, pierces two tanks, 1.5 s between shots |
| Scatter | Seven pellets in a fan, lethal in your face and useless across the map |
| Mortar | 58 on impact plus 46 of falling-off splash, and enough knockback to ride |
| Ricochet | 21 damage, four wall bounces, 2.5 s of life: shoot round the corner |

**Pickups, on Quake timers.** Thirty-two pads, placed symmetrically, each with
its own respawn clock: 12 s for the autocannon, 25 s for the railgun and the
mortar, 15 s for health, 20 s for armour, 40 s for overdrive. A pad you cannot
use is left standing rather than wasted. Picking a weapon up equips it unless
what you are holding is already stronger. Armour absorbs two thirds of incoming
damage until it is gone; overdrive doubles what you deal for ten seconds.

**An arena, not a field.** 120x90 tiles of point-symmetric cover: bunkers with a
doorway, long walls, crate clusters and sandbag lines, on a 15-tile lattice that
guarantees at least eight tiles of corridor between any two blocks. Every open
cell is reachable — the test suite floods the map to prove it. Cover is
**not destructible**, on purpose: the grid is derived from a four-byte seed
rather than stored, so a joining client rebuilds it exactly and the raw world
state stays a fixed 17,752 bytes. Network snapshots use a 17,768-byte keyframe
only for join/recovery and a bounded changed-byte delta thereafter; a 32-player
bot trace measured 1,869–3,201-byte normal deltas (p50 2,438) over 200 frames,
versus the former fixed 17,640-byte message. The codec sends a keyframe at least
every 20 snapshots.

**Bots that are worth fighting.** A bot is a client, not a special case: it reads
the world and emits the same 32-byte input packet a keyboard does, which is why
the server can host them, a client can host them offline, and `BattleWorld` has
no notion of "AI" at all. They break for health when hurt, contest the pad that
would upgrade them, close to the range their current weapon actually wants,
strafe across a target rather than walking into it, steer around cover with a
remembered avoidance side so they do not dither in a doorway, notice when they
are stuck, and lead a shot by the time the projectile will take to arrive. Four
difficulty rows scale reaction time, aim error, lead accuracy, trigger
discipline, greed and strafe. The suite asserts that nightmare beats recruits.

**Short time to kill, and straight back in.** 100 health, 96 ticks dead, one
second of half-damage spawn protection, and a spawn point chosen for distance
from the nearest living enemy.

## How it is put together

The simulation is **integer-only**. There is no `Math.sin`, `Math.cos` or
`Math.sqrt` anywhere in `BattleWorld`, because none of them is required to be
bit-identical between two JavaScript engines and this world is stepped
independently by a server and by every predicting client. Directions are Q8 unit
vectors rather than angles, so slewing a turret is a normalised lerp over an
exact integer square root, and no sine table is needed at all.

Everything is fixed-capacity: 32 players, 512 projectiles, 32 pickup pads, 256
ticks of input history, a 256-slot presentation event ring. `step()` constructs
no object, array, map, set or closure; its scratch vectors are instance fields.
That is an architectural property of the class, not a VM allocation measurement.

The **Defold side is shaped by what the bindings can actually execute.** Only the
current-instance shapes of `go.set_position` / `go.set_rotation` /
`go.get_position` are implemented, so nothing writes another object's transform:
the arena director creates objects and never moves them, and every hull, turret,
projectile and pad reads the slot it was spawned for and moves itself. A tank is
two game objects because the hull and the turret rotate independently and each
has to be the thing that rotates.

**Art is generated**, by `tools/generate-art.mjs`, from a palette histogrammed
out of the pinned tutorial PNGs — the generator throws if asked for a colour that
is not in that histogram. Same 16 px tiles, same chunky silhouettes, same 1 px
`#2c2839` outline the tutorial sprites carry. It writes 70 files plus the atlas
and the tilesource, is byte-reproducible, and has a `--check` mode wired into
`pnpm check`. `tools/generate-arena-tilemap.mjs` then emits the tilemap from the
*same* arena seed and the art manifest's tile ids, so the picture and the
collision grid cannot drift apart.

## Online

`core/match-server.ts` is the authoritative match: one `BattleWorld`, one session
per client, bots filling every slot no human has taken. `core/client.ts` is the
predicting client: it runs the world locally, sends one input per tick on the
unreliable lane, and on each authoritative snapshot restores and replays its own
newer inputs so the local tank does not rubber-band while the rest of the arena
snaps to the truth. Both talk to `GameTransport` and nothing else, so the same
code runs over the in-memory pair in a unit test, over Deno's QUIC endpoint, or
over anything else implementing four methods.

The protocol was extended rather than replaced: `PROTOCOL_VERSION` is now 5,
which adds authoritative chassis and weapon-branch state to snapshots and the
reliable control lane. The tick input packet is still exactly 32 bytes (version 1 reserved byte
15 and wrote zero; it is now the weapon request, so every other offset is
unchanged), and the session, control and snapshot lanes now carry a typed
four-byte envelope whose kind fixes the lane it is allowed on. Full table in
[`server/README.md`](./server/README.md).

**What is and is not proven.** The two-client match, the prediction agreeing with
the server exactly, the reconciliation replay, the full-match refusal, the
rejection of a packet claiming another player's slot, and the reliable control
lane are covered by `test/core.test.mjs` over the in-memory transport. The
separate `pnpm runtime:webtransport` gate opens a real loopback
Chrome-to-Deno HTTP/3/WebTransport session, completes the 32-player welcome,
receives multiple authoritative snapshots over the server reliable lane, sends
tick inputs through QUIC datagrams, and observes a MatchServer marker proving
that at least three inputs were accepted server-side. The gate intentionally
does not claim a persistent-stream open count. This is browser loopback
evidence, not WAN/ingress, native Defold, load, loss, or allocation evidence.

The compact snapshot unit test independently proves the codec against a full
32-player world: the former 17,640-byte frame is now a 17,768-byte keyframe,
while the measured 20 Hz bot trace uses 1,869–3,201-byte deltas (p50 2,438).
The test also proves keyframe reconstruction, exact-base enforcement, sorted
run bounds, and rejection of a delta without its baseline. This is protocol and
in-process evidence; it is not a WAN compression, packet-loss, or allocation
benchmark.

## Evidence

[`evidence/headless-soak.json`](./evidence/headless-soak.json) is a ten-minute
32-bot match: 36,000 ticks, a 36,864,032-byte replay of the inputs the real bot
controller produced, 1,402 kills, and an authoritative restore-and-replay that
finishes at the same state hash as uninterrupted play. In-process determinism
only — not a network, Defold, rendering or allocation result.

[`evidence/bundle-size.json`](./evidence/bundle-size.json) is regenerated by
`pnpm bundle:size:update` and asserted byte-for-byte by the tests. JavaScript
bundle measurements only; no Defold package or Hermes bytecode size is claimed.
The source census excludes the generated `defold_hermes` and
`defold_hermes_typed_native` installations so selecting a native or browser
target cannot change an authored-game measurement.

[`evidence/webtransport-quic-loopback.json`](./evidence/webtransport-quic-loopback.json)
records the real browser transport gate: Chrome connects to the Deno 2.9 QUIC
endpoint with a short-lived pinned P-256 certificate, joins the 32-player
authoritative match, applies at least three snapshots, sends at least three
input datagrams, and observes at least three server-accepted inputs. Regenerate
it with `pnpm runtime:webtransport --
--record-evidence`; the gate owns and removes its certificate, server, browser
profile, and static host.

The packaged native and HTML5 evidence documents are current for this tree.
[`evidence/packaged-runtime-arm64-macos.json`](./evidence/packaged-runtime-arm64-macos.json)
records the custom-engine run through the tutorial collision/score chain and
arena engagement. [`evidence/browser-runtime-wasm-web.json`](./evidence/browser-runtime-wasm-web.json)
records the same game in Chrome through the browser host, including the real
auto-fit camera projection and all three clamp states. Both are artifact- and
source-bound; their tests fail when code, generated output, or packaged bytes
change without a fresh engine observation.

The marker contract preserves the scripted demonstration, collision and score
coordinates, then requires `war-battles:arena-init` and
`war-battles:arena-engaged` so a run observes the match itself rather than only
the tutorial loop. Native camera geometry remains exact. Browser camera geometry
is checked semantically because Defold auto-fit is viewport-dependent: it must
preserve the authored 1280x720 projection, 16:9 aspect ratio and world bounds.
The browser gate's in-engine component count is eight, and
`test/integration.test.mjs` asserts that count against the generated component
manifest so the two cannot drift.

## Commands

| Command | What it does |
| --- | --- |
| `pnpm generate` | Project SDK, component proxies, synced `core/` sources |
| `pnpm check` | Generated state, art and tilemap freshness, types, tests |
| `pnpm art` / `pnpm art:check` | Regenerate or verify the pixel art |
| `pnpm tilemap` / `pnpm tilemap:check` | Regenerate or verify the arena tilemap |
| `pnpm play` | Launch the built native engine |
| `pnpm play:headless`, `pnpm soak` | Deterministic matches with no engine |
| `pnpm serve` | The Deno HTTP/3 match server |
| `pnpm dev` | Compiler, watcher and hot-reload control plane |
| `pnpm runtime:packaged`, `pnpm runtime:browser` | The two packaged runtime gates |
| `pnpm runtime:projections` | The projection-set gate |
| `pnpm bundle:size`, `pnpm bundle:size:update` | Bundle measurement |

The headless runner also accepts `--replay-out PATH` and `--replay-in PATH`.
Writing and reading the same replay reproduces the same state and body hashes;
the runner exits nonzero if its rollback result differs from uninterrupted play.

The 32-player presentation mockup that used to be the built scene is retained,
unbuilt, under [`defold/reference/`](./defold/reference/README.md).

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
  its current resume token, then the server either restores the player slot and
  sends a fresh full snapshot or refuses the resume. A transport connection
  itself is never assumed resumable. This example's token is deterministic and
  in-process only; deployment authentication must replace it with a signed or
  otherwise authenticated credential service.

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
