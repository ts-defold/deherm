---
title: Native extension header ingestion and generated ABI glue
description: Current deterministic path from a third-party C header to normalized IR, TypeScript declarations, and universal value-cell dispatch.
type: research
status: active
---

# Native extension header generator

`deherm generate-extension-api --header <header> --module <prefix> --output
<directory>` invokes Clang's JSON AST, normalizes declarations into a stable
extension IR, then emits TypeScript and C++ dispatch glue. The generated code
uses the same 24-byte value cell and status vocabulary as the dmSDK universal
ABI. It is a mechanical projection; no API method is authored by an agent.

The proven C11 slice contains free functions whose names begin with the chosen
module prefix and whose inputs/results are void, booleans, fixed-width signed
or unsigned integers, float/double, declared enums, or C strings. Generated
glue validates cell tags, boolean and integer narrowing, and enum domains
before calling the extension symbol. Clang-discovered records are emitted as
TypeScript metadata, but by-value records and arbitrary pointers are cataloged
with exact blockers instead of receiving guessed layouts or ownership.

The fixture parses one header containing four functions, one enum, and one POD
record. Three scalar/enum/string routes generate; the by-value record route is
reported as `cataloged-needs-layout`. A native compile/link/runtime test calls
the generated dispatcher against real fixture implementations. A CLI test
proves the same files are available to npm consumers.

This is not yet a complete arbitrary C++ extension bridge. C++ methods,
overloads, templates, callbacks, record layout/alignment, pointer ownership,
nullable contracts, platform feature gates, and extension lifecycle/thread
affinity need schema inputs and project-catalog integration. Dependency ZIP
headers also need deterministic extraction before Clang can ingest them.

# Browser typed arena

The dmSDK generator now emits `browser-arena.ts`. It implements the typed
`DmSdkUniversalBridge` over the raw Emscripten direct-memory transport, writes
and reads the exact 24-byte little-endian cell layout, bounds addresses to
wasm32, validates scalar/object domains and the catalog SHA, encodes transient
UTF-8 strings, and releases every arena allocation in reverse order. A Node
WebAssembly-memory harness executes bigint and string calls and verifies
balanced releases.

The transport still needs to be installed by the packaged HTML5 extension and
backed by its bounded Wasm scratch allocator. The adapter proof does not claim
a rebuilt Defold HTML5 bundle or all 1,361 dmSDK routes.
