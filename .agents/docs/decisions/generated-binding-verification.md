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
| Static Hermes | The sound-typed extern-C declaration is checked against the same ABI-cell contract with generator-owned, lane-specific exact-call vectors. | A compiler/frontend smoke is required for emitted reachable units; no separate semantic certification. |
| Dynamic Hermes/JSI | The generated adapter is driven by generator-owned, lane-specific exact-call vectors through a recording provider. | Transport parity and ownership checks are required. |
| HTML5/Wasm | The wasm32 C ABI consumes generator-owned, lane-specific vectors. Playwright runs a packaged browser sentinel to prove the JavaScript/Wasm/engine boundary exists. | Playwright is an integration sentinel, not one browser scenario per Defold function. |

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

The recording artifact now separates generic harness capability from canonical
target applicability. Four dense per-route lane IDs are derived from the same
lowering selections that emit production code: Dynamic Hermes emits 882
JSI/Lua-stack routes plus 31 native-POD routes and omits two profile routes;
Static Hermes emits 325 typed-native routes; browser/Wasm emits 888
direct-memory routes plus 23 callback-registry routes and retains two explicit
closure-result blockers; Lua emits 911 routes and retains those same two
blockers. Exact input/result vectors are interned into 406 contracts rather
than copied into 915 rows. A generated real-Hermes driver now executes all 31
Dynamic-Hermes native-POD routes through the production value-binding
dispatcher. The 23 browser callback-registry rows are now a precise executable
obligation, not a generic recorder skip; their registry driver remains open.

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
links, and executes the generator-owned driver for direct functions, a template
specialization, a constructor, a member function, and a destructor. A second
shape suite covers booleans, floating point, enums, C strings, scalar and
pointer-represented handles, references, and callbacks. The generated recording
callees compare the decoded receiver and every native argument, return a
deterministic native value, and expose reset/call/failure counters through C ABI
observation functions. Record-by-value and enum-result cases fail closed until
their usage supplies the missing layout or domain fact. This proves the native
C-ABI exact-call lane for every concrete usage the materializer accepts; it
does not prove Defold implementation semantics or callback/handle ownership.
The remaining census work is generating an applicability manifest and expanding
the relevant vectors across every emitted shape in each transport; abstract
recipes remain available but are not falsely described as concrete calls.

Concrete dmSDK usage is now checker-derived rather than hand-authored. The
SDK generator places a content-addressed marker in the first parameter name of
each emitted `callDmSdk` overload. Parameter names do not change TypeScript
call syntax, while the resolved signature retains the marker. A generated
project-local index joins that marker to the exact catalog declaration ID and
dense numeric recipe ID. ttsc writes `.deherm/generated/dmsdk-usage.json`, and
`deherm materialize-dmsdk` consumes that file by default to emit the production
provider, verification provider, exact recording callee, driver, and report.
The tested fixture selects `dmGraphics::Finalize` in TypeScript and directly
materializes recipe 503 and both generated C++ artifacts without a handwritten
usage manifest.

The 1,361 recipes currently form 1,335 checker-visible overload shapes.
Twenty-one shapes collapse more than one native declaration after C++ types are
projected into TypeScript. A release compilation refuses to guess among those
declarations and records every candidate at the call site. The generated
`callDmSdkDeclaration(declarationId, ...args)` escape hatch addresses every
recipe by canonical declaration ID; its literal selector is checker-resolved
back to the same catalog. Selection is therefore total and tree-shakeable even
when executable specialization is still required. Nonliteral or unknown exact
selectors fail release compilation rather than being omitted from the usage
manifest. This ambiguity is a projection fact, not an `unverified` API
classification.

Release reachability also fails closed on indirect invocation of these facades.
`Function.call`, `Function.apply`, other invoked function properties, and
`Reflect.apply` resolve to standard-library signatures rather than the
generated overload declaration, so treating only resolved call signatures as
evidence would silently omit their providers. The checker recognizes the
generated callable type at those escape sites and records a source-located
unresolved call until a mechanically modeled indirect-call contract exists.

The checker manifest proves total declaration selection and classifies the
executable lowering at the call site. Of the current 1,361 recipes, 486 are
universal-ready from declaration identity alone, 59 have a concrete callable
generated-adapter route, and 816 require specialization. The 59 callable rows
are 45 named wrappers plus 14 stable-ID C-string family-dispatch rows. Their
shared concrete-call plan authenticates declaration, recipe, family, wrapper or
dispatcher identity, header, and dense family ID, and the materializer emits a
linker-retention source and manifest for only the reached rows. Another 87
preferred adapter rows retain their generated provider-boundary blockers; they
are not promoted merely because source exists. The remaining 729 rows require
call-site facts such as template arguments, receiver types, callback contracts,
or layout/storage policy. All declarations remain generated and addressable.
Release checking rejects a reached specialization-required declaration at its
source location rather than writing an apparently complete manifest.

The declaration parse resolves public source headers against the exact,
checksum-pinned Defold SDK support headers for the same revision. Only the 91
transitively referenced type facts enter the IR: nested enums, generated DDF
records and aliases, and target-specific native-handle spellings. The current
projection has zero unknown value constructors. Target-dependent handles such
as `VkImage` retain their per-bundle spelling and use one generated bit codec
that packs or unpacks either a pointer or an integer at C++ compile time.
Aliases that a Defold header replaces with a platform-supplied definition are
classified from the generated target-conditional report as opaque handles.
That structural rule covers WebGPU's native integer aliases and Emscripten
pointer handles without a WebGPU symbol allowlist.

The compiler derives one canonical, numeric-ID-ordered corpus for all 486 ready
recipes from the authenticated catalog and release-call symbol index. Its
committed plan, production source, and verification source are clean-room-owned
generated artifacts; the plan authenticates the index, ordered vector hashes,
both source hashes, and the materializer manifest without owning a handwritten
declaration list. The native declaration-only census compiles those production
and exact-call twins against the pinned SDK, links recording callees, and
executes every vector. It checks preconditions, receiver and ordered argument
decoding, exact callee count, and result encoding.
Complete pointee fixtures use the source type's actual alignment; incomplete
and `void` pointees never form `alignof` expressions. This is exact bridge
evidence, not execution of Defold implementation semantics.

The declaration-only census deliberately combines every ready Defold header in
one generated translation unit. On Linux that exposed an otherwise independent
global-name collision: Xlib's `Font` typedef, included by
`graphics_native.h`, conflicts with Defold's opaque `Font` declaration. When a
materialization includes the native-graphics header, the compiler now primes
the GLX include guard while spelling only Xlib's typedef as
`DehermX11Font`, then restores the preprocessor state before including the
authoritative Defold headers. It also removes Xlib's object-like `None` macro
after the GLX declarations are complete so later Hermes enum members named
`None` remain valid C++. No generated wrapper names or calls either Xlib name,
so this is a target-scoped header-composition repair rather than an ABI
translation. Materializations without native graphics do not acquire GLX.

The arbitrary-extension C-header lane follows the same rule. Function identity
is derived from module, native symbol, ordered native parameter spellings, and
native result spelling plus the variadic call form, so inserting lines in a
header cannot renumber calls. Repeated compatible declarations deduplicate;
variadic declarations remain visible but require a typed non-variadic facade.
The generated production dispatcher, ABI-compatible fake dispatcher, runnable
driver, and content-addressed verification report all consume that normalized
route plan. `deherm generate-extension-api` writes all four artifacts. The
current parser is deliberately a single-header C11 lane: C++ methods/templates,
multi-header project assembly, records, unsafe pointers, and callback ownership
remain explicit follow-on shape work rather than implied support.

The browser-target dmSDK lane has a separate target gate because host-native
execution is not wasm32 evidence. `pnpm test:dmsdk-browser-exact-call`
materializes the canonical 486-call corpus through the same exact-call
generator, compiles the generated provider, recording callees, observations,
driver, and universal dispatcher with the pinned Emscripten toolchain, and runs
the emitted `.wasm` from a
loopback page in Chrome. Success is a manifest-bound marker printed by code
executing inside that Wasm module. The gate never substitutes a JavaScript
`WebAssembly.Memory` or a mock heap. Missing pinned Emscripten activation or a
real browser is a named prerequisite failure, not a skipped or downgraded test.
This proves all declaration-only ready exact-call vectors in a real
browser-loaded wasm32 C ABI. It does not yet drive those cells through the
production JavaScript browser arena/dispatcher, cover the 875
usage-specialized recipes, or execute a Defold engine implementation.

The Dynamic Hermes lane generates a C++ runner from the generator-owned
canonical 486-call corpus, creates a real packaged Hermes runtime, installs the production
`DmSdkUniversal.call` JSI host function, and verifies native recording-callee
observations and decoded JavaScript results for every declaration-only ready
recipe. That runner now belongs to `@deherm/compiler` and accepts any
materialized usage vector set; `deherm materialize-dmsdk` emits its JSI source
and report beside the native production/exact sources and checks all of them as
one atomic output set. Callback-tagged vectors remain explicitly unsupported
rather than being counted as executed. Callable generated-adapter rows are
retained by their concrete plan and continue to rely on their family-owned
exact-call tests until those family vectors are normalized into the shared JSI
runner. The 816 specialization-required recipes remain selected only when a
release program supplies their missing call-site facts.

The Static Hermes lane uses a generated, thread-local four-frame pool rather
than exposing the raw universal-dispatch pointer ABI to sound TypeScript. Each
frame owns 32 24-byte argument cells and one result cell; that capacity and the
frame emitter are a versioned package capability, while a policy carries and
cross-checks its recipe-derived maximum (currently fifteen). Acquire, cell
copy, dispatch, result access, and release are the only Static Hermes FFI
operations. A strict `shermes` unit replays the canonical 486-call corpus and
checks the generated fake observations and bounded frame transport. This does
not prove Defold implementation semantics or retained handle/callback lifetime
policy for the 875 recipes that require call-site specialization.

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
