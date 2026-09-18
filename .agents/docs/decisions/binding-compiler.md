---
type: Architecture Decision
title: Compile bindings to direct C ABI calls and fixed memory layouts
description: Use one validated binding IR to generate TypeScript, Static Hermes, JSI, C, and Emscripten surfaces without runtime reflection or Embind.
tags: [decision, bindings, ffi, static-hermes, jsi, emscripten]
status: accepted
generated: { by: codex/gpt-5, at: 2026-09-17T00:00:00-04:00 }
sources:
  - id: defold-generator
    resource: https://github.com/defold/defold/blob/dev/scripts/dmsdk/gen_sdk.py
    title: Defold dmSDK generator
    author: team:defold
  - id: defold-csharp
    resource: https://github.com/defold/defold/blob/dev/scripts/dmsdk/gen_csharp.py
    title: Defold C# generator
    author: team:defold
  - id: hermes-types
    resource: https://github.com/facebook/hermes/blob/static_h/doc/TypedLanguage.md
    title: Static Hermes typed language
    author: team:meta
  - id: hermes-ffigen
    resource: https://github.com/facebook/hermes/blob/static_h/tools/ffigen/ffigen.py
    title: Static Hermes FFI generator
    author: team:meta
  - id: nitro
    resource: https://github.com/mrousavy/nitro
    title: Nitro Modules
    author: human:mrousavy
---

# Decision

Treat bindings as a small compiler, not a collection of wrappers. A canonical,
validated IR produces every target surface in one deterministic pass:

* ergonomic TypeScript interfaces and a type-inferred module registry;
* explicit fixed-width C declarations;
* C `sizeof` and `offsetof` assertions for every shared memory record;
* eager JSI module objects containing statically generated host functions;
* Static Hermes typed `$SHBuiltin.extern_c` declarations;
* TypeScript typed-array memory layouts and read/write codecs for Wasm;
* later, Lua declarations and adapters from the same IR.

Each callable also receives its own generated ESM input. This granularity lets
the real bundler graph produce an exact used-symbol manifest. The same compiler
can then filter all runtime projections from that manifest while leaving the
complete declaration surface available to the editor.

There is no runtime reflection, string-keyed native dispatcher, JSON
serialization, Embind, or generic variant representation in a scalar call.
Generated JSI thunks validate JavaScript at the boundary and invoke the final C
symbol directly. Static Hermes calls the same symbol through its compiler-known
C signature.

# Defold C# precedent

Defold runs Clang with `-ast-dump=json`, filters declarations selected by each
library's `sdk_gen.json`, extracts documentation, and feeds a language emitter.
The C# emitter maps a limited set of C types to unsafe C# structs and
`DllImport` declarations. Per-library rename and ignore tables repair the public
surface.

This is a useful ingestion architecture but not a complete binding solution.
At the pinned Defold revision only five generated C# binding files cover dlib,
extension, and Lua APIs. Enums and function typedefs are disabled in the C#
emitter, unsupported struct fields truncate generation, and layout handling is
marked TODO. We will reuse the Clang/documentation IR idea, not copy those
limitations into the JavaScript ABI.

# Static Hermes fit

Static Hermes' typed language exposes fixed native types such as `c_i32`,
`c_u32`, `c_f32`, `c_f64`, and `c_ptr`. Its own `ffigen.py` converts C headers
to `extern_c` declarations, lowers structs passed by value to pointer/out
parameters, and emits field-offset accessors. That validates the overall model.

The strict tier starts with `bool`, `i32`, `u32`, `f32`, `f64`, and `void`.
Ambiguous `number` declarations are rejected. Strings, arrays, structs in
calls, 64-bit identifiers, and ownership-bearing objects are not silently
boxed; each needs an explicit lowering and lifetime rule.

Defold's own value types are the first such lowering. `vector3`, `vector4`,
`quaternion`, `matrix4`, `hash`, and `url` are transparent fixed-layout records,
so the generator owns their element counts, widths, and ordering as ABI and
derives every one of them from the pinned dmSDK headers rather than declaring
them. Modelling them as opaque handles was rejected: it would leave every vmath
operation boxed and make the tier pointless. Engine-owned values such as
`node`, `buffer_data`, and `render_target` stay opaque and fail closed until the
retained-handle transport exists. See
[Transparent Defold value transport](../research/transparent-defold-value-transport.md).

# Emscripten memory contract

HTML5 uses raw Wasm exports and the generated memory schema. Fixed-layout POD
records have compile-time byte sizes, alignments, and offsets. TypeScript codecs
address reusable `Uint8Array`, `Int32Array`, `Uint32Array`, `Float32Array`, and
`Float64Array` views directly. A memory-growth hook must refresh those views.

Struct and span calls will reserve reusable scratch arenas rather than allocate
per call. Large buffers remain in Wasm memory and are exposed as views where
lifetime permits. This keeps the HTML5 path independent of Embind.

# Performance rules

* Scalar calls lower to one generated type check, unbox, native call, and box.
* Module functions are created once during runtime installation.
* Stateful objects use `NativeState` and shared prototypes, not one function
  object per instance.
* Hot POD and span paths reuse scratch memory and typed-array views.
* Debug builds validate ranges, layout version, and lifetimes. Release builds
  may elide checks proven by the typed frontend, but never change the ABI.
* Every new type lowering needs conformance tests and a microbenchmark.
* Development packages contain the complete precompiled adapter set; release
  generation computes a transitive type/layout/callback dependency closure
  from the used-symbol manifest before native dead stripping.

The initial arm64 macOS release-build harness performs one million generated
JSI-to-C-ABI scalar calls. Its first observed run measured 26.6 ns per native
call versus 20.6 ns per pure JavaScript addition in the same Hermes runtime.
This is a smoke benchmark, not a cross-platform performance claim; future work
must report warm distributions and compare struct/span lowerings separately.

# Ingestion plan

The durable source of truth is the curated C facade, because most dmSDK headers
are C++ and expose engine-owned pointers and templates that should not cross a
public ABI verbatim. A Clang importer will read selected dmSDK headers and docs,
normalize them into the same IR, and require explicit policy for ownership,
thread affinity, nullability, handles, and callbacks before emitting code.

The schema file is the current executable prototype of that IR. It should
eventually become a versioned compiler package rather than remain a single
repository script.
