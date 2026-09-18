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
