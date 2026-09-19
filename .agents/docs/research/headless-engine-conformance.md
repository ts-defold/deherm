---
type: Research Note
title: Headless Defold conformance harness
description: Defold's null backends, headless bundle variant, and in-process engine driving API, and what they change about how binding conformance should be proven.
tags: [research, defold, conformance, headless, verification]
status: verified-runtime
generated: { by: claude/opus-5, at: 2026-09-18T23:40:00-04:00 }
sources:
  - id: defold-engine-api
    resource: upstream/defold/engine/engine/src/engine.h
    title: Defold engine lifecycle API at 7f0f554f41f9dce1e0ddff99bf08200657d1ee05
    author: team:defold
  - id: defold-engine-tests
    resource: upstream/defold/engine/engine/src/test/test_engine.cpp
    title: Defold's own in-process engine test harness
    author: team:defold
  - id: bob-variants
    resource: upstream/defold/com.dynamo.cr/com.dynamo.cr.bob/src/com/dynamo/bob/Bob.java
    title: Bob bundle variants
    author: team:defold
  - id: script-box2d
    resource: upstream/defold/engine/gamesys/src/gamesys/scripts/box2d/script_box2d.cpp
    title: Box2D script module entry points at 7f0f554
    author: team:defold
  - id: comp-collision-object-box2d
    resource: upstream/defold/engine/gamesys/src/gamesys/components/box2d/comp_collision_object_box2d.cpp
    title: Box2D collision-object component world lifecycle
    author: team:defold
  - id: script-bullet3d
    resource: upstream/defold/engine/gamesys/src/gamesys/scripts/bullet3d/script_bullet3d.cpp
    title: Bullet script module entry points, with the null component-world guard
    author: team:defold
  - id: script-box2d-body-v2
    resource: upstream/defold/engine/gamesys/src/gamesys/scripts/box2d/v2/script_box2d_body_v2.cpp
    title: Box2D v2 body script bindings, including PushWorld
    author: team:defold
  - id: script-box2d-fixture-v2
    resource: upstream/defold/engine/gamesys/src/gamesys/scripts/box2d/v2/script_box2d_fixture_v2.cpp
    title: Box2D v2 fixture script bindings
    author: team:defold
---

# Finding

Defold can be driven programmatically, in process, one tick at a time, with
every platform backend replaced by a null implementation. Binding conformance
therefore does not require bundling a windowed game, launching it, scraping
stdout and sending a signal.

This corrects an earlier assumption in this project that real-engine evidence is
expensive, which is why a generated recording provider was originally proposed
as the primary conformance instrument.

# The driving API

`engine/engine/src/engine.h` is a complete lifecycle:

```c
void                   dmEngineInitialize();
dmEngine::HEngine      dmEngineCreate(int argc, char** argv);
dmEngine::UpdateResult dmEngineUpdate(HEngine);   // exactly one tick
void                   dmEngineGetResult(HEngine, int* run_action, int* exit_code,
                                         int* argc, char*** argv);
void                   dmEngineDestroy(HEngine);
void                   dmEngineFinalize();
```

`dmEngineUpdate` returns `RESULT_OK`, `RESULT_REBOOT` or `RESULT_EXIT`, so a
harness owns the frame loop and its termination condition rather than inferring
them from process behaviour.

# Null backends

| Concern | Null implementation |
| --- | --- |
| Graphics | `engine/graphics/src/null/graphics_null.cpp` |
| Sound | `engine/sound/src/sound_null.cpp` |
| Input | `engine/hid/src/hid_null.cpp` |
| Window | `engine/platform/src/platform_window_null.cpp` |
| GUI | `engine/gui/src/gui_null.cpp` |
| Particles | `engine/particle/src/particle_null.cpp` |
| Rig | `engine/rig/src/rig_null.cpp` |
| Profiler | `engine/profiler/src/profiler_null.cpp` |
| Engine service | `engine/engine/src/engine_service_null.cpp` |
| Live update | `engine/liveupdate/src/liveupdate_null.cpp` |
| Record | `engine/record/src/record/record_null.cpp` |
| Crash | `engine/crash/src/crash_null.cpp` |

`Bob.VARIANT_HEADLESS` makes `--variant headless` a supported bundle variant
beside `debug` and `release`.

# The harness pattern to copy

`engine/engine/src/test/test_engine.cpp` drives the API from a gtest fixture:

* `Launch(argc, argv, pre_run, post_run, context)` owns create/loop/destroy and
  returns the engine exit code.
* Per-case content is selected by argv, not by separate projects:
  `--config=bootstrap.main_collection=/text_input/text_input.collectionc`.
* `PreRun`/`PostRun` hooks inject state and inspect results; the text-input case
  calls `dmHID::AddKeyboardChar(engine->m_HidContext, 'A')` directly.
* The Lua or TypeScript side signals failure by exiting non-zero.

A content corpus sits beside it covering factories, collection factories,
collection proxies, fixed update, GUI, cross-script messaging, identifiers and
cameras.

# Consequence for this project

Conformance should be generated **per contract**, not per route. The canonical
lowering plan already interns 221 distinct contracts and 504 marshalling
programs across 926 script routes, so contract-level coverage is the tractable
unit and route-level scenario authoring is not.

A generated recording provider remains valuable, but for states a real engine
makes hard to provoke rather than as the primary instrument:

* reentrancy and nested dispatch
* fixed-capacity pool and arena exhaustion
* stale and cross-generation handle rejection
* warmed zero-allocation counting
* cross-transport trace equivalence for one contract

Both instruments must remain generated from the same IR. Neither may promote
generation evidence to runtime evidence.

# Built instrument

`native/headless_conformance_driver.cpp` is that harness for this project. It
links the déherm native extension against the pinned Defold SDK archives with
the null backends the `headless` appmanifest selects, owns `main`, calls
`dmExportedSymbols` exactly as `engine_main.cpp` does, and then runs
create/update/destroy per case with its own tick budget. It carries no route,
contract or API knowledge: every case is chosen by argv, every per-case engine
configuration arrives as opaque `key=value` tokens in the case manifest, and
every verdict arrives through `sys.exit` and `dmEngineGetResult`.

`scripts/generate-headless-conformance.mjs` generates everything above it from
the pinned IR - the per-contract plan, one minimal collection, game object,
collection proxy and Lua fixture per reachable contract, and the TypeScript
that exercises it. `scripts/check-headless-conformance.mjs` runs
generate -> bundle -> Bob content build -> CMake link -> execute and writes the
report. There is no per-route or per-contract hand-authored code anywhere in
the lane.

Three properties are checked, and each is selected by the contract record
rather than by the route:

| Property | Selected when | What a real engine decides |
| --- | --- | --- |
| `result-arity` | always | the value crossing the boundary matches the declared marshalling program, or the declared error model refused the synthesized argument |
| `scratch-reuse` | `scratch` is `caller-owned-bounded-reentrant-scratch` | 64 sequential invocations keep the same disposition, so the arena neither leaks nor exhausts |
| `error-model` | `errorModel` is `status-return-and-target-exception` | withholding the required arguments raises into TypeScript and leaves the boundary usable |

A fourth, `handle-provenance`, is emitted whenever an exercise takes a borrowed
handle: it records that the producer chain really did yield a live engine
object, or the precise reason it could not.

# What a fixture is

A fixture is a *shape* of generated collection, never a scenario. A fixture
profile declares the components the single generated game object carries, the
engine configuration the driver passes for that case, the script contexts the
resulting instance supplies, and the borrowed-handle contexts that can be
rooted from it. Nothing in a profile names a route or a contract; a contract is
assigned the profile that makes the most of its routes eligible.

| Profile | Collection | Engine configuration | Contracts |
| --- | --- | --- | ---: |
| `engine` | one game object with the déherm script | - | 14 |
| `physics-2d` | plus two dynamic box collision objects | `physics.type=2D` | 12 |
| `physics-3d` | plus two dynamic box collision objects | `physics.type=3D` | 8 |

The second collision object exists so a route needing two *distinct* engine
objects is given two: each occurrence of one handle kind in one call takes its
own ordinal, and an ordinal selects one of the profile's published component
addresses.

A contract runs from the déherm application's second `update`, not from `init`.
Defold updates script components (priority 200) before collision objects
(priority 400), so on the first update no component world has stepped and
engine state a shipped game always sees does not exist yet. This is not a
detail: running from `init` aborted the process inside Box2D, see below.

# Handle provenance

`packages/bindings/generated/defold-script-borrowed-handle-classification.json`
names each borrowed handle kind and the pinned Defold sources that implement
it. The plan derives, per fixture profile, a producer chain for every handle
kind the profile can root:

* a producer is any route whose single declared result is that handle kind;
* it becomes a provider when the profile supplies its context and every one of
  its own parameters, which may itself be a handle from an already-resolved
  provider;
* the fixpoint is bounded at six hops, so a cyclic handle algebra fails closed.

A handle kind is admissible in a profile only when every source the
classification cites for it lies under that profile's physics backend
directory, so 2D and 3D handle algebra can never be mixed into one engine
instance.

| Profile | Rooted kinds |
| --- | --- |
| `engine` | `buffer-data`, `buffer-stream`, `resource-declaration` |
| `physics-2d` | the above plus `box2d-world`, `box2d-body`, `box2d-joint` |
| `physics-3d` | the above plus `bullet-world`, `bullet-object`, `bullet-shape` |

`box2d-joint` is reached at depth two: `b2d.get_body` at two distinct addresses
feeds `b2d.joint.create_distance`.

# Runtime profile

The harness plans against one Defold runtime profile and refuses to record
evidence against another. The driver's pinned SDK archives carry Box2D **v2**
and Bullet, which déherm detects as `default-legacy-bullet`; the plan is built
from that profile's available-route set, and the check script asserts the
profile déherm reports in the transcript equals the planned one.

Before this, the plan exercised Box2D v3 routes the linked engine never
registers. Those calls produced déherm's own "route is unavailable in the
active runtime profile" refusal, which the report recorded as an observed
target exception - evidence about availability dressed up as evidence about a
contract. 49 routes across 9 contracts now carry the explicit blocker
`route-unavailable-in-runtime-profile:default-legacy-bullet` instead.

# Observed

`packages/bindings/generated/defold-headless-conformance-report.json`, at
Defold `7f0f554`, arm64 macOS, headless, runtime profile
`default-legacy-bullet`:

| Outcome | Contracts |
| --- | --- |
| observed | 31 |
| mismatched | 0 |
| engine fault | 0 |
| blocked | 3 |
| unreachable | 48 |

129 routes were exercised across 34 fixtures in 135 exercises, producing 82
`result-arity:observed`, 49 `result-arity:observed-as-target-exception`, 129
`scratch-reuse:observed`, 104 `error-model:observed` and 90
`handle-provenance:observed`. A refused synthesized argument is recorded as
`observed-as-target-exception`, not as a mismatch: it is evidence the declared
error model holds, not evidence about the route's semantics.

The three blocked contracts are honest runtime blockers, not skips: `buffer-data`
has no producer the harness can feed a real resource path to
(`resource.get_buffer` needs a compiled `.bufferc`), and `buffer-stream` depends
on it.

# Findings only a real engine produced

## `b2d.get_world` segmentation-faults with no collision object in the collection

`dmGameSystem::B2D_GetWorld` resolves the collision-object component world and
passes it straight to `CompCollisionObjectGetBox2DWorld`, which dereferences
it:

```cpp
void* comp_world = dmGameObject::GetWorld(collection, component_type_index);
void* world = dmGameSystem::CompCollisionObjectGetBox2DWorld(comp_world);  // null deref
```

`CompCollisionObjectBox2DNewWorld` sets the component world to `0x0` whenever
the collection declares no collision object (`params.m_MaxComponentInstances ==
0`), so any collection without physics faults here. `Bullet3D_GetWorld` in the
same engine revision does hold the guard `B2D_GetWorld` lacks:

```cpp
void* component_world = dmGameObject::GetWorld(collection, component_type_index);
if (!component_world) { lua_pushnil(L); return 1; }
```

This is an upstream asymmetry, not a déherm defect, and it is not patchable
from this repository. The harness resolves it structurally instead: the
contract returns a `borrowed-engine-world` handle, so profile selection places
it in a fixture that owns the physics world that handle belongs to, and the
fault is gone. The enumerated boundary now carries the requirement rather than
a crash.

## déherm cannot capture a Box2D v2 world handle, and said so misleadingly

With the fault gone, `b2d.get_world` fails closed inside déherm instead.
Box2D v2's `PushWorld` pushes a **light** userdata:

```cpp
void PushWorld(struct lua_State* L, void* world) { lua_pushlightuserdata(L, world); }
```

`CapturedLuaRouter::read` gated on `lua_isuserdata`, which is true for a light
userdata, while `LuaValueRegistry::validateLuaType` requires `LUA_TUSERDATA`.
The capture therefore always failed, and reported
`semantic handle result capture failed or registry is exhausted` - a
diagnostic that blames capacity for a representation mismatch. The generated
router now separates the three causes and refuses a light userdata by name:

```
semantic handle result is a light userdata with no rooted identity
```

The borrowed-handle classification describes `box2d-world` as
`lua-rooted-userdata` because it is derived from the **v3** sources; under the
v2 backend the representation is a raw pointer with no metatable and no
generation to check. Refusing it is correct; the classification's
representation is profile-dependent and currently is not.

## No handle-lowered consumer accepts a `box2d-joint` the engine produced

`b2d.joint.create_distance` is absent from both the borrowed-handle
classification and the handle-lowering route table, so its result crosses the
boundary through the universal-value transport rather than as a semantic
handle. All 82 handle-lowered `b2Joint` consumers then reject it with
`handle argument codec mismatch`; 21 of them were exercised and every one
refused a handle a live engine really had produced. The plan records the
disagreement per profile as machine-readable state:

```json
{ "handleKind": "box2d-joint", "producerRouteId": "script:b2d.joint.create_distance",
  "producerHandleLowered": false, "consumerCount": 88,
  "handleLoweredConsumerCount": 82, "agreement": "producer-outside-handle-lowering" }
```

The classification's producer partition covers only routes whose *name* reads
as an accessor; every `create_*` route that returns a handle is outside it.
That is the input to fix, not the harness.

## `b2d.fixture.get_aabb` aborts before the first physics step

Running contracts from `init` aborted the process:

```
Assertion failed: (0 <= childIndex && childIndex < m_proxyCount), function GetAABB, file b2Fixture.h, line 349.
```

`Fixture_GetAABB` validates `child_index` against the shape's child count and
converts it to zero-based, but `b2Fixture::GetAABB` asserts against
`m_proxyCount`, which is zero until the fixture is registered in the broad
phase. Moving every contract to the second `update` removed it, which is both
the fix and the confirmation: the route is only safe after the owning world has
stepped once.

# The enumerated boundary

Headless removes the window, not the engine's context requirements. The 48
unreachable contracts carry these machine-readable blocker families:

| Family | Contracts | Routes |
| --- | --- | --- |
| `context-fixture-missing` | 18 | 118 |
| `route-unavailable-in-runtime-profile` | 9 | 49 |
| `no-handle-producer-chain` | 3 | 37 |
| `multi-result-shape-unmodelled` | 4 | 22 |
| `no-generated-universal-adapter` | 3 | 9 |
| `unsynthesizable-parameter-type` | 7 | 8 |
| `execution-policy-destructive` | 5 | 5 |
| `lua-stack-blocked-capability` | 1 | 2 |
| `execution-policy-context-blocked` | 1 | 1 |

`unsynthesizable-parameter-type` has fallen from 402 routes to 8: what remains
is four callback function types, `go.PLAYBACK`, a `vector3`, and one record
parameter. The physics handle algebra is no longer in it.

`no-handle-producer-chain` is 37 `btTypedConstraint` routes. Every
`bullet3d.constraint.create_*` takes a required parameter record
(`bullet3d.constraint.hinge_params` and friends), so the kind has no root
producer at all. `b2Shape` and `b2Chain` are in the same position and are
counted under the runtime-profile blocker in this build.

`context-fixture-missing` is no longer a call for somebody to write a fixture.
For the two large contexts no fixture is sufficient, and the plan says why:

| Context | Routes | Obstacle |
| --- | ---: | --- |
| `gui-scene` | 103 | `AttachLuaInstance` in `defold/defold_hermes/src/extension.cpp` calls `dmScript::CheckGOInstance`, so a `.gui_script` instance cannot attach the déherm runtime at all |
| `render-script` | 12 | the same attachment constraint |
| `window` | 2 | the headless variant links the null window backend |
| `network` | 1 | the driver runs offline and must stay deterministic |

The gui and render contexts are therefore blocked on the component-proxy
attachment lane, not on this one. The plan carries this in
`unsuppliedContexts` with the source evidence for each entry.

# Remaining boundary

* The fixture attaches the déherm runtime through a generated Lua game-object
  script, which is the lane with proven runtime attachment. Driving the same
  contracts through the `*.script.ts` / `*.gui.ts` component-proxy transport is
  a separate lane and is not claimed here. It is also what blocks the
  `gui-scene` and `render-script` contexts.
* A contract's observation is drawn from at most sixteen of its routes, and a
  destructive route is admitted only when the contract has no safe route and
  then exercised exactly once, without the repetition-based properties. The
  canonical plan's interning is what carries evidence to the rest of a
  contract's routes; the harness records `exercisedRouteCount` beside
  `routeCount` so the distinction stays visible.
* Optional parameters are synthesized when the harness can inhabit them, as an
  additive second arity for the same route; the required-only observation is
  never replaced by it.
* This lane produces runtime evidence only. It never promotes generation,
  compilation or linkage evidence, and it claims nothing for a contract it
  recorded as unreachable, blocked or faulted.
