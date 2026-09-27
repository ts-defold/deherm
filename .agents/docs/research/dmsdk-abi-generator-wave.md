---
type: Research
title: dmSDK ABI generator wave
description: Reproduced scalar blocker audit, exact ABI-shape census, and generated scalar, enum, and bounded-span bindings.
tags: [research, generated, dmsdk, bindings, abi, conformance]
status: active
---

# dmSDK ABI generator wave

The dmSDK runtime queue is now decomposed mechanically rather than by a hand-written function list. `scripts/generate-dmsdk-abi-shapes.mjs` resolves aliases, enums, records, handles, pointers, callbacks, direction, and fixed ABI scalars for all 1,361 runtime-pending declarations. The resulting ledger contains 888 exact signature shapes grouped into 15 implementation tranches. The increase from the earlier neutral-source census is source-correct: exact SDK support headers preserve nested enums and platform-native handle aliases that Clang recovery had collapsed to `int`. Every row retains its source declaration ID and header, plus explicit blockers; no tranche is promoted as runtime evidence merely because it was classified. Named scalar discovery now resolves aliases directly from that revision IR without a package-side typedef table or tranche-name dependency. The current revision discovers 21 candidates, emits 20 fixed-cell wrappers and exact twins, and retains the universal fallback for the one archive-evidence blocker.

The enum-value family discovers functions whose arguments and results contain only ABI scalars or resolved enums and require at least one declared enum domain. Generic source-semantic inference retains universal fallback for registry-unregister and documented pre-context adapter-install operations; the package policy has no callable IDs, source paths, expected counts, or emit list. The current revision discovers ten candidates, blocks three lifecycle/registry mutations, and emits seven normal calls. The generated ABI uses `int32_t` for enums, exact generated input-domain checks, `uint64_t` plus JSI `bigint` for hashes, dense integer IDs, and stack-only fixed slots. Four buffer/log calls link and execute against the pinned packaged dmSDK. Three graphics/sound calls compile against the complete SDK but remain `engine-context-pending` until exercised in a real Defold process.

Four additional context-free families are now generated from exact ABI-census
selectors plus stable format recipes:

- four fixed digests with caller-provided capacity and fixed 16/20/32/64-byte outputs;
- two Base64 span operations with explicit capacity/query semantics and strict
  padded alphabet, padding-position, and canonical discarded-bit validation
  before platform-native decode;
- two bounded ASTC header probes returning a caller-owned three-`uint32_t`
  record; and
- XTEA encrypt/decrypt specialized to `ALGORITHM_XTEA`, with non-null spans and
  the pinned 16-byte key maximum checked before the native assertion; and
- `dmHashBuffer32`/`dmHashBuffer64` over borrowed explicit-length byte spans,
  including embedded-NUL vectors and caller-owned scalar results.

All ten compile and link against pinned Defold code or packaged SDK libraries
and pass known-behavior and rejection tests. Warmed harnesses observe zero C++
`operator new` calls through the generated glue. That is not a claim that every
platform-native implementation is allocation-free: the Apple Base64 path uses
Foundation, so Objective-C/native allocations remain unmeasured. Defold buffer
hashing can also allocate when its process-global reverse-hash registry is
explicitly enabled; pinned source proves that registry defaults off, and the
generated glue itself owns no heap primitive.

## Corrected blocker claim

The earlier scalar report said `dmGraphics::Finalize` was blocked because `graphics/graphics_ddf.h` was absent. That claim was true only of the source checkout and false of the packaged SDK used by extensions. The audit now compiles the complete packaged `dmsdk/graphics/graphics.h`, fingerprints its generated `graphics_ddf.h`, and takes the exact `dmGraphics::Finalize` symbol address. The declaration remains unexposed solely because process-global graphics teardown requires an explicit engine-lifecycle capability. The same policy applies to profiler and logging initialization/finalization. None of those destructive lifecycle calls are executed by the test.

## Reproduced evidence

- The 26 scalar thunks selected from the current revision's direct primitive ABI shapes compile, source-link, and execute. A warmed 100,000-call dispatch loop observes zero C++ allocations.
- All five lifecycle blockers compile from their real pinned headers; their object file contains exact unresolved native symbol references.
- The seven enum-value wrapper and JSI translation units compile against the complete packaged SDK.
- Four host-safe enum-value routes source-link and execute against `libdlib.a`; invalid enum sentinels fail before the native call; a warmed 100,000-call dispatch loop observes zero C++ allocations.
- Generated reports fingerprint their IR, classification, overrides, relevant SDK headers, and output artifacts. Temporary-output regeneration is byte-identical.

This is host and arm64-macOS evidence only. HTML5 remains fail-closed for the enum-value family pending the Emscripten BigInt ABI and linked-symbol matrix. Graphics and sound behavior still needs packaged-engine probes.

## Revision-derived arena cstrings

The arena-cstring package recipe now contains only its stable counted-input,
caller-owned-output transport contract and the 4095/4096-byte scratch limits.
It no longer pins a Defold revision, generated-report identities, concrete
Defold enum names, declaration shapes, headers, lines, or copied comments.
Candidate names and headers come from the revision IR; the generator derives
error-string, trimmed-string, canonical-path, and URI-encoding semantics from
the public descriptions and ABI roles, then selects the adapter with the shared
compiler pattern selector.

The current revision retains five generated adapters, five exact-call twins,
and sixty specialized-lane blockers. The bounded thread-local input arena,
same-thread reentrancy rejection, output clearing, termination checks, overlap
support, sanitizer execution, and 100,000 warmed calls with zero heap
allocations are unchanged. Withheld or changed documentation now declines only
the optimized arena adapter; the usage-materialized universal recipe and its
Static Hermes direct C-ABI path remain available for every declaration.

The same compiler completed policy materialization and compile verification for
Defold 1.13.1, 1.12.0, and 1.11.0. Their IR selected the same canonical-path,
error-string, and URI-encoding patterns where those callables existed, but the
historical symbol census did not prove all-target/all-variant linkage, so those
optimized adapters stayed fail-closed. The universal recipes still materialized
and compiled. That is a version-survival result, not a claim that the historical
specialized lanes are engine-linked.

## Revision-derived C-string/value contracts

The C-string/value package recipe has been reduced from a 7.7 KB table of
current-revision declaration IDs, symbols, headers, hashes, regexes, and copied
anchors to the stable 64 KiB scratch bound and UTF-8/nullability codecs. Three
compiler patterns now cover enum-to-string literals, nullable slices borrowed
from an input path, and input-string transforms. Restricted string domains,
reverse-hash registry lifetimes, profiler context, and missing documentation
remain explicit universal fallbacks.

The current and 1.13.1 revisions each discover 20 candidates and select 14;
1.12.0 discovers 19 and selects 13; 1.11.0 discovers 15 and selects 10. The
1.12.0 C++ resource helper has no public documentation in that revision, so it
correctly remains universal-only instead of inheriting the documented C helper's
nullable contract. Every lane completed policy materialization and compile
verification with the same compiler package. Current generated C ABI, JSI,
Static Hermes direct-memory, browser descriptor, TypeScript surface, exact
stub runtime, overlap/reentrancy checks, and zero-warmed-allocation evidence are
unchanged; the specialized family remains private staging until its product
backends are deliberately promoted.

The C-string/value family now has a compiler-owned authenticated plan between
projection and emission. The plan owns candidate eligibility, documentation
interpretation, pattern selection, explicit universal fallback, compiler-safe
TypeScript route identities, and the canonical projection order that preserves
the pre-migration dense dispatch IDs. The emitter verifies the complete plan by
re-deriving it through `@deherm/compiler`, then only renders the selected rows.
It contains no selector, pattern catalog, documentation parser, or independent
eligibility prose.

The evidence boundary is deliberate. A public Defold `const char *` parameter
documented as a string, path, or UTF-8 value is trusted as a synchronous
borrowed call parameter unless the same revision says it is nullable, retained,
stored, deferred, asynchronous, arbitrary-encoded, or contains embedded NUL.
A public C-string result documented as a string representation is trusted as
NUL-terminated and non-null unless the revision contradicts that contract.
Those are Defold API conventions at the owner boundary, not claims inferred
down to every CPU instruction. Explicit negative prose dominates generic
positive words and withdraws only the specialization; the declaration remains
in the universal recipe set. The generated adapters still narrow JavaScript
inputs to valid UTF-8 strings and do not claim that every native byte string is
Unicode.

Systemic tests reject object/text provenance skew, forged contracts, registry
or owner drift, family-label eligibility changes, negative nullability,
termination, encoding, and lifetime evidence, and normalized TypeScript name
collisions. Clean-room regeneration reproduces the plan and all downstream
artifacts byte-for-byte. Current, 1.13.1, 1.12.0, and 1.11.0 all complete the
same materialization, compile, link, and exact-call matrix with revision-
specific API counts.

## Structurally closed hash-state lifecycles

Incremental hash-state generation no longer copies Defold descriptions, regular
expressions, callable names, record names, a fixed `hash.h` include, or symbol
evidence paths into the package policy. The compiler recognizes a candidate
state from its complete public record layout, derives 32- or 64-bit width from
the native member types, and requires exactly one ABI-distinct init, clone,
counted-buffer update, final, and release operation for that state. The five
operations are promoted or withheld together, preventing a partial lifecycle
from exposing a token that cannot be consumed safely.

The generated translation units take their public include and exact linker
identities from the revision IR. The exact-call twin now treats the state as
opaque storage and no longer names Defold's record fields. Current generation
still emits all ten operations; sanitizer execution and 100,000 warmed calls
still observe zero C++ allocations. Defold 1.11.0, 1.12.0, and 1.13.1 each
derive the same ten structural candidates, but their saved symbol census does
not prove all-target/all-variant linkage, so the optimized family stays
withheld and every operation remains callable through its universal recipe.

## Revision-derived fixed-width buffer hashes

The two fixed-width buffer hash routes no longer depend on copied Defold
descriptions, a summary regular expression, parameter prose, a fixed `hash.h`
include, callable names, or route IDs. The compiler selects the exact
`const void*` plus `uint32_t` counted-input ABI with a `uint32_t` or `uint64_t`
result, obtains its public include and linker symbol from the revision IR, and
retains the universal recipe beneath it. The package policy is now only the
stable borrowed-counted-byte transport, supported result widths, synchronous
ownership, and fallback contract.

Current host compilation and behavior vectors still pass against the packaged
SDK, including embedded NUL input, invalid storage rejection, and zero warmed
C++ allocations with Defold reverse hashing left at its default-disabled state.
Defold 1.11.0, 1.12.0, and 1.13.1 each independently derive the same two ABI
shapes; that is derivation evidence only, not a retroactive host-runtime claim
for those saved revisions.

## Revision-derived bounded span semantics

Fixed digest, Base64, ASTC, and XTEA specialization no longer treats English
documentation, declaration spelling, or copied numeric constants as compiler
control data. `generate-dmsdk-source-semantic-facts.mjs` selects structurally
eligible ABI rows, parses the pinned implementations with Clang's JSON AST, and
emits a compact authenticated fact graph. It follows same-translation-unit
helpers and records parameter forwarding, calls, fixed local arrays, literal
and enum constants, operations, assignments, and returns. The four family
analyzers recover digest extents, Base64 operation/capacity behavior, ASTC
header/dimension behavior, and XTEA key/success behavior from those facts.

The compiler-owned package data is now only reusable grammar: ABI-role
patterns, composable fact queries, transport constructors, emitters, and
fallback recommendations. It contains no Defold declaration IDs, headers,
symbols, descriptions, parameter prose, return prose, expected route counts,
or Defold-derived bounds. Those revision facts travel in the generated policy.
The fact artifact authenticates the exact SDK IR and ABI-shape inputs as well
as every implementation source it read.

The generated public includes and native call expressions come from the
selected revision IR. Current generation remains four fixed digests, two
Base64 operations, two ASTC probes, and two XTEA operations; the generated
C/C++ transport is byte-identical to the previous optimized implementation.
Focused harnesses compile and link the exact calls, execute success and
rejection vectors, and observe zero warmed C++ allocation calls. These are
unchanged runtime claims rather than evidence inferred from the new parser.

Semantic specialization is additive. If an ABI-shaped declaration uses an
unseen implementation shape, the generator keeps its universal
usage-materialized recipe. A compiler-level audit now accounts for every one
of the 1,260 universal fallbacks, groups them into 848 structural shapes, names
the closest optimized patterns and their blockers, and records actionable
emitter or fact-query recommendations. No fallback can disappear from this
ledger. The current partition is 101 preferred specializations, 1,260 audited
universal fallbacks, 537 immediately universal-ready calls, 723 calls requiring
project usage facts, and zero silent omissions.

The current revision yields 10/10 requested source-fact records and selects 4/4
fixed digests, 2/2 Base64 operations, 2/2 ASTC probes, and 2/2 XTEA operations.
Focused exact-call harnesses compile, link, execute success and rejection paths,
and retain zero warmed C++ allocator calls. Clean-room generation independently
rebuilds all 1,361 recipes and 115 artifacts byte-for-byte from declared inputs.
Those are distinct generation, compile/link, runtime, allocation, and
reproducibility claims; none is promoted into another stage's evidence.

## Clean-room registry inputs and outputs

`scripts/lib/dmsdk-generator-pipeline.mjs` is the single ownership and ordering
registry for this focused runtime-lowering pipeline. The clean-room checker
copies only the registered generator sources, pinned inputs, and referenced
Defold evidence into a new temporary directory, executes the steps in order,
discovers generated dmSDK files independently, rejects unowned output, and
compares the complete generated artifact registry byte-for-byte with the repository.
`scripts/generate-dmsdk-runtime.mjs` is the thin public orchestrator; both its
generate and `--check` modes consume this registry rather than restating the
step chain.

The registered steps are:

1. `scripts/classify-dmsdk-bindings.mjs`
   - input: `packages/bindings/generated/defold-sdk-ir.json`
   - output: `packages/bindings/generated/defold-dmsdk-binding-patterns.json`
2. `scripts/generate-dmsdk-abi-shapes.mjs`
   - inputs: the SDK IR and binding-pattern report
   - output: `packages/bindings/generated/defold-dmsdk-abi-shapes.json`
3. `scripts/generate-dmsdk-scalar-thunks.mjs`
   - inputs: the SDK IR, ABI-shape report, and stable direct-primitive recipe
   - outputs: scalar report, one revision-derived C++ source, C ABI, runtime dispatcher, JSI adapter, browser adapter, and TypeScript wrapper
4. `scripts/generate-dmsdk-named-scalar-bindings.mjs`
   - inputs: SDK IR, ABI-shape report, and `packages/bindings/overrides/dmsdk-named-scalar-policies.json`
   - outputs: a 21-route policy report plus intentionally empty C ABI, JSI, and TypeScript surfaces
5. `scripts/generate-dmsdk-enum-value-bindings.mjs`
   - inputs: SDK IR, ABI-shape report, scalar-thunk report, and `packages/bindings/overrides/dmsdk-enum-value-bindings.json`
   - outputs: enum-value report, C ABI, runtime dispatcher, JSI adapter, TypeScript wrapper, and buffer/graphics/log/sound C++ sources listed in its report
6. `scripts/generate-dmsdk-fixed-digest-bindings.mjs`
   - outputs: four capacity-checked digest wrappers and a dense runtime dispatcher
7. `scripts/generate-dmsdk-base64-span-bindings.mjs`
   - outputs: canonical padded Base64 span wrappers and query/dispatch metadata
8. `scripts/generate-dmsdk-astc-probe-bindings.mjs`
   - outputs: two bounded ASTC probes with a fixed caller-owned result record
9. `scripts/generate-dmsdk-xtea-span-bindings.mjs`
   - outputs: specialized XTEA encrypt/decrypt span wrappers and dispatcher
10. `scripts/generate-dmsdk-hash-span-bindings.mjs`
   - outputs: bounded `dmHashBuffer32`/`dmHashBuffer64` wrappers and dispatcher

Focused gates are `npm run check:dmsdk-runtime`,
`npm run check:dmsdk-clean-room`, `npm run test:dmsdk-runtime-codegen`, and
`npm run test:dmsdk-clean-room`. The clean-room input fingerprint for this
wave is `f534e54945a92f821b75272e40973ca8060d885d4c8774002dc9ec635fa28eeb`.

The enum-value runtime and JSI dispatcher are now installed by the generated
module installer and exported by the generated SDK barrel. The standalone host
runner links explicit host-only wrapper stubs outside the shipping extension;
the extension syntax gate instead compiles the seven real generated wrappers
against the complete pinned packaged SDK. This proves generation, compilation,
and installer linkage, but it does not yet promote the seven routes to retained
or observed packaged-engine evidence.
