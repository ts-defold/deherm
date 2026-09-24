# Playable attachment evidence and remaining blockers

The example is a top-down arena deathmatch built out of déherm TypeScript
components. Gameplay runs as Defold game objects with sprite, factory and
collision-object components; the GUI is the HUD. The 32-tank presentation mockup
is retained, unbuilt, under [`reference/`](./reference/README.md).

## Current native and browser evidence

### Reachable-only Static Hermes projection

The project now records a separate generated Static Hermes projection at
[`../evidence/static-hermes-reachable-arm64-macos.json`](../evidence/static-hermes-reachable-arm64-macos.json).
Run `node bin/deherm.mjs typecheck --project examples/war-battles-online/defold
--release` before generating it; the generator then reads the release usage
manifest, canonical lowering plan, and typed-native adapter census. The current
record has 27 reachable routes, all 27 selected for Static Hermes, and zero
reachable blockers. The canonical typed-native exact set is 517/517 routes.
The project-owned bridge source is pinned at SHA-256
`d8b7183d3f003300e068f840673221d15dae9d68be9f98310ec993fd9fb3eb1f`.

The project-owned gate report at
`build/gates/war-battles-static-hermes-project/report.json` records passed
Static Hermes compilation and Bob/Extender linkage, plus an engine launch that
observed the typed-native unit registration marker. This report is generated
build output and is intentionally not copied into tracked evidence.

This is an honest product projection, not a gameplay claim: no packaged War
Battles application has executed entirely as Static Hermes yet. The record
keeps full-game Static AOT gameplay, Defold semantics, visual behavior, and
allocation/performance out of the claim. Full War Battles gameplay remains
Dynamic Hermes. `pnpm check:war-battles-projections` regenerates the record in
memory and fails if the checked-in evidence or any named blocker drifts.

The two checked evidence documents -
[`../evidence/packaged-runtime-arm64-macos.json`](../evidence/packaged-runtime-arm64-macos.json)
and [`../evidence/browser-runtime-wasm-web.json`](../evidence/browser-runtime-wasm-web.json)
- are current for the arena project. They were re-recorded from clean Bob builds
on 2026-09-22. The native projection loaded the bundle through Dynamic Hermes,
made the generated Static Hermes transport reachable, detected 315 generated
Lua symbols, ran the tutorial collision/score sequence, engaged the eight-player
offline arena, and exited through `@system/exit` with code 0. The browser
projection loaded the same bundle fingerprint through the browser host and ran
the same game-owned marker sequence.

The reproducible commands are:

```sh
# native
pnpm bob:local:bundle
pnpm --filter @deherm/example-war-battles-online runtime:packaged:record

# browser
DEFOLD_HERMES_PROJECT=examples/war-battles-online/defold pnpm bob:web:bundle
pnpm --filter @deherm/example-war-battles-online runtime:browser:record
```

The separate browser playability gate sends real Chrome keyboard events. It
observes movement, firing, a generated sound cue, and an `R` restart that advances
the round to two. It also requires a live WebGL 2 context and analyzes a composed
browser screenshot rather than the cleared default framebuffer.

### What changed in the marker contract, deliberately

The scripted demonstration is unchanged: the same one-second shot, the same
ten-second tour, the same coordinates, and all ten of the game-owned markers the
gates assert. Two markers were **added**, because "the tutorial loop ran" and
"the game started" are different claims and only the second one is now the
interesting part:

```text
war-battles:arena-init:players=8:online=0
war-battles:arena-engaged:players=8:skill=2:seed=1463898690:mode=offline
```

The browser gate's in-engine component count moved from **five to eight**: the
arena director, the tank hull/turret renderer and the pickup pad joined the four
original components and the retained presentation mockup. It is exported from
the gate as `EXPECTED_COMPONENT_COUNT` and asserted a second time in
`test/integration.test.mjs` against the generated component manifest, so the
number inside the engine and the number on disk cannot drift apart.

## Observed packaged-engine run

A custom arm64-macOS engine built through the pinned local Extender was launched
from `build/default` on 2026-09-18. Defold 1.14.0 loaded the archive, created
the Vulkan device, sound device, and the Box2D v2.2.1 physics context, detected
the exact runtime profile, loaded bundle generation 1, and emitted the complete
game-owned marker sequence with no `ERROR:`, `FATAL:`, `RESULT_SCRIPT_ERROR`,
`stack traceback:`, bundle-rejection, or component-runtime diagnostic:

```text
INFO:DEFOLD_HERMES: war-battles:ui-init
INFO:DEFOLD_HERMES: war-battles:player-init:560.0:360.0
INFO:DEFOLD_HERMES: war-battles:rocket-init:1.00:0.00
INFO:DEFOLD_HERMES: war-battles:player-fire:560.0:360.0:1.00:0.00
INFO:DEFOLD_HERMES: war-battles:rocket-hit
INFO:DEFOLD_HERMES: war-battles:score:100
INFO:DEFOLD_HERMES: war-battles:player-moved:739.9:360.0
INFO:DEFOLD_HERMES: war-battles:rocket-explosion-done
```

That sequence is the whole tutorial loop:

* a `.gui.ts` component resolved `gui.get_node("score")` and wrote it;
* a `.script.ts` component read its own position through `go.get_position`;
* `factory.create` spawned `/main/rocket.go` with a typed `dir` vector3
  property, and the spawned component observed exactly `(1, 0, 0)`;
* Defold physics delivered `collision_response` from the `rockets` group to the
  `tanks` group and the rocket deleted the reported `other_id`;
* `msg.post("/gui#ui", "add_score", { score: 100 })` crossed from a game-object
  component to a GUI-scene component and the score node was rewritten;
* `msg.post("#sprite", "play_animation", …)` played the once-forward explosion
  and Defold returned `animation_done` to the rocket, which deleted itself;
* `go.set_position` advanced the player 179.9 px over the one-second scripted
  move, so the frame loop, not just `init`, drives engine state.

Not observed by the native transcript, and therefore not claimed by that
projection:

* pixel output. Browser/WebGL pixel evidence is held by the companion browser
  playability projection, not inferred from this native transcript;
* keyboard input. The browser playability gate owns the keyboard claim;
* every arena branch, bot decision, weapon, or multiplayer transport. Dedicated
  deterministic tests own the 32-player simulation claim, and no real QUIC
  session has been observed yet.

## Provider defects fixed to reach this point

Two defects in the packaged component provider were exposed the first time a
real game-object component was attached; both are fixed in
`defold/defold_hermes`:

1. `component_hermes_backend.cpp` read editor properties off the component
   `self` with `lua_rawget`. Defold hands a script or GUI component a *userdata*
   `self` whose metatable resolves declared properties, so the raw read both
   missed every property and crashed LuaJIT. It now uses `lua_gettable`.
2. Generated current-instance thunks (`go.get_position`, `go.set_position`,
   `go.set_rotation`) resolve against the innermost active game-object context,
   which was only ever pushed by the legacy bootstrap attachment. Every such
   call from a component failed closed with `No active game-object context`.
   `active_game_object_context.hpp` now carries an installable
   `CurrentInstanceApi`; `extension.cpp` installs a resolver that borrows the
   game object Defold is currently dispatching, and the component backend
   publishes it for the duration of a game-object dispatch.

## Component runtime gate

The generated global manifest still reports
`state: native-dynamic-hermes-harness-executable` and
`runtimeConformant: false`, and the generation-only API readiness gate still
reports `gameplayExecutionObserved: false`. One example run does not promote
every component context, lifecycle, runtime target, or API.

The dependency link is intentionally a monorepo development layout. A standalone
distribution must replace it with a versioned Defold library archive whose root
exports `defold_hermes`.

## Recorded and outstanding evidence

`integration/packaged-runtime-evidence.mjs` now requires the tutorial markers
above, and `../evidence/packaged-runtime-arm64-macos.json` was re-recorded
against this build: `pnpm runtime:packaged`, `runtime:packaged:record`,
`runtime:packaged:check`, and `runtime:packaged --check-sources` all pass, and
the process still terminates on SIGTERM with no rejected diagnostic.

`../evidence/bundle-size.json` is current for the authored source census and
compiled JavaScript bundle. Generated extension trees and target selector state
remain outside the authored-source count so switching targets does not corrupt
the measurement.

## Online boundary

The built Defold project now drives the simulation in `core/`, and
`arena.script.ts` will open a `BattleClient` over the browser WebTransport
adapter when `game.project` declares `[war_battles] server`. What that does and
does not prove:

* **Proven, in `test/core.test.mjs` over the in-memory transport pair:** two
  clients joining one authoritative match and taking bot slots over; the
  predicting client's state matching the server's exactly; a client that falls
  behind reconciling by replaying its own inputs; a full match refusing a further
  session with a typed reject; a session's forged packet for another player's
  slot being rejected without moving that tank; an upgrade bought over the
  reliable control lane.
* **Browser transport is proven on both lanes:** the owner gates open a real
  QUIC/WebTransport session and a forced WebSocket/TCP fallback from the
  Bob-produced HTML5 game, then require authoritative snapshots and
  server-accepted input. Native Defold still needs a native transport adapter
  and otherwise plays offline.
* Resume tokens are fixed 40-byte HMAC-SHA-256 credentials with bounded,
  persisted generation state. The Docker restart gate proves that the same
  player resumes after the server container restarts; it is not a claim of
  matchmaking, account identity, abuse prevention, or cross-region failover.

## Route shapes this port deliberately does not use

The scene is shaped by the bindings that have actually executed inside a
packaged engine, not by what the generated surface declares:

* `go.set_position` / `go.set_rotation` / `go.get_position` are used only in
  their current-instance shape, so every entity moves itself and the director
  moves nothing. This is why a tank is two game objects.
* Object visibility is creation and deletion, not `enable`/`disable` messages.
* The HUD is text only. `gui.get_node` and `gui.set_text` are the two GUI routes
  with a packaged-engine observation behind them; `gui.set_size`, `gui.set_color`
  and `gui.play_flipbook` are declared and used by the retained mockup, but this
  port does not depend on them.
* Pointer input is not bound. Defold's input-action shape for pointer motion has
  not been executed through the generated binding, so the turret uses a target
  assist rather than a guess at an unproven route.
