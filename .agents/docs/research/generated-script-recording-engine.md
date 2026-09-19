---
type: Design and Verification Report
title: Generated script recording engine
description: A generated null/observer Defold that asserts, records, and replays every callable script route through the real binding stack over each drivable transport.
tags: [bindings, verification, transports, jsi, static-hermes, browser, contracts]
status: active
generated: { by: claude/opus-5, at: 2026-09-18T18:40:00-04:00 }
sources:
  - id: canonical-plan
    resource: ./canonical-lowering-plan.md
    title: Canonical cross-target binding lowering plan
    author: project:deherm
  - id: completion-matrix
    resource: ./full-stack-completion-matrix.md
    title: Full-stack completion matrix
    author: project:deherm
---

# Problem

The script surface has 926 routes, 915 of them callable and non-intrinsic.
Authoring an engine scenario per route does not scale and drifts. The canonical
lowering plan already proves the real redundancy: those routes reduce to a small
set of interned effect contracts and marshalling programs. The useful unit of
verification is therefore the contract, not the route.

# What this is

A **generated** null/observer engine. `scripts/generate-script-recording-engine.mjs`
and `packages/compiler/src/script-recording-engine.mjs` consume the same IR that
emits the bindings — the script projection IR, the universal-value binding
report, the handle-kind ledger, and the canonical lowering plan — and emit four
things:

1. **A provider** (`tests/fixtures/generated_script_recording_provider.cpp`).
   It installs under the real `ScriptBridgeApi` seam, where Defold would be. For
   every incoming call it asserts the declared contract — arity, per-slot wire
   value shape, retained-handle runtime tokens, result storage capacity, and a
   fresh string/table scratch frame — records the observation, and synthesises a
   result of the declared shape.
2. **A driver** (`tests/fixtures/generated_script_recording_driver.cpp` plus
   `generated_script_recording_driver.js`). It replays every route through the
   **real** binding stack on each drivable transport.
3. **An expected trace** (`tests/fixtures/generated_script_recording_expected_trace.txt`),
   derived from the contract alone, never from a run.
4. **A three-way diff**: driver output against provider recording against
   expectation, plus a cross-transport diff per route.

There is no hand-authored per-route code anywhere in the harness. Route tables,
wire value shapes, driver order, and skip reasons are all interned and generated;
the provider and driver are generic machines over those tables.

# Transports

The plan models transports, not engines. The harness drives every transport that
sits above the recorded seam:

| Transport | Runtime | Entry point driven | Status |
|---|---|---|---|
| `jsi` | hermes | `globalThis.__defoldScriptBridgeV1.call` inside a real Hermes runtime | drivable |
| `direct-memory` | browser | the exported `deherm_script_universal_dispatch` universal wire | drivable natively |
| `typed-native` | hermes | the Static Hermes fixed-capacity frame C API | drivable |
| `lua-stack` | hermes | — | **not drivable**: Lua sits *below* the recorded seam, so driving it would require the real engine this harness replaces |

`direct-memory` is driven natively through the same exported wire symbol the
browser host calls. That is transport evidence, not browser-host evidence.

# Evidence boundary

**This proves only that the generated binding stack matches this repository's
declared contract.** It cannot and does not prove that the contract matches
Defold. Nothing in the generated report, trace, or harness output is engine
conformance evidence, and no row of the completion matrix may be promoted from
it.

Every trace record is keyed by the canonical lowering plan's **interned contract
index**, so a later real-engine differential can diff against these records per
contract rather than per route. The generated report carries the exact
`planSha256` it was built against and a `planInputDrift` ledger recording any
declared plan input whose bytes no longer match the plan's own recorded hash.

# Current census

Generated for 915 callable routes across 79 distinct contracts and 504 distinct
marshalling programs:

| Transport | Exercised | Skipped |
|---|---|---|
| `jsi` | 865 | 50 |
| `direct-memory` | 890 | 25 |
| `typed-native` | 861 | 54 |

Every skip carries a machine-readable reason:

* `callback-argument-lifetime-is-not-modelled-by-the-recorder` (23 routes, all
  transports) — the recorder does not yet own a retained-callback lifetime, so
  it refuses to drive callback arguments rather than guess one.
* `result-callback-is-not-synthesizable` (2 routes, all transports) — the two
  higher-order Lua-closure results the canonical plan already blocks.
* `no-recorded-handle-source:<kind>` (25 routes, `jsi` only) — JavaScript cannot
  fabricate a retained engine handle; it can only present one an earlier
  recorded call minted. The driver order is a generated fixpoint over that pool,
  which reaches 14 of the 15 handle kinds. `box2d-shape` and `graphics-texture`
  have no handle-free producer, so their consumers stay explicitly undriven.
* `static-frame-has-no-url-or-matrix4-argument-push` (29 routes, `typed-native`)
  — a real capability gap in the Static Hermes frame API, recorded rather than
  worked around.

# Findings

The first end-to-end run found a real defect and one real asymmetry:

* **Aliased empty result tables read as a cycle.** The universal encoder detects
  cycles by comparing `ScriptValue::data` pointers. Two empty tables in one
  result graph that share the scratch cursor alias to the same address and were
  rejected as `Universal backend returned a cyclic table`. Any backend that
  returns more than one empty table per frame hits this. The generated provider
  now claims one scratch slot per table so addresses stay distinct; the encoder's
  pointer-identity cycle rule is unchanged and remains a live constraint on every
  backend.
* **Transport asymmetry on handle arguments.** The wire transports accept a raw
  retained handle; JSI structurally cannot. That asymmetry is now explicit in the
  generated skip ledger instead of being invisible.

After those, the harness runs clean: 915 routes, three transports, zero contract
violations, zero expectation divergences, zero cross-transport divergences.

# Reproducing

```
pnpm test:script-recording-engine
```

Generation is registered with the script generator pipeline and its clean-room
gate, so the provider, driver, tables, JavaScript driver, expected trace, and
report are all regenerated byte-identically from pinned inputs.

# Next gates

1. Give the recorder a bounded retained-callback lifetime so the 25
   callback-lifecycle routes stop being skipped.
2. Add a `box2d-shape` and `graphics-texture` handle source so the JSI fixpoint
   closes over all 15 handle kinds.
3. Add URL/Matrix4 argument pushes to the Static Hermes frame API, or retain the
   capability blocker explicitly in the canonical plan.
4. Run the same route set against a packaged Defold engine and diff **per
   contract** against these records. Only that step can say anything about
   Defold.
