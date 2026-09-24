---
type: Architecture Decision
title: Policy and realizer ownership boundary
description: Separates stable package realization algorithms from complete revision-owned Defold facts and defines exact capability compatibility.
tags: [decision, generator, policy, compiler, sdk, distribution]
status: accepted
---

# Policy and realizer ownership boundary

## Decision

The npm package is a revision-independent **realizer**. It owns stable algorithms: parsers, canonical content addressing, scalar/optional/union/record/handle combinators, TypeScript and C++ emitters, ABI cells, arenas, registries, transports, and conformance-harness mechanics.

Each published policy is the complete authenticated **Defold truth** for one engine revision. It owns every fact whose answer comes from Defold: source names, namespaces, semantic type vocabulary, layouts, lifecycle/property vocabulary, route and target availability, declaration recipes, toolchain pins, and the selected stable recipe for every source-derived node.

Project extensions remain project inputs. They are discovered and compiled locally against the resolved engine policy; they are never published into the engine policy.

## Release invariant

A normal Defold release publishes a new policy and does **not** require a new npm package. Changed names, declarations, counts, layouts, namespaces, profiles, platforms, or toolchain values are data changes.

An npm release is needed only when a policy selects a genuinely new parser, emitter, ABI, runtime, or transport construct that the installed realizer cannot perform. Adding a missing optimized recipe is also a package change, while continuing through the generic unverified fallback is not.

## Compatibility contract

Every policy index entry and authenticated root carries:

```json
{
  "realizer": {
    "minimumPackageVersion": "0.0.0",
    "requiredCapabilities": [
      "policy.content-addressed-graph.v1",
      "sdk.script.types.render.v1"
    ]
  }
}
```

`requiredCapabilities` is the sorted union of exact recipe identifiers actually selected by the policy. `minimumPackageVersion` is the maximum `introducedInVersion` across those capabilities. The package version that produced the policy is provenance only and must never become the minimum automatically.

The CLI checks the small index entry before downloading the root or any large object. If the installed package is too old or lacks a capability, it stops with exact `pnpm` and `npm` upgrade commands. After download, the authenticated root must repeat the same contract exactly.

Derivation capabilities and realization capabilities are separate: a nightly may need a newer source parser to produce policy IR without forcing consumers of that already-derived IR to upgrade.

## Source-to-package rule

If deleting a Defold checkout would make a value unknowable, that value belongs in policy. Package code may know how to render a fixed `f32` record; it may not know that Defold calls one `vector3`, that it has three semantic lanes in a particular revision, or which routes consume it.

The initial migration moved `defold-value-layouts.json`, including policy-defined TypeScript projection names, into the authenticated compiler surface. Extension generation now reads that document from the resolved revision surface rather than importing the package's pinned revision.

The dmSDK usage materializer is likewise catalog-free: it consumes the resolved
policy's `defold-dmsdk-universal-bindings.json`. The repository keeps a generated
JavaScript catalog only as a regeneration/test fixture; npm packaging explicitly
excludes it. Repository-only policy derivation code is also excluded from the
consumer package.

Component proxy realization now follows the same boundary. The repository
derives `defold-component-proxy-contract.json` from each revision's lifecycle
tables, Bob script-resource suffixes, `go.property` signature, and documented
resource constructors. The package retains stable lifecycle slots, property
codecs, TypeScript authoring suffixes, and Lua lowering recipes. Existing ABI
slots never move when Defold reorders a callback table; `late_update` and
`fixed_update` therefore append at slots 6 and 7. A policy-added resource
constructor can use the package's generic `property.resource(kind, path)`
recipe without an npm release, while the familiar named helpers remain
convenience APIs. Unknown callbacks and value types stay present in the policy
as unsupported capabilities instead of disappearing.

## Remaining migration frontier

The same rule must be applied to:

1. Native extension sources: ship only invariant skeleton/runtime/emitters; materialize revision-generated descriptors and adapters from policy.
2. Component authoring declarations: generate policy-specific ergonomic named
   helpers and callback declarations; correctness no longer depends on the
   fixed resource-helper list because the generic resource recipe is
   revision-parametric.
3. Script type and context vocabulary, handle classifications, route semantics, dynamic-route evidence, dmSDK specializations, and platform/toolchain vocabulary.
4. Generated SDK and Static Hermes files: package copies may be fixtures for the pinned revision, never authority for an arbitrary revision.

The capability registry must become per-recipe rather than filename/mode-based. A new construct inside an existing renderer must therefore select a new capability and cannot hide behind an old coarse capability.

## Fallback

Source constructs without an optimized recipe select `binding.raw-unverified-fallback.v1`. They remain emitted and usable where the generic transport can represent them, carry unverified documentation/evidence, and feed the automated issue/report pipeline. A nightly is not blocked merely because an optimized specialization is missing.
