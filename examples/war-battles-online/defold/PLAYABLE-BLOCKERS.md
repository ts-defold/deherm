# Playable attachment evidence and remaining blockers

The example is a top-down arena deathmatch built out of déherm TypeScript
components. Gameplay runs as Defold game objects with sprite, factory and
collision-object components; the GUI is the HUD. The 32-tank presentation mockup
is retained, unbuilt, under [`reference/`](./reference/README.md).

## Evidence superseded by the Ultimate Edition

**Read this first.** The two packaged-engine evidence documents -
[`../evidence/packaged-runtime-arm64-macos.json`](../evidence/packaged-runtime-arm64-macos.json)
and [`../evidence/browser-runtime-wasm-web.json`](../evidence/browser-runtime-wasm-web.json)
- were recorded against the tutorial-scope scene. Rebuilding that scene into the
arena changed the authored project tree they are hash-bound to, so both are now
**stale and must be re-recorded**. Neither gate was weakened: they still refuse.

Re-recording is a real engine run, not a file edit. It needs Bob, a running local
Extender (`pnpm extender:status`) and a rebuilt custom engine, and for the
browser a fresh `wasm-web` bundle:

```sh
# native
pnpm bob:local:bundle
pnpm --filter @deherm/example-war-battles-online runtime:packaged:record

# browser
DEFOLD_HERMES_PROJECT=examples/war-battles-online/defold pnpm bob:web:bundle
pnpm --filter @deherm/example-war-battles-online runtime:browser:record
```

`test/integration.test.mjs` carries a skipped test naming this debt and a
companion test asserting that `check-packaged-runtime.mjs --check-sources`
actually reports the staleness rather than passing quietly. Delete the skip when
the evidence is re-recorded.

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

## Observed packaged-engine run (tutorial-scope scene, superseded)

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

Not observed in engine output, and therefore not claimed:

* pixel output. No screenshot or frame capture was taken. The tilemap, atlases,
  fonts, sprites, and GUI scene all compiled and loaded without a resource or
  component diagnostic, but "it renders correctly" is unverified.
* keyboard input. `on_input` is wired to arrows, WASD, space, shift and `1`-`6`,
  and the same `dispatchInput` path is exercised by the retained reference
  component, but no key event was injected into this port by any gate. A human
  has driven it in a browser; that is a report, not evidence this repository
  holds.
* everything the arena does. The run above predates it entirely.

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

`../evidence/bundle-size.json` is stale, but for reasons outside this port: the
measured entry only moved from `main/battle.gui.ts` to `reference/battle.gui.ts`,
while the recorded source byte and file counts changed with an unrelated
in-flight SDK regeneration. Re-record it with `pnpm bundle:size:update` once that
lands.

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
* **Not proven anywhere:** a real QUIC session. No gate in this repository has
  opened one. `server/deno-main.ts` and the certificate procedure are written and
  typechecked; Deno is not installed in the environment that wrote them.
* **Native Defold has no WebTransport client.** `arena.script.ts` detects the
  missing global, logs `war-battles:arena-online-unavailable:no-webtransport`
  and plays offline. Generating that extension through the normal binding
  pipeline remains the blocker it always was.
* The resume token issued by `MatchServer` is a keyed hash, not a signed
  credential. It proves the reconnect *path*, not the reconnect *security*, and
  says so at its definition.

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
