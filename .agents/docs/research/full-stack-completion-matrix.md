---
type: Design and Verification Report
title: Full-stack completion matrix
description: Evidence-separated status and next gates for the binding compiler, TypeScript toolchain, runtimes, bundler, editor, and packaged Defold targets.
tags: [bindings, compiler, bundler, hermes, static-hermes, wasm, vscode, verification]
status: active
generated: { by: claude/opus-5, at: 2026-09-18T22:30:00-04:00 }
sources:
  - id: canonical-plan
    resource: ./canonical-lowering-plan.md
    title: Canonical cross-target binding lowering plan
    author: project:deherm
  - id: tooling
    resource: ../tooling.md
    title: Tooling
    author: project:deherm
---

# Purpose

This is the reasoning matrix for completion. A green cell in one column never
implies a later column. In particular, a generated wrapper is not proof that it
compiled, linked into a retained extension, crossed Hermes or the browser host,
or met its ABI, allocation, and lifetime contract. Déherm verifies that generated
bridge contract; Defold remains authoritative for implementation and game
semantics behind the selected call.

The generated per-API authority is
`packages/bindings/generated/defold-binding-lowering-plan.json`. This document tracks
the larger compiler and product systems that cannot be represented as one API
unit.

# Completion matrix

| Surface | Authority / projection | Generated artifact | Compile / type check | Link / package | Runtime evidence | Conformance and performance | Next deterministic gate |
|---|---|---|---|---|---|---|---|
| Defold script API | Pinned reference docs plus source registrations feed the script projection IR; source registration wins on a documented-name contradiction | Public TypeScript SDK covers all 926 functions with a total machinery partition: 915 universal runtime routes, eight component-property intrinsics, and three timer bridges; a normalized four-target applicability catalog and 406 interned exact-vector contracts cover the 915 | Generated SDK, Dynamic Hermes, portable C ABI, strict Static Hermes value layer, and browser provider compile in focused gates | Generated native families link in focused harnesses; release reachability decides what a game retains | The generic recorder executes 915 JSI rows, the Lua adapter executes 882, and a real-Hermes native-POD driver executes the remaining 31 Dynamic-Hermes rows; integration sentinels exercise packaged native and browser boundaries | Recursive/reentrant/cycle/exhaustion and warmed allocation gates exist; the 23 browser callback-registry routes are identified but not yet driven, and complete ownership/finalization parity remains | Drive the 23 browser callback vectors through the real registry, then bind lifecycle/negative obligations to the normalized target catalog; use engine/browser runs only as integration sentinels |
| dmSDK | Pinned Clang-derived SDK IR feeds the dmSDK projection IR | Public declarations and materializable recipes cover all 1,361 runtime declarations; checker classification is 486 universal-ready, 59 callable generated-adapter, and 816 specialization-required | The common dispatcher, generated materialized thunks, native JSI bridge, browser cell codec, generated recording callees, and compiler-owned usage-scoped JSI runner compile in focused gates | Direct, template, constructor, member, destructor, scalar, enum, C-string, scalar/pointer handle, reference, and callback fixtures compile, link, and run through the native C-ABI driver; the 59 callable adapter rows emit authenticated retention routes | The native driver compares every decoded argument and encoded fake result; all 486 universal-ready vectors execute through real Hermes/JSI; native bigint and browser bigint/string arena sentinels execute separately | Native uses caller-owned fixed frames; browser releases scratch allocations in reverse order; 87 provider-bound adapter rows and ownership, thread, callback, record-layout, and target policies remain explicit | Normalize family-owned exact vectors into the usage-scoped plan, then drive each applicable call through Static Hermes and the production browser arena; derive the remaining 729 specializations from concrete call-site facts |
| TypeScript execution contexts | Source suffix and Defold context are explicit inputs | `.script.ts`, `.gui.ts`, and `.render.ts` projects, declarations, proxies, and the complete component registry are generated | TypeScript 7 AST/checker preflight rejects illegal cross-context and generated-internal imports | Proxies are valid Defold resources and the native provider packages into a custom engine | Lua and Dynamic Hermes harnesses execute all three context kinds; a hash-bound repeatable packaged-runtime gate proves the War Battles port's game-object, GUI, and camera components run one tutorial loop end to end in a packaged arm64-macOS engine, and a graceful `@system/exit` proves their `final()` callbacks run at teardown | Fixed-depth reentrant context selection and warmed attach/detach allocation gates pass; a `.render.ts` context has no packaged run, and full game-object/GUI conformance remains open | Run render fixtures through the same hash-bound packaged-runtime gate |
| Component properties | TypeScript literal schema is parsed from component definitions | Lua property declarations, manifest codecs, stable component IDs, specializations, and property frames are generated | Fixtures and golden outputs pass | Proxy resources package with a native provider and a browser provider | Property frames reach pooled Hermes component instances in the Dynamic Hermes harness and pooled browser instances in the packaged HTML5 gate; one packaged spawn override is observed on both, where `factory.create` carries a `vector3` property table into a spawned component's `init` | Editor round trips and every other property type remain unproven in a packaged engine, and the observed override is one codec on one shape | Add packaged scenarios for the remaining property types and retain allocation/lifetime evidence per codec |
| Dynamic Hermes | Standard TS/JS bundle plus JSI host modules | Runtime, JSI modules, callback registry, Lua compatibility adapters, current API families, and a generator-owned dmSDK exact-call runner exist | Native runtime and focused end-to-end executable compile; five exact vector families compile and run in a real packaged Hermes runtime through the production `DmSdkUniversal.call` host function | A desktop Defold extension bundle has been produced and retained for the bootstrap path | Bundle evaluation, init/update/final, callbacks, selected script calls, reload rejection, and retry behavior have focused proofs; the packaged War Battles projection adds one whole tutorial loop; exact vectors prove boolean/integer, float, address/handle, constructor, and template ordering | Sanitizers and focused zero-allocation gates pass; dmSDK callback values lack a production JSI wire representation, and complete same-IR coverage plus component lifecycle integration remain | Generate the callback wire token/ownership registry, expand exact vectors across every JSI-emitted shape, and retain a small packaged-engine lifecycle sentinel |
| Static Hermes | Sound-TypeScript constraints, the C ABI, and the pinned Defold value layouts are modeled separately | Static application unit loading, vmath bridge, a generated fixed-capacity universal value frame with Matrix4/URL arenas, a typed-native bridge, and a generated four-deep thread-local dmSDK exact-call frame exist; the package owns its 32-cell capability while policy recipes declare their required maximum | Strict typed recursive scalar/string/array/record materialization plus transparent Defold value records compile and run; a strict `shermes` unit replays nine dmSDK vectors through acquire/set/dispatch/result/release without importing the raw pointer dispatcher and compares every result-cell field | `shermes -emit-c` output is assembled into a project-local extension, uploaded by Bob, compiled and linked by the pinned local Extender into an arm64-macOS engine, and evaluated into the same Hermes runtime as the bytecode bundle | Unit loading, transparent Defold value round-trips, the packaged War Battles typed-native/JSI split, and exact bool/float/enum/C-string/handle/pointer/reference/callback frame observations execute; not full game or full dmSDK coverage | Native warmed glue is allocation-free; both value and dmSDK transports use bounded reentrant pools. Lua closures, retained engine handles, Defold semantics, and retained callback ownership remain explicit | Expand exact vectors across every Static-emitted shape, add retained-handle/callback lifetime policy, then run the shared packaged-engine trace |
| Lua compatibility | Pinned Lua 5.1 registrations and source-derived runtime profiles are authority | Cached route descriptors, exact profile detector, value/handle registries, and generated routers exist | Native harnesses compile | Focused routers link; release reachability controls packaged retention | Generated dispatch verifies exact lookup and ordered argument transport; selected calls also cross real Lua 5.1 and packaged Defold sentinels | Reentrant bounded scratch, stale generations, detach/re-attach, sanitizers, and warmed allocation behavior are tested | Complete same-IR exact-call vectors for results, callbacks, handles, stack restoration, errors, ownership, and finalization across every emitted transport row |
| Browser / Wasm host | Browser JavaScript owns the JS runtime; Defold remains Wasm | The bootstrap has recursive script direct memory, a generated typed dmSDK arena adapter over the raw universal transport, and a browser component-attachment provider; none uses Hermes or Embind | Browser providers, callback trampolines, variable-result tuple normalization, dmSDK 24-byte cell codec, and the browser component backend compile; Node/native direct-memory harnesses pass; four generated dmSDK exact vectors also compile with pinned Emscripten | A fresh `wasm-web` bundle of the War Battles port links the browser component provider through the pinned local Extender; the exact-call gate separately emits and fingerprints a real Emscripten HTML/JavaScript/Wasm module | A packaged headless-Chrome run of War Battles attaches all five components and executes its lifecycle markers; a second real-browser run executes unsigned integer, float, boolean, and C-string exact calls in the wasm32 C ABI and observes a manifest-bound marker; it does not yet traverse the production JavaScript arena; two Lua-owned closure results fail closed | dmSDK wasm32 bounds/catalog checks and balanced scratch release pass; exact-call evidence is four bounded C-ABI recipes, not the production JS transport or whole dmSDK; script bounds/reentrancy/handles/maps/cycles/callback cleanup also pass | Drive the generator-owned vectors through the production JavaScript arena/dispatcher, expand every browser-emitted shape, then add a bounded reverse callable registry for Lua-owned closures or retain the precise two-route blocker |
| Compiler front end | TypeScript 7 AST/checker, project inspection, and Clang JSON AST are inputs | Context projects, `.script_api` declarations, and a C11 native-extension command emit IR, TypeScript, production C glue, an exact-call twin, runnable driver, and verification report; signature-derived IDs survive line shifts | CLI plus production and exact-call native extension executables compile and run in the default materializer gate | npm packaging exports the generator and command; automatic project-extension consumption is not yet connected | C++ methods/templates, multi-header assembly, dependency-ZIP extraction, and the `.script_api` runtime bridge are not yet generated through this lane | Scalar/enum narrowing is fail-closed; record/pointer/callback ownership and layouts remain explicit blockers | Feed discovered project headers and reviewed schemas into one normalized extension catalog, then add C++/record/callback shape families and content-hash every discovered source leaf |
| Bundler / reachability | The canonical API plan and bundle-emitted usage manifest are separate authorities | A final-build selection plan retains exact reachable compatible API identities and compacts referenced tables; keyed release generation emits per-family sources, registries, target gates, CMake inputs, and pruned generated-module sources for Dynamic Hermes, Static Hermes, and browser/Wasm | Planner and release tests reject blocked, unavailable, duplicate, unknown, forged, or stale authority; all three target registries compile and no-write checks pass | Dynamic Hermes consumes the generated CMake family projection; Static/browser family sources and gates are emitted but not yet closed through packaged-engine link retention | Development bundles run; release-selected native glue is not yet proven end to end in packaged engines | Bundle size deltas exist for the War Battles diagnostic bundle; dead-symbol retention across native/HTML5 release artifacts is still open | Connect the Static and HTML5 production consumers, then prove unused families disappear from final native/Wasm artifacts without regenerating the SDK |
| Keyed generation | Declared inputs, generator source, canonical hashes, and output sentinel form the key | Canonical lowering plan has atomic force regeneration and a stat-based fast path | Deep verification regenerates byte-identically | Other generator families still use their own check/orchestration paths | Not applicable | The canonical plan is idempotent; the entire pipeline is not yet one cache graph | Give every generator node declared inputs/outputs and compose them into one content-addressed dependency DAG |
| Hot reload | Bundle resource generation is the versioned authority | Native reload stages a fresh Hermes runtime before activation | Reload fixture compiles | Native packaged resource replacement exists; browser activation is gated | Native accepts valid generations and retains the previous runtime after a rejected generation | Component state migration, callback transfer, and long-running soak are open | Put component registries behind generation ownership and add explicit recreate/migrate policies |
| VS Code / live tooling | Generated project metadata and source maps are available | Context tsconfigs and generated declarations exist | Standard TypeScript diagnostics work | No dedicated extension package is complete | No live instance/property/telemetry channel is complete | Debugger and profiler integration are open | Build the language-server/extension boundary on the shared incremental graph, then add runtime telemetry as a separate debug protocol |
| Whole-system release proof | Exact plan, emitted source, package, and engine hashes must agree | Exact-call verification is generated from the same IR as production bindings; every accepted concrete dmSDK/native-extension materialization owns a native C-ABI twin, with bounded JSI, Static, and real-Wasm runners consuming generator-owned lane-specific vectors | The default check compiles/runs native twins and real Hermes JSI; Static Hermes compiles/runs nine frame vectors and compares complete result cells; pinned Emscripten/Chrome runs four Wasm vectors | Full native and HTML5 release artifacts are not both closed over every retained lane | Packaged engine/browser runs remain integration sentinels; per-function live gameplay is deliberately not a publication gate | Whole-game leak, allocation, parity, size, callback ownership, and complete shape coverage remain product/performance or transport-expansion gates, not API-availability authority | Introduce a shared applicability manifest and expand vectors across every emitted transport shape, close callback ownership, then retain clean consumer and small packaged sentinels on every target |

# The War Battles projections

The matrix is per-target because a projection is a first-class artifact rather
than a filtered copy of another: development-full, release-pruned, native and
browser are four projections of one IR, selected by runtime, per-route
transport, reachable set, and profile. The consequence is that **every
projection carries its own evidence**. See
[`../decisions/release-reachability-and-native-lowering.md`](../decisions/release-reachability-and-native-lowering.md).

War Battles is the first product example to exist in more than one at once, and
its three runtime records are declared as a set in
`examples/war-battles-online/integration/projections.mjs`. Each declaration
names the four parameters, what its evidence observed, and what it explicitly
does not claim; each evidence document embeds that declaration verbatim, and
`pnpm check:war-battles-projections` refuses a set in which any declared
projection has no evidence, so a projection nobody ran is a named failure
rather than a silence.

| Projection | Runtime | Transport | Reachable set | Profile | Evidence |
|---|---|---|---|---|---|
| `native-arm64-macos` | `hermes` | `jsi` + `typed-native` | complete | engine-detected | `evidence/packaged-runtime-arm64-macos.json` |
| `browser-wasm-web` | `browser` | `direct-memory` | complete | browser | `evidence/browser-runtime-wasm-web.json` |
| `native-arm64-macos-typed-native-transport` | `hermes` | `typed-native` + `jsi` | complete | `DEHERM_PROFILE` | `evidence/packaged-typed-native-transport-arm64-macos.json` |

The first two observe the same tutorial loop reaching the engine; the third
observes how each call got there. They are deliberately not merged: a route
that ran is not a route whose transport anyone looked at, and the third
projection's engine is the instrumented one, which is not what ships.

# Reading the matrix

The work advances horizontally. Adding another declaration improves only the
generated-artifact column. A generated binding is verified when its same-IR
twin proves exact selection, ABI transport, ordering, bounds, and lifetime for
each transport that emits it. Compile, link, package, integration-sentinel, and
performance evidence remain separate product columns; absence of a bespoke
live-engine scenario does not demote or suppress an otherwise verified binding.

The implementation-lane registry is intentionally broader than the set of
concrete release usages. It includes complete recipes plus candidate and
contradiction reports so the matrix can distinguish “available for
materialization,” “emitted and exact-call verified,” and “positive source or
runtime contradiction.” A missing bespoke fixture is never an API blocker.
