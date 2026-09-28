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
| borrowed handle/scalar ABI | 148 | Every handle argument is borrowed for the synchronous call and the result is void or a bounded scalar. |
| handle lifecycle ABI | 34 | The same transport carries an exact per-argument retain, release, or finalize transition plus any public non-local state effect. |
| universal fallback | 0 | No route in this revision's 182-declaration structural envelope requires transfer or asynchronous escape. The universal recipe remains available beneath every specialization. |

The generated report is
`packages/bindings/generated/defold-dmsdk-borrowed-handle-bindings.json`. It retains all
182 stable declaration and projection identities. Every row records its effect
evidence and keeps the universal route. The selection policy in
`packages/bindings/overrides/dmsdk-borrowed-handle-bindings.json` contains only shape
rules; it has no declaration list, expected count, or per-symbol exception.

This remains a soundness repair, not a claim that absence of a contradiction is
implementation proof. The authenticated plan joins the compiler's C++
ownership/effect artifact directly. Of the 148 pure-borrow routes, 74 have
diagnostic-free source proof for non-owning, synchronous, non-escaping handle
use; 74 retain the exact `defold-public-by-value-resource-borrow`
Defold-contract convention and carry their source-proof gaps. The remaining 34
routes use revision-derived lifecycle vectors instead of being discarded:
each handle position is independently `borrow`, `retain`, `release`, or
`finalize`, while scalar positions remain `none`. `AcquireInstanceIndex` is a
pure-borrow route because its result is a scalar index, not an acquired handle.
Withdrawing a source fact changes
`source-derived` to `defold-contract-trusted` without changing emitted ABI or
mislabeling the evidence; adding a contradiction still withdraws the fast
path.

The source audit deliberately stops at the Defold boundary. Unresolved calls
through a selected graphics backend, platform wrapper, system library, or OS
primitive are recorded as proof gaps; they are not treated as evidence that a
Defold public contract is unsafe. This avoids turning specialization into
whole-program verification while preserving positive contradiction detection.

# Provider boundary

The 182 generated declarations use one C ABI dispatcher with caller-owned
64-bit argument and result slots. There are 48 deterministic semantic handle
kinds and at most eight arguments per selected call. A borrowed handle never
crosses as a JavaScript number: Dynamic Hermes and TypeScript use `BigInt`,
while Static Hermes and the browser descriptor use an exact 64-bit memory lane.

Before every dispatch, the native bridge requires a provider to prove:

1. the call is on the provider's current engine thread;
2. every handle is nonzero;
3. every handle matches the expected semantic kind and is live in the
   provider's current lifetime epoch; and
4. the provider accepts the stable generated binding ID; and
5. after a successful call and canonical result validation, the provider
   applies each generated non-borrow lifecycle transition.

Registration copies one fixed provider record and is constrained to startup or
shutdown, before concurrent dispatch. Concurrent provider replacement is not a
supported operation. Lifecycle bookkeeping is a required, infallible provider
callback after success; it never runs for a rejected argument, provider error,
or invalid result. The ABI itself allocates no resource and returns only void or
bounded scalar lanes.

The generated adapters cover:

- C ABI descriptors and dispatch;
- Dynamic Hermes JSI validation and result decoding;
- Static Hermes `extern_c` direct-memory declaration;
- browser/Wasm direct-memory descriptors and raw dispatcher;
- nominal TypeScript `BorrowedHandle<Kind>` APIs; and
- a 182-signature pinned-header audit across the selected dmSDK headers; and
- 182 generator-owned exact-call provider twins with position-distinct native
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

The tests independently rederive the 182/148/34/0 plan census and its
74 source-derived / 74 Defold-contract-trusted / 34 revision-derived-lifecycle
partition, regenerate every
artifact into a clean temporary directory, reject source/census drift, compile
all selected signatures against the complete pinned SDK include projection,
compile the C and JSI adapters, type-check the Dynamic/Static TypeScript
surfaces, parse the browser adapter, and link/run the provider bridge under
ASan and UBSan. The host harness dispatches every one of the 182 generated
routes through its exact typed provider twin, rejects noncanonical argument and
result cells, rejects finite JavaScript values that overflow `f32`, clears the
caller result before every fallible check, and normalizes successful `void`
calls to zero even when the provider writes nothing. It separately executes a
warmed native loop of 100,000 guarded dispatches with zero observed C++
`operator new` calls. The
repository-wide clean-room pipeline reproduces the owned dmSDK artifacts
byte-for-byte from pinned inputs.

# Evidence boundary

The runtime harness uses a deterministic fake provider. It proves all 182
selected descriptors' layout, error ordering, provider callbacks, thread rejection, handle rejection,
linkage of the generic bridge, sanitizer cleanliness, and warmed glue
allocation behavior. It also proves the lifecycle callback runs only after a
successful provider call. It does not supply real Defold handles, link the 182 engine
symbols, establish real subsystem thread policies, or prove packaged-engine
behavior. Consequently the generated report records zero packaged-engine
runtime verifications. The withdrawal is an atomic private pre-release provider
ABI v3 migration; all generated consumers use the same plan-owned dense IDs.

The native C ABI and Dynamic Hermes module are compiled into the production
runtime, and the Static Hermes entry point is exported from its package. They
remain fail-closed until an engine provider is installed. The nominal
TypeScript helper is generated but is not re-exported from the high-level SDK
barrel, because doing that before provider installation and target
feature/symbol selection would make the optional fast path appear universally
available. All 182 structural candidates retain the working universal recipe
Both the 148 pure-borrow and 34 lifecycle routes retain the universal base
recipe; this provider
boundary is additive and cannot suppress it.

No dmSDK declaration disappeared. A future transferred or asynchronous route
will remain callable through generated universal machinery and will carry a
machine-readable fallback blocker. New lifecycle shapes must satisfy the same
compiler-owned taxonomy; a one-off wrapper or declaration allowlist is not an
accepted substitute.

## Source-fact frontend (audit boundary)

`scripts/generate-dmsdk-cpp-ownership-effect-facts.mjs` binds the union of the
borrowed-handle and scratch-scalar-out structural envelopes to exact Clang AST
declaration/definition identities. It scans pinned Defold C/C++ implementations
and inline headers, then joins definitions to the SDK IR by exact Clang mangled
symbol identity or the naturally included header declaration. It does not force
unrelated public headers into implementation translation units. Package-owned
layout rules reconstruct Defold's build-time module include aliases into a
content-addressed overlay; the revision-owned alias names, source paths, and
source hashes are authenticated in the report. Module-local quoted includes
use per-translation-unit `-iquote` roots, generated protobuf/build paths use a
Clang VFS overlay backed by pinned SDK bytes, and projected headers retain
their source-local include closure. Large translation units retry with a
qualified-namespace AST profile instead of exhausting Node's string bound.
Source and translation-unit
hashes plus the Clang profile are also recorded. Rejected translation units
retain categorical, machine-readable blockers; raw compiler diagnostics are
deliberately ephemeral rather than policy inputs because include-stack
presentation is not semantic evidence.
Typedef-backed handles retain their
desugared pointer identity; missing, ambiguous, unresolved, or conflicting
definitions are explicit `unknown` rows and cannot become positive
specializations.

The current artifact is
`packages/bindings/generated/defold-dmsdk-cpp-ownership-effect-facts.json`.
It covers 212 deduplicated structural rows (182 borrowed + 30 scratch), with
198 observed and 14 unknown under the host-only profile. The borrowed envelope
is 168 observed / 14 unknown; the scratch envelope is 30 observed / 0 unknown.
The 14 unknowns remain explicit target/backend conflicts or missing/rejected
implementation joins; they are not hidden by a route allowlist. The
authenticated artifact is approximately 731 KB rather than the earlier
multi-megabyte Cartesian source/route join because a route now retains only
lexically relevant source observations. The artifact states its two evidence
scopes independently. Its `semanticAdmission` accepts diagnostic-free facts
from the pinned Defold implementation as revision-authoritative source
semantics, with unknown rows falling back universally. Its
`targetAvailability` remains `not-established-by-source-analysis`: the host
extraction profile does not prove that a symbol links or ships in any target
engine. Provider-link and packaged-engine evidence own that later claim.
Inline/header observations are available to the next policy migration,
including the `dmAtomic` family, without promoting source semantics into
target availability.
