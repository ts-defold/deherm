---
type: Product Roadmap
title: War Battles TypeScript showcase
description: Post-binding-gate plan to port War Battles and grow it into a 32-player Defold Hermes showcase.
tags: [defold, hermes, typescript, war-battles, multiplayer]
status: proposed
generated: { by: codex/gpt-5, at: 2026-09-17T00:00:00-04:00 }
sources:
  - id: defold-war-battles
    resource: https://github.com/defold/tutorial-war-battles
    title: Defold War Battles tutorial
    author: team:defold
  - id: ts-defold-war-battles
    resource: https://github.com/ts-defold/tsd-template-war-battles
    title: Existing ts-defold War Battles template
    author: team:ts-defold
  - id: quake3-client-input
    resource: https://github.com/id-Software/Quake-III-Arena/blob/master/code/client/cl_input.c
    title: Quake III Arena client input transport
    author: organization:id-software
  - id: quake3-client-prediction
    resource: https://github.com/id-Software/Quake-III-Arena/blob/master/code/cgame/cg_predict.c
    title: Quake III Arena client prediction
    author: organization:id-software
  - id: quake3-aas-routing
    resource: https://github.com/id-Software/Quake-III-Arena/blob/master/code/botlib/be_aas_route.c
    title: Quake III Arena AAS routing
    author: organization:id-software
  - id: supertripland-webtransport
    resource: https://x.com/0xGuavaGuy/status/2093400953294582110
    title: 128-Ticks Per Second Multiplayer in a Web Browser
    author: person:guavaguy
---

# Outcome

Port the complete War Battles tutorial application to application-level
TypeScript on `@ts-defold/deherm`, then expand it into a polished 32-player
multiplayer showcase. The port is the first full-product acceptance test for
the generated Defold script API, raw dmSDK access, native extension discovery,
browser adapter, dynamic Hermes, and Static Hermes profiles.

The game is downstream of the full binding gate. Gameplay code must not hide
missing runtime bindings behind hand-written per-symbol native glue or new Lua
gameplay scripts. A small generated/bootstrap Lua seam is acceptable only where
Defold still requires a script component to establish engine context, and it
must be measured and documented.

# Source selection

Before importing assets or code, pin and record:

1. the Defold editor's current `tutorial-war-battles` template revision;
2. the existing `ts-defold/tsd-template-war-battles` revision and its current
   TS-to-Lua behavior;
3. asset and source licenses separately;
4. hashes for all imported archives.

The TSDefold version is migration evidence, not the target architecture. The
new application runs TypeScript through the selected Deherm runtime profile.

# Gate 0: binding completeness

The port begins only after the generated conformance ledger proves, for every
public function selected by the game and every discovered extension symbol:

* TypeScript generation;
* native adapter generation;
* object compilation and final-binary retention;
* TypeScript-to-engine execution in the required context;
* semantic conformance or a precise unsupported reason;
* sanitizer and ownership coverage for values that cross a runtime boundary.

The whole imported script and dmSDK inventories must have an honest disposition
before the SDK is called complete. The game may use only entries whose runtime
state is executable on its target profile.

# Stage 1: faithful TypeScript port

Reproduce the tutorial's existing behavior with no deliberate feature changes:

* player lifecycle, movement, aiming, shooting, collision, damage, and death;
* factories, collections, messages, input, camera, particles, sound, GUI, and
  render behavior;
* deterministic smoke scenarios and captured frame/state traces;
* native dynamic-Hermes, native Static-Hermes, and HTML5 browser-host builds.

Run the original and TypeScript ports from the same scripted input timeline and
compare authoritative gameplay state rather than relying on screenshots alone.

# Stage 1b: world, camera, and scale

The tutorial ships a single fixed screen at its original resolution, which makes
the pixel art read as very small on a modern display and leaves the level with
nowhere to go. Before multiplayer is attached, the presentation moves to a
scrolling world:

* a camera component that follows the player with bounded look-ahead and
  clamping at world edges, rather than a fixed viewport;
* a world substantially larger than one screen, so the tilemap scrolls and the
  level has traversable space;
* a render and display configuration that presents the pixel art at a legible
  scale, with an explicit integer-scale or resolution policy rather than
  incidental stretching;
* GUI that stays in screen space while the world scrolls beneath it.

This is deliberately sequenced after the faithful port. The port establishes
that game objects, factories, physics, sprite animation and input work through
generated bindings; this stage changes presentation only, so any regression is
attributable to the camera and world change rather than to the binding surface.

It also widens the exercised API surface in a useful direction: camera routes,
render-context routes, and world-space versus screen-space addressing are all
distinct contract families that a single fixed screen never touches.

## Delivered

All four bullets are in `examples/war-battles-online/defold`, observed on a
pinned local-Extender arm64-macOS engine:

* `main/camera.go` carries a built-in `camera` component and
  `main/camera.script.ts`; no third-party extension and no hand-rolled view
  matrix. Defold 1.14's built-in render script binds an enabled camera
  component through `camera.get_cameras()`/`render.set_camera` on its own, and
  draws the `gui` predicate through a separate screen-space projection, so the
  GUI needed no change.
* `main/tutorial-world.tilemap` is 120x90 tiles (1920x1440 px) generated from a
  fixed seed by `examples/war-battles-online/tools/generate-world-tilemap.mjs`
  out of the tutorial's own four ground tiles and single 4x2 prop; the authored
  51x49 map is preserved verbatim inside it and every original world coordinate
  is unchanged.
* The scale policy uses a 1280x720 reference display,
  `orthographic_projection` with `ORTHO_MODE_AUTO_FIT`, and an authored
  `orthographic_zoom = 2`. The camera script multiplies that authored zoom by
  `camera.getOrthographicAutoZoom(active)` to derive the effective zoom and
  clamp the world to the actual viewport; the rejected alternatives are written
  down in the project README.
* The current HTML5 playability gate proves WebGL2 input, restart, sound, and
  visible composed pixels after the auto-fit camera fix. It retains
  `build/evidence/war-battles-html5.png` (SHA-256
  `1d1f6631f47163a4118024b6fb170d7c07d5009cb856fc1604cd0cccce7507f0`) as
  human-review evidence; the assertion is the machine-checked playability
  markers and viewport visibility, not screenshot aesthetics alone.

The stage found the binding gap it was supposed to find. World-space addressing
is declared but not implemented: `go.get_position`, `go.set_position` and
`go.set_rotation` all declare `String`/`Hash`/`Url` call shapes and implement
only the current-instance shape, and `msg.url(String)` fails its universal
descriptor. A component therefore still cannot read or write another game
object's transform. The camera works around it with an implemented
`msg.post(String, String, Table)` position report from the player, which is the
honest shape of the gap rather than a fix for it.

# Stage 2: multiplayer simulation

Build a server-authoritative 32-player simulation with a fixed tick and an
explicit network protocol. Keep simulation state in dense, generation-keyed
SoA stores so entity iteration is cache-local and stable. Allocate pools at
match creation; normal ticks must not grow containers or allocate bridge
objects.

Required systems:

* client prediction and server reconciliation for the local tank;
* interpolation for remote actors;
* compact snapshots with interest management and delta compression;
* deterministic weapon/projectile simulation where practical;
* authoritative damage, pickups, progression, spawn selection, and scoring;
* reconnect, late join, host migration policy, abuse limits, and replayable
  input/state recordings;
* bots capable of filling all 32 slots for repeatable load tests.

Transport is selected after measuring Defold-supported native and browser
options. The binding generator must ingest any chosen native extension instead
of adding bespoke application bindings.

## Bounded presentation and lifecycle tranche

The online client now keeps a fixed-capacity pair of transform samples for all
32 slots and samples remote hull/turret transforms across the authoritative
snapshot interval advertised by the server (four ticks / 15 Hz by default).
An incoming sample starts from the pose that was actually rendered, not the
previous authoritative target, so jittered or bunched streams do not jump an
in-flight interpolation forward. Generation or player-mode changes hard-snap
instead of blending across a respawn, slot reuse, or tank/on-foot transition.
Hull and turret directions follow their shortest angular arc. The local slot
remains an immediate read from its predicted/reconciled world, with positional
and angular reconciliation error decaying over the same bounded 100 ms window.
The preceding frame delta is consumed before a pending snapshot is installed,
so a new segment or correction is first rendered at alpha zero.
Defold tank components consume this caller-owned sample, while a failed dial,
pre-welcome reject, or pre-welcome close returns to the offline `PlayableBattle`
that was created at arena start.
This is presentation smoothing and connection fallback evidence; compact
snapshots and reconnect-after-welcome are now covered by focused in-process
evidence; the broader multiplayer release gate remains open.

## Real browser WebTransport tranche

The production `GameTransport` adapter now passes a loopback Chrome-to-Deno 2.9
HTTP/3/WebTransport gate. Chrome completes the 32-player authoritative welcome,
applies multiple authoritative snapshots, sends tick inputs as QUIC datagrams, and
observes the authoritative MatchServer accept them. Snapshot state now uses one
independently cancellable stream per packet; ordered session/control delivery
remains separate. Repeated frames use the existing bounded five-byte framing;
focused adapter tests prove stream-local stale cancellation, while the loopback
record makes no stream-open-count claim. The
evidence artifact is mechanically source-bound, records the browser and Deno
versions, and explicitly excludes WAN, ingress, native Defold, impairment,
load, persistent-stream runtime, and allocation claims. Those remain separate
gates rather than implied by loopback transport success.

Server terminal rejects use the same persistent ordered event stream. When a
reject is immediately followed by session close, the adapter stops admitting
new frames, drains the bounded reliable FIFO, closes the stream to emit FIN,
and only then closes the WebTransport session. A one-second deadline still
closes a session whose stream sink never settles. The focused regression uses
an asynchronous Web Streams sink where premature session close discards queued
bytes; it proves terminal reject delivery before close rather than relying on
the synchronous in-memory transport. `REJECT_RATE_LIMITED` remains different:
it is an advisory on the live control lane, increments client telemetry, and
does not close or reject an already-ready client.

## Network bot dashboard tranche

The bot load/demo client is a browser dashboard hosted by a second, ordinary
Deno HTTP process. Browser ownership is intentional: Deno 2.9 exposes the
server-side QUIC/WebTransport upgrade but does not expose a working client
constructor in the installed runtime, while Chromium already provides the
production WebTransport surface the HTML5 game uses. The dashboard therefore
opens one genuine HTTP/3/WebTransport session per bot without adding a Node
native-addon dependency or inventing a Deno-only protocol.

`core/network-bot.ts` is the only intent-adaptation seam. It feeds the existing
`BotController` from each `BattleClient`'s predicted/reconciled `BattleWorld`,
then copies the staged intent into the ordinary client controls. Local,
authoritative-server, and network bots share the same difficulty rows and
decision code; only the ownership of the resulting input packet changes. When
the shared brain predicts a chassis or weapon-branch purchase, the adapter also
sends that request over the ordinary reliable authoritative control lane. A
focused exact-call test proves the adapter mapping and an independent server
control test proves authoritative application; the short real-QUIC bot gate
does not manufacture credits and therefore does not claim to observe a purchase.

The dashboard's foreground interval is not a gameplay-clock authority. Chromium
may throttle that interval when the packaged native game owns focus, which used
to leave a session visibly ready while its tank received only occasional input
bursts and coasted to a stop. Each bot now has an independent bounded clock that
is also awakened by authoritative snapshot delivery. The network wake applies
the latest snapshot first, records movement from the reconciled client view, then
advances at most 250 milliseconds/eight client steps; it neither builds an
unbounded catch-up queue nor depends on a foreground browser tab.

`pnpm bots:dashboard` builds and hosts the operator UI. It reports per-session
slot, state, server tick, snapshots, inputs, drops, reconciled travel, RTT, and
last error, with count and skill controls up to the 32-player cap.
`pnpm runtime:network-bots`
is the executable acceptance gate: it starts the Deno HTTP/3 server and a fresh
headless Chrome, admits four independent dashboard sessions, observes unique
authoritative slots and replacement of four server bots, applies snapshots,
sends inputs, and requires `MatchServer` to accept those inputs. The gate checks
every bot independently for snapshots, inputs, a non-idle decision, and nonzero
travel in the reconciled view after authoritative snapshots instead of accepting
aggregate traffic or local prediction as proof. A deterministic unit test also
proves that snapshot wakes keep advancing during a fully absent dashboard timer
and retain the catch-up bound. A same-endpoint skill redeploy must
retain the live sessions and their authoritative player slots; explicit stops
retain resume credentials for a later restart. The dashboard sends periodic
protocol pings so its RTT column is live telemetry rather than decoration.
This is real loopback browser-to-Deno QUIC evidence; it does not claim WAN
behavior, long-duration load, packet
impairment, or native-Defold client coverage.

## Arena-shooter replication and navigation wave

The authoritative simulation remains 60 Hz. Human and network-bot clients
predict at that same rate and submit one unreliable datagram per tick. Protocol
10 repeats up to three complete commands oldest-first in each datagram; the
server ignores consumed copies and stages every still-future command. This is a
bounded loss-recovery window, not a retransmission queue. The deterministic
loss test drops every second datagram and still observes continuous
authoritative travel with zero protocol rejections.

Server state is 15 Hz by default. Prediction now advances the local world
by `leadTicks` and preserves every command's tick on the wire. The former path
predicted command N locally but retimestamped it to N + leadTicks for the
server, which guaranteed repeated corrections. Local simulation accepts each
authoritative correction and replays later commands on their exact original
ticks; presentation decays only the remaining visual error over 100 ms. Remote
players interpolate between authoritative samples. Adaptive lead grows by at
most one tick per authoritative sample, but no longer ratchets upward forever:
twelve consecutive samples below the current target lower it by one tick. The
client catches down by consuming one future wall-clock tick without stepping,
never by rewinding simulation or changing an input's tick. Scalar client stats
record current/maximum positional correction, remote in-flight rebases and
their maximum distance, non-lifecycle interpolation discontinuity, lifecycle
hard-snaps, current lead, lead decreases, and completed catch-down holds. These
counters are allocation-free observability; they do not by themselves prove
visual quality outside the deterministic and bounded loopback profiles that
record them.

Snapshot delivery is replaceable state, not an ordered event log. Each packet
owns an independent WebTransport stream, up to eight unsettled streams; streams
still pending after 300 ms are reset, acknowledged streams are reset before
leaving the fixed window, and newer state is dropped while all eight slots are
occupied. A reset is stream-local and never closes the session.
This intentionally provides unreliable/partial-reliability semantics without
putting large fragmented snapshots into the browser datagram queue. Inputs
remain true unreliable QUIC datagrams. Session/control events remain reliable
and ordered.

`latestSnapshotTick` now selects the server delta base only after the client
applied that exact snapshot and returned the acknowledgement in an input. The
server and client retain a fixed 64-snapshot exact-base history (about 4.27 seconds at
15 Hz) and the server emits a keyframe whenever the acknowledged base is
absent. Receiving a frame does not mutate the client's decode base; applying
it does. Consequently independently completing streams
may arrive out of order, a bad stream cannot discard a newer complete pending
frame, and no delta depends on state the client merely received but never used.
Focused tests prove command-tick identity, exact acknowledged delta bases,
bounded independent streams, and stream-local cancellation. WAN impairment is
still a separate evidence gate.

Bot movement now separates route planning from local avoidance. `ArenaMap`
derives deterministic routes from the seeded collision grid, and
`BotController` uses one fixed-capacity breadth-first scratch arena to pick the
farthest visible waypoint on a shortest route. Equal-cost neighbour order is
deterministically biased per slot so a full roster does not select one identical
corridor. Existing steering, hazard repulsion, and stuck recovery are the
last-metre movement layer; they no longer have to discover a route around a
multi-cell bunker. Route cost, replans, and failures are fixed typed-array bot
state and introduce no per-tick heap allocation.

`pnpm stack` is the local operator entry point for the complete playable path.
One supervisor reuses or creates the pinned localhost certificate, starts the
Deno HTTP/3 match server, launches the packaged native Defold client with that
pin, hosts and opens the browser dashboard, autodeploys the remaining seven
network bots, and tears down its owned server/dashboard processes when the game
closes or the operator presses Ctrl-C. The command compiles the current
TypeScript generation and rebuilds the Bob archive before launch; `--no-build`
is an explicit expert escape hatch and may only reuse a protocol-compatible
archive. A local smoke observed native `webtransport-h3-quic`, authoritative
slot admission, accepted inputs, and live Hermes telemetry from the freshly
rebuilt protocol-10 archive. It remains local arm64-macOS runtime evidence, not
cross-host or WAN evidence.

## Uint32 tick-wrap hardening tranche

Protocol 10 closes the simulation-clock boundary that the admission ledger had
already treated as a uint32 serial number. Server, offline, client-prediction,
replay, bot-reaction, redundant-input, and snapshot ordering now share the
RFC-1982 half-range helpers instead of JavaScript numeric `<`/`>` comparisons.
Tick `0xffffffff` is a real input-ring value rather than an empty sentinel: a
separate fixed validity bitmap owns queue occupancy. Player last-input state is
stored in a `Float64Array` so all uint32 values plus the local `-1` sentinel are
exact; snapshot version 8 uses the former reserved player byte as an explicit
validity bit and transports the tick itself as uint32.

Focused tests cross `0xfffffffd -> 0xffffffff -> 0 -> 1` through direct world
input and snapshot restore, then cross the same boundary through a welcomed
predicting client, redundant datagrams, the authoritative server, bots, and
snapshot application. This is deterministic long-session correctness evidence;
it does not extend the separately bounded credential/session horizon beyond
RFC-1982's half range.

The client's prediction-history tick keys use `Float64Array`, not signed
`Int32Array`, so the exact local `-1` sentinel and every uint32 wire tick coexist.
A focused client/server regression crosses `0x7fffffff -> 0x80000000`, proves
the command is transmitted, and proves the authoritative world executes that
same tick. The earlier wrap regression began above the signed boundary and did
not expose the storage conversion; both boundaries are now covered.

## Ordered admission and native close tranche

All frames on the client's one ordered reliable stream now enter one bounded
server dispatch queue. The queue retains at most 32 immutable frame references
and 256 KiB while asynchronous credential admission settles, then dispatches
HELLO, WELCOME_ACK, control, and reliable-input frames in their original order.
Overflow and any control or ping before the corresponding admission state fail
closed. The client also suppresses pre-ready control and ping emission and
enqueues WELCOME_ACK before exposing the ready state. Positive and negative
tests cover delayed token issuance, control before HELLO, control before ACK,
and capacity exhaustion; the complete native stack then joined and submitted
inputs through this path.

The unreliable lane has no ordering relation with that stream. A datagram may
therefore arrive after WELCOME but before WELCOME_ACK even when both peers are
correct. Each pending session now owns one fixed-capacity input-bundle buffer;
pre-ACK datagrams replace its contents latest-only, and the selected bundle is
validated and processed on the first authoritative tick after admission. A
forced cross-lane regression proves the older bundle is replaced, nothing is
executed before the ACK, and exactly one bounded bundle is admitted afterward.

The native WebTransport client now owns a local close reason in fixed 256-byte
storage rather than retaining packet-loop scratch memory. It sends the
WT_CLOSE_SESSION capsule and CONNECT FIN, permits a bounded delivery/application
grace, closes the dedicated HTTP/3 connection with H3_NO_ERROR, and reports the
original application code and reason locally. A fresh ASan/UBSan build, the
native runtime test, and a live picoquic-to-Deno probe observed local code `1`
with `known-close-reason`; the former dangling reason and mapped 14-digit H3
code no longer appear.

Deno 2.9.7 currently resolves its server-side WebTransport `closed` promise
from the underlying QUIC connection and does not parse a post-handshake close
capsule on the retained CONNECT stream. Its server telemetry therefore reports
decimal `256` (`H3_NO_ERROR`) with an empty reason. The connection-wide QUIC
backlog transition is delivery evidence, not a capsule-specific application
acknowledgement, so this work does not claim Deno consumed the application code
or reason. A future generic/poolable client should prefer an observed peer
CONNECT FIN/reset before teardown while retaining the bounded deadline.

## 32-player full-stack admission and teardown diagnostics tranche

`pnpm stack` is now an evidence-bearing launcher rather than a process starter
that prints its requested bot count. Before `war-battles-stack:ready`, it must
observe all of the following:

- native Defold logs `arena-engaged:players=<authoritative roster>` after
  adopting `WELCOME.maximumPlayers` and building that complete presentation;
- the server health endpoint reports the native client and every requested
  browser bot as human-owned slots, the remaining bot count exactly, and at
  least one accepted authoritative input;
- each dashboard bot has applied a server snapshot, emitted a non-idle shared
  bot-brain command, sent input, and observed nonzero reconciled travel.

`--headless --exit-when-ready` runs that same composition as a finite local
acceptance gate. The verified arm64-macOS run used the complete 32-player
roster: one packaged native Defold/Dynamic-Hermes client and 31 independent
Chrome WebTransport sessions. It observed 503 bot snapshot applications and
1,559 bot input sends before success.

Admission now has an explicit client-side commit point. Receiving WELCOME
builds bounded client state but does not expose `ready` or call gameplay's
`onWelcome` until the ordered WELCOME_ACK write returns `sent`; controls and
pings stay gated during the write. Server sessions carry a monotonic diagnostic
id through close and reliable-dispatch errors, preserving the existing strict
pre-HELLO/pre-ACK rejection while making concurrent failures distinguishable.

The Deno host boundary also validates peer close metadata before forwarding it.
Codes outside uint32 or binary-looking decoded reasons are host corruption, not
application close facts, and become `1:invalid peer close metadata`. This is a
containment rule around an unstable host API, not evidence that Deno consumed a
WT_CLOSE_SESSION capsule. POSIX launcher services use owned process groups so
the packaged Node wrapper and its dmengine child can be terminated together,
including on `SIGHUP`; Windows uses bounded `taskkill /T` escalation for the
complete owned tree. Bounded cleanup remains part of the executable gate. The
focused protocol suite is 103/103 green and the complete War Battles gate is
207/207 green.

## Reliable WebSocket fallback tranche

The browser now has an executable fallback on the Deno server's existing TCP
health/control listener (`/ws`). It uses the same bounded five-byte reliable
frame envelope as WebTransport, reports `websocket-tcp`, and exposes no
datagram capability: tick inputs therefore use the explicit reliable
`input-fallback` lane. Arena connection order remains WebTransport first,
WebSocket second, then pre-welcome offline fallback. The focused adapter test
proves control and input lane delivery and rejects malformed frames; the
browser gate is `pnpm runtime:websocket`. This does not promote TCP to QUIC or
claim unreliable input semantics, native Defold WebSocket extension coverage,
WAN behavior, or WebTransport evidence.

## Bounded combat-feedback tranche

The arena now renders a one-shot sprite-only `muzzle` prototype at the
authoritative muzzle position for every observed `EVENT_FIRE`, including remote
players and mortar shots, while the bounded presentation-event and effect pools
retain capacity. The existing director-owned effect pool is the sole owner of
the created object: it records the returned id and deletes it after the fixed
animation lifetime, so no component callback can race a second deletion. The
source-level integration gate checks the factory/prototype and event wiring,
while native and browser runtime gates prove the updated game tree still loads,
runs, and tears down, and the focused project typecheck checks the remaining
generated contexts.
This closes a concrete product gap in issue #99's real-art and animation
acceptance without changing the core binding generator or introducing a
game-specific input route.

## Bounded camera impact tranche

The arena now reduces authoritative `EVENT_HIT`, `EVENT_EXPLOSION`, and
`EVENT_KILL` records to at most one reusable `camera_impact` message per update,
keeping the strongest impact when several records arrive together. The camera
accepts only nearby impacts, applies a fixed 180 ms deterministic envelope, and
clamps the shaken view against the same world rectangle as the follow view. The
phase is an incrementing scalar rather than a random source, so the same event
stream produces the same shake without a new bridge, queue, or per-frame
presentation allocation in the TypeScript state.

The integration gate proves the bounded aggregation, message route, decay, and
post-shake clamp structurally. Existing native and browser runtime gates prove
the updated project still loads, renders, and tears down; they do not claim a
specific combat event was visually observed during their fixed runtime window.

## Bounded announcer tranche

The GUI now has one authored `announcement` text node. It consumes the
authoritative presentation event ring and coalesces the newest kill notice:
local kills are emphasized as `YOU DESTROYED P#`, local deaths as
`P# DESTROYED YOU`, and remote-versus-remote kills remain visible without
claiming local credit. Offline round transitions use the authoritative
`PlayableBattle.round` counter through the same node. Notices have a fixed
180-update lifetime and are disabled in place when they expire; no GUI nodes,
queues, or per-event bridge objects are created at runtime.

The focused integration gate proves the authored node, kill-event route,
coalescing/expiry constants, and round text path. Existing native and browser
runtime gates prove the updated HUD still loads, renders, and tears down. They
do not claim that a particular kill or round notice was observed during their
short fixed runtime windows; event-specific visual observation remains a
separate runtime scenario.

## Bounded compact snapshot tranche

Authoritative snapshots use a session-local, fixed-capacity acknowledged
baseline. Protocol 12 leaves the 17,888-byte rollback image broad and projects
it into an exact 11,232-byte network image; the fixed recovery frame is 11,248
bytes. Established sessions receive sorted, non-overlapping changed-byte runs
against the exact snapshot the client applied and acknowledged, with a
keyframe at least every 20 snapshot frames.

The 15-byte projectile record is trajectory/event state, not a repeated pose.
It stores a slot generation, owner/content fields, exact Q8 direction and speed,
and two fixed-point phase invariants: `position - tick * displacement` modulo
the coordinate width and `tick + remainingLife` modulo 256. Straight motion is
therefore byte-identical. Spawn, bounce, pierce/correction and despawn change
the record and naturally become delta events; keyframes still enumerate every
live trajectory. Expansion reconstructs the exact rollback `x`, `y`, and life
at the snapshot tick and rejects noncanonical or out-of-range fields.

Ordinary frames are capped at 3 KiB. A frame up to 12 KiB consumes the one-per-
second recovery credit; larger frames close fail-closed. Only an admitted newer
state cancels an older unfinished stream. The client rejects a delta whose
exact base is unavailable and waits for the next periodic keyframe; it never
applies partial state. Focused tests cover all 512 live projectile slots,
straight-trajectory byte identity, exact reconstruction, reserved fields, and
recovery-budget admission.

## Bounded reconnect/resume tranche

After a welcome, the server issues one rotating 40-byte authenticated resume
credential per player slot. Closing an authenticated session releases the connection but reserves
that slot for a bounded, tick-based grace window; the world continues from its
existing player state with the bot takeover policy already used for a missing
human. A reconnect with the current token restores the same player id and
state, rotates the token again, and starts a fresh session-local snapshot
baseline. Its first authoritative frame is therefore a complete keyframe, and
the client clears all pending bytes and acknowledgement bits at the welcome
boundary before applying it. Token rotation is two-phase: a staged credential
becomes current only after the client echoes that exact credential in the
`welcome-ack` introduced by protocol 8 and retained by current protocol 12;
local enqueue success alone is not admission evidence.
A missing acknowledgement closes and releases the session after five seconds,
while failed or closed delivery retains the prior credential and its original
grace deadline. A snapshot send that reports a terminal transport
also closes the server session and releases the claimed slot.

Non-zero resume attempts never fall through to a new anonymous slot. Unknown,
stale, active-session, and foreign-match tokens all receive `REJECT_BAD_RESUME`;
anonymous joins can use only never-authenticated or expired reservations. The
credential is a fixed-size HMAC-SHA-256 token issued by the injected
`SessionTokenService`; its generation remains revocable through the bounded
`SessionLedger`. Focused tests cover identity/state retention, keyframe
recovery, token rotation, invalid/stale/foreign rejection, tampering, and
restart restore. A deployment must configure the same secret across restarts.
The durable session ledger covers admission identity/generation and reservation
state, while the Deno host's separate world checkpoint covers the fixed
`BattleWorld` simulation image. They are restored before admission; the world
restore rebases the admission clock against the ledger checkpoint.

The control-plane replacement seam is now implemented in
`examples/war-battles-online/core/session-auth.ts` and
`core/session-persistence.ts`. `SessionTokenService` issues and verifies a
fixed-size HMAC-SHA-256 credential with match/slot/generation/expiry claims and
bounded key rotation; malformed, foreign, stale, or expired credentials fail
closed. `SessionLedger` persists exactly `MAX_PLAYERS` fixed records in a
versioned, checksummed binary envelope, and `DurableSessionPersistence`
serializes explicit control-plane writes. The Deno file adapter uses a synced
sibling temporary file, rename, and parent directory sync (when supported) for
crash-durable checkpoints. Session expiry and grace deadlines use half-range
uint32 serial ordering across clock wrap. Focused tests cover tampering, key
rotation, expiry including wrap, exact acknowledgement, lost acknowledgement,
deterministic bytes, restart restore, and corruption/foreign-context refusal.
MatchServer now injects this service and
ledger at the hello/welcome boundary, while the Deno host restores and flushes
the ledger only at explicit lifecycle events; the simulation hot path remains
unchanged.

## Deterministic 32-player impairment/load tranche

`integration/check-authoritative-load.mjs` owns a machine-readable
`evidence/authoritative-load-32.json` record generated from the real
`MatchServer` and `BattleClient` protocol. The bounded in-process network seam
emulates the transport's ordered reliable-channel contract and verifies all
6,592 reliable sends were delivered without backpressure, while applying
reproducible 42 ms latency, ±25 ms jitter, 12% datagram loss, bounded datagram
backpressure, and datagram reordering to all 32 clients. The former fixed
two-tick lead reproduced a hidden failure: only 5,743 of 19,200 generated input
ticks were accepted (29.9%), while already-consumed redundant commands were
silently discarded and the evidence asserted only that some input succeeded.

`BattleClient` now derives one-way transit ticks from each applied snapshot's
tick versus its local predicted tick, subtracts the current lead to avoid a
self-amplifying estimate, keeps a three-tick jitter margin, and grows its lead
by at most one tick per authoritative frame up to the fixed 16-tick bound. Each
increase performs a real predicted/staged/transmitted catch-up step; it is not
metadata-only and adds no dynamic storage. The server uses fixed per-session
accepted/late tick rings to distinguish already-accepted redundant copies from
unique commands first seen after their simulation tick, including around the
32-bit tick wrap.

The current 600-tick run generated 19,348 commands, accepted 19,153 (98.992%),
classified 169 unique commands as late and 26 as never observed. Clients learned
a six-to-seven tick lead. The run delivered 17,016 datagrams, dropped 2,264,
backpressured 68 sends, observed 3,907 reordered datagrams, peaked at 144 queued
packets, and drained to zero pending packets. Every client completed welcome,
applied authoritative snapshots, and converged on tick 609 and the same final
hash with zero captured protocol errors. The harness fails below a conservative
95% unique-command acceptance floor, so connectivity or convergence alone can
no longer hide late-input collapse.

`REJECT_RATE_LIMITED` is a live-session advisory, not an admission failure. A
ready client records and logs it without entering `rejected` or invoking the
terminal rejection callback that can trigger offline fallback. Other reject
codes retain the terminal path; focused tests exercise both outcomes.
The source inventory and digest in the evidence prevent stale results from
being presented as current. This is deterministic transport/simulation load
evidence only; it excludes WAN behavior, native Defold networking, browser
WebTransport, allocation benchmarking, sanitizer results, and visual proof.

The focused 32-player codec test measured 1,918–3,160-byte normal deltas (p50
2,433) across a 200-frame veteran-bot trace, compared with the former fixed
17,568-byte message. The test proves keyframe reconstruction, exact-base
enforcement and malformed-run rejection. The codec loops use direct indexed
copies, so they create no typed-array views or heap objects after setup; the
server's final bounded payload view is a separate transport send-boundary
concern. These are in-process protocol and allocation-shape claims; they do
not claim WAN compression, packet-loss recovery latency, or a VM allocation
benchmark.

# Stage 3: over-the-top game expansion

Use data-driven definitions for content so new items do not require new bridge
code. The target showcase includes:

* multiple tank chassis with distinct mass, armor, speed, handling, and slots;
* ballistic, explosive, beam, rapid-fire, guided, area-denial, and support
  weapons;
* branching weapon upgrades, chassis upgrades, temporary match pickups, and
  readable counters;
* destructible or reactive combat spaces, hazards, objectives, team modes,
  free-for-all, and escalating bot encounters;
* strong hit feedback, particles, camera response, audio, announcer, combat
  text, spectating, scoreboards, and accessibility controls;
* React/hooks-driven Defold GUI once that renderer passes its own runtime and
  memory gates.

## Bounded Stage-3 chassis tranche

The first Stage-3 vertical slice is now implemented in the canonical
`examples/war-battles-online/core` source and mirrored into Defold. Four fixed
capacity chassis rows (scout, assault, bulwark, artillery) carry distinct
health/armour, acceleration/top speed, handling, knockback response, weapon
slot masks, roles, unlock costs, and presentation sprite ids. The authoritative
`BattleWorld` stores the selected chassis and a bounded unlock mask per slot;
reliable `CONTROL_SET_CHASSIS` spends credits once, then switches among unlocked
rows without charging again or refilling armour. Both fields are included in
the versioned compact snapshot so rollback, delta recovery, and resume restore
the same state. Bots start with deterministic role variety, filter weapon pads
by their slot mask, and may purchase the next row through the same world path.
The Defold adapter exposes the selection path on keys 7–0, renders generated
role-marked hulls, and shows chassis/role plus chassis-scaled health in the HUD.
Focused core tests cover stat distinction, one-time selection cost, weapon-mask
rejection, snapshot rollback/resume, fail-closed control input, and existing
32-player convergence. This tranche does
not claim the complete Stage-3 weapon families, destructible spaces, or final
renderer/accessibility work listed above.

## Bounded Stage-3 branching weapon tranche

The second Stage-3 vertical slice keeps the six existing weapons and adds two
data-driven branches to each (blast/piercer, overclock/stabilizer,
phase/capacitor, slug/fan, napalm/siege, and chain/shard). Each branch is a
fixed wire id with stat deltas applied to the base weapon at fire time; no new
bridge or protocol shape is required. A per-player 12-bit unlock mask and
packed six-weapon branch selection are authoritative fixed-capacity state.
The first selection spends credits once, while selecting an already-unlocked
branch is free. The selected branch is captured on each projectile so a later
selection cannot rewrite in-flight shots.

The reliable control lane carries branch selection, and the expanded versioned
snapshot preserves unlocks, selections, and projectile branch identity through
prediction rollback, delta recovery, and reconnect. Bots choose branches from
the same authoritative world path using a stable tick/slot hash. Defold exposes
branch one/two as Q/E and keeps the active branch in the compact HUD status.
Focused tests cover data rows, meaningful fire-time effects, one-time purchase,
free reselection, invalid IDs, reliable control, and snapshot restoration. The
raw world image is now 17,888 bytes and the keyframe is 17,904 bytes after
the fixed cover-health extension. Persistent destructible cover is documented
in the bounded tranche below; this content tranche does not claim final
accessibility or a VM allocation benchmark.

## Bounded Stage-3 command-beacon objective tranche

Team matches now have one deterministic central command beacon. The
authoritative world counts live team-1/team-2 tanks inside its fixed 96 px
radius each tick, advances signed progress toward the leading team, decays a
contested bar toward neutral, and awards a capture point at three seconds of
uncontested pressure. Owner, progress, both team scores, and capture events are
stored in the fixed snapshot header; the state was introduced in protocol 7
and remains mandatory in current protocol 8, so older peers fail closed. A three-point objective score ends offline team
rounds through the existing bounded restart path.

Bots periodically choose the beacon as a goal through their existing fixed
movement/input controller, so they contest it without an AI-only simulation
shortcut. The Defold HUD adds one authored text node for owner/progress/score
and consumes the authoritative capture event for a bounded announcement;
free-for-all matches remain inert because team-zero players never contribute.
Focused core coverage proves capture, event emission, snapshot restore, and
state-hash equality; integration coverage proves the authored HUD resource and
generated source path. This tranche does not claim arbitrary terrain editing,
network matchmaking, or human visual-quality review.

## Bounded Stage-3 rotating hazard tranche

Four point-symmetric environmental vents are deterministic map content. Their
centres are derived from `mapSeed`, while the active vent, four-second live
window, ten-second cycle, and half-second damage pulses are pure functions of
the authoritative tick. A live vent damages tanks in a fixed radius, emits a
bounded `EVENT_HAZARD_DAMAGE`, and can kill without awarding a player frag.
Because the schedule is derived rather than mutable, no terrain bytes are added
to the fixed snapshot; rollback, reconnect, and durable checkpoint restore keep
the same hazard phase from the restored tick.

Bots add deterministic repulsion from the active field to their existing
movement command, while the HUD reports the live vent/cooldown and hit/death
announcements. Focused core coverage proves symmetric open
vent placement, authoritative pulse damage, event delivery, and cycle handoff;
the 32-player replay/rollback and owned headless evidence are refreshed against
the new content. This remains a reactive hazard slice; persistent cover is
covered by the bounded tranche below, not by the vent schedule itself.

## Bounded Stage-3 destructible-cover tranche

The arena now layers up to 64 deterministic crate/sandbag panels over the
generated grid in a 64-entry fixed-capacity table. Each occupied panel has one
health byte (100 at match start), so
projectile impacts can authoritatively damage and destroy cover without putting
the 10,800-cell map on the wire. A destroyed panel becomes open to collision and
line-of-sight; bots already consume the same `solidAt`/LOS queries, so their
movement and target choices adapt to intact versus destroyed cover without a
second AI map.

Cover health is serialized in the versioned world snapshot (`SNAPSHOT_VERSION`
6), included in state hashes, rollback/reconnect, and durable checkpoint restore.
Older frames fail closed on the version/size check. The bounded event ring emits
`EVENT_COVER_CHANGED` for presentation; Defold renders a bounded impact effect
and announces panel destruction, while generated mirrors are refreshed only by
`integration/sync-defold-sources.mjs`. Focused tests prove fixed panel count,
deterministic damage, collision opening, snapshot state-hash equality, event
delivery, HUD/source integration, and the existing 32-player replay/rollback
coverage. This tranche does not claim arbitrary terrain editing or a WAN visual
quality review.

## Bounded Stage-3 pilot last-chance tranche

Tank destruction now transitions the authoritative player record from `tank`
to `infantry` instead of immediately awarding a kill. The on-foot pilot has a
smaller collision body, 24 health, a bounded pistol, no tank pickups or boost,
and a short post-ejection depot lock. A hostile moving tank may crush the pilot,
projectile splash remains lethal, and only terminal pilot death increments the
victim's deaths and the attacker's score. Existing arena spawn pads are the
deterministic replacement-tank depots; the HUD points toward the nearest depot
and reports its distance and lock countdown. Reaching one restores the selected
chassis through the ordinary spawn path.

Player mode is fixed-width authoritative state in snapshot version 7 and is
therefore covered by rollback, resume, state hashing, and deterministic bot
simulation. Bots use the same input contract as human players, walk toward a
depot while on foot, and now sample target position only at their configured
reaction cadence. Recruit and regular defaults carry larger persistent aim
error and lower trigger rates; the simulation no longer grants every bot a
perfect authoritative aim update each tick. Focused tests cover ejection before
scoring, terminal scoring, snapshot preservation, depot reacquisition, hostile
tank crushing, bot difficulty ordering, and the changed 32-player snapshot
trace. This is deterministic simulation and source-integration evidence, not a
human visual-quality or final balance claim.

## Stage-3 production-art pass

The tutorial-derived presentation is a functional integration fixture, not the
final showcase art. The production pass covers the entire visible game rather
than stopping at the HUD:

* one coherent pixel grammar for terrain, walls, destructible cover, tank
  depots, spawn pads, command beacons, thermal hazards, props, decals, tracks,
  craters, and wreckage;
* four readable chassis families with separate turrets, four player-brand
  palettes, weapon-specific projectiles, pickups, muzzle flashes, impacts,
  explosions, smoke, and wreck states;
* four reusable driver variants for the 32 deterministic player identities.
  A driver remains attached to its player slot across tank, ejected-infantry,
  death, and replacement-tank states; repeated character art is intentional,
  while callsign and player-brand colour distinguish the slot;
* authored title, loadout, combat HUD, leader board, objective display, kill
  feed, minimap, and last-chance/depot guidance with no debug-text wall; and
* at least three visual arena themes which share the authoritative collision
  and gameplay grammar, so presentation variety does not fork simulation rules.

`design/mockups/gameplay-world-v1.png`, `gameplay-hud-v1.png`, and
`title-loadout-v1.png` are zero-runtime-evidence art-direction targets. Runtime
assets must remain mechanically reproducible: immutable source generations and
request manifests live under `art/source/`, while deterministic slicing,
padding, anchors, atlases, tilesources, and freshness metadata live under
`defold/assets/derived/` and their owning tools. Sprite Fusion is the sponsored
pixel-art production service and must be credited on the shipped title screen.
The first approved portrait family and eight-frame idle animation cost 30
credits; no concept-only pass may consume API credits.

Sprite Fusion's documented direct API owns source-art generation: terrain
candidates, pickups, depots, cover, hazards, objectives, items, drivers,
ejected infantry, tank motion, and effects. Its browser Tilemap Editor has no
documented automation API and is therefore not a build dependency. Checked-in
local generators and Defold's native formats own tileset layout, adjacency
rules, weighted variants, collision layers, `.tilemap`, `.tilesource`,
gameplay-role metadata, palette variants, atlas packing, seeded arena
realization, and freshness checks. Defold's editor remains the native visual
inspection and optional authoring surface.

The first world-art experiment is intentionally classified rather than silently
promoted. `refinery-pickup-pedestal-v1` produced a useful prop family and its
compact first candidate is approved as the common pickup base. The request named
`refinery-basalt-floor-v1` did not produce seamless opaque floor tiles; selected
outputs are retained only as vents, fissures, and pipe props. Basalt terrain
remains unresolved until the checked-in tileset generator emits an explicit
edge grammar and its edge-continuity checks pass.

The approved prop subset is now wired through that boundary. The checked
`generate-world-art.mjs` projection validates the immutable request, asset,
hash, dimension, and selection records and emits six normalized 16 px cells.
`generate-art.mjs` imports those cells into the one Defold arena tilesource.

Terrain realization now has one shared semantic projection instead of two
similar hand-written maps. `core/arena-visual.ts` projects an authoritative
`ArenaMap` into caller-owned ground, decor, and mark role buffers. It declares
the north/south/east/west mask bits and all sixteen four-neighbour wall-mask
results explicitly. `generate-art.mjs` maps those roles into three complete
themes (`frontier`, `refinery`, and `canyon`) and emits the TypeScript tile-id
contract consumed by both the checked `.tilemap` generator and the live Defold
component. The generator proves opaque wall coverage, clean interior seams, a
one-pixel perimeter, wrap-safe sandbags, all sixteen masks, and all required
role tables for every theme. A seeded temporary-output test materializes all
three native Defold `.tilemap` variants without changing collision rules.

The runtime retains six fixed 10,800-byte role buffers and reprojects only when
the authoritative map seed changes. Steady frames therefore allocate nothing
and issue no tilemap calls; a seed transition writes only cells whose resolved
Defold tile id changed, then swaps the current and scratch buffers. The default
frontier map remains the checked project resource. The dedicated
`runtime:arena-theme` gate now compiles a temporary, exactly representable seed
through Bob, observes the refinery projection marker from the live packaged
native engine, requires component teardown, then restores the authored
collection byte-for-byte and deletes its isolated build output. This is native
runtime/control-flow evidence, not a screenshot or aesthetic oracle. Defold
editor number properties pass through a float representation, so editor-authored
seed values must remain in the exact integer range; full-width uint32 protocol
seeds remain authoritative after they enter the TypeScript world.

This closes the previously unresolved deterministic terrain grammar, but not
the whole production-art pass. The generated palette themes currently reuse
one structural tile family, and the authored HUD/title/minimap/leader-board,
driver animation, wreckage, crater, and broader environment-detail targets
above remain open.

## Bounded performance and operability evidence tranche

`integration/check-performance.mjs` owns a deterministic 32-slot, 600-tick
fixture over the real `BattleWorld` and snapshot codec. It records p50/p95/p99
simulation and frame operation-cost percentiles after a 60-tick warm-up, plus
keyframe/delta counts, total and per-simulated-second snapshot bytes, and
reconciliation drift immediately before authoritative restore. The current
record contains 540 measured ticks, 150 snapshot frames (eight periodic or
recovery keyframes and 142 deltas), 218,587 total snapshot bytes, and a maximum
53 fixed-point-unit pre-restore error; post-restore error is zero.

The same run reports observable high-water/failure counters for all 32 player
slots, 512 projectile slots, 32 pickups, the 256-entry presentation-event ring,
and the fixed snapshot frame buffer. It explicitly marks the native/VM arena as
unobservable. Allocation evidence is not yet measured: the record explicitly
leaves both VM allocation counts and transitive source-shape inspection unset.
The snapshot boundary records its six caller-owned buffers and five `DataView`
constructions per snapshot, but that is structure rather than a heap-allocation
measurement. No Hermes/VM, Defold, native-heap, browser-queue, or wall-clock
allocation/timing claim is made. The evidence inventory and digest bind the
record to the canonical core and harness sources, and the focused test rejects
stale records.

## Self-hosted and packaged-browser multiplayer tranche

The authoritative `server/deno-main.ts` now has a separate HTTP liveness and
readiness plane, is packaged as a pinned Deno Docker service with an explicitly
published QUIC/UDP port, and retains its short-lived local certificate across
container restarts. `integration/check-local-multiplayer.mjs` proves two real
Chrome WebTransport sessions receive distinct authoritative player slots in the
same match, apply snapshots, and send input datagrams. The Docker image itself
builds and reports healthy on the local Colima backend. Its external Chrome gate
correctly failed there because Colima's default macOS user-mode network did not
forward the published QUIC/UDP path; containerized UDP ingress therefore remains
environment-dependent evidence and must not be inferred from `/readyz`.

The deterministic Docker owner gate checks the rendered Compose mounts, restart
policy, `/readyz` healthcheck, and the entrypoint's private generated resume key
plus fixed session-ledger paths. The key helper proves first-boot generation,
restart-stable bytes, permissions, and malformed-state rejection; the Deno/Chrome
WebSocket gate (with its `--docker` mode) separately proves the labelled
`websocket-tcp` reliable fallback, restarts the container, and resumes the same
slot; it never promotes that transport to WebTransport or datagrams.

`integration/check-packaged-online.mjs` closes a different boundary: the actual
Bob-produced Defold/Wasm game runs in Chrome, the generated browser host loads
the deherm bundle, `arena.script.ts` connects through the production
target-neutral `WebTransportGameClient` over the generated `WebTransport`
constructor, and its fixed-shape live telemetry reports the
selected transport/input lane, online state, received snapshots, and sent
inputs. A development-only browser configuration object supplies the loopback
URL, optional WebSocket endpoint, and certificate hash before engine startup,
while `game.project` remains the production configuration authority. The normal
gate proves `webtransport-h3-quic` plus datagram input; its `--fallback` mode
makes only QUIC unavailable and proves the same packaged game selects
`websocket-tcp` plus the reliable `input-fallback` lane. Both modes require an
authoritative welcome, snapshots, and server-accepted input.

The game source no longer imports a provider-specific native adapter or pumps
transport events itself. Browser and native builds share the same structural
streams/datagrams consumer; browser construction delegates to the host global,
while native construction is supplied by the generated extension facade and
its hidden once-per-frame runtime pump.

The native Defold full-stack gate on 2026-09-25 exposed and then closed two
transport-only failures that the browser gate could not reveal. First,
client-originated hello/control frames used separate QUIC streams and could be
delivered out of order; they now share one ordered bidirectional lane. Second,
one-stream-per-snapshot exhausted the native facade's 64 active stream handles;
the client now retires a complete one-frame snapshot immediately and the server
treats that peer retirement as packet-local backpressure. The server caps eight
outstanding state streams with a 300 ms stale deadline, aborts acknowledged
streams before releasing their slots, and both sides retain a 64-snapshot
exact-base history so WAN acknowledgements and sibling deltas may complete out
of order.
Focused exact-wire/core tests passed, real Chrome-to-Deno WebTransport passed,
and a manually observed rebuilt native Defold-to-Deno session remained admitted
with continuous telemetry for more than 45 seconds—well beyond the former
roughly three-second 64-stream failure—with no stream-limit close or
missing-base report. The checked evidence artifacts cover the shorter packaged
runtime and real WebTransport gates; the 45-second observation is not a sealed
artifact. This is loopback correctness evidence, not WAN loss/latency evidence.

This tranche does not yet claim WAN deployment, matchmaking/account identity,
network failover, or dedicated-server failover.

## Snapshot bandwidth and projectile replication

The simulation already uses integer fixed point: positions have 1/16-pixel
precision, headings use Q8 direction vectors, and velocity has its own 1/256
sub-unit scale. The initial network codec nevertheless treated the complete
17,888-byte rollback image as its keyframe and byte-diff source. That made
unused capacity—not gameplay state—part of the bandwidth bill.

Protocol 14 keeps the fixed rollback image in memory but projects an exact
10,144-byte network image before emitting sparse keyframes and gap/length-
varint deltas. Each player record is an exact 62-byte schema projection rather
than a copied 96-byte rollback record. Velocity uses the simulation's explicit
3× impulse-speed component bound, reasserted after all tick impulses;
countdowns encode stable expiry phases, and
accepted input tick/sequence coordinates are relative to the enclosing
snapshot tick. Inactive projectile slots serialize only their generation;
stale pool bytes are not logical world state. Projectile trajectory phase makes
straight flight byte-identical across snapshots, so the delta codec carries
lifecycle/trajectory changes rather than repeated `x/y/life` updates.

The deterministic 32-player, 15 Hz trace records 14,466 application payload
bytes/second/client (115,728 bit/s), an 858-byte median, a 1,968-byte p95,
and a 3,621-byte largest keyframe. Projectile attribution remains 15,287 bytes
per ten-second trace. Local input remains sampled and predicted at 60 Hz, while
the unreliable lane emits at 30 Hz. Its two new commands plus prior two-command
window share one identity, acknowledgement, tick, and sequence header and cost
50 bytes instead of four 32-byte packets. This reduces upstream application
payload from 5,760 to 1,500 bytes/second/client. These numbers exclude QUIC,
HTTP/3, TLS, UDP, IP, Ethernet, retransmission, acknowledgement, and congestion
overhead.

This mirrors the mechanism visible in id's released source rather than treating
“60 Hz input” as “60 packets per second”:
[`CL_CreateNewCommands`](https://github.com/id-Software/Quake-III-Arena/blob/master/code/client/cl_input.c)
samples commands at the client frame cadence, while `CL_ReadyToSendPacket`
accumulates them behind the `cl_maxpackets` throttle; the stock
[`cl_maxpackets` and `cl_packetdup` defaults](https://github.com/id-Software/Quake-III-Arena/blob/master/code/client/cl_main.c)
are 30 and 1 respectively.

The runtime enforces a 3,072-byte ordinary-frame ceiling plus at most one
10,160-byte recovery frame per second. At 15 Hz that is a hard application-
payload admission bound of 53,168 bytes/second/client (425,344 bit/s), or
1,701,376 bytes/second for 32 clients. Run metadata (37,395 bytes) and player
changes (86,242 bytes) dominate the ten-second trace; projectiles are no
longer the primary target. A field-aware player delta with separate exact owner
correction and remote presentation state is the next useful compression step.
Any further narrowing or presentation quantization still requires an explicit
range and error budget rather than an unchecked cast.

Projectile replication follows state semantics, not a blanket “projectiles are
events” rule. Hitscan weapons are fire/impact events. Missiles remain
authoritative entities, but their wire state is trajectory-shaped: create or
bounce establishes slot/generation, base tick/position, direction and speed;
despawn/impact is an event; unchanged motion is evaluated from that trajectory
instead of retransmitting x/y/life every snapshot. A keyframe still enumerates
all live missile trajectories, and acknowledged-baseline deltas retain
fail-closed recovery. This follows the useful Quake III split between compact
entity-state trajectories and short-lived entity events without copying its
float-based representation.

Evidence owner: `integration/check-performance.mjs`; checked artifact:
`evidence/performance-operability.json`. Current targets are 24,000 ordinary
and 64,000 adversarial payload bytes/second/client, p95 at 1,100 bytes, and an
8,000-byte keyframe. Ordinary downlink, adversarial bound, keyframe, and
upstream targets pass; the 8,000-byte stretch and 1,100-byte p95 remain open.

Authenticated resume credentials, fail-closed durable admission, and local
Docker process-restart resume are now proven at their named boundaries.
The Deno host also owns a fixed-size, versioned and checksummed authoritative
world checkpoint. It restores the checkpoint before opening transport listeners,
writes at an explicit 60-tick control-plane boundary and during orderly
shutdown, coalesces slow storage to one active plus one latest pending image,
and atomically replaces the state file. Match/arena/roster/team-mode identity is
repeated outside the canonical world payload; truncated, corrupt, or foreign
checkpoints fail closed. Restore rebases the admission clock against the
session ledger so the world tick is not counted twice. The focused restart test proves state-hash equality
and restored tick/state before a new session is admitted. Slow and failing
storage tests prove the retained queue stays bounded and that the single latest
retry can recover without preserving an unbounded history. This remains local
Deno/Docker evidence, not a claim that Colyseus H3 interop is complete.
Protocol-10 acknowledgement, exact WebSocket Origin admission, non-root runtime
ownership, fsync-backed atomic replacement, and wrap-safe deadlines are now
implemented and covered by focused owner tests. Compose uses a bounded root-only
volume migrator and runs the long-lived server as uid/gid 10001. These are
control-plane correctness claims; a trusted public certificate, application
identity/matchmaking, secret management, and WAN failover remain separate
deployment frontiers.

# Verification

The release gate is one reproducible command that builds and exercises all
profiles, plus a long-running 32-bot soak. Record:

* p50/p95/p99 frame and simulation time;
* bridge calls and bytes per frame;
* allocations after warm-up, pool high-water marks, and arena failures;
* snapshot bandwidth and reconciliation error;
* retained binding symbols and bundle size per target;
* sanitizer, leak, disconnect/reconnect, and browser memory results.

The showcase is successful when it demonstrates the SDK under real load and
the same TypeScript gameplay source works across native and HTML5 targets.

The local HTML5 playability gate builds the current project through pinned Bob
and Extender, engages the arena through real Chrome keyboard events, queries
the Defold-owned WebGL context, analyzes Chrome's composed frame for visible
and diverse pixels, and retains a screenshot for human inspection. That is
input/render evidence under software WebGL, not hardware-GPU parity or an
aesthetic regression oracle.
