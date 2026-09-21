---
type: Verification Report
title: Scalar Lua dispatch evidence and limits
description: Source validation, allocation measurements, and honest executable limits for the generated scalar Lua bridge.
tags: [verification, lua, bindings, allocation, codegen]
status: spike-validated
generated: { by: codex/gpt-5, at: 2026-09-17T00:00:00-04:00 }
sources:
  - id: defold
    resource: https://github.com/defold/defold/tree/7f0f554f41f9dce1e0ddff99bf08200657d1ee05/engine
    title: Pinned Defold engine source
    author: team:defold
---

# Scalar Lua dispatch evidence and limits

The generated scalar slice assigns stable FNV-1a IDs to all 90 bindings in the
`scalar` lowering family and emits compact structure-of-arrays descriptors.
This is descriptor coverage, not a claim that every engine API can execute in
a standalone Lua state. GUI, render, profiler, platform, crash, HTML5, and
other functions require modules and engine-owned context registered by Defold.
The dispatcher binds only functions selected by generated code or the bundler,
so a target does not need to cache every platform-specific API.

## Installed universal seam

All 926 generated TypeScript function wrappers now embed the same collision-
checked FNV-1a stable ID used by the native descriptors and call one public
`DefoldScriptBridge.call(stableId, args)` surface. Native Hermes installs that
surface as `globalThis.__defoldScriptBridgeV1` through JSI. The browser host
installs the same surface and crosses a bounded Emscripten C shim without
`embind`. A manual `installDefoldScriptBridge` override remains available for
tests and alternate hosts.

The C++ ABI is deliberately wider than the first executable family: a tagged
`ScriptValue` reserves primitive, handle, callback, table, and Defold-value
tags, while `ScriptCallFrame` supports multiple results. The current adapter
executes the 90 scalar descriptors only. Calls in the other 836 generated
function rows fail with an explicit unsupported-family error; they are not
counted as executable. This preserves one public bridge while later codecs
graduate onto the same stable-ID dispatch path.

The native end-to-end fixture bundles actual generated TypeScript wrappers and
proves the complete path through Hermes, JSI, the tagged frame, the scalar
descriptor, and pinned Defold Lua 5.1. It covers number, integer, boolean,
string, optional input, and void output shapes; then checks an unsupported
table-family call, a Lua error, and a successful call after that error. The
Lua stack top and prior Defold script instance are exact before and after.
The browser test exercises the equivalent stable-ID/tagged memory layout and
verifies that its stack scratch rewinds after both success and rejection.

## Static Hermes exact-call twin

The Static Hermes transport does not add a scalar-only C ABI. Its generated
sound-typed caller encodes the 90 scalar routes into the same bounded universal
frame used by the typed-native bridge, then dispatches their stable IDs through
the production `ScriptCallFrame` seam. The generator selects those routes by
`loweringFamily === "scalar"` from the recording IR and emits their exact
arguments and result predicates alongside the existing 127 Defold-value
vectors. The native recording provider therefore observes the same stable ID,
ordered primitive values, arity, and decoded results that a production Static
unit uses.

The scalar wave's 217-route census had no scalar table-entry, Matrix4, or URL
scratch requirement; however, it deliberately retained the production frame's
fail-closed argument bound and reentrant frame-pool behavior. Its normal and
ASan/UBSan executions prove the bridge contract and memory-safety gate. They do
not instrument allocation calls or assert Defold implementation semantics for
context-dependent calls. Warmed allocation evidence comes from the separate
instrumented scalar runtime benchmark below.

## Reproduced source claims

- `render.set_viewport` reads four integer stack slots with
  `luaL_checkinteger` and returns no values in
  `engine/render/src/render/render_script.cpp:971-983`. It also calls
  `RenderScriptInstance_Check`, proving that generic marshaling alone is not
  sufficient: the bridge must restore the captured Defold script instance.
- `render.set_color_mask` requires four actual Lua booleans before reading them
  in `engine/render/src/render/render_script.cpp:2272-2290`. The scalar codec
  therefore uses exact tags instead of Lua 5.1 truthiness or numeric coercion.
- `gui.get_width` returns one Lua number and requires the current GUI scene in
  `engine/gui/src/gui_script.cpp:3110-3116`.
- `sys.get_config_boolean` treats its second argument as optional, reads it by
  Lua truthiness, and pushes a boolean when an engine config exists in
  `engine/script/src/script_sys.cpp:668-691`. The generated TypeScript-facing
  codec remains stricter and only accepts a boolean, matching the documented
  API. The implementation can push `nil` when there is no script context even
  though the reference type says `boolean`; that source/document discrepancy
  remains visible rather than widening the public type from an abnormal
  engine-less state.
- `bit.tohex` uses `lua_isnone(L, 2)` and defaults the missing digit count to 8
  in `engine/script/src/bitop/bitop.c:125-137`. The imported parameter metadata
  failed to mark `n` optional despite prose and examples saying it is optional.
  A narrow generated override records the source line and makes its accepted
  arity 1-2.
- `liveupdate.is_built_with_excluded_files` pushes exactly one boolean in
  `engine/liveupdate/src/script_liveupdate.cpp:157-165`.

All evidence above was checked against pinned Defold revision
`7f0f554f41f9dce1e0ddff99bf08200657d1ee05`.

## Allocation and ownership boundary

The dispatcher owns a fixed 90-entry registry-reference array. Its generated
tables are read-only static data. A `ScalarCallArena` stages the current maximum
of six trivial input cells in call-local storage and has no heap fallback.
Function lookup, Lua registry references, and stack reservation occur before
the hot path.

The native harness installs instance get/set hooks, captures a target instance,
and demonstrates zero Lua allocator calls and zero C++ `operator new` calls
across 500,000 warmed numeric dispatches including instance swap/restore. It
also checks stack restoration after success and failure, arena rewind after
every call, and zero live bytes after `lua_close`. This does not imply that
every Lua call is allocation-free:
new strings may be interned, Lua errors may be formatted, and the selected
Defold function may allocate internally. String results are copied into a
caller-provided bounded buffer before stack restoration; the bridge never
returns a pointer into a popped Lua value.

## Stable-ID lookup consolidation

Source inspection reproduced three searches of the same 90-entry scalar table
on a warmed scalar call: the adapter's scalar-family gate,
`Dispatcher::isBound`, and `Dispatcher::dispatch`; an unbound first call also
searched in `Dispatcher::bind`. Both files carried their own implementation of
that search. Independent selectors for the families probed before the scalar
fallback are outside this count and remain unchanged.

There is now one shared `findDenseIndex` implementation. The adapter resolves
the sparse stable ID once and carries that dense index through bounds-checked
bind/status/dispatch entry points. Direct Dispatcher callers retain stable-ID
entry points that each perform one lookup. No generated descriptor was edited,
no allocation or mutable lookup table was added, and every dense entry point
checks the table bound before indexing.

The production `ScriptAdapter` path was added to the existing release transport
benchmark. On this Apple M4 host, with 20,000 warmups and nine repeats of
100,000 four-integer `render.set_viewport` calls, three whole-binary runs gave:

| State | Best-of-nine ns/call runs | Mean |
| --- | --- | ---: |
| three steady-state searches | 260.3, 261.8, 262.8 | 261.6 |
| one steady-state search | 259.3, 259.0, 261.3 | 259.9 |

This is a measured 1.8 ns/call (0.7%) reduction on this host, not a device or
engine-wide performance claim. Follow-up controls measured the complete adapter
at 258.6 ns/call, direct dense Dispatcher entry at 207.4 ns/call, and the
remaining lookup across all 90 IDs at 4.4 ns/call. The adapter/dense difference
is an upper bound containing family probes, ScriptValue conversion, arena work,
and outer validation—not evidence that the Dispatcher's defensive validation is
expensive. Therefore argument revalidation stays, the family order stays, and
no perfect/dynamic hash is introduced.

`test:scalar-lua-runtime` still reports zero warmed Lua allocator calls, zero
C++ allocations, balanced stack/instance restoration, and zero Lua live bytes
after shutdown. `test:scalar-lua-sanitize` executes the same family under
ASan/UBSan with no finding. This sanitizer result covers the host harness only;
it is not whole-engine or device leak evidence.

## Remaining blockers before engine-validated 90/90

1. Generate usage-selected bind lists per bundle and target. HTML5-only and
   native-only modules cannot all be required in one state.
2. Run conformance calls inside real engine fixtures for every module; the
   standalone harness deliberately mocks only representative stack shapes.
3. Resolve source/reference discrepancies as explicit semantic tokens, never
   by broad coercion. `bit.tohex` is the first proven example.
4. Measure allocators on device. The codec eliminates native transient heap
   work, but an individual Defold API may still allocate by design.
