---
type: Research Note
title: Headless Defold conformance harness
description: Defold's null backends, headless bundle variant, and in-process engine driving API, and what they change about how binding conformance should be proven.
tags: [research, defold, conformance, headless, verification]
status: verified-runtime
generated: { by: claude/opus-5, at: 2026-09-18T21:10:00-04:00 }
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
contract or API knowledge: every case is chosen by argv and every verdict
arrives through `sys.exit` and `dmEngineGetResult`.

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

# Observed

`packages/bindings/generated/defold-headless-conformance-report.json`, at
Defold `7f0f554`, arm64 macOS, headless:

| Outcome | Contracts |
| --- | --- |
| observed | 15 |
| engine fault | 1 |
| mismatched | 0 |
| unreachable | 66 |

27 routes were exercised across 16 fixtures, producing 13 `result-arity:observed`,
13 `result-arity:observed-as-target-exception`, 26 `scratch-reuse:observed`,
16 `error-model:observed` and 10 `error-model:not-applicable`. A refused
synthesized argument is recorded as `observed-as-target-exception`, not as a
mismatch: it is evidence the declared error model holds, not evidence about the
route's semantics.

The engine fault is a real finding that only a real engine could produce.
Contract 150's single route, `script:b2d.get_world`, segmentation-faults inside
`dmGameSystem::B2D_GetWorld` when it is reached from a collection with no
physics world, through déherm's generated captured-Lua handle router. The
driver's case list is resumed after such a fault, so one crashing contract does
not erase the evidence for the rest.

# The enumerated boundary

Headless removes the window, not the engine's context requirements. The 66
unreachable contracts carry these machine-readable blocker families:

| Family | Contracts | Routes |
| --- | --- | --- |
| `unsynthesizable-parameter-type` | 34 | 402 |
| `context-fixture-missing` | 19 | 124 |
| `execution-policy-destructive` | 10 | 11 |
| `multi-result-shape-unmodelled` | 5 | 27 |
| `no-generated-universal-adapter` | 3 | 9 |
| `execution-policy-context-blocked` | 1 | 1 |
| `harness-effect-guard` | 1 | 1 |
| `lua-stack-blocked-capability` | 1 | 2 |
| `lua-stack-omit-profile` | 1 | 2 |

`unsynthesizable-parameter-type` is dominated by the physics handle algebra -
`b2Body`, `b2World`, `b2Joint`, `b2Shape`, `b2Chain`, `btRigidBody`,
`btCollisionObject`, `btTypedConstraint`, `btDiscreteDynamicsWorld` - each of
which needs a fixture that first builds a physics world and a collision object.
`context-fixture-missing` is the GUI scene, render script, window and network
contexts: a `.gui` with a gui script, a custom render script, a real window and
a live socket respectively. Those are the next fixtures to build, and the plan
names exactly which contracts each one would unblock.

# Remaining boundary

* The fixture attaches the déherm runtime through a generated Lua game-object
  script, which is the lane with proven runtime attachment. Driving the same
  contracts through the `*.script.ts` / `*.gui.ts` component-proxy transport is
  a separate lane and is not claimed here.
* A contract's observation is drawn from at most four of its routes. The
  canonical plan's interning is what carries that evidence to the rest of the
  contract's routes; the harness records `exercisedRouteCount` beside
  `routeCount` so the distinction stays visible.
* This lane produces runtime evidence only. It never promotes generation,
  compilation or linkage evidence, and it claims nothing for a contract it
  recorded as unreachable, blocked or faulted.
