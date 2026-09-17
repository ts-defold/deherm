---
type: Architecture Decision
title: Use a Defold-owned typed JSI module registry
description: Borrow the useful authoring shapes of TurboModules and Nitro Modules without taking a React Native runtime dependency.
tags: [decision, jsi, turbo-modules, nitro-modules]
status: accepted
generated: { by: codex/gpt-5, at: 2026-09-17T00:00:00-04:00 }
sources:
  - id: react-native-turbo
    resource: https://reactnative.dev/docs/turbo-native-modules-introduction
    title: React Native Turbo Native Modules introduction
    author: team:react-native
  - id: nitro
    resource: https://github.com/mrousavy/nitro
    title: Nitro Modules
    author: human:mrousavy
---

# Status

Accepted. The handwritten proof has been replaced by generated JSI installers.

# Decision

Expose a Defold-owned, type-inferred `DefoldModules.get()` /
`getEnforcing()` API and generate module bindings from a runtime-neutral IR.

Native implementations install direct JSI host functions and objects. Browser
implementations install equivalent JavaScript objects that call the Defold
Emscripten bridge where engine access is needed.

The generated implementation waist is a C ABI. Dynamic Hermes wraps it with
JSI; Static Hermes uses `extern_c`; Lua uses ordinary native-extension bindings;
and HTML5 reaches it through Emscripten. This keeps target-specific VM objects
out of the durable engine interface.

# Compatibility stance

TurboModules provide useful typed-spec and enforcing-registry conventions, but
their registry, lifecycle, Codegen output, and platform integration belong to
React Native. Nitro Modules are closer to the desired static JSI binding and
instance-based object model, but their package, autolinking, and Swift/Kotlin
layers likewise assume React Native.

Therefore the first goal is source-pattern compatibility, not binary drop-in
compatibility. A later adapter may ingest a conservative subset of
TurboModule or `*.nitro.ts` specs, but generated C++ must target the
Defold-owned installer ABI.

# Implemented proof

The sample resolves a typed `ExampleMath` module and calls `add(20, 22)`.
Native execution reaches a Hermes JSI host function directly. Browser execution
uses the same TypeScript call against an ordinary browser object. Both emit
`module:42` in the parity transcript.

The host function delegates to an `extern "C"` function, and the Defold HTML5
adapter refers to the same symbol. `bindings/modules.json` now generates the
TypeScript interface, fixed Wasm memory layouts, C declarations and layout
assertions, JSI installer, and Static Hermes `extern_c` projection. The Static
Hermes compiler accepts the generated typed declarations.

Singleton modules are eagerly-created ordinary JSI objects containing host
functions. This avoids a `HostObject.get()` trap and function allocation on
every property read. Stateful native instances will instead use JSI
`NativeState` plus generated shared prototypes, following Nitro's current
hybrid-object shape.

# Follow-up

Add pointer/out-parameter lowering for structs, borrowed strings and spans,
opaque Defold handles, callbacks, promises, and hybrid-object lifetime. Then
generate one module contributed by a separate Defold extension before
promising compatibility with either ecosystem.
