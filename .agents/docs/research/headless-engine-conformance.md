---
type: Research Note
title: Headless Defold conformance harness
description: Defold's null backends, headless bundle variant, and in-process engine driving API, and what they change about how binding conformance should be proven.
tags: [research, defold, conformance, headless, verification]
status: verified-source
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

# Open boundary

Headless removes the window, not the engine's context requirements. Contracts
needing a physics world, a factory prototype, a render context, a loaded
resource or a sound device still need a fixture that supplies one. Which
contracts those are is not yet enumerated.
