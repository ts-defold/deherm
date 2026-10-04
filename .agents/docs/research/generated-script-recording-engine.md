---
type: Design and Verification Report
title: Generated script recording engine
description: A generated null/observer Defold that asserts, records, and replays every callable script route through the real binding stack over each drivable transport.
tags: [bindings, verification, transports, jsi, static-hermes, browser, contracts]
status: active
generated: { by: agent/legacy, at: 2026-09-18T18:40:00-04:00 }
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
report, the handle-kind ledger, exact overload/value/table descriptors, and the
canonical lowering plan — and emit five
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
5. **A real-Lua ScriptAdapter companion**
   (`tests/fixtures/generated_script_recording_lua_adapter.cpp`). It installs
   route-indexed C closures at every exact nested module/member path and calls
   `ScriptAdapter::api()` with generated arguments. Six source-derived runtime
profiles supply the union of handle routes, and generated game-object, GUI,
and render test contexts use distinct instance identities and select the
required captured instance per component-scoped call. Global and explicit-
handle calls assert the carrier selected by their actual generated adapter
family rather than treating either the prior or captured instance as
interchangeable.

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
| `lua-stack` | hermes | `ScriptAdapter::api()` over pinned Lua 5.1 | driven by the exact-call companion, outside the recording trace |

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

Generated for 1,056 callable/constant routes across 83 distinct contracts and 505 distinct
marshalling programs:

| Transport | Exercised | Skipped |
|---|---|---|
| `jsi` | 1,056 | 0 |
| `direct-memory` | 1,031 | 25 |
| `typed-native` | 1,031 | 25 |

Every skip carries a machine-readable reason:

* `callback-target-requires-jsi-registry` (23 routes, direct-memory and
  typed-native) — callback inputs execute in JSI with real function descriptors;
  the generic recorder does not fabricate a JavaScript callback registry. The
  browser applicability projection owns a separate generated exact-call driver
  for these rows.
* `function-result-is-jsi-only` (2 routes, direct-memory and typed-native) —
  higher-order Lua-closure results are emitted by JSI and explicitly outside the
  two fixed-frame target contracts.

Generated provider-only handle seed routes now mint genuine HostObjects for the
two input-only `box2d-shape` and `graphics-texture` kinds, so JSI executes the
full route set. Static URL and Matrix4 pushes also use their real bounded frame
helpers; neither family remains a skip.

The browser applicability companion derives all 23 callback-registry vectors
from the same route, shape, exact-contract, and lifecycle records. A pinned
Emscripten build links the production direct-memory universal bridge and the
production browser callback registry into real Wasm, then Chrome executes the
complete route set. The generated driver compares stable IDs, argument and
result order, callback arguments and synchronous results, and explicit
retain/dispatch/release/finalization. It also executes a nested reentrant route,
the registry capacity bound, and whole-registry invalidation. This is exact
JavaScript/Wasm bridge evidence, not packaged Defold behavior.

The canonical Dynamic-Hermes emitted partition is independently reported and
must total 1,054 routes:

| Exact twin | Routes | Current evidence |
|---|---:|---|
| Real Lua 5.1 through `ScriptAdapter::api()` | 1,023 | exact lookup, arguments, results, call count, stack restoration, instance restoration, missing-member failure, and allocator-longjmp recovery |
| Native POD specialization | 31 | generated real-Hermes exact driver executes the production adapter with exact stable-ID, argument, result, and failure-contract checks; deliberately not mislabeled as Lua-stack evidence |
| Source/profile omission | 2 | omitted by the canonical profile and retained as machine-readable skips |

The Lua companion still installs providers for all 1,056 routes. Its success line
uses `deherm-script-lua-exact-result/v1`; failures use
`deherm-script-lua-exact-failure/v1` with a route index, stable generated code,
and detail. GUI/render attachment here is test-fixture capability only. Product
`*.gui.ts` and `*.render.ts` proxy providers remain
`provider-required-unimplemented`.

Result handles are also checked at the carrier boundary. Top-level semantic
handles must be generation-checked semantic roots, specialized GUI-node results
must use the GUI-node carrier, and semantic HANDLE/GUI_NODE shapes nested inside
universal tables use the semantic-handle carrier only when that exact
route/path is marked as a semantic `Handle` by canonical universal result-shape
metadata. Opaque metadata paths and explicit USERDATA shapes remain generic
rooted Lua-userdata carriers, even if the recording fixture's source shape has
a semantic-looking label. The generated recording oracle checks those
distinctions recursively; it does not weaken or coerce runtime output to make a
route pass.

Two formerly blocked value-tail codecs are now pinned to their concrete source
contracts. `gui.set_texture_data` calls `luaL_checktype(L, 5, LUA_TSTRING)` and
reads the counted payload with `lua_tolstring(L, 5, &buffer_size)`; it accepts the
documented `rgb`, `rgba`, `l`, and `astc` string domain (including the
string-compatible `image.TYPE` constants); its generated negative assertion
forbids silently widening that slot to `Number`. `liveupdate.remove_mount`
stores `dmLiveUpdate::Result` and returns it with `lua_pushinteger`; its generated
result codec is therefore the numeric/integer carrier for the exported
`LIVEUPDATE_*` domain.

The source-derived counted-string fact is preserved as a byte semantic instead
of being narrowed to UTF-8 text. Public TypeScript accepts `Uint8Array |
ArrayBuffer`; dynamic JSI borrows the exact bytes; the generated Lua adapter uses
`lua_pushlstring`; and the direct-memory, browser/Wasm, and Static Hermes frame
transports all carry the same byte tag and length. Exact fixtures include
`00 80 ff 41`, so the evidence rejects both NUL truncation and UTF-8 rewriting.
The sound-typed Static Hermes exact runner independently executes all 517 routes
the canonical plan emits for that target; its route-aware argument planner
constructs the counted-string slot as `DehermStaticBytes` while retaining the
source Lua string shape. This is generated bridge/provider evidence, not a live
Defold GUI-scene call.

Value-tail Lua work uses a C-only nested protection structure rather than
relying on C++ destructor triviality. The outer `lua_cpcall` callback saves the
previous current instance; an inner `lua_pcall` contains function binding,
argument preparation, target invocation, and result copying. If Lua allocation
longjmps during a value-tail string push, the inner call returns an error to the
outer C callback, which restores the prior instance before control returns to
the C++ adapter. The fixed native argument arrays are prepared before entering
Lua and bounded by the generated maximum arity. An injected allocator test
forces OOM on a unique 8 KiB value-tail string and checks fail-closed behavior,
stack and instance restoration, and subsequent usability. `lua_checkstack`
reserves stack slots but does not guarantee `lua_pushlstring` or userdata
allocation succeeds. The public Defold `dmScript::PushHash` remains an explicit
upstream trust boundary because preserving canonical hash userdata identity
requires that API; pinned `PushHash`, `CreateLuaHashUserdata`, and
`PushHashWeakTableKey` use only trivial scalar, pointer, and hash-table locals,
though their internal C++ frames are not converted into C. This is host
Lua failure-containment evidence, not allocation-free or packaged-engine
evidence.

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

After those, the harness runs clean: 915 routes over the three recorded
transports plus 882 exact Lua-adapter routes, with zero contract violations,
expectation divergences, cross-transport divergences, stack leaks, or instance
restoration failures.

# Reproducing

```
pnpm test:script-recording-engine
pnpm test:script-browser-callback-exact-call
```

Generation is registered with the script generator pipeline and its clean-room
gate, so the provider, drivers, Lua adapter companion, tables, JavaScript
driver, expected trace, and report are all regenerated byte-identically from
pinned inputs.

# Next gates

1. Add a reverse callable-result token only if browser, Static Hermes, or raw
   Lua begins emitting the two higher-order closure-result contracts; until then
   their blocker is exact and intentional.
2. Run the same route set against a packaged Defold engine and diff **per
   contract** against these records. Only that step can say anything about
   Defold.
