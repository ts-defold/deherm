# Playable attachment evidence and remaining blockers

The example is now a port of the Defold War Battles tutorial rather than the
GUI-only presentation mockup. Gameplay runs as Defold game objects with sprite,
factory, and collision-object components; the GUI is one score text node. The
mockup is retained, unbuilt, under [`reference/`](./reference/README.md).

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

Not observed in engine output, and therefore not claimed:

* pixel output. No screenshot or frame capture was taken. The tilemap, atlases,
  fonts, sprites, and GUI scene all compiled and loaded without a resource or
  component diagnostic, but "it renders correctly" is unverified.
* keyboard input. `on_input` is wired to arrow keys plus space, and the same
  `dispatchInput` path is exercised by the retained reference component, but no
  key event was injected into this port.

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

No Defold WebTransport client is attached. Browser WebTransport, Deno, Quinn,
Colyseus H3, WebRTC, and WebSocket adapters remain behind the existing typed
transport boundary. The deterministic 32-player simulation in `core/` is no
longer driven by the built Defold project; it is retained for the headless
match, bundle-size measurement, and the `reference/` presentation scene.
