---
type: Research
title: Adversarial simplicity review of the API policy architecture
description: Whether the current policy and materialization system is irreducibly complex, which mechanisms are accidental, and the smallest architecture that preserves source-free deterministic generation.
tags: [policy, architecture, generator, materialization, cache, reproducibility, review]
status: verified
generated: { by: openai/gpt-6-astra, at: 2026-09-26T00:00:00-04:00 }
sources:
  - id: layered-policy
    resource: ../decisions/layered-api-policy-cache.md
    title: Cache source-derived API policies in layers, keyed by content hash
    author: project:deherm
  - id: materialization
    resource: ../decisions/policy-surface-materialization.md
    title: Materialize a complete Defold surface from authenticated policy facts
    author: project:deherm
  - id: policy-store
    resource: api-policy-store.md
    title: The API policy artifact and its content-addressed static site
    author: project:deherm
---

# Verdict

**Simplify, but keep the producer/consumer split and content-addressed
publication.** The present system is a sound correctness-first transition, not
the simplest steady-state design.

The irreducible architecture is:

```text
pinned Defold code
  -> extract one canonical semantic fact model once
  -> authenticate and publish those revision-derived facts
  -> realize SDK, native glue, tests, and reports with package-owned emitters
  -> combine with project-local extension facts
  -> compile the project
```

The following are not irreducible:

* a namespace-oriented copy and a compiler-oriented copy of the same API;
* a custom string/shape codec that reconstructs an already-generated lowering
  plan;
* duplicated recipe maps and capability inventories;
* evidence reports in the mandatory realization closure;
* mutable revision-only surface directories; and
* overlapping cache identities that do not authenticate the same bytes.

The recommended destination is **one normalized semantic model behind a
shallow content-addressed manifest**. Use a small number of chunks only where
measured cross-revision reuse earns the added mechanism. A single compressed
per-revision bundle is the simpler baseline that any finer partition must beat.

# Evidence boundary

The review inspected `main` at
`3293adf09d21c040fa510d9dc03cc3de036b00db`. It ran the focused policy,
resolver, materializer, hydration, and revision-derivation suites: **82/82
passed**. It did not rerun native runtime or three-host CI; those were already
green for the reviewed commit.

The size results below are serialized committed JSON bytes, not observed HTTP
wire transfer. One concatenated experiment compressed the 140-object installed
realization closure from 17,522,407 bytes to 1,550,651 bytes with gzip level 9
or 984,560 bytes with Brotli quality 11. That experiment demonstrates
compressibility; it is not a production network benchmark.

# Current control flow

```text
Defold revision + SDK/ref-doc/sysroot + reviewed source facts
  -> ordered extraction/generation pipeline
     -> declaration IR
     -> registration/profile/resource facts
     -> derived catalogs, accounting, lowering plan
     -> generated TypeScript/C++/JavaScript
  -> policy assembler reads those generated products
     -> 52 namespace projections + @shared + @profiles
     -> @toolchain
     -> @compiler manifest
        -> 20 compiler documents
        -> 12 SDK source snapshots
        -> 106 repository-output snapshots
        -> expected hashes for package-rendered outputs
  -> SHA-256 object store + root + mutable revision-to-root index
  -> static website + separate artifact mapping
  -> installed resolver downloads @compiler closure + @toolchain
  -> materializer restores revision tokens, decodes/renders/copies outputs
  -> mutable revision-keyed surface + descriptor + lowering sentinel
  -> project extension discovery and generation
```

The producer explicitly performs source extraction before policy assembly in
`scripts/derive-revision.mjs`. The policy assembler consumes existing generated
JSON and source products in
`packages/generator/src/policy/generate-api-policy.mjs` rather than operating on
one canonical semantic model.

# Measured graph

| Group | Objects | Serialized bytes | Required by installed realization |
| --- | ---: | ---: | --- |
| Compiler documents | 20 | 15,518,676 | yes |
| Compiler manifest | 1 | 67,380 | yes |
| SDK compatibility sources | 12 | 112,761 | yes, temporarily |
| Other compatibility sources | 106 | 1,819,914 | yes, temporarily |
| Namespace projections | 52 | 6,749,299 | no |
| `@profiles` + `@shared` | 2 | 819,687 | no |
| Toolchain | 1 | 3,676 | yes |
| Root | 1 | 25,675 | yes |
| **Total** | **194 objects + root** | **25,117,068** | |

`packages/cli/src/policy-client.mjs` deliberately fetches the compiler
manifest's closure and `@toolchain`, not ordinary namespace objects. The
namespace/profile/shared branch therefore adds **7,568,986 raw bytes** to the
published graph without serving installed realization. It is not globally
dead: website checks inspect it, and it remains a possible reporting view. The
unimplemented extension layers do not currently consume it.

The materializer's historical `<5 MB` budget measures only the now-67 KB
compiler manifest. It does not measure the 17.5 MB referenced realization
closure.

# Essential complexity

These mechanisms solve real requirements and should remain:

* a pinned revision and exact source/input identity;
* extraction of registration, availability, lifetime, ownership, and ABI facts
  that declarations alone cannot express;
* explicit unresolved and unverified states rather than guesses;
* a stable package containing parsers, lowering rules, and emitters;
* revision-derived facts published independently from npm releases;
* source-free installed generation;
* content authentication, offline caching, and deterministic encoding;
* minimum realizer compatibility; and
* independent extension identity because engine and extension inputs move
  separately.

# Accidental complexity

## Duplicate semantic authorities

Script and dmSDK declarations exist both as per-namespace projections and as
whole compiler IR. Profiles likewise exist in `@profiles` and a compiler
document. Installed generation consumes the compiler representation; reporting
consumes parts of the namespace representation. Both must remain coherent.

The namespace view should become a derived report from the canonical model, not
a second realization authority.

## The lowering recipe is not semantic regeneration

`packages/compiler/src/binding-lowering-plan-recipe.mjs` interns every string
and object shape of the already-generated plan and then decodes the whole body.
That reduces serialized bytes but preserves all redundant plan information and
adds another schema/interpreter. It does not recompute lowering from minimal
semantic facts.

Until a genuine semantic emitter exists, canonical JSON plus normal transport
compression is simpler and more honest. The steady-state fix is to derive the
plan from the one normalized model.

## Competing canonical forms

Policy JSON sorts object keys while the historical plan digest depends on
insertion-order `JSON.stringify`. The materializer has a repair path for that
conflict. Revision abstraction also recursively replaces revision text inside
arbitrary strings and source snapshots. These are signs that byte history has
become part of the data model.

One schema-owned canonical serializer should define identity. Historical output
ordering can remain a golden compatibility test without being policy semantics.

## Repeated recipe and compatibility declarations

Manifest records contain their recipe, while `realizationRecipes` repeats the
same mapping and validation checks that the two copies agree. Required
capabilities also largely restate recipes already visible in the manifest.

Keep a minimum package/realizer version. Derive required recipe support from
the manifest entries themselves.

## Stable writes are not incremental realization

The materializer decodes the plan and renders SDK sources before `writeStable`
compares existing files. It avoids file writes, not computation. A recipe cache
should key each output family by its emitter identity plus authenticated input
digests and skip execution when unchanged.

## Overlapping project identities

Project generation maintains a comprehensive SHA-256 generation key and a
separate diagnostic Merkle structure. Native source/header bytes already enter
the comprehensive inventory, while the diagnostic tree retains incomplete
leaves. One canonical content-hashed input manifest can provide both invalidation
and changed-input attribution.

## Mutable realized surfaces

Realized surfaces are keyed only by Defold revision, even though a new policy
root or compiler implementation can target the same directory. Files are
written individually and the descriptor is written last.

Use an immutable directory keyed by `(policy root, compiler identity, options)`,
stage a complete surface, and atomically publish it. A revision pointer may
select the immutable directory, but must not be its identity.

# Cache-verification omissions

The following are established by code inspection; this review did not build a
forged-cache exploit and does not claim a remote attack path.

1. Reopening a materialized surface verifies SDK and repository-output file
   existence but not their bytes against authenticated manifest hashes.
   `packages/cli/src/generate.mjs` then prefers tree hashes stored in the mutable
   descriptor instead of rehashing those directories.
2. Toolchain bytes are compared with a hash from the mutable descriptor but are
   not resealed against the authenticated policy root's `@toolchain` digest.
3. Materialized lowering plan/sentinel files receive internal consistency
   checks, but a reopened surface does not compare their reconstruction with the
   authenticated lowering recipe.

The simplest immediate repair is one verification routine whose authority is
the authenticated manifest:

* hash SDK and repository outputs against manifest entries;
* revision-abstract and reseal toolchain facts against `@toolchain`;
* regenerate and compare derived outputs from authenticated recipe inputs; and
* treat `surface.json` only as a disposable acceleration record.

# Candidate designs

| Criterion | Weight | Local source | Monolithic fact bundle | Current graph | Normalized shallow CAS |
| --- | ---: | ---: | ---: | ---: | ---: |
| Correctness and reproducibility | 25% | 3 | 4 | 3 | 5 |
| Installed-client portability | 20% | 1 | 5 | 4 | 5 |
| Mechanism simplicity | 20% | 3 | 5 | 2 | 4 |
| Incremental transfer and work | 15% | 2 | 2 | 4 | 5 |
| Ownership and auditability | 15% | 3 | 4 | 3 | 5 |
| Migration ease | 5% | 1 | 3 | 5 | 2 |
| **Weighted score / 100** | | **47** | **81** | **65** | **93** |

Scores are engineering judgments from this review, not benchmark data.

## Compile directly from source locally

This is superficially the purest code-in/code-out path. In practice it moves the
producer's source acquisition, ref-doc, Python, Clang/sysroot, SDK, host-parity,
and auditing requirements onto every user and CI machine. A local checkout mode
is valuable for producers and debugging, but it fails the normal source-free,
portable installed experience.

## Monolithic per-revision fact bundle

Publish `revision -> digest`, download one authenticated canonical bundle, and
run package emitters. Keep provenance/evidence reports separate. This meets the
core goals with far fewer mechanisms and requests. Its cost is coarser cache
reuse: any changed fact fetches the bundle.

This is the baseline. Sharding must demonstrate enough reuse or latency benefit
to justify itself.

## Current layered graph

The current graph is tested, source-free, and shares unchanged objects. It also
maintains a namespace split that the installed consumer does not use, multiple
historical representations, 140-object realization fan-out, and unimplemented
extension layers.

## One normalized model with shallow CAS

Publish one versioned semantic schema split into a few measured domains, for
example:

* script declarations, registration, resources, and profiles;
* dmSDK declarations and ABI facts;
* toolchain and target facts;
* semantic lowering selections; and
* a temporary compatibility-source pack while emitter extraction finishes.

The compiler consumes those same facts to emit SDK, native glue, browser glue,
exact-call twins, and reports. Extension parsing emits the same applicable
schema plus provenance. Reports and namespace pages are derived views outside
realization identity.

# Recommended sequence

## P0: repair integrity without redesign

1. Add the single authenticated surface verifier.
2. Add negative tests for SDK/output mutation, toolchain-plus-descriptor
   mutation, and self-consistent lowering-plan/sentinel mutation.
3. Key realized surfaces by policy root plus compiler identity and publish them
   atomically.

## P1: establish one authority

1. Define the canonical normalized fact schema and adapt the current producer
   to emit it alongside v1.
2. Move unique registration/resource/profile facts into that schema.
3. Make namespace objects optional derived website/report artifacts.
4. Replace the lowering codec with a real semantic emitter; use plain canonical
   JSON plus compression until then.
5. Remove duplicated recipe maps and derive recipe requirements from entries.
6. Move accounting/probe reports out of mandatory realization identity unless
   an emitter truly consumes them.
7. Consolidate project cache identity around one content-hashed input manifest.

## P2: remove transition payloads and optimize from measurements

1. Replace the 12 SDK and 106 repository snapshots with family emitters.
2. Add per-family incremental realization keyed by emitter plus input digests.
3. Batch object fetches or publish a compressed closure pack if cold latency
   warrants it.
4. Measure compressed closure transfer, request count, warm CPU, cross-revision
   reuse, and cache storage. Do not use the compiler-manifest size as a proxy for
   system simplicity.

# Migration risk

A wholesale replacement would risk semantic regressions hidden by historical
byte goldens. Introduce a schema-v2 lane incrementally:

1. repair current cache verification;
2. emit v1 and v2 from the same pinned inputs;
3. migrate one output family at a time;
4. compare output bytes, semantic census, exact-call twins, and at least two
   Defold revisions;
5. move reports outside realization; and
6. delete old readers, codec, inventories, and compatibility modes after the
   support window.

The existing golden is a useful migration oracle for 28 SDK files and 118
repository outputs. It is not independent semantic proof when producer and
consumer share emitters, so exact-call and runtime verification must remain
separate.
