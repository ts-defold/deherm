---
type: Design and Verification Report
title: dmSDK borrowed-handle scalar bridge wave
description: Structural partition and provider-gated cross-target generation for borrowed dmSDK handles with scalar-only calls.
tags: [research, bindings, dmsdk, handles, codegen, jsi, static-hermes, wasm]
status: active
generated: { by: codex/gpt-5, at: 2026-09-18T20:00:00-04:00 }
---

# Outcome

The pinned dmSDK ABI-shape report contains 348 declarations in the
`borrowed-handle-consumers` tranche. The new generator partitions that complete
family without symbol-name allowlists:

| Disposition | Count | Rule |
| --- | ---: | --- |
| provider-gated handle/scalar ABI | 82 | Scalar result is `bool`, `f32`, `i32`, `u32`, or `u64`; every argument is a handle or the same bounded scalar algebra; at least one argument is a handle; no `platform-gated` family marker. |
| blocked with row-local tokens | 266 | Pointer, record, enum, callback, void/handle/pointer result, unresolved value, or platform-specific ABI remains. |

The generated report is
`packages/bindings/generated/defold-dmsdk-borrowed-handle-bindings.json`. It retains all
348 stable declaration and projection identities. Every rejected row records
its structural blockers plus explicit ownership/nullability/lifetime, thread,
symbol-linkage, and target-matrix blockers. The selection policy in
`packages/bindings/overrides/dmsdk-borrowed-handle-bindings.json` contains only shape
rules and expected census values; it has no declaration list or per-symbol
exception.

# Provider boundary

The 82 generated declarations use one C ABI dispatcher with caller-owned
64-bit argument and result slots. There are 32 deterministic semantic handle
kinds and at most two arguments per selected call. A borrowed handle never
crosses as a JavaScript number: Dynamic Hermes and TypeScript use `BigInt`,
while Static Hermes and the browser descriptor use an exact 64-bit memory lane.

Before every dispatch, the native bridge requires a provider to prove:

1. the call is on the provider's current engine thread;
2. every handle is nonzero;
3. every handle matches the expected semantic kind and is live in the
   provider's current lifetime epoch; and
4. the provider accepts the stable generated binding ID.

Registration copies one fixed provider record and is constrained to startup or
shutdown, before concurrent dispatch. Concurrent provider replacement is not a
supported operation. The family is borrowed-only: it creates, retains,
releases, or invalidates no engine resource, and it returns only scalar lanes.

The generated adapters cover:

- C ABI descriptors and dispatch;
- Dynamic Hermes JSI validation and result decoding;
- Static Hermes `extern_c` direct-memory declaration;
- browser/Wasm direct-memory descriptors and raw dispatcher;
- nominal TypeScript `BorrowedHandle<Kind>` APIs; and
- an 82-signature pinned-header audit across 22 dmSDK headers.

# Evidence

Run the focused proof with:

```sh
node scripts/generate-dmsdk-borrowed-handle-bindings.mjs --check
node scripts/check-dmsdk-clean-room-regeneration.mjs
node --test \
  tests/dmsdk-borrowed-handle-bindings.test.mjs \
  tests/dmsdk-generator-pipeline.test.mjs
```

The tests independently rederive the 348/82/266 census, regenerate every
artifact into a clean temporary directory, reject source/census drift, compile
all selected signatures against the complete pinned SDK include projection,
compile the C and JSI adapters, type-check the Dynamic/Static TypeScript
surfaces, parse the browser adapter, and link/run the provider bridge under
ASan and UBSan. The host harness dispatches every one of the 82 generated
routes through the fake provider before the warmed native loop executes 100,000
additional guarded dispatches with zero observed C++ `operator new` calls. The
repository-wide clean-room pipeline reproduces all 79 owned dmSDK artifacts
byte-for-byte from pinned inputs.

# Evidence boundary

The runtime harness uses a deterministic fake provider. It proves descriptor
layout, error ordering, provider callbacks, thread rejection, handle rejection,
linkage of the generic bridge, sanitizer cleanliness, and warmed glue
allocation behavior. It does not supply real Defold handles, link the 82 engine
symbols, establish real subsystem thread policies, or prove packaged-engine
behavior. Consequently the generated report records zero packaged-engine
runtime verifications.

The TypeScript and target artifacts are intentionally staged rather than added
to the public SDK barrel or packaged extension build. Doing that safely depends
on a real provider installation and target feature/symbol matrix; exporting the
surface earlier would make currently unavailable calls appear executable.

The 266 blocked declarations remain intentionally ungenerated. Unlocking them
requires reusable policies for enum domains, output initialization/failure,
pointer bounds and nullability, record layout/copying, returned-handle
ownership, callbacks, or per-target availability. Adding a one-off wrapper or
symbol allowlist is not an accepted substitute.
