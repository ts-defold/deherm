---
type: Research
title: dmSDK ABI generator wave
description: Reproduced scalar blocker audit, exact ABI-shape census, and generated enum-value bindings.
tags: [research, generated, dmsdk, bindings, abi, conformance]
status: active
---

# dmSDK ABI generator wave

The dmSDK runtime queue is now decomposed mechanically rather than by a hand-written function list. `scripts/generate-dmsdk-abi-shapes.mjs` resolves aliases, enums, records, handles, pointers, callbacks, direction, and fixed ABI scalars for all 1,361 runtime-pending declarations. The resulting ledger contains 881 exact signature shapes grouped into 15 implementation tranches. Every row retains its source declaration ID and header, plus explicit blockers; no tranche is promoted as runtime evidence merely because it was classified. The next 21 named-scalar declarations have now been reviewed: all 21 remain policy-blocked—two need engine/audio context, five need thread/TLS ownership and lifecycle capabilities, and 14 require a provenance-carrying profiler-property handle. The empty generated family deliberately exports and installs no callable surface.

The first derived follow-on family is `next-enum-value-direct`: ten functions whose arguments and results contain only ABI scalars or resolved enums. A small reviewed policy manifest blocks three lifecycle/registry mutations and emits seven normal calls. The generated ABI uses `int32_t` for enums, exact generated input-domain checks, `uint64_t` plus JSI `bigint` for hashes, dense integer IDs, and stack-only fixed slots. Four buffer/log calls link and execute against the pinned packaged dmSDK. Three graphics/sound calls compile against the complete SDK but remain `engine-context-pending` until exercised in a real Defold process.

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
compares all 34 artifacts byte-for-byte with the repository.
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

Focused gates are `npm run check:dmsdk-runtime`,
`npm run check:dmsdk-clean-room`, `npm run test:dmsdk-runtime-codegen`, and
`npm run test:dmsdk-clean-room`. The clean-room input fingerprint for this
wave is `b15928c87caed6584bd79cc0941bc2bcdd00c713245fb2390713953ab135354e`.

The enum-value runtime and JSI dispatcher are now installed by the generated
module installer and exported by the generated SDK barrel. The standalone host
runner links explicit host-only wrapper stubs outside the shipping extension;
the extension syntax gate instead compiles the seven real generated wrappers
against the complete pinned packaged SDK. This proves generation, compilation,
and installer linkage, but it does not yet promote the seven routes to retained
or observed packaged-engine evidence.
