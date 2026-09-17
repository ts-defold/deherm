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

The native harness demonstrates zero Lua allocator calls and zero C++
`operator new` calls across 500,000 warmed numeric dispatches, stack restoration
after success and failure, arena rewind after every call, and zero live bytes
after `lua_close`. This does not imply that every Lua call is allocation-free:
new strings may be interned, Lua errors may be formatted, and the selected
Defold function may allocate internally. String results are copied into a
caller-provided bounded buffer before stack restoration; the bridge never
returns a pointer into a popped Lua value.

## Remaining blockers before executable 90/90

1. Generate usage-selected bind lists per bundle and target. HTML5-only and
   native-only modules cannot all be required in one state.
2. Wire Defold's instance get/set hooks and capture the correct script, GUI, or
   render instance at the Hermes ownership boundary.
3. Run conformance calls inside real engine fixtures for every module; the
   standalone harness deliberately mocks only representative stack shapes.
4. Resolve source/reference discrepancies as explicit semantic tokens, never
   by broad coercion. `bit.tohex` is the first proven example.
5. Measure allocators on device. The codec eliminates native transient heap
   work, but an individual Defold API may still allocate by design.
