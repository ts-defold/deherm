---
type: Roadmap
title: Semantic Surface IR v2 and deterministic multi-revision generation
description: Replace duplicate policy authorities with one canonical semantic fact model, total pattern selection, compressed shallow publication, and backward-version conformance.
tags: [roadmap, goal, policy, semantics, ir, generator, determinism, compatibility]
status: active
generated: { by: openai/gpt-6-astra, at: 2026-09-26T00:00:00-04:00 }
sources:
  - id: simplicity-review
    resource: ../research/policy-architecture-simplicity-review.md
    title: Adversarial simplicity review of the API policy architecture
    author: project:deherm
  - id: api-source
    resource: ../decisions/api-source-resolution.md
    title: Resolve API ground truth from the exact Defold engine SHA
    author: project:deherm
  - id: generated-verification
    resource: ../decisions/generated-binding-verification.md
    title: Generated binding verification stops at the exact bridge contract
    author: project:deherm
  - id: defold-1-13-1
    resource: https://github.com/defold/defold/releases/tag/1.13.1
    title: Defold 1.13.1
    author: team:defold
  - id: defold-1-12-0
    resource: https://github.com/defold/defold/releases/tag/1.12.0
    title: Defold 1.12.0
    author: team:defold
  - id: defold-1-11-0
    resource: https://github.com/defold/defold/releases/tag/1.11.0
    title: Defold 1.11.0
    author: team:defold
---

# Goal

Build a deterministic schema-v2 compiler pipeline in which:

1. pinned Defold code and archives are parsed into one canonical semantic
   `SurfaceIR`;
2. authenticated policy objects contain every fact whose truth is determined by
   that Defold revision, and no generated product masquerading as a fact;
3. the installed package contains revision-neutral pattern selection, lowering,
   and emitters;
4. generator-time semantics select the fastest sound implementation pattern;
5. every discovered callable is emitted, with a total universal/default
   fallback when no specialization applies;
6. SDK, native glue, Static Hermes glue, browser glue, exact-call twins, docs,
   accounting, and namespace reports are deterministic projections of the same
   facts; and
7. the same installed compiler consumes current and older Defold revisions
   without a per-engine npm release.

The objective is not to remove semantic analysis. Semantic ownership, lifetime,
context, enum domain, callback escape, layout, and registration facts are what
allow the generator to select the best transport. The objective is to make
those facts the sole authority and make every later artifact disposable.

# Compiler shape

```text
Defold source, ref-doc, SDK headers and toolchain declarations
    |
    +-- Clang AST frontend
    +-- script/ref-doc frontend
    +-- Lua registration frontend
    +-- resource/protobuf frontend
    |
    v
Canonical SurfaceIR
    declarations + semantics + provenance + diagnostics
    |
    v
Total pattern selector
    direct scalar -> fixed layout -> typed handle/callback -> universal fallback
    |
    v
Pure emitters
    TypeScript SDK | native/Static Hermes | Lua | browser | tests | docs/reports
```

Frontend-specific AST nodes do not cross the `SurfaceIR` boundary. Selected
patterns and generated files are derived output, not policy inputs.

# Ownership matrix

| Concern | Defold-derived policy | Installed package | Derived output |
| --- | --- | --- | --- |
| Names, declarations, layouts and constants | yes | no | projected |
| Registration, context and target availability | yes | no | projected |
| Ownership, lifetime and callback evidence | yes | inference vocabulary only | projected |
| Unresolved facts and source diagnostics | yes | diagnostic schemas | reported |
| Pattern predicates and specificity | no | yes | selection trace |
| Universal fallback contract | no | yes | route implementation |
| TypeScript/C++/JS/Lua text | no | emitters only | yes |
| Exact-call vectors and twins | source facts only | emitter | yes |
| Namespace website pages and accounting | no duplicate authority | report emitter | yes |
| Verification evidence | separate evidence store | verifier | yes |

# Historical compatibility matrix

The matrix is keyed by immutable commits. Release names are display labels only.
All nine official archive endpoints required for these three historical
revisions (`ref-doc.zip`, `defoldsdk.zip`, and `bob.jar`) returned HTTP 200 when
checked on 2026-09-26.

| Lane | Label | Immutable Defold commit | Purpose |
| --- | --- | --- | --- |
| current | pinned `dev` | `7f0f554f41f9dce1e0ddff99bf08200657d1ee05` | development authority |
| recent stable | `1.13.1` | `574678c7d44be490d874fbed2d0ae6211feec4d9` | nearest stable release |
| previous line | `1.12.0` | `3206f699aaff89f357c9d549050b8453e080c5d2` | medium backward span |
| compatibility floor | `1.11.0` | `7c81792859a6da7f7401c0ac37a4cc83bb500ff6` | approximately one-year span |

This is a rolling support window, not a claim that 1.11.0 is a permanent
minimum. Moving the floor requires an explicit support decision and must not
rewrite historical evidence.

# Per-revision proof matrix

| Stage | Current | 1.13.1 | 1.12.0 | 1.11.0 |
| --- | --- | --- | --- | --- |
| Resolve immutable source/archive identities | required | required | required | required |
| Extract canonical facts with no checkout-path leak | required | required | required | required |
| Validate schema and total declaration census | required | required | required | required |
| Select exactly one lowering strategy per callable | required | required | required | required |
| Retain universal fallback for unspecialized calls | required | required | required | required |
| Re-run deterministically to identical bytes | required | required | required | required |
| Materialize from package + compressed policy only | required | required | required | required |
| Generate SDK, native, Static Hermes and browser glue | required | required | required | required |
| Generate and compile exact-call twins | required | required | required | required |
| Headless/package engine smoke | required | required | required | required |
| Full target/runtime depth | required | nightly | nightly | nightly/floor gate |

An API addition, removal, or deprecation in Defold is an expected fact delta,
not a compatibility failure. A failure means the same compiler cannot parse,
classify, emit, or faithfully report the selected revision.

# Ordered implementation

## 0. Repair the current authenticated cache boundary

- [ ] Verify cached SDK and repository-output bytes against authenticated
  manifest entries rather than existence plus mutable descriptor hashes.
- [ ] Reseal revision-abstracted toolchain facts against the policy root's
  `@toolchain` digest.
- [ ] Regenerate and compare lowering products from authenticated recipe input.
- [ ] Key realized surfaces by policy root, compiler identity, and relevant
  options; stage and atomically publish complete immutable directories.
- [ ] Add negative mutation tests for every class above.

## 1. Define canonical Surface IR v2

- [ ] Define typed, versioned schemas for callables, values, ownership,
  lifetime, context, availability, layouts, constants, provenance, and
  diagnostics.
- [ ] Define one canonical serializer and digest. Property insertion order is
  not semantic identity.
- [ ] Separate realization facts from reports and runtime evidence.
- [ ] Write v1-to-v2 adapters so migration can be proved incrementally.

## 2. Normalize every frontend into the same model

- [ ] Clang/dmSDK declarations and target conditions.
- [ ] Script annotations and documentation.
- [ ] Lua registration, constants and context availability.
- [ ] Resources and protobuf declarations.
- [ ] Local and dependency extensions, using the same applicable schema plus
  their independent content identity.

## 3. Implement the total pattern selector

- [ ] Express patterns as structural predicates over semantic facts, never as
  route-name allowlists.
- [ ] Rank applicable strategies by specificity and cost.
- [ ] Reject ambiguous equal-priority selections deterministically.
- [ ] Always retain the sound universal/default strategy.
- [ ] Emit a compact decision trace for every callable.
- [ ] Generate pattern exhaustiveness and exact-call tests from the same IR.

## 4. Make every product a projection

- [ ] Emit TypeScript SDK and TSDoc.
- [ ] Emit Static Hermes/direct C ABI and native glue.
- [ ] Emit Lua adapters and context proxies.
- [ ] Emit browser/Wasm glue.
- [ ] Emit exact-call twins, compile probes, reports, and namespace pages.
- [ ] Replace the historical lowering-plan codec with genuine semantic
  lowering.
- [ ] Remove the 12 SDK and 106 repository compatibility snapshots as their
  emitter families become complete.

## 5. Condense policy publication

- [ ] Publish a shallow manifest over a small number of canonical semantic
  chunks.
- [ ] Compress every chunk as a transport detail; authenticate canonical
  uncompressed content.
- [ ] Use a monolithic compressed fact bundle as the simplicity/transfer
  baseline. Additional chunks must earn their mechanism through measured
  reuse or latency.
- [ ] Derive required capabilities from recipe-bearing schema records instead
  of maintaining duplicate maps.
- [ ] Preserve user-level content-addressed caching and offline operation.

## 6. Prove multi-revision survival

- [ ] Add the four immutable revisions above to a data-driven fixture manifest.
- [ ] Derive, materialize, generate, and compile each revision with the same
  installed package.
- [ ] Compare semantic census and pattern distributions without demanding that
  different Defold versions expose identical APIs.
- [ ] Run twice with shuffled host/file enumeration and require identical
  canonical facts and output hashes.
- [ ] Run current and floor revisions as blocking gates; run the full matrix
  nightly until its cost is measured and tuned.

## 7. Cut over and delete v1 complexity

- [ ] Demonstrate v2 output equivalence or explicitly reviewed semantic deltas
  for every family.
- [ ] Move namespace/accounting views outside realization authority.
- [ ] Delete duplicate recipe inventories, the plan codec, mutable revision-only
  surfaces, and obsolete compatibility readers.
- [ ] Retain historical immutable v1 roots for their published support window.

# Completion rule

The goal is complete only when one package version consumes all four immutable
Defold revisions from policy facts alone, deterministically emits every
discovered callable, selects exactly one sound strategy per callable, compiles
the generated exact-call twins, passes the required engine smokes, and contains
no duplicate realization authority or generated snapshot classified as a
semantic fact.

Generation, compilation, linkage, exact-call execution, engine runtime,
cross-host parity, and performance evidence remain separate. Passing a later
stage never rewrites what an earlier stage proved.
