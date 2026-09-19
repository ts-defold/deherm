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
matched Defold behavior, or met its allocation and lifetime contract.

The generated per-API authority is
`packages/bindings/generated/defold-binding-lowering-plan.json`. This document tracks
the larger compiler and product systems that cannot be represented as one API
unit.

# Completion matrix

| Surface | Authority / projection | Generated artifact | Compile / type check | Link / package | Runtime evidence | Conformance and performance | Next deterministic gate |
|---|---|---|---|---|---|---|---|
| Defold script API | Pinned reference docs plus reviewed engine registrations feed the script projection IR | Public TypeScript SDK covers all 926 functions; one generated bounded value-graph fallback owns all 915 callable non-intrinsic routes, with one optional specialized lane per route | Generated SDK, Dynamic Hermes, portable C ABI, strict Static Hermes value layer, and browser provider compile in focused gates | Generated native families link in focused harnesses; packaged retention is not universal | The canonical plan emits 913 profile-available callable routes for Dynamic Hermes, 911 for Lua/browser, and 325 typed-native routes whose Defold value records all have a pinned transparent layout; the whole surface is not engine-executed | Recursive/reentrant/cycle/exhaustion tests and warmed zero-allocation gates pass for the universal ABI, Static frame, 23 retained callback trampolines, and two Dynamic rooted Lua-closure routes; variable one/two-result execution is proven | Add callable-result transport to browser/Static only if its ownership contract remains bounded, then shard packaged-engine conformance over the emitted matrix |
| dmSDK | Pinned Clang-derived SDK IR feeds the dmSDK projection IR | Public TypeScript declarations cover the SDK; every runtime declaration has a universal recipe/stable ID, Dynamic Hermes has a typed generated JSI bridge, and the browser has a generated typed arena over raw Wasm memory | The common dispatcher, generated materialized thunks, native JSI bridge, and browser cell codec compile in focused gates | A generated endian selection links through Hermes/JSI/C ABI; all 1,361 recipes are not claimed as linked engine implementations | Native bigint round-trip and browser bigint/string arena calls execute; whole-engine semantic coverage remains open | Native uses caller-owned fixed frames; browser releases scratch allocations in reverse order; ownership, thread, callback, layout, and target policies remain explicit | Install the browser transport in the HTML5 package, then materialize reachable project/extension usage and shard engine conformance |
| TypeScript execution contexts | Source suffix and Defold context are explicit inputs | `.script.ts`, `.gui.ts`, and `.render.ts` projects, declarations, proxies, and the complete component registry are generated | TypeScript 7 AST/checker preflight rejects illegal cross-context and generated-internal imports | Proxies are valid Defold resources and the native provider packages into a custom engine | Lua and Dynamic Hermes harnesses execute all three context kinds; a hash-bound repeatable packaged-runtime gate proves the War Battles port's game-object, GUI, and camera components run one tutorial loop end to end in a packaged arm64-macOS engine, and a graceful `@system/exit` proves their `final()` callbacks run at teardown | Fixed-depth reentrant context selection and warmed attach/detach allocation gates pass; a `.render.ts` context has no packaged run, and full game-object/GUI conformance remains open | Run render fixtures through the same hash-bound packaged-runtime gate |
| Component properties | TypeScript literal schema is parsed from component definitions | Lua property declarations, manifest codecs, stable component IDs, specializations, and property frames are generated | Fixtures and golden outputs pass | Proxy resources package with a native provider and a browser provider | Property frames reach pooled Hermes component instances in the Dynamic Hermes harness and pooled browser instances in the packaged HTML5 gate; one packaged spawn override is observed on both, where `factory.create` carries a `vector3` property table into a spawned component's `init` | Editor round trips and every other property type remain unproven in a packaged engine, and the observed override is one codec on one shape | Add packaged scenarios for the remaining property types and retain allocation/lifetime evidence per codec |
| Dynamic Hermes | Standard TS/JS bundle plus JSI host modules | Runtime, JSI modules, callback registry, Lua compatibility adapters, and current API families exist | Native runtime and focused end-to-end executable compile | A desktop Defold extension bundle has been produced and retained for the bootstrap path | Bundle evaluation, init/update/final, callbacks, selected script calls, reload rejection, and retry behavior have focused proofs; the packaged War Battles projection adds one whole tutorial loop and a graceful shutdown that runs component `final()` | Sanitizers and focused zero-allocation gates pass; full API and component lifecycle do not | Route generated component instances through the runtime, then execute generated API scenarios in the packaged engine |
| Static Hermes | Sound-TypeScript constraints, the C ABI, and the pinned Defold value layouts are modeled separately | Static application unit loading, vmath bridge, a generated fixed-capacity universal value frame with Matrix4/URL arenas, and a generated typed-native bridge claiming 320 of the plan's 325 lowered routes exist | Strict typed recursive scalar/string/array/record materialization plus transparent `vector3`/`vector4`/`quaternion`/`matrix4`/`hash`/`url` records compile and run; 325 route shapes are emitted | `shermes -emit-c` output is assembled into a project-local extension, uploaded by Bob, compiled and linked by the pinned local Extender into an arm64-macOS engine, and evaluated into the same Hermes runtime as the bytecode bundle | Unit loading, one representative recursive graph, exact round-trips of each transparent Defold value record, and a packaged War Battles run whose telemetry shows 14 routes on `typed-native` and exactly the two `value-type:node` routes on `jsi` in one binary, against a control build of the same project that puts all 16 on `jsi`; not full game coverage | Native warmed glue is allocation-free; the configurable default pool is four reentrant 16-KiB-string frames. Lua closures, retained engine handles (`node` blocks 103 routes), and packaged Defold remain explicit | Add the retained-handle transport, then run the shared packaged-engine conformance trace |
| Lua compatibility | Pinned Lua 5.1 registrations and source-derived runtime profiles are authority | Cached route descriptors, exact profile detector, value/handle registries, and generated routers exist | Native harnesses compile | Focused routers link; not every route is retained in a packaged game | Implemented families cross real Lua 5.1 in harnesses; only selected calls cross a packaged Defold engine | Reentrant bounded scratch, stale generations, detach/re-attach, sanitizers, and warmed allocation behavior are tested | Attach all Defold script contexts and run the generated whole-surface scenario harness |
| Browser / Wasm host | Browser JavaScript owns the JS runtime; Defold remains Wasm | The bootstrap has recursive script direct memory, a generated typed dmSDK arena adapter over the raw universal transport, and a browser component-attachment provider; none uses Hermes or Embind | Browser providers, callback trampolines, variable-result tuple normalization, dmSDK 24-byte cell codec, and the browser component backend compile; Node/native direct-memory harnesses pass | A fresh `wasm-web` bundle of the War Battles port links the browser component provider through the pinned local Extender | A packaged headless-Chrome run of that bundle attaches all five components, executes init/update/message/input/animation-callback lifecycles, and emits every required game marker; two Lua-owned closure results fail closed | dmSDK wasm32 bounds/catalog checks and balanced scratch release pass; script bounds/reentrancy/handles/maps/cycles/callback cleanup also pass; the packaged browser gate asserts markers and CDP state, never pixels | Add a bounded reverse callable registry for Lua-owned closures or retain the precise two-route blocker, then shard browser scenario conformance and measure frame cost |
| Compiler front end | TypeScript 7 AST/checker, project inspection, and Clang JSON AST are inputs | Context projects, `.script_api` declarations, and a C11 native-extension header-to-IR/TS/C-glue command are generated | CLI/type-check plus native extension compile/link/runtime fixtures pass | npm packaging exports the generator and command | C++ methods/templates and dependency-ZIP extraction are not yet generated | Scalar/enum narrowing is fail-closed; record/pointer/callback ownership and layouts remain explicit blockers | Merge reviewed extension schemas with discovered headers, then add C++/record/callback shape families to the same deterministic IR |
| Bundler / reachability | The canonical API plan and bundle-emitted usage manifest are separate authorities | A final-build selection plan retains exact reachable compatible API identities and compacts referenced tables; keyed release generation emits per-family sources, registries, target gates, CMake inputs, and pruned generated-module sources for Dynamic Hermes, Static Hermes, and browser/Wasm | Planner and release tests reject blocked, unavailable, duplicate, unknown, forged, or stale authority; all three target registries compile and no-write checks pass | Dynamic Hermes consumes the generated CMake family projection; Static/browser family sources and gates are emitted but not yet closed through packaged-engine link retention | Development bundles run; release-selected native glue is not yet proven end to end in packaged engines | Bundle size deltas exist for the War Battles diagnostic bundle; dead-symbol retention across native/HTML5 release artifacts is still open | Connect the Static and HTML5 production consumers, then prove unused families disappear from final native/Wasm artifacts without regenerating the SDK |
| Keyed generation | Declared inputs, generator source, canonical hashes, and output sentinel form the key | Canonical lowering plan has atomic force regeneration and a stat-based fast path | Deep verification regenerates byte-identically | Other generator families still use their own check/orchestration paths | Not applicable | The canonical plan is idempotent; the entire pipeline is not yet one cache graph | Give every generator node declared inputs/outputs and compose them into one content-addressed dependency DAG |
| Hot reload | Bundle resource generation is the versioned authority | Native reload stages a fresh Hermes runtime before activation | Reload fixture compiles | Native packaged resource replacement exists; browser activation is gated | Native accepts valid generations and retains the previous runtime after a rejected generation | Component state migration, callback transfer, and long-running soak are open | Put component registries behind generation ownership and add explicit recreate/migrate policies |
| VS Code / live tooling | Generated project metadata and source maps are available | Context tsconfigs and generated declarations exist | Standard TypeScript diagnostics work | No dedicated extension package is complete | No live instance/property/telemetry channel is complete | Debugger and profiler integration are open | Build the language-server/extension boundary on the shared incremental graph, then add runtime telemetry as a separate debug protocol |
| Whole-system release proof | Exact plan, emitted source, package, and engine hashes must agree | Scenario/probe generators exist but do not yet cover every executable target row | Focused suites are green | Full native and HTML5 release artifacts are not both closed over the whole matrix | No claim that every API has executed from TypeScript in Defold | No whole-game leak, allocation, parity, or size proof | Generate a scenario for every executable unit, run by context and backend, and record evidence without promoting unobserved rows |

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
generated-artifact column. A lane is complete for one target only after its
exact source and plan hashes have independent compile, link, retained-package,
runtime, conformance, and lifetime/allocation evidence.

The implementation-lane registry is intentionally broader than the set of
executable APIs. It includes candidate and blocker reports so the matrix can
distinguish “no generator pattern exists” from “a generator classified this
shape and deliberately refused unsafe emission.”
