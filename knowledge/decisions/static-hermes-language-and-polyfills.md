---
type: Architecture Decision
title: Require sound Static Hermes game code and install only manifest-selected polyfills
description: Use ttsc to lower authored TypeScript into sound typed Static Hermes units, keep compatibility islands explicit, and provide React-Native-style host globals through a versioned reachability manifest.
tags: [decision, static-hermes, typescript, ttsc, polyfills, performance]
status: accepted
generated: { by: codex/gpt-5, at: 2026-09-17T20:30:00-04:00 }
sources:
  - id: typed-language
    resource: https://github.com/facebook/hermes/blob/4947871513667919bf2fe225134af3e3a1a3772c/doc/TypedLanguage.md
    title: Pinned Static Hermes typed language guide
    author: team:meta-hermes
  - id: typescript-stripping
    resource: https://github.com/facebook/hermes/blob/4947871513667919bf2fe225134af3e3a1a3772c/doc/typescript-stripping.md
    title: Pinned Hermes TypeScript stripping guide
    author: team:meta-hermes
---

# Decision

The native release profile requires sound Static Hermes typing for application,
gameplay, generated binding, and hot polyfill code. Untyped AOT is an explicitly
named `compat` profile and never an automatic fallback. Release reports state
the compiled mode of every unit; `strict` fails when any reachable unit is
untyped or unsupported.

Authored code remains idiomatic TypeScript. `ttsc` owns the semantic lowering:

1. TypeScript checks the authored program against the Deherm SDK.
2. The transformer resolves modules, erases TypeScript-only declarations, and
   rewrites generated API calls to stable binding IDs or direct `extern_c`.
3. It emits the sound subset accepted by `shermes -parse-ts -typed -strict`.
4. Static Hermes emits named C units which Defold links into the extension.
5. The runtime evaluates those units and drives the registered lifecycle.

This is not ordinary TypeScript erasure. Hermes `--transform-ts` is incompatible
with `-typed`; it is therefore reserved for the explicit compatibility profile.
The strict transformer must preserve return, parameter, field, tuple, exact
object, and nominal class types.

# Reproduced proof

The repository now builds and runs two strict units:

* a generated `$SHBuiltin.extern_c` unit calls the same `ExampleMath` C ABI and
  reports `42`;
* a TypeScript class compiled with `-parse-ts -typed -strict` registers an app
  and executes `init`, `update`, `onMessage`, and `final` as AOT code.

The executable prints `static.ffi:42`,
`static.lifecycle:typed-strict:init,update,message,final`, and
`defold-hermes-static:ok`. The ordinary bundled app is also compile-checked as
an untyped AOT compatibility unit but is not used by the strict runner.

The proof also reproduced a pinned TS-to-Flow frontend bug: return annotations
on function expressions, arrow functions, and class methods were left as TS
nodes. Draft [`facebook/hermes#2188`](https://github.com/facebook/hermes/pull/2188)
adds the two missing visitor paths and an official regression test. The focused
TS2Flow suite passes. Deherm may carry that exact patch only until the pinned
Hermes revision includes the fix; the contributor fork never becomes the
product dependency. Reproduction and removal details are recorded in the
[upstream evidence note](../research/static-hermes-ts2flow-upstream.md).

# Polyfill policy

`packages/polyfills/compatibility.json` is the machine-readable authority. It
separates four cases:

* engine intrinsics already supplied by Hermes or the browser;
* host globals backed by Defold/dmSDK on native and browser globals on HTML5;
* build-time transforms such as `process.env.NODE_ENV`;
* rejected dynamic or Node-only facilities.

Polyfills are reachable-only modules, not a blanket `core-js` bundle. Each has
native, strict Static Hermes, and HTML5 providers. Hot scheduler, encoding, and
bridge implementations must themselves pass sound typing and allocation tests.
Cold compatibility code may live in an explicitly reported compat unit, but
strict release builds reject it by default.

The first required React-style host set is `global`, `console`,
`performance.now`, the microtask queue, immediates, timers, animation frames,
UTF-8 codecs, URL primitives, abort, fetch, and secure random bytes. Hermes
collections, promises, typed arrays, BigInt, weak references, and finalization
are probed instead of redundantly polyfilled.

# Gates

1. No silent typed-to-untyped fallback.
2. Every emitted unit records `typed-strict`, `untyped-aot`, or `browser`.
3. The strict application and generated ABI units compile, link, and run.
4. Every selected polyfill has native, Static Hermes, and HTML5 conformance.
5. Scheduler callbacks are generation-safe and bounded; hot calls allocate
   neither C++ heap memory nor Lua userdata.
6. Unsupported npm constructs produce source-mapped ttsc diagnostics.
