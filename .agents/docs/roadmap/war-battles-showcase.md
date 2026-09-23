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
