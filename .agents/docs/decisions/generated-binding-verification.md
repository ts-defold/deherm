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

The dmSDK surface has 1,361 runtime declarations and 1,361 materializable
recipes with silent omission forbidden. Its current native materializer test
compiles, links, and runs representative direct functions, a template
specialization, a constructor, a member function, and a destructor. The
remaining work is to make the exact-call verification artifact an automatic
output of every usage materialization rather than a representative test only.

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
