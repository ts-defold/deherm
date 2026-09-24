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
snapshot interval advertised by the server (three ticks / 20 Hz by default).
The local slot remains an immediate read from its predicted/reconciled world.
Defold tank components consume this caller-owned sample, while a failed dial,
pre-welcome reject, or pre-welcome close returns to the offline `PlayableBattle`
that was created at arena start.
This is presentation smoothing and connection fallback evidence; compact
snapshots and reconnect-after-welcome are now covered by focused in-process
evidence; the broader multiplayer release gate remains open.

## Real browser WebTransport tranche

The production `GameTransport` adapter now passes a loopback Chrome-to-Deno 2.9
HTTP/3/WebTransport gate. Chrome completes the 32-player authoritative welcome,
applies multiple 20 Hz snapshots over the reliable lane, sends tick inputs as
QUIC datagrams, and observes the authoritative MatchServer accept them.
Repeated reliable frames use the existing bounded five-byte framing; focused
adapter tests prove one persistent server stream and latest-only snapshot
backpressure, while the loopback record makes no stream-open-count claim. The
evidence artifact is mechanically source-bound, records the browser and Deno
versions, and explicitly excludes WAN, ingress, native Defold, impairment,
load, persistent-stream runtime, and allocation claims. Those remain separate
gates rather than implied by loopback transport success.

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

Authoritative snapshots now use a session-local fixed-capacity baseline. A
joining or recovering session receives a complete 17,576-byte keyframe (the
16-byte protocol/codec header plus the 17,560-byte raw world image). Established
sessions receive sorted, non-overlapping changed-byte runs against their last
sent baseline, with a keyframe at least every 20 snapshot frames. The browser
transport's latest-only backpressure path forces the next frame to be a
keyframe, so replacing a pending delta cannot poison the client's base tick.
The server permits one snapshot send in flight and retains exactly one latest
pending raw state; a pending replacement is always encoded as a keyframe after
the in-flight result resolves.
The client rejects a delta whose exact base is unavailable and waits for the
next periodic keyframe; it never applies a partial state.
The frame decoder also rejects nonzero reserved/header fields. After any decode
or world-restore failure, the client reports the root error once, drops pending
dependent deltas, and waits for a valid keyframe before accepting the stream
again.

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
becomes current only after the client echoes that exact credential in a
protocol-v8 `welcome-ack`; local enqueue success alone is not admission evidence.
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
6,224 reliable sends were delivered without backpressure, while applying
reproducible 42 ms latency, ±25 ms jitter, 12% datagram loss, bounded datagram
backpressure, and datagram reordering to all 32 clients. A 600-tick run accepted
5,691 inputs, delivered 16,916 datagrams, dropped 2,261, backpressured 23 sends,
observed 3,714 reordered datagrams, peaked at 130 queued packets, and drained to
zero pending packets. Every client completed the welcome, attempted 600 inputs
(598–600 delivered), applied authoritative snapshots, and converged on the
server's final tick/hash with zero captured protocol errors.
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
raw world image is now 17,760 bytes and the keyframe is 17,776 bytes; the
updated 200-frame trace measures 1,869–3,201-byte normal deltas (p50 2,438).
This tranche does not claim persistent destructible spaces, final
accessibility, or a VM allocation benchmark.

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
generated source path. This tranche does not claim destructible terrain,
network matchmaking, or human visual-quality review.

## Bounded performance and operability evidence tranche

`integration/check-performance.mjs` owns a deterministic 32-slot, 600-tick
fixture over the real `BattleWorld` and snapshot codec. It records p50/p95/p99
simulation and frame operation-cost percentiles after a 60-tick warm-up, plus
keyframe/delta counts, total and per-simulated-second snapshot bytes, and
reconciliation drift immediately before authoritative restore. The current
record contains 540 measured ticks, 200 snapshot frames (one 17,776-byte
keyframe followed by 199 deltas), 440,267 total snapshot bytes, and a maximum
42 fixed-point-unit pre-restore error; post-restore error is zero.

The same run reports observable high-water/failure counters for all 32 player
slots, 512 projectile slots, 32 pickups, the 256-entry presentation-event ring,
and the fixed snapshot frame buffer. It explicitly marks the native/VM arena as
unobservable. Allocation evidence is not yet measured: the record explicitly
leaves both VM allocation counts and transitive source-shape inspection unset.
The snapshot boundary records its four caller-owned buffers and two `DataView`
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
`BrowserWebTransportClient`, and its fixed-shape live telemetry reports the
selected transport/input lane, online state, received snapshots, and sent
inputs. A development-only browser configuration object supplies the loopback
URL, optional WebSocket endpoint, and certificate hash before engine startup,
while `game.project` remains the production configuration authority. The normal
gate proves `webtransport-h3-quic` plus datagram input; its `--fallback` mode
makes only QUIC unavailable and proves the same packaged game selects
`websocket-tcp` plus the reliable `input-fallback` lane. Both modes require an
authoritative welcome, snapshots, and server-accepted input.

This tranche does not claim native Defold networking, WAN deployment,
matchmaking/account identity, network failover, or dedicated-server failover.
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
Deno/Docker evidence, not a claim that Colyseus H3 interop or native Defold
transport is complete.
Protocol-v8 acknowledgement, exact WebSocket Origin admission, non-root runtime
ownership, fsync-backed atomic replacement, and wrap-safe deadlines are now
implemented and covered by focused owner tests. Compose uses a bounded root-only
volume migrator and runs the long-lived server as uid/gid 10001. These are
control-plane correctness claims; a trusted public certificate, application
identity/matchmaking, secret management, WAN failover, and native Defold
transport remain separate deployment frontiers.

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
