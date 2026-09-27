---
type: Design and Verification Report
title: dmSDK borrowed-handle scalar bridge wave
description: Structural partition and provider-gated cross-target generation for borrowed dmSDK handles with bounded scalar and void-terminal calls.
tags: [research, bindings, dmsdk, handles, codegen, jsi, static-hermes, wasm]
status: active
generated: { by: codex/gpt-5, at: 2026-09-18T20:00:00-04:00 }
---

# Outcome

The compiler-owned borrowed-handle plan now evaluates the complete global ABI
envelope rather than the historical `borrowed-handle-consumers` tranche. The
pinned revision has 182 structurally compatible declarations:

| Disposition | Count | Rule |
| --- | ---: | --- |
| provider-gated handle/scalar ABI | 147 | The structural contract matches and the revision contains no ownership, lifecycle, lease, retention, transfer, or deferred-use contradiction to Defold's public by-value-resource borrow convention. |
| universal fallback | 35 | Twenty-three historical finalizers, `AcquireInstanceIndex`, and eleven routes previously misclassified as borrowed have explicit lifecycle, refcount, lease, or state-transition contradictions. |

The generated report is
`packages/bindings/generated/defold-dmsdk-borrowed-handle-bindings.json`. It retains all
182 stable declaration and projection identities. Every rejected row records
its effect evidence and keeps the universal route. The selection policy in
`packages/bindings/overrides/dmsdk-borrowed-handle-bindings.json` contains only shape
rules; it has no declaration list, expected count, or per-symbol exception.

This is an immediate soundness repair, not a claim that absence of a
contradiction is implementation proof. Positive rows record
`trusted-defold-default` and the exact convention they rely on. The compiler's
new C++ ownership/effect extractor derives ownership, escape, completion,
result provenance, pointer memory effects, and write predicates from Clang AST
declaration identities and passes alpha-renaming, finalizer, refcount, escape,
indirect-call, span, atomic, and persistent-rebind fixtures. Wiring those facts
into the revision policy is the next migration step.

# Provider boundary

The 158 generated declarations use one C ABI dispatcher with caller-owned
64-bit argument and result slots. There are 45 deterministic semantic handle
kinds and at most eight arguments per selected call. A borrowed handle never
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
releases, or invalidates no engine resource, and it returns only void or scalar
lanes.

The generated adapters cover:

- C ABI descriptors and dispatch;
- Dynamic Hermes JSI validation and result decoding;
- Static Hermes `extern_c` direct-memory declaration;
- browser/Wasm direct-memory descriptors and raw dispatcher;
- nominal TypeScript `BorrowedHandle<Kind>` APIs; and
- a 158-signature pinned-header audit across 25 dmSDK headers; and
- 158 generator-owned exact-call provider twins with position-distinct native
  arguments and result checks.

# Evidence

Run the focused proof with:

```sh
node scripts/generate-dmsdk-borrowed-handle-bindings.mjs --check
node scripts/check-dmsdk-clean-room-regeneration.mjs
node --test \
  tests/dmsdk-borrowed-handle-bindings.test.mjs \
  tests/dmsdk-generator-pipeline.test.mjs
```

The tests independently rederive the 348/158/190 census, regenerate every
artifact into a clean temporary directory, reject source/census drift, compile
all selected signatures against the complete pinned SDK include projection,
compile the C and JSI adapters, type-check the Dynamic/Static TypeScript
surfaces, parse the browser adapter, and link/run the provider bridge under
ASan and UBSan. The host harness dispatches every one of the 158 generated
routes through its exact typed provider twin, rejects noncanonical argument and
result cells, rejects finite JavaScript values that overflow `f32`, clears the
caller result before every fallible check, and normalizes successful `void`
calls to zero even when the provider writes nothing. It separately executes a
warmed native loop of 100,000 guarded dispatches with zero observed C++
`operator new` calls. The
repository-wide clean-room pipeline reproduces the owned dmSDK artifacts
byte-for-byte from pinned inputs.

# Evidence boundary

The runtime harness uses a deterministic fake provider. It proves all 147
selected descriptors' layout, error ordering, provider callbacks, thread rejection, handle rejection,
linkage of the generic bridge, sanitizer cleanliness, and warmed glue
allocation behavior. It does not supply real Defold handles, link the 158 engine
symbols, establish real subsystem thread policies, or prove packaged-engine
behavior. Consequently the generated report records zero packaged-engine
runtime verifications. The withdrawal is an atomic private pre-release provider
ABI v2 migration; all generated consumers use the same plan-owned dense IDs.

The native C ABI and Dynamic Hermes module are compiled into the production
runtime, and the Static Hermes entry point is exported from its package. They
remain fail-closed until an engine provider is installed. The nominal
TypeScript helper is generated but is not re-exported from the high-level SDK
barrel, because doing that before provider installation and target
feature/symbol selection would make the optional fast path appear universally
available. All 182 structural candidates retain the working universal recipe
beneath the optional provider specialization, including the 35 fallback rows.
The 147 selected routes retain the universal base recipe as well; this provider
boundary is additive and cannot suppress it.

No dmSDK declaration disappeared: every withdrawn specialization is realized
through the generated universal machinery. Unlocking a fallback row requires
revision-derived effect evidence satisfying the same compiler-owned taxonomy;
a one-off wrapper or declaration allowlist is not an accepted substitute.

## Source-fact frontend (audit boundary)

`scripts/generate-dmsdk-cpp-ownership-effect-facts.mjs` binds the union of the
borrowed-handle and scratch-scalar-out structural envelopes to exact Clang AST
declaration/definition identities. It scans pinned Defold C/C++ implementations
and inline headers, force-includes the declared public header when a `.cpp`
translation unit does not include it, and records source and translation-unit
hashes plus the Clang profile. Rejected translation units retain a categorical
state; raw compiler diagnostics are deliberately ephemeral rather than policy
inputs because include-stack presentation is not semantic evidence.
Typedef-backed handles retain their
desugared pointer identity; missing, ambiguous, unresolved, or conflicting
definitions are explicit `unknown` rows and cannot become positive
specializations.

The current artifact is
`packages/bindings/generated/defold-dmsdk-cpp-ownership-effect-facts.json`.
It covers 212 deduplicated structural rows (182 borrowed + 30 scratch), with
32 observed and 180 unknown under the host-only profile. This artifact is
currently marked `audit-only-single-profile`; it is not evidence for a
cross-target release policy until target/build macro profiles are joined with
unknown-dominates semantics. Inline/header observations are nevertheless
available to the next policy migration, including the `dmAtomic` family.
