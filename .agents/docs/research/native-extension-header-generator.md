---
title: Native extension header ingestion and generated ABI glue
description: Current deterministic path from a third-party C header to normalized IR, TypeScript declarations, and universal value-cell dispatch.
type: research
status: active
---

# Native extension header generator

`deherm generate` now consumes every public C header found by project extension
discovery; the isolated `generate-extension-api` command remains available for
generator development. Project generation invokes Clang's JSON AST, normalizes
declarations into stable extension IR, then emits TypeScript and C++ dispatch
glue. The generated code
uses the same 24-byte value cell and status vocabulary as the dmSDK universal
ABI. It is a mechanical projection; no API method is authored by an agent.

Local and resolved dependency-ZIP headers follow the same path. Discovery uses
an exact `include` path segment, hashes each header and every public include
root into the project generation key, and passes all roots to Clang so one
public header can use types from another. Dependency include trees are filtered,
size/entry bounded, and extracted into a temporary confined directory for
parsing; unsafe archive paths fail the project operation. The owned output is
`.deherm/generated/native-extensions/<defold-revision>/<project-generation-key>/`,
with an index and whole-tree digest checked by `verify-generated`. Missing
sentinels bypass the fast cache, and deep verification refuses stray owned
files. Executable Clang identity and generator-source identity join the key.
Missing tools, source drift, confinement errors, and I/O faults abort atomically;
only source diagnostics from a running Clang become machine-readable blockers.

The automatic C11 slice contains every free function declared by the selected
public header and preserves its exact C identifier as the first TypeScript
member name; it does not assume `extension_name_*` naming. Transitive headers
supply enum/record type facts but do not leak helper functions into the selected
surface. The standalone generator can still request an explicit symbol prefix
and strip it for ergonomic member names. Supported inputs/results are void,
booleans, fixed-width signed or unsigned integers, float/double, declared enums,
or C strings. Generated
glue validates cell tags, boolean and integer narrowing, and enum domains
before calling the extension symbol. Clang-discovered records are emitted as
TypeScript metadata, but by-value records and arbitrary pointers are cataloged
with exact blockers instead of receiving guessed layouts or ownership.

The standalone fixture parses one header containing four functions, one enum, and one POD
record. Three scalar/enum/string routes generate; the by-value record route is
reported as `cataloged-needs-layout`. A native compile/link/runtime test calls
the generated dispatcher against real fixture implementations. Project CLI
coverage proves local and dependency headers enter the keyed tree, and the
packed-package smoke invokes the installed `deherm generate` command on a
consumer extension without a separate header command.

This is not yet a complete arbitrary C++ extension bridge. C++ methods,
overloads, templates, callbacks, record layout/alignment, pointer ownership,
nullable contracts, platform feature gates, and extension lifecycle/thread
affinity still need explicit schema inputs. Project integration does not turn a
generated wrapper into Defold linkage or runtime evidence; the exact twin proves
the call expression against generated fake callees only.

# Browser typed arena

The dmSDK generator now emits `browser-arena.ts`. It implements the typed
`DmSdkUniversalBridge` over the raw Emscripten direct-memory transport, writes
and reads the exact 24-byte little-endian cell layout, bounds addresses to
wasm32, validates scalar/object domains and the catalog SHA, encodes transient
UTF-8 strings, and releases every arena allocation in reverse order. A
forced-growth WebAssembly-memory harness executes bigint and string calls,
detaches the old buffer during string allocation, and verifies the codec creates
its `DataView` only after allocation. The pinned Emscripten/Chrome exact gate
runs all 566 current universal-ready calls through this production adapter with
994 balanced reverse-order releases and a 240-byte peak.

The transport still needs to be installed by the packaged HTML5 extension and
backed by its bounded Wasm scratch allocator. The standalone adapter proof does
not claim a rebuilt Defold HTML5 bundle, Defold implementation semantics, or the
731 dmSDK recipes that still require call-site specialization.
