---
type: Architecture Decision
title: Generated binding verification stops at the exact bridge contract
description: Every emitted Lua or dmSDK call carries a generated twin that verifies exact symbol selection, signature, ABI layout, argument and result ordering, bounds, and lifetime behavior; Defold remains authoritative for implementation semantics.
tags: [decision, generator, verification, lua, dmsdk, abi, ci, wasm]
status: accepted
generated: { by: codex, at: 2026-09-20T00:00:00-04:00 }
sources:
  - id: never-gate
    resource: ./generate-report-never-gate.md
    title: Generate, report, open issues - a generator never refuses
    author: project:deherm
  - id: recording-engine
    resource: ../research/generated-script-recording-engine.md
    title: Generated script recording engine
    author: project:deherm
---

# Decision

Déherm verifies what déherm owns. For every emitted binding, the same IR that
emits production code emits or drives a verification twin. The twin proves:

1. the public stable ID selects the intended source declaration;
2. the exact Lua module/member or C/C++ symbol and overload are selected;
3. the generated signature has the expected arity and native types;
4. ABI cells, records, pointers, handles, and arenas use the generated layout;
5. arguments reach the callee in the declared order with their exact values;
6. results return in the declared order and decode to the expected values;
7. bounds, stack restoration, ownership, invalidation, and release behavior are
   preserved; and
8. the census is total, so a new Defold declaration automatically adds a test
   obligation rather than waiting for a hand-authored case.

Defold is authoritative for the semantics of the implementation behind that
call. Déherm does not need to reconstruct every possible game-object, GUI,
render, physics, audio, input, network, and platform context before publishing
the binding.

# Surface-specific contract

| Surface | Generated verification twin | Publication rule |
| --- | --- | --- |
| Lua/script API | The stable-ID operation catalog plus generated null/recording providers assert the exact module, member, arity, argument tags/order, result tags/order, stack discipline, bounds, and ownership behavior. Compile-time property intrinsics and the specialized timer bridge form their own generated lanes. | A route is `verified` when its generated lane passes CI. Missing a bespoke live-engine fixture is only a harness coverage note. |
| dmSDK | The declaration recipe records the exact native symbol, invocation kind, receiver, ordered native parameter types, result type, and ABI cells. Each usage materialization must emit the production wrapper and a verification vector/stub contract from the same resolved recipe and substitutions. | Every runtime declaration ships with a materializable recipe. Every reachable/materialized call must pass its generated exact-call test. Templates are tested after usage supplies the specialization; an abstract template is not falsely called a concrete function. |
| Static Hermes | The sound-typed extern-C declaration is checked against the same ABI cells and exact-call vectors used by the native provider. | A compiler/frontend smoke is required for emitted reachable units; no separate semantic certification. |
| Dynamic Hermes/JSI | The generated adapter is driven by the same exact-call vectors through a recording provider. | Transport parity and ownership checks are required. |
| HTML5/Wasm | The direct-memory provider consumes the same vectors. Playwright runs a packaged browser sentinel to prove the JavaScript/Wasm/engine boundary exists. | Playwright is an integration sentinel, not one browser scenario per Defold function. |

# Current evidence

The Lua surface is partitioned without omissions: 915 universal dispatch rows,
eight component-property compiler intrinsics, and three specialized timer
bridges cover all 926 documented routes. The universal native dispatcher loops
over every generated row, forwards ordered sentinel arguments, and checks the
selected operation. The JavaScript test reads the generated C++ table and
checks its stable ID, module, member, and contract against the generated policy;
this includes the source correction from documented `sys.set_render_enable` to
registered `sys.set_render_enabled`.

The generated recording engine now executes all 915 universal rows through the
real Dynamic Hermes/JSI bridge. Two input-only handle kinds (`box2d-shape` and
`graphics-texture`) have no public constructor or return route, so generated,
collision-checked provider fixture IDs mint genuine JSI HostObjects before the
census; they are not substituted with plain JavaScript objects. The
direct-memory and typed-native drivers each execute 890 rows. Their remaining
25 rows are an explicit target partition: 23 callback-input routes require the
HTML5 callback registry or JSI fallback, and two routes return functions that
only JSI emits. Static URL and Matrix4 arguments are exercised through their
real bounded frame helpers rather than skipped by the harness.

The remaining eleven script routes now have their own generated exact-call
report and C verification header. The emitter exact-set joins the accounting
rows to the component compiler capability and to both timer schemas; either
schema drifting, a missing row, or an unexpected row fails generation. All
eight compiler intrinsics are compiled from one generated `.script.ts` fixture
through the real TypeScript AST component compiler and compared with their
exact emitted `go.property`/`resource.*` Lua declarations. The three timer
routes execute through four applicable lanes: cached Lua stack thunks, a real
Dynamic Hermes/JSI runtime, the browser/Wasm host glue, and a sound-typed Static
Hermes unit compiled to C by the pinned frontend. Evidence is lane-specific.
Lua, Dynamic Hermes/JSI, and browser/Wasm run the same generated lifecycle
scenario and check exact route selection, ordered values, result normalization,
one-shot and repeating ownership/release, failure rollback where applicable,
and stack restoration. Static Hermes checks its generated symbol, ordered
scalar values, result, and flattened callback-handle field transport; its fake
C callee does not claim to prove callback ownership. The warmed Lua bridge
still reports zero Lua allocator calls on the primitive and callback hot paths.
This closes the generated 915 + 8 + 3 script-call inventory and its declared
lane contracts; it does not claim that a packaged engine exercised every
gameplay context.

The dmSDK surface has 1,361 runtime declarations and 1,361 materializable
recipes with silent omission forbidden. Every concrete usage materialization
now emits two artifacts from one resolved call plan: the production wrapper and
an exact-call wrapper/provider targeting a uniquely named ABI-compatible fake
callee. A content-addressed vector records the source symbol, invocation kind,
receiver, template arguments, ordered native parameters and slots, result
shape, requirements, and both wrapper identities. The native test compiles,
links, and executes that twin for direct functions, a template specialization,
a constructor, a member function, and a destructor, asserting receiver and
ordered native values as well as result re-encoding. The remaining census work
is transport-driving each reachable concrete usage through JSI, Static Hermes,
and browser/Wasm adapters where that usage is emitted; abstract recipes remain
available but are not falsely described as concrete calls.

# Integration tests are sentinels

Native headless Defold and Playwright HTML5/Wasm runs remain valuable. They
prove packaging, engine attachment, and one real cross-boundary path and catch
integration failures that a stub cannot. They do not grant per-function
permission to ship and do not create `unverified` labels for routes they did
not happen to exercise.

# Consequences

* Public route status is `verified` unless positive source or runtime evidence
  contradicts the declaration, in which case it is `suspect` and receives an
  issue. Harness coverage is separate.
* Generated code and generated test contracts must share identity and schema
  inputs. Hand-maintained per-symbol test lists are forbidden.
* A test may use an ABI-compatible fake callee because the property under test
  is déherm's selection and transport. The real engine remains the authority
  for the callee's internal semantics.
* Release reachability controls how many dmSDK concrete usages are materialized;
  it does not alter the complete declaration/recipe surface users can select.
