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

## 4. Finish the installed developer experience

Public ledger: [#96 Finish installed TUI, watch, HMR, telemetry, debugging, and profiling](https://github.com/ts-defold/deherm/issues/96).

1. Make `npx deherm` enter the TUI, discover `game.project`, or offer a scaffold
   when absent, entirely from the published npm package.
2. Default dev mode watches, incrementally compiles, builds when necessary,
   launches, hot-reloads, and relaunches without needless rebuilds.
3. Verify runtime HMR by exact bundle fingerprint and display live engine,
   Hermes, callback, component, Lua, and arena telemetry.
4. Make logs laptop-scrollable/copyable and mirrored to a plain file; surface
   full errors; make `q` teardown and quit.
5. Finish source maps, Hermes debugging/profiling, and the VS Code extension/LSP
   with context types and live instance/property telemetry.

## 5. Finish public API ergonomics and project integration

Public ledger: [#100 Finish idiomatic TypeScript API ergonomics and extension ingestion](https://github.com/ts-defold/deherm/issues/100).

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
