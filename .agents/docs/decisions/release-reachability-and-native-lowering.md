---
type: Architecture Decision
title: Take release reachability from ttsc, and lower reachable code to native
description: The checker resolves which API symbols a project actually calls; release builds emit only those, and the reachable surface is progressively lowered from bytecode to extern_c native code.
tags: [decision, reachability, tree-shaking, ttsc, static-hermes, release, performance]
status: accepted
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

# Why module-graph reachability was not enough

`scripts/build.mjs` used to derive Defold API usage from esbuild's module graph:

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

A build therefore emits a **symbol-level** usage manifest from ttsc: every
reached route by stable ID, with its call site. The bundler's module graph
remains a cross-check, never the authority.

Dynamic access stays conservative and explicit. A project that indexes the SDK
dynamically declares it and gets the full surface, with a diagnostic naming the
site, rather than silently defeating the optimisation for everyone.

## How the checker answers in canonical identity

The checker can only name what TypeScript declares: `GuiApi.getNode`,
`B2dApi.body.applyForce`. Everything downstream speaks route IDs
(`script:gui.get_node`) and 32-bit stable IDs. A derived
**script route symbol index** joins the two, one entry per route, and it is
derived rather than authored - the script API IR owns the public spelling and
the canonical lowering plan owns identity and disposition, so a member the two
disagree about is a hard error rather than a silently unreachable route.

The index is project state, not package state: `deherm generate` and every dev
rebuild write it next to the resource symbol table, and this repository's own
build writes it under `build/ttsc/`. The plugin entry points at it with
`routeSymbols`, and names its output with `apiUsage`.

Resolution follows the pattern the resource-name checker already uses. A
property access resolves to a symbol; a symbol resolves to a `PropertySignature`
declared in the generated `generated/script/types.ts`; the member path is
rebuilt by walking that declaration's parents, since a nested Lua module is
declared as an anonymous type literal inside its interface. Resolution is by
symbol, so an aliased namespace, a re-export and a direct call all answer the
same route.

Computed access - `gui[name]` - is the one thing this cannot resolve. It is
detected from the object's *type* rather than its symbol, because a project
imports `gui` as an ordinary const: a type with at least one property declared
in the generated script declarations is the generated surface, however the value
reached that position. An undeclared computed access is a compile error under
the release profile that names file, line and column; under the development
profile it is recorded in the manifest and reported, never raised, because
development links everything anyway and the edit loop is not the place for it.
The release planner refuses a manifest that claims dynamic access without
declaring it, so the profile the manifest was produced under cannot be used to
slip past the gate.

# What the reachable set prunes

One symbol set drives every layer, so nothing can disagree:

| Layer | Pruned to the reachable set |
| --- | --- |
| TypeScript bundle | only reached SDK modules are retained |
| Generated binding families | per-family C++ sources, route tables and registries |
| CMake inputs | `sources.cmake` lists only the families a reachable route lands in |
| Emitted C | the typed-native lane handed to `shermes -emit-c` is re-rendered over the reachable set, so a pruned route has no `extern_c` declaration to emit |
| dmSDK provider | `materialize-dmsdk` already prunes to declared usage |
| Target gates | unreachable routes are absent from the registry, the Static Hermes gate and the browser library, not merely disabled |

A reached route may still legitimately not be emitted, and the plan says which
cases those are rather than treating every one as a gap. A compile-time
intrinsic - `go.property`, the `resource.*` constructors - never reaches any
runtime target, because the compiler lowered it. A `typed-native` target is an
acceleration tier over a baseline transport rather than a runtime of its own, so
a route that cannot be soundly typed stays at the tier it qualifies for. On a
baseline runtime transport every other non-emission still fails closed: a
reached route with nothing to dispatch to is a hole in the shipped surface.

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

Reachability is still computed in development, but only to *report*. Every dev
rebuild reads the manifest the checker just wrote and publishes it to the
console model, which shows one line - "release would retain 24/926 Defold routes
across 7 namespace(s); development links all of them" - long before anyone
produces a release. Nothing on that path touches what is linked.

## One projection among several, by design

Development-full and release-pruned are not a build and a variant of it. They
are two projections of one IR, and so is the browser/Wasm build, and so is each
native platform a release targets.

A projection is selected by four parameters and nothing else:

| Parameter | Development native | Release native | Release browser |
| --- | --- | --- | --- |
| Runtime | `hermes` | `hermes` | `browser` |
| Transport per route | `jsi` | highest tier the contract allows | `direct-memory` |
| Reachable set | complete | ttsc-resolved | ttsc-resolved |
| Profile | engine-detected | engine-detected | browser |

Nothing in the pipeline is special-cased for any of them. The canonical plan
holds every unit's disposition per transport, contracts and marshalling programs
are interned so a shape is described once and reused, target capabilities are
declared as data, and reachability is a filter applied at the end. That is what
makes a Wasm build the same operation as an arm64 release rather than a separate
port, and it is why adding a platform is a capability declaration plus a
`libhermes.a`, not new code paths.

The consequence is not a caveat to watch for; it falls out of the design.
**Every projection carries its own evidence**, because every projection is a
first-class artifact rather than a filtered copy of another. The completion
matrix is already per-target for this reason. A route proven on `jsi` is not
thereby proven on `direct-memory`, and one retained in a development link is not
thereby present in a release one.

## Where the hazard actually lives

Multiple projections are a benefit, not a risk. The risk sits one level down, in
the primitives every projection is built from: value marshalling, handle
lifetime and generation, context resolution, scratch and arena discipline, the
error model, callback lifetime, address resolution.

A primitive is correct when it **resolves deterministically to the same
observable behaviour in every environment it is projected into**, or when its
difference is declared as a capability rather than discovered at runtime. Given
that, more projections cost nothing: each is the same semantics reached by a
different mechanism. Given a primitive that resolves differently on `jsi` than
on `typed-native`, every projection multiplies the defect instead of containing
it.

So the obligation is on the primitives, and it is checkable rather than
aspirational. The generated recording engine drives one contract across every
drivable transport and diffs the traces, which is precisely a test that a
primitive resolves identically: 915 routes over `jsi`, `direct-memory` and
`typed-native` currently produce zero cross-transport divergences. A divergence
there is the single most valuable signal this project can get, because it means
a primitive - not a projection - is wrong.

The remaining enforcement is narrow: the ttsc symbol set and the bundler module
graph must not disagree about what a build reaches, and dynamic access must be
declared rather than inferred, so a projection's reachable set is a statement
rather than a guess.

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
* The measured ratio is the point. The War Battles example - a real game -
  resolves **24 routes** across seven namespaces out of 913 emittable ones, and
  this repository's own runtime-smoke entrypoint resolves 33. The bundler's
  module graph retains 125 routes for that same entrypoint, because it keeps
  whole namespace objects; before this change the release planner retained all
  913.

# Gates

Reachability is a claim about an artifact and must be checked against one:

* A symbol absent from the reachable set must not appear in the final native or
  Wasm artifact. `tests/release-reachability.test.mjs` compiles a fixture
  project that calls seven routes, asserts that every one of the other 919
  stable IDs is absent from the generated release registry, and runs
  `shermes -emit-c` over the pruned typed-native lane to assert its pruned C
  symbols are absent from the emitted C - while proving the gate is not vacuous
  by emitting the complete lane and finding those same symbols there.
* The ttsc symbol set and the bundler module graph must agree, or the build
  fails. Two independent derivations disagreeing means one is wrong. The bundle
  is read directly for this: the generated SDK dispatches through
  `callScriptApi(<stableId>, args)`, so the emitted integers are a census of the
  routes the output can reach that owes nothing to the checker. Every resolved
  route must appear there, and every namespace the bundle retained must be
  claimed by a resolved route.
* Conformance evidence must be attributed to the *pruned* release projection,
  not only the full development surface. Proving 913 routes in development and
  shipping 40 unproven ones is not evidence.

# Boundary

This describes what is emitted and retained. It is not runtime evidence, and a
route being lowered to tier 2 or 3 says nothing about whether it behaves
correctly - that remains the headless conformance harness's job.
