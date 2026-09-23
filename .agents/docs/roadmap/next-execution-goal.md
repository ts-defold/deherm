---
type: Roadmap
title: Ordered execution goal after the generated-verification decision
description: Complete ordered backlog from exact generated call verification through policy realization, cross-target delivery, developer tooling, War Battles, and reserved product frontiers.
tags: [roadmap, goal, verification, policy, ci, tooling, war-battles]
status: active
generated: { by: codex, at: 2026-09-20T01:09:30-04:00 }
sources:
  - id: generated-verification
    resource: ../decisions/generated-binding-verification.md
    title: Generated binding verification stops at the exact bridge contract
    author: project:deherm
  - id: completion-matrix
    resource: ../research/full-stack-completion-matrix.md
    title: Full-stack completion matrix
    author: project:deherm
---

# Goal

Finish déherm as a deterministic, policy-driven TypeScript binding compiler and
runtime integration that emits the complete Defold Lua and dmSDK surfaces,
generates an exact verification twin for every concrete call it emits, works
from the published npm package and policy site on every supported target, and
dogfoods the result in a playable native/browser War Battles project.

# Ordered work

## Active execution tranche

This is the current implementation queue. It refines the broader ordered work
below without changing its completion rule.

1. **Completed — Static script exact calls.** The sound-typed executable runs
   all 325 Static universal routes; the three timer routes make the applicable
   target total 328/328. The policy graph must continue to build and execute
   this target rather than relying only on local evidence.
2. **Completed — dmSDK hash-state 10.** All
   `dmHash{Init,Clone,UpdateBuffer,Final,Release}{32,64}` routes use the bounded,
   generation-tagged state registry and pass native exact, sanitizer, stale,
   foreign, exhausted, double-consumed, and warmed-allocation gates.
3. **Completed — Static tail 108.** Lua-table 70, dynamic-value 14,
   multi-result 12, and overload-dispatch 12 all use the existing bounded
   Static frame and generated exact vectors.
4. **Completed — matrix reconciliation.** The 926-route script partition is
   total and the emitted-target matrix is 2,158/2,158. The 1,361-declaration
   dmSDK catalog has zero omissions; every emitted concrete route carries its
   generated exact twin. The 721 specialization-required rows are abstract
   recipes awaiting call-site facts, not missing emitted calls.
5. **Completed — policy-only clean consumer.** A packed npm package plus an
   external content-addressed policy materializes, compiles, links, and executes
   a concrete `dmMath::Clamp<int32_t>` production wrapper and exact twin without
   a Defold checkout. Remaining policy snapshot/transfer reduction is tracked
   as optimization and does not gate API availability or product work.
6. **Completed — close CI and cross-platform delivery.** Hosted end-to-end run
   `35674434017` passed the local and extension-header gates plus all eleven Bob
   targets across macOS, iOS/simulator, Linux, Windows, Android, and HTML5/Wasm.
7. **Completed — installed TUI, watch, launch, HMR, logs, and telemetry.** The
   packed npm consumer enters the declarative TUI, discovers or scaffolds a
   project, watches and incrementally builds, launches native and HTML5
   targets, acknowledges exact bundle fingerprints, reports live telemetry,
   writes `.deherm/dev/session.log`, supports keyboard/mouse log navigation and
   clipboard copy, and tears down the engine when `q` quits the session. Real
   War Battles runtime evidence includes two activated HMR generations.
8. **Active — finish Hermes developer inspection.** The native Hermes CDP core,
   bounded engine transport, standard CLI discovery/WebSocket bridge, and HMR
   runtime rebinding are implemented and proven in real War Battles. The
   incremental compiler already emits source-content maps and feeds them into
   debug Hermes bytecode. Installed CPU/heap capture and an editor-neutral DAP
   now cover authored source-map breakpoints, stack/scopes, variables, watches,
   conditional breakpoints, stepping, exception policy, and HMR breakpoint
   reapplication; native tests prove both Hermes' paused-runtime command path
   and the background engine transport. The public DAP process now has a
   repeatable live War Battles proof: a breakpoint on the permanent arena
   component stops the real packaged engine at the authored TypeScript line,
   maps the top frame to that line, evaluates live `dt`, resumes, disconnects,
   and repeats through a freshly rebuilt inspector session without restarting
   the engine.
   The same public DAP path now stops a fresh Defold Wasm game in Chrome at the
   authored `arena.script.ts` line, evaluates live `dt`, resumes, and disconnects;
   browser HMR breakpoint URLs cover both the initial and numbered generations.
   The installed package now exposes an editor-neutral Defold-semantic LSP,
   and the separate thin VS Code workspace client starts that exact local CLI,
   contributes resource/address completion, hover and definition, and launches
   the existing DAP. Native and browser runtimes now emit the same bounded live
   instance/property snapshot; the CLI joins exact schemas, the TUI renders the
   genuine rows, and the VS Code client polls the authenticated state into
   bounded CodeLens values beside authored component files. A packaged
   arm64-macOS War Battles engine has now emitted the snapshot through the
   public dev session and the authenticated endpoint joined current schemas
   with zero omissions. Generated route/argument metadata now also drives
   scoped completion, hover, and definition for attached resources,
   addressed-component resources, component addresses, and separately derived
   project message ids; real War Battles queries prove the joins. Public
   TypeScript ergonomics and extension ingestion are now complete: contextual
   hash literals, the `defold` namespace, function/class component adapters,
   context-specific projects, generated properties and documentation, and
   local/dependency `.script_api` plus C/C++ schemas all pass their common
   generation and test-twin gates. Next record the actual VS Code visual
   observation. Native activation itself is already
   proven, while cross-realm component state migration remains the distinct
   measured HMR boundary tracked by
   [issue #120](https://github.com/ts-defold/deherm/issues/120). After that,
   continue native/browser War Battles. Do not reopen the
   compiler/distribution or core TUI/HMR seams without a concrete regression.

Every route remains public when Defold exposes it. Verification status controls
the evidence label, never whether the generator ships the route; a missing
specialization must retain a generated default path and a machine-readable
limitation rather than silently removing API.

## External task ledger

GitHub issues are the public execution ledger for this roadmap. Before each
wave begins, map its work to existing open issues, merge or close duplicates,
and create an issue only when no existing issue owns the requirement. During a
wave, post concrete generated, compile, link, runtime, or packaged evidence to
the owning issues. Close an issue only when its stated acceptance criteria are
satisfied by authoritative evidence; do not keep completed issues open as
general reminders, and do not close broader issues because one representative
case passed. Every wave ends with an open-issue reconciliation so the backlog
shrinks as implementation lands.

## 0. Close and publish the current verification wave

1. Regenerate every downstream artifact through its owner after the
   source-authoritative `sys.set_render_enabled` runtime-name correction.
2. Run the Static Hermes universal-value compiler test against the pinned local
   frontend and keep its generated extern-C surface in the package smoke.
3. Run `pnpm check`, clean-room checks, the native universal dispatcher census,
   dmSDK universal tests, and OKF validation.
4. Reseal the content-addressed policy only after all outputs are current.
5. Review, commit this integrated generated-state wave atomically, push it, and
   require policy/end-to-end CI to pass.

## 1. Complete generated exact-call verification

Public ledger: [#92 Complete generated exact-call verification across emitted transports](https://github.com/ts-defold/deherm/issues/92).

### Lua/script surface

1. Generate one verification vector per emitted route from the same projection
   row: stable ID, source-corrected runtime module/member, exact arity, ordered
   input/output shapes and values, bounds, ownership, and release expectations.
2. Require a total three-lane partition for all 926 documented routes: 915
   universal runtime calls, eight property compiler intrinsics, and three timer
   bridge calls.
3. Drive every applicable row through each transport that emits it: Dynamic
   Hermes/JSI, Static Hermes typed-native, and browser/Wasm direct memory.
4. Generate callback/handle/result fixtures so every emitted target row has an
   exact-call vector.
5. Verify exact lookup, argument/result order and values, stack restoration,
   errors, reentrancy, bounds, ownership, and finalization.
6. Keep native-headless and Playwright HTML5/Wasm as packaged integration
   sentinels, not per-route gameplay scenarios.

### dmSDK surface

1. Keep every concrete reachable usage emitting both its production wrapper
   and exact verification contract from the same resolved
   recipe/substitutions. The initial 486 universal-ready declarations reached
   this gate in `2cf15fd`; the current generated partition has 566.
2. Generate ABI-compatible fake callees that exercise the compile-time-selected
   call expression and record receiver, ordered native arguments, call count,
   and result. Ownership remains a declared contract unless an independent
   lifecycle observer exists; a fake must not report its own expectation as an
   observed effect.
3. Cover functions, methods, constructors, destructors, callbacks,
   pointers/spans, enums, handles, and templates after specialization. Keep
   generic by-value records fail-closed until a typed size, alignment, and
   lifetime provider exists; the catalog recipe remains public meanwhile.
4. Run the same vectors through C ABI, JSI, Static Hermes, and browser/Wasm
   adapters wherever that call is emitted. The current 566-vector
   universal-ready partition executes in all four transports with complete
   applicability accounting; future specialized shapes must join the same
   contract as they begin emitting.
5. Keep all 1,361 recipes available; release reachability materializes and
   tests only the concrete calls retained by the final program.
6. Apply the same test-twin contract to arbitrary project extensions. Project
   generation now consumes discovered local and dependency-ZIP C headers into
   keyed IR, TypeScript, production glue, exact twins, drivers, and reports;
   C++/record/callback shapes and target-specific extension runners remain the
   next extension frontier.

### Reporting

1. Publish `verified` for generated lanes that pass the exact bridge contract.
2. Publish `suspect` only for positive source/runtime contradictions, with a
   deterministic issue link.
3. Keep fixture/profile exploration in a separate harness queue.

## 2. Finish policy-only local realization

Public ledger: [#93 Shrink published Defold policies to source-derived recipe facts](https://github.com/ts-defold/deherm/issues/93), [#94 Add lazy policy transfer and writable project surface caches](https://github.com/ts-defold/deherm/issues/94), and [#95 Use OS-native user cache roots with a safe migration path](https://github.com/ts-defold/deherm/issues/95).

1. Replace the remaining fifteen SDK compatibility snapshots with
   compiler-owned pure emitters from primary IR and compact recipe facts.
2. Replace the 10.21 MB lowering-plan object with a compact revision recipe and
   reconstruct the plan locally in `@deherm/compiler`.
3. Remove revision-derived SDK/native outputs and source archives from npm; the
   package carries stable machinery and policy carries Defold-derived facts.
4. Prove policy + npm package + project extensions regenerate final TypeScript,
   native, Static Hermes, and browser artifacts on a clean machine without a
   Defold checkout.
5. Preserve keyed/idempotent no-write generation and explicit verification.
6. Enforce `minimumPackageVersion` and `requiredCapabilities` only for genuinely
   new compiler machinery.

## 3. Close cross-platform build and publication delivery

Public ledger: [#97 Close cross-platform artifact publication and clean consumer delivery](https://github.com/ts-defold/deherm/issues/97) and [#102 Evaluate tmikov/hermes-x as the pinned Hermes upstream](https://github.com/ts-defold/deherm/issues/102).

1. Keep one ordered policy graph: discover, derive on Linux, run exact-call and
   engine sentinels, validate Linux/macOS/Windows parity, publish, then smoke a
   clean consumer.
2. Keep native artifacts green for Linux, macOS, Windows, Android, and web,
   including Windows archive paths and Android static ICU/runtime linkage.
3. Cache by complete fingerprint and schedule only missing artifact rows with
   race-safe non-cancelling concurrency.
4. Prove host tools and target archives are downloadable, digest-verified, and
   usable by npm consumers and contributors.
5. Evaluate `tmikov/hermes-x`; adopt only after existing Static Hermes, JSI,
   Android, iOS, and packaging gates pass.

Hosted full end-to-end run `35674434017` satisfies this delivery gate: the local
and extension-header jobs and every one of the eleven Bob target jobs completed
successfully. Policy/materialization transfer-size work remains a tracked
optimization and does not reopen this gate.

## 4. Finish the installed developer experience

Public ledger: [#96 Finish installed TUI, watch, HMR, telemetry, debugging, and profiling](https://github.com/ts-defold/deherm/issues/96).

1. **Completed.** `npx deherm` enters the TUI, discovers `game.project`, or
   offers a scaffold when absent, entirely from the packed npm package.
2. **Completed.** Default dev mode watches, incrementally compiles, builds when
   necessary, launches, hot-reloads, and relaunches without needless rebuilds.
3. **Completed.** Runtime HMR is acknowledged by exact bundle fingerprint and
   the TUI displays live engine, Hermes, callback, component, Lua, and arena
   telemetry with explicit unavailable reasons rather than invented values.
4. **Completed.** Logs are laptop-scrollable, mouse-selectable, copyable, and
   mirrored to `.deherm/dev/session.log`; full errors remain in the file and
   `q` tears down the engine and quits the session.
5. **Active.** The incremental compiler emits transformed JavaScript through
   TypeScript-Go's mapped emitter, composes those authored maps through esbuild,
   and passes the final map to `hermesc -source-map` for debug bytecode. Native Hermes now
   exposes a standard CLI CDP endpoint and preserves one frontend across HMR.
   Stable session discovery plus standard CPU-profile and streaming heap-snapshot
   capture are implemented. The editor-neutral DAP now provides authored
   breakpoints/source presentation, stack/scopes/variables, watches, stepping,
   exception policy, and HMR reapplication, with pinned-Hermes and background
   engine-transport proofs. The installed native War Battles smoke stops at
   `arena.script.ts`, maps stack state, evaluates `dt`, resumes, and disconnects
   through two consecutive public stdin/stdout DAP processes. A fresh
   `wasm-web` War Battles bundle also passes the browser twin through Chrome's
   own CDP endpoint: authored breakpoint, mapped frame, live evaluation,
   continue, and detach. The first VS Code/LSP slice is implemented and packed:
   generated Defold symbols drive resource/address completion, hover and
   definition, while ordinary TypeScript stays with VS Code's built-in service;
   the thin client resolves only the workspace-local déherm package and launches
   both LSP and DAP. Native/browser live instance and property telemetry now
   reaches the TUI and a schema-current CodeLens beside authored component
   files through the authenticated project state endpoint. A packaged
   arm64-macOS War Battles engine has emitted that live state through the public
   dev session; record the actual VS Code visual observation and finish the remaining route-specific
   Defold semantic projections.

## 5. Finish public API ergonomics and project integration

Public ledger: [#100 Finish idiomatic TypeScript API ergonomics and extension ingestion](https://github.com/ts-defold/deherm/issues/100).

Status: completed on 2026-09-22. The contextual-hash transform, public-root
projection, component authoring/proxy generator, context projects,
source-derived documentation, and local/dependency extension ingestion are all
mechanically covered through the public package paths described below.

1. Preserve contextual `DefoldHash` literals; runtime-hash only dynamic data.
2. Finish the public `defold` namespace migration and remove leaked `builtins`
   without changing stable ABI identities.
3. Complete function and class/factory adapters for `.script.ts`, `.gui.ts`,
   and `.render.ts`, editor properties, and context-correct tsconfigs.
4. Merge local/remote extension `.script_api`, C, and C++ surfaces into the same
   policy/projection/test-twin pipeline.
5. Preserve idiomatic names, overloads, literal address/hash types, TSDoc,
   deprecations, and provenance.

## 6. Dogfood the finished system in War Battles

Public ledger: [#99 Ship playable War Battles across native, Static Hermes, and browser](https://github.com/ts-defold/deherm/issues/99).

Current evidence (2026-09-22): tutorial-derived art, animation, input, GUI,
generated audio resources, collision/score flow, restart, bots, Dynamic Hermes,
reachable typed-native Static Hermes, and browser-host WebGL 2 are implemented
and observed. Checked native and browser evidence is current, and Chrome's
playability gate observes fire, audio-call, and round-two restart markers. The
remaining work in this tranche is installed-TUI HMR proof and the multiplayer
expansion; literal VS Code visual observation remains a tooling-tranche debt.

1. Make the tutorial-faithful game playable with real tutorial art, correctly
   sliced/anchored animation, tint/material effects, input, GUI, audio,
   collisions, scoring, restart, and bots—all in public-package TypeScript.
2. Run the same project in native Dynamic Hermes, reachable-only Static Hermes,
   and browser/Wasm projections.
3. Prove installed-TUI watch/build/launch/HMR/telemetry/relaunch.
4. Expand to 32-player authoritative multiplayer, self-hosted Colyseus
   WebTransport/QUIC with fallback, bots, tanks/weapons/upgrades, effects,
   persistence, soak tests, and local Docker orchestration.

## 7. Reserved frontiers after the core/product gate

Public ledger: [#103 React or Preact GUI](https://github.com/ts-defold/deherm/issues/103), [#101 TypeGPU and `use math`](https://github.com/ts-defold/deherm/issues/101), [#98 strict Static Hermes extension authoring](https://github.com/ts-defold/deherm/issues/98), [#105 TurboModule/Nitro/JSI modules](https://github.com/ts-defold/deherm/issues/105), and [#104 focused upstream Static Hermes fixes](https://github.com/ts-defold/deherm/issues/104).

1. React or Preact hooks over Defold GUI with a custom reconciler and measured
   Yoga/Clay choice.
2. TypeGPU shaders and a checker-aware `"use math"` ttsc/VS Code transform with
   remappable vmath/xMath backends.
3. Strict Static Hermes TypeScript extension authoring, proven with an ECS.
4. Compatible TurboModule/Nitro/JSI native modules through the registry.
5. Focused upstream Static Hermes TypeScript fixes with reproductions and tests.

# Completion rule

Work proceeds in order. Later product work may run in parallel but cannot
bypass the generator, policy, verification, or package boundaries. Each
substantial wave ends with owned regeneration, focused tests, full `pnpm check`,
an adversarial review when appropriate, an atomic commit, a push, green CI, and
reconciliation of its GitHub issues against the evidence that just landed.
