---
type: Research
title: dmSDK ABI generator wave
description: Reproduced scalar blocker audit, exact ABI-shape census, and generated scalar, enum, and bounded-span bindings.
tags: [research, generated, dmsdk, bindings, abi, conformance]
status: active
---

# dmSDK ABI generator wave

The dmSDK runtime queue is now decomposed mechanically rather than by a hand-written function list. `scripts/generate-dmsdk-abi-shapes.mjs` resolves aliases, enums, records, handles, pointers, callbacks, direction, and fixed ABI scalars for all 1,361 runtime-pending declarations. The resulting ledger contains 881 exact signature shapes grouped into 15 implementation tranches. Every row retains its source declaration ID and header, plus explicit blockers; no tranche is promoted as runtime evidence merely because it was classified. The next 21 named-scalar declarations have now been reviewed: all 21 remain policy-blocked—two need engine/audio context, five need thread/TLS ownership and lifecycle capabilities, and 14 require a provenance-carrying profiler-property handle. The empty generated family deliberately exports and installs no callable surface.

The first derived follow-on family is `next-enum-value-direct`: ten functions whose arguments and results contain only ABI scalars or resolved enums. A small reviewed policy manifest blocks three lifecycle/registry mutations and emits seven normal calls. The generated ABI uses `int32_t` for enums, exact generated input-domain checks, `uint64_t` plus JSI `bigint` for hashes, dense integer IDs, and stack-only fixed slots. Four buffer/log calls link and execute against the pinned packaged dmSDK. Three graphics/sound calls compile against the complete SDK but remain `engine-context-pending` until exercised in a real Defold process.

Four additional context-free families are now generated from exact ABI-census
selectors plus source-pinned semantic policies:

- four fixed digests with caller-provided capacity and fixed 16/20/32/64-byte outputs;
- two Base64 span operations with explicit capacity/query semantics and strict
  padded alphabet, padding-position, and canonical discarded-bit validation
  before platform-native decode;
- two bounded ASTC header probes returning a caller-owned three-`uint32_t`
  record; and
- XTEA encrypt/decrypt specialized to `ALGORITHM_XTEA`, with non-null spans and
  the pinned 16-byte key maximum checked before the native assertion; and
- `dmHashBuffer32`/`dmHashBuffer64` over borrowed explicit-length byte spans,
  including embedded-NUL vectors and caller-owned scalar results.

All ten compile and link against pinned Defold code or packaged SDK libraries
and pass known-behavior and rejection tests. Warmed harnesses observe zero C++
`operator new` calls through the generated glue. That is not a claim that every
platform-native implementation is allocation-free: the Apple Base64 path uses
Foundation, so Objective-C/native allocations remain unmeasured. Defold buffer
hashing can also allocate when its process-global reverse-hash registry is
explicitly enabled; pinned source proves that registry defaults off, and the
generated glue itself owns no heap primitive.

## Corrected blocker claim

The earlier scalar report said `dmGraphics::Finalize` was blocked because `graphics/graphics_ddf.h` was absent. That claim was true only of the source checkout and false of the packaged SDK used by extensions. The audit now compiles the complete packaged `dmsdk/graphics/graphics.h`, fingerprints its generated `graphics_ddf.h`, and takes the exact `dmGraphics::Finalize` symbol address. The declaration remains unexposed solely because process-global graphics teardown requires an explicit engine-lifecycle capability. The same policy applies to profiler and logging initialization/finalization. None of those destructive lifecycle calls are executed by the test.

## Reproduced evidence

- The original 26 scalar thunks compile, source-link, and execute. A warmed 100,000-call dispatch loop observes zero C++ allocations.
- All five lifecycle blockers compile from their real pinned headers; their object file contains exact unresolved native symbol references.
- The seven enum-value wrapper and JSI translation units compile against the complete packaged SDK.
- Four host-safe enum-value routes source-link and execute against `libdlib.a`; invalid enum sentinels fail before the native call; a warmed 100,000-call dispatch loop observes zero C++ allocations.
- Generated reports fingerprint their IR, classification, overrides, relevant SDK headers, and output artifacts. Temporary-output regeneration is byte-identical.

This is host and arm64-macOS evidence only. HTML5 remains fail-closed for the enum-value family pending the Emscripten BigInt ABI and linked-symbol matrix. Graphics and sound behavior still needs packaged-engine probes.

## Clean-room registry inputs and outputs

`scripts/lib/dmsdk-generator-pipeline.mjs` is the single ownership and ordering
registry for this focused runtime-lowering pipeline. The clean-room checker
copies only the registered generator sources, pinned inputs, and referenced
Defold evidence into a new temporary directory, executes the steps in order,
discovers generated dmSDK files independently, rejects unowned output, and
compares all 60 artifacts byte-for-byte with the repository.
`scripts/generate-dmsdk-runtime.mjs` is the thin public orchestrator; both its
generate and `--check` modes consume this registry rather than restating the
step chain.

The registered steps are:

1. `scripts/classify-dmsdk-bindings.mjs`
   - input: `bindings/generated/defold-sdk-ir.json`
   - output: `bindings/generated/defold-dmsdk-binding-patterns.json`
2. `scripts/generate-dmsdk-scalar-thunks.mjs`
   - inputs: the SDK IR and binding-pattern report
   - outputs: scalar report, C ABI, runtime dispatcher, JSI adapter, browser adapter, TypeScript wrapper, and per-module C++ sources listed in its report
3. `scripts/generate-dmsdk-abi-shapes.mjs`
   - inputs: the SDK IR and binding-pattern report
   - output: `bindings/generated/defold-dmsdk-abi-shapes.json`
4. `scripts/generate-dmsdk-named-scalar-bindings.mjs`
   - inputs: SDK IR, ABI-shape report, and `bindings/overrides/dmsdk-named-scalar-policies.json`
   - outputs: a 21-route policy report plus intentionally empty C ABI, JSI, and TypeScript surfaces
5. `scripts/generate-dmsdk-enum-value-bindings.mjs`
   - inputs: SDK IR, ABI-shape report, scalar-thunk report, and `bindings/overrides/dmsdk-enum-value-bindings.json`
   - outputs: enum-value report, C ABI, runtime dispatcher, JSI adapter, TypeScript wrapper, and buffer/graphics/log/sound C++ sources listed in its report
6. `scripts/generate-dmsdk-fixed-digest-bindings.mjs`
   - outputs: four capacity-checked digest wrappers and a dense runtime dispatcher
7. `scripts/generate-dmsdk-base64-span-bindings.mjs`
   - outputs: canonical padded Base64 span wrappers and query/dispatch metadata
8. `scripts/generate-dmsdk-astc-probe-bindings.mjs`
   - outputs: two bounded ASTC probes with a fixed caller-owned result record
9. `scripts/generate-dmsdk-xtea-span-bindings.mjs`
   - outputs: specialized XTEA encrypt/decrypt span wrappers and dispatcher
10. `scripts/generate-dmsdk-hash-span-bindings.mjs`
   - outputs: bounded `dmHashBuffer32`/`dmHashBuffer64` wrappers and dispatcher

Focused gates are `npm run check:dmsdk-runtime`,
`npm run check:dmsdk-clean-room`, `npm run test:dmsdk-runtime-codegen`, and
`npm run test:dmsdk-clean-room`. The clean-room input fingerprint for this
wave is `084e8e8598a175851932f16ebaca12311a8be510ada183f0a6c7340addab21d1`.

The enum-value runtime and JSI dispatcher are now installed by the generated
module installer and exported by the generated SDK barrel. The standalone host
runner links explicit host-only wrapper stubs outside the shipping extension;
the extension syntax gate instead compiles the seven real generated wrappers
against the complete pinned packaged SDK. This proves generation, compilation,
and installer linkage, but it does not yet promote the seven routes to retained
or observed packaged-engine evidence.
