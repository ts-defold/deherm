---
type: Design and Verification Report
title: Full-stack completion matrix
description: Evidence-separated status and next gates for the binding compiler, TypeScript toolchain, runtimes, bundler, editor, and packaged Defold targets.
tags: [bindings, compiler, bundler, hermes, static-hermes, wasm, vscode, verification]
status: active
generated: { by: codex/gpt-5, at: 2026-09-18T18:30:00-04:00 }
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
| Defold script API | Pinned reference docs plus reviewed engine registrations feed the script projection IR | Public TypeScript SDK and every unit has one specialized or projection-only owner lane in the canonical plan | Generated SDK and fixtures type-check | Generated native families link in focused harnesses; packaged retention is not universal | Dynamic Hermes and Lua harnesses exercise implemented families; whole surface is not engine-executed | Sanitizers and warmed allocation gates exist for focused families, but only an invoked gate is evidence; whole-surface differential conformance is open | Resolve the next structural semantic family, emit it for every applicable backend, then add exact compile/link/runtime evidence |
| dmSDK | Pinned Clang-derived SDK IR feeds the dmSDK projection IR | Public TypeScript declarations cover the SDK; all native enums now emit tree-shakeable named value objects plus literal-union types, every declaration has one specialized or projection-only owner lane, and unresolved lanes remain explicit | Current generated C/C++ families compile against the pinned packaged SDK; the private C-string family now validates exact declared enum domains from SDK IR | Focused families link against packaged SDK/host sources; full extension retention is open | Focused host behavior exists; whole dmSDK runtime coverage is open | Bounded span/scalar families have focused allocation checks; ownership, thread, callback, layout, and target matrices remain explicit | Turn effect and ABI tokens into reusable policies and target probes, never per-symbol wrappers |
| TypeScript execution contexts | Source suffix and Defold context are explicit inputs | `.script.ts`, `.gui.ts`, and `.render.ts` projects, declarations, and proxies are generated | TypeScript 7 AST/checker preflight rejects illegal cross-context and generated-internal imports | Proxies are valid Defold resources | Runtime component methods intentionally fail closed | No component lifecycle conformance claim yet | Implement the fixed-capacity attachment provider and prove independent instances, lifecycle ordering, teardown, reload, and stale-handle rejection |
| Component properties | TypeScript literal schema is parsed from component definitions | Lua property declarations, manifest codecs, stable component IDs, and specializations are generated | Fixtures and golden outputs pass | Proxy resources package; native registration is gated | Property-to-Hermes instance delivery is not implemented | Spawn overrides and editor round trips are unproven | Generate the property frame layout and attach it to the component instance without hot-path heap allocation |
| Dynamic Hermes | Standard TS/JS bundle plus JSI host modules | Runtime, JSI modules, callback registry, Lua compatibility adapters, and current API families exist | Native runtime and focused end-to-end executable compile | A desktop Defold extension bundle has been produced and retained for the bootstrap path | Bundle evaluation, init/update/final, callbacks, selected script calls, reload rejection, and retry behavior have focused proofs | Sanitizers and focused zero-allocation gates pass; full API and component lifecycle do not | Route generated component instances through the runtime, then execute generated API scenarios in the packaged engine |
| Static Hermes | Sound-TypeScript constraints and C ABI are modeled separately | Static application unit loading, vmath bridge, and staged C ABI families exist | Focused Static Hermes samples compile; full application and full SDK do not | Full Static Hermes extension linkage is open | Unit loading has focused runtime coverage, not full game coverage | No full parity, size, or allocation result yet | Make the same generated component/application contract compile as Static Hermes units and run the shared conformance trace |
| Lua compatibility | Pinned Lua 5.1 registrations and source-derived runtime profiles are authority | Cached route descriptors, exact profile detector, value/handle registries, and generated routers exist | Native harnesses compile | Focused routers link; not every route is retained in a packaged game | Implemented families cross real Lua 5.1 in harnesses; only selected calls cross a packaged Defold engine | Reentrant bounded scratch, stale generations, detach/re-attach, sanitizers, and warmed allocation behavior are tested | Attach all Defold script contexts and run the generated whole-surface scenario harness |
| Browser / Wasm host | Browser JavaScript owns the JS runtime; Defold remains Wasm | Emscripten-facing host glue and selected browser adapters exist | Browser bundle builds | HTML5 Defold bundle path exists | Baseline browser-host lifecycle has focused evidence; API parity and hot activation are open | Direct-memory ABI and whole-surface performance are unproven | Generate and execute the same API scenario frames against the Wasm engine, with browser-host JS rather than embedded Hermes |
| Compiler front end | TypeScript 7 AST/checker plus project inspection | Context projects, extension declarations, component manifests, binding usage manifest, and source maps are generated | CLI/type-check suites pass | npm packaging is present | No custom language-server runtime yet | Incremental latency and large-project memory remain to benchmark | Make project inspection, extension parsing, transform, and type checking one incremental graph shared by CLI and VS Code |
| Bundler / reachability | The canonical API plan and bundle-emitted usage manifest are separate authorities | A final-build selection plan retains exact reachable compatible API identities and compacts referenced tables; keyed release generation emits pruned generated-module sources for native JSI, Static Hermes, and browser/Wasm | Planner and release tests reject blocked, unavailable, duplicate, unknown, forged, or stale authority and prove no-write checks | Canonical per-API family source/CMake/Extender pruning is still `selection-only-no-family-emitter`; generated-module pruning is real but narrower | Development bundles run; release-selected native glue is not yet proven end to end in packaged engines | Bundle size deltas exist for the War Battles diagnostic bundle; dead-symbol retention across native/HTML5 release artifacts is still open | Make canonical family emitters and build consumers obey the selection artifact, then prove unused API families disappear without regenerating the SDK |
| Keyed generation | Declared inputs, generator source, canonical hashes, and output sentinel form the key | Canonical lowering plan has atomic force regeneration and a stat-based fast path | Deep verification regenerates byte-identically | Other generator families still use their own check/orchestration paths | Not applicable | The canonical plan is idempotent; the entire pipeline is not yet one cache graph | Give every generator node declared inputs/outputs and compose them into one content-addressed dependency DAG |
| Hot reload | Bundle resource generation is the versioned authority | Native reload stages a fresh Hermes runtime before activation | Reload fixture compiles | Native packaged resource replacement exists; browser activation is gated | Native accepts valid generations and retains the previous runtime after a rejected generation | Component state migration, callback transfer, and long-running soak are open | Put component registries behind generation ownership and add explicit recreate/migrate policies |
| VS Code / live tooling | Generated project metadata and source maps are available | Context tsconfigs and generated declarations exist | Standard TypeScript diagnostics work | No dedicated extension package is complete | No live instance/property/telemetry channel is complete | Debugger and profiler integration are open | Build the language-server/extension boundary on the shared incremental graph, then add runtime telemetry as a separate debug protocol |
| Whole-system release proof | Exact plan, emitted source, package, and engine hashes must agree | Scenario/probe generators exist but do not yet cover every executable target row | Focused suites are green | Full native and HTML5 release artifacts are not both closed over the whole matrix | No claim that every API has executed from TypeScript in Defold | No whole-game leak, allocation, parity, or size proof | Generate a scenario for every executable unit, run by context and backend, and record evidence without promoting unobserved rows |

# Reading the matrix

The work advances horizontally. Adding another declaration improves only the
generated-artifact column. A lane is complete for one target only after its
exact source and plan hashes have independent compile, link, retained-package,
runtime, conformance, and lifetime/allocation evidence.

The implementation-lane registry is intentionally broader than the set of
executable APIs. It includes candidate and blocker reports so the matrix can
distinguish “no generator pattern exists” from “a generator classified this
shape and deliberately refused unsafe emission.”
