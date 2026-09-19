---
type: Architecture Decision
title: Take release reachability from ttsc, and lower reachable code to native
description: The checker resolves which API symbols a project actually calls; release builds emit only those, and the reachable surface is progressively lowered from bytecode to extern_c native code.
tags: [decision, reachability, tree-shaking, ttsc, static-hermes, release, performance]
status: proposed
generated: { by: claude/opus-5, at: 2026-09-19T00:10:00-04:00 }
sources:
  - id: build-seam
    resource: ./toolchain-distribution-and-build-seam.md
    title: Toolchain distribution and the build seam
    author: project:deherm
  - id: profiles
    resource: ./runtime-profiles-and-reachability.md
    title: Runtime profiles and reachability
    author: project:deherm
  - id: policy-cache
    resource: ./layered-api-policy-cache.md
    title: Layered API policy cache
    author: project:deherm
---

# Why the current reachability is not enough

`scripts/build.mjs` derives Defold API usage from esbuild's module graph:

```js
const usesCanonicalBindings = [...retainedInputs].some((input) =>
  canonicalBindingRoots.some((root) => input.startsWith(root)));
const defoldApiUsage = { dynamicAccess: usesCanonicalBindings, symbols: [] };
```

Retaining *any* file under the generated script SDK sets `dynamicAccess` and an
empty symbol list, which the release planner reads as "retain the complete
surface". A real game imports the SDK, so in practice a release build tree-shakes
nothing of the Defold API. The conservative fallback is correct; it is simply
almost always taken.

Module granularity cannot do better. `gui.getNode` and `gui.newPieNode` live in
one module, and importing one retains both.

# Decision: the checker is the reachability authority

ttsc already resolves call sites against the generated SDK's declared interfaces
- it does so today to lower `DefoldHash` literals and to resolve resource names
against the project symbol table. The same checker position yields the exact set
of API symbols a project calls.

A release build therefore emits a **symbol-level** usage manifest from ttsc:
every reached route by stable ID, with its call site. The bundler's module graph
remains a cross-check, never the authority.

Dynamic access stays conservative and explicit. A project that indexes the SDK
dynamically declares it and gets the full surface, with a diagnostic naming the
site, rather than silently defeating the optimisation for everyone.

# What the reachable set prunes

One symbol set drives every layer, so nothing can disagree:

| Layer | Pruned to the reachable set |
| --- | --- |
| TypeScript bundle | only reached SDK modules are retained |
| Generated binding families | per-family C++ sources, route tables and registries |
| CMake inputs | the emitted source list for the release extension |
| Emitted C | `shermes -emit-c` runs only over reachable typed-native routes |
| dmSDK provider | `materialize-dmsdk` already prunes to declared usage |
| Target gates | unreachable routes are absent, not merely disabled |

An unreachable route costs nothing: no TypeScript, no C, no object, no symbol.

# Development is deliberately the inverse

Reachability pruning applies to release builds only. **Development links the
complete Defold API surface on purpose.**

The expensive step in this project is not compiling TypeScript; it is compiling
and linking native code through Bob and Extender. If the linked surface tracked
what the game currently calls, then the first use of a new API would invalidate
the extension and force a native rebuild - in the middle of iteration, for a
one-line edit. Linking everything once removes that class of interruption
entirely: a developer can reach for any of the 913 routes and the running engine
already has it.

That is already how it builds. Bob compiles the whole of
`defold/defold_hermes/src/`, and `DEHERM_CANONICAL_RELEASE_DIR` is empty unless
release generation sets it, so the pruned projection is opt-in.

| | linked native surface | game code | relink triggered by |
| --- | --- | --- | --- |
| development | complete | bytecode over JSI | adding a native extension, or regenerating the surface |
| release | reachable only | bytecode plus `extern_c` where lowered | every release build |

Reachability is still computed in development, but only to *report*: the
operator console can show what a release build would retain, long before anyone
produces one. It never prunes what is linked.

## The asymmetry this creates, and the gate it demands

Development and release therefore do not link the same thing, and that is the
one place this design can bite. A route exercised all through development can be
absent from release if the checker failed to see its call site - a dynamic
index, a computed member, a call reached only through a code path ttsc could not
resolve.

This is precisely why dynamic access must be *declared and diagnosed* rather
than inferred, and why conformance evidence has to be attributed to the pruned
projection. A release build is not a subset of a development build that has been
tested; it is a different artifact, and it carries its own evidence.

# Native lowering as a tier, not a target

The reachable surface is lowered as far as each route's contract allows. These
are tiers of the same Hermes 1.0 runtime, chosen per route, not separate builds.

| Tier | Mechanism | Applies when |
| --- | --- | --- |
| 0 | JS evaluated by Hermes | always available; the development default |
| 1 | Hermes bytecode via `hermesc` | any reachable code |
| 2 | `extern_c` native call via `shermes -typed` | the route's value shapes are soundly typeable |
| 3 | project and library code AOT-compiled to native | the code is sound-typed TypeScript |

Tier 2 is the binding boundary and is measured today: 325 of 913 reachable
routes. Tier 3 is the further step - **our own library code becomes native**.
The SDK's address resolution, vmath wrappers, component adapter and dispatch
helpers are ordinary sound-typed TypeScript; compiled by `shermes` they stop
being interpreted entirely.

That matters because the measured cost is not only the boundary crossing. A
route on tier 2 still reaches it through library code on tier 0 unless that
library code is lowered too. Lowering the callers is what makes the lowered
boundary worth having.

Nothing regresses: a route or module that cannot reach a higher tier stays at
the one it qualifies for, in the same binary, in the same runtime.

# Consequences

* Release size and startup scale with what the game uses, not with the size of
  the Defold API.
* The typed-native ratio becomes a property of a *project*, not of the whole
  surface: a game using 40 routes may be entirely tier 2 even though the overall
  ratio is 325/913.
* Growing tier 2 coverage is a performance investment with a measurable ceiling,
  and the timing telemetry already distinguishes the transports.
* Generated C only exists for reachable routes, so the build seam's assembly
  step scales with the project.

# Gates

Reachability is a claim about an artifact and must be checked against one:

* A symbol absent from the reachable set must not appear in the final native or
  Wasm artifact. `tests/release-build.test.mjs` already performs dead-symbol
  retention checks; they extend to the emitted C and the typed-native lane.
* The ttsc symbol set and the bundler module graph must agree, or the build
  fails. Two independent derivations disagreeing means one is wrong.
* Conformance evidence must be attributed to the *pruned* release projection,
  not only the full development surface. Proving 913 routes in development and
  shipping 40 unproven ones is not evidence.

# Boundary

This describes what is emitted and retained. It is not runtime evidence, and a
route being lowered to tier 2 or 3 says nothing about whether it behaves
correctly - that remains the headless conformance harness's job.
