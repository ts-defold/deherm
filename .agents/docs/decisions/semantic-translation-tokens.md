---
type: Architecture Decision
title: Preserve API semantics as explicit translation tokens
description: Carry names, evidence, overloads, ABI layouts, language projections, and conformance state through one canonical binding IR.
tags: [decision, api, bindings, ir, semantics, typescript, lua, dmsdk]
status: accepted
generated: { by: codex/gpt-5, at: 2026-09-17T23:30:00-04:00 }
sources:
  - id: defold-ref-doc
    resource: https://d.defold.com/archive/7f0f554f41f9dce1e0ddff99bf08200657d1ee05/engine/share/ref-doc.zip
    title: Pinned Defold generated API reference
    author: team:defold
  - id: defold-sdk
    resource: https://github.com/defold/defold/tree/7f0f554f41f9dce1e0ddff99bf08200657d1ee05/engine
    title: Pinned Defold engine and dmSDK source
    author: team:defold
---

# Decision

The generator must not translate a declaration directly from source text to a
TypeScript signature. It first creates a semantic token for every symbol and
type position. That token retains enough evidence to produce different, but
equivalent, Lua, dynamic-Hermes, Static-Hermes, browser, and raw-dmSDK
projections.

A token carries at least:

```ts
interface SemanticToken {
  canonicalId: string;
  sourceName: string;
  typescriptName: string;
  kind: "function" | "parameter" | "return" | "record" | "handle" | "value";
  source: { artifact: string; location?: string; defoldRevision: string };
  evidence: readonly EvidenceClaim[];
  sourceType: SourceType;
  semanticType: SemanticType;
  abi: AbiLowering;
  projection: Record<Target, TargetLowering>;
  state: "inventoried" | "typed" | "compiled" | "linked" | "conformant";
}
```

The original name is immutable. A TypeScript spelling is a separate field, so
renaming never changes native lookup or Lua dispatch. Reserved identifiers use
one shared synonym table: `function -> callback`, `default -> defaultValue`,
`var -> value`, `this -> receiver`, and so on. Normalized module-name collisions
receive a deterministic eight-character source-name hash in generated internal
identities while retaining their exact runtime names.

# Why the API looked complete while calls were wrong

The first generator preserved declarations but flattened several semantic
distinctions:

| Source evidence | Incorrect flattening | Required token |
| --- | --- | --- |
| `T` constrained to number/vector | opaque `DefoldOpaque<"T">` | generic identity plus constraint |
| repeated C++ symbol | one indexed TypeScript function type | ordered overload family |
| `const char*` versus `char*` | one pointer brand | readonly versus mutable pointee |
| C ABI `uint8_t` boolean | JavaScript number `0`/`1` | ABI scalar plus language boolean normalization |
| template/external native type | “unresolved” | intentional opaque with reason |
| unknown name with no declaration | opaque native type | unresolved error with source context |
| `fun(...): Result|nil` | optional function | nullable function result |
| Lua `...` | synthetic opaque type | variadic argument/result tuple |

Concrete regressions now pin these boundaries. `vmath.clamp` and `vmath.lerp`
retain vector generic identity; `dmDDF::LoadMessage` exposes every overload;
mutable pointers are assignable to const-pointer parameters but not the reverse;
and HTML5 wrappers convert native `0`/nonzero results into real JavaScript
booleans.

# Evidence hierarchy

No one Defold artifact answers every question:

1. packaged dmSDK headers and Clang AST own native declarations, constness,
   visibility, overloads, layouts, and platform gates;
2. generated reference annotations own public script names, documented
   overloads, examples, and most intended Lua types;
3. Lua binding implementation owns behavior absent from annotations: accepted
   alternative stack types, variable argument rules, current-instance lookup,
   defaulting, stack returns, callbacks, and error behavior;
4. conformance probes own disputed behavior such as `0`/`1` booleans or
   multiple-return ordering;
5. the reviewed semantic overlay records the final public TypeScript choice and
   why it is equivalent.

When annotations and implementation disagree, generation emits a claim to be
resolved; it does not silently choose either. Reading `luaL_check*`,
`lua_is*`, stack-index tests, and the number and order of `lua_push*` calls is a
mechanical evidence extractor, but interpreting those branches as an idiomatic
overload remains a reviewed semantic step.

# Defold trust boundary and optimization authority

Déherm does not attempt to prove Defold down to CPU execution. The exact pinned
Defold revision is the product authority. Its public headers, generated public
declarations, build-selected platform guards, and positive Lua registration
entries determine which APIs exist, their names, their ABI declarations, and
their target availability. A complete, error-free compiler AST produced with
the source language and build inputs selected by Defold is trusted as the
structural representation of that source.

This authority is deliberately split from déherm's optimization evidence:

1. a discovered public declaration is always emitted exactly once;
2. a positive Lua registration is source-observed evidence, while absence of a
   parsed registration is unresolved rather than proof of either presence or
   absence;
3. implementation facts may select a faster transport only when they satisfy a
   structural pattern's complete causal contract;
4. an errored or recovery compiler AST can contribute diagnostics but can
   contribute no positive semantic facts;
5. a route without sufficient optimization evidence uses the generated
   universal implementation and retains a machine-readable selection trace;
6. failure to specialize never removes an API from the generated product.

Déherm owns the bridge: exact symbol/member selection, native signature,
argument and result order, representation, bounds, ownership, compilation, and
linkage. Defold owns the implementation semantics behind the selected call.
Conformance probes refine contradictions and portability claims; they are not a
license to withhold an otherwise authoritative Defold API.

The integrated anti-regression contract is relational rather than a frozen
route count. Source IDs and emitted IDs must be equal sets; every ID has exactly
one preferred selection and one universal base recipe; every structurally
compatible fact selects its specialization; rejected ASTs produce no facts;
and a same-revision, same-input specialization cannot silently fall back.

Clean-room evidence follows the same boundary. A generated semantic-fact
report can never select the source files used to regenerate itself. The dmSDK
clean room derives a conservative implementation-source closure from the
pinned SDK IR, copies the complete engine and SDK include closures used by the
compiler, and only then runs semantic extraction. Candidate additions,
removals, renames, and rejected translation units therefore change the proof
inputs without relying on a prior generated result. Extra candidate files are
safe and only increase proof cost; a missing candidate would be unsound.

Implementation observations are causal records, not bags of syntax. Calls
retain their resolved Clang declaration identity and signature; local values
retain initializers; operations and returns retain their controlling branches;
and helper traversal follows resolved call edges before using a leaf-name
fallback. A specialized recipe must join the facts that establish its contract:
the fixed digest extent reaches the helper that consumes the output and extent,
the Base64 capacity query controls the write/failure path of the selected codec
call, the ASTC minimum comes from the parser helper actually called by the
three-output wrapper, and the XTEA key capacity belongs to the called helper's
key copy, guard, and in-place data mutation. Unrelated calls, constants, arrays,
comparisons, dead helpers, and output writes are negative metamorphic fixtures
and cannot change pattern selection.

Defold implementation parsing reconstructs build-time include spelling without
shipping revision facts in the package. The package owns only the stable
`engine/<module>/src[/dmsdk]` layout recipe; each pinned revision supplies the
actual include names, source paths, and bytes. Those aliases are recursively
derived, content-addressed, and authenticated beside the source/TU identities.
Quoted module-relative includes are resolved through per-translation-unit
`-iquote` roots so they cannot shadow system headers. Generated protobuf/build
headers are mapped from pinned SDK bytes into their revision-owned virtual
build paths with an authenticated Clang VFS overlay; projected headers also
retain their recursively discovered source-local include closure. Large Clang
ASTs may be recovered with qualified-namespace filters, but a filtered or full
observation containing any compiler diagnostic cannot positively admit a
specialization.
Only stable include roots are passed to Clang: adding every header leaf is
forbidden because it can make a Defold header such as `dlib/math.h` shadow a
system header. A definition joins the public SDK declaration by exact mangled
symbol identity, or by an exact naturally included header location. The
frontend must not force unrelated public headers into a translation unit merely
because it contains a same-spelled call site.

Pattern selection is a compiler-owned phase, not an emitter side effect. The
bounded-span planner authenticates the ABI census, implementation-fact graph,
and five stable recipes; joins their structural and causal facts; and emits one
ranked decision per relevant declaration. Fixed digest, Base64, ASTC, XTEA, and
fixed-width hash emitters consume that decision and cannot invoke the selector
themselves. A separate value planner authenticates the same revision IR and ABI
census plus the scalar, enum, and named-scalar recipes, then owns all direct
primitive, declared enum-domain, and source-resolved alias selections. Those
three emitters likewise render assignments without importing the selector or
constructing a shadow registry.
The plan retains the complete rejection trace and universal fallback, so a
withdrawn source fact changes one explicit decision without suppressing the
public API. The same contract is the migration target for the remaining dmSDK
families: collect facts first, select once, then let each emitter render only
the declarations assigned to it.

Compiler-owned fact requests precede a plan without becoming a second
selection authority. The bounded C/C++ implementation collector consumes the
planner's exported structural candidate predicate; it neither carries a
private family catalog nor reads the final plan whose inputs it produces.
The borrowed-handle provider boundary has its own authenticated compiler-owned
plan over the complete global ABI envelope. That migration found eleven
lifecycle/refcount/state-transition routes inside the former "borrowed"
tranche and withdrew their specializations without removing their universal
APIs. The same plan now authenticates and joins the shared C++
ownership/effect artifact: 73 selected routes are source-derived and 74 retain
the explicit Defold public by-value-resource compatibility convention with
machine-readable proof gaps. A source-proof withdrawal changes only that
admission label; lifecycle/refcount contradictions still dominate and select
the universal route. The emitter never performs either selection.
The scratch scalar-out plan applies that extractor over the complete structural
envelope and is the sole selection authority consumed by the production
emitter. New admissions require diagnostic-free exact-one, success-written,
synchronous, non-escaping scalar slots. Atomics, spans, persistent rebinding,
owned-resource outputs, and exact-one scalar slots share the same raw ABI, so
scanning that broad shape alone remains insufficient evidence. A narrow second
admission preserves previously generated routes only when the revision-derived
`scratch-out-parameters` tranche and the same structural recipe still agree;
those rows retain their missing source facts as `evidenceGaps` and are never
reported as source-proven. This keeps an existing optimization while effect
recovery catches up, without creating a second selector in the emitter.

Generated-family census checks are structural, not optimization-count locks.
For a family report, `declarations.length` must equal the revision's
`coverage.structurallyEligible`; `coverage.discovered` and `coverage.emitted`
may be smaller when that revision cannot prove the specialized recipe. Those
remaining declarations must be represented by explicit policy blockers and
the universal implementation. This relation prevents an older revision from
being rejected merely because it supplies less optimization evidence, while a
missing structurally eligible declaration still fails closed.

The systemic plan-properties gate makes these relations executable for the
compiler-owned borrowed-handle plan. It checks the real current universal
corpus by declaration identity (1361 dispatchable raw calls; the remaining IR
rows are type metadata or intentionally hidden), authenticates the package
recipe and current policy, and asserts that selected/fallback totals and dense
selected ordering are complete. It also runs the same planner over every
revision identity in `defold-revision-matrix.json` using the current source
fixture as a revision envelope. Those cases prove that the planner does not
key its result to a revision string; the separate four-revision derivation
matrix supplies historical source evidence. Small
metamorphic cases then rename a contradiction-free route, add a structurally
valid route, and introduce an unresolved lifetime fact. Existing decisions stay
stable, totals change mechanically, and the unresolved route is retained by
the universal fallback. Source-proof withdrawal also preserves the explicit
compatibility route without relabeling it as source-derived.

# Claim protocol

Every material review claim follows `observe -> reproduce -> classify -> act`:

* **observe** records the exact generated symbol and provenance;
* **reproduce** uses the smallest compiling or executing fixture;
* **classify** distinguishes defect, intentional ABI detail, hardening idea,
  source ambiguity, and reviewer false positive;
* **act** changes code only for reproduced defects and adds the fixture as a
  regression test.

Examples from the adversarial audit:

* reproduced: vector generics were uncallable, a dmSDK overload collapsed,
  stale generated modules survived, normalized module names collided, browser
  booleans returned numbers, and symlinked extensions disappeared;
* rejected after reproduction: the installed npm tarball flow works end to end;
  callback self-release and slot reuse was safe in the current Hermes build;
  Defold's extension result enum genuinely offers only `RESULT_OK` and
  `RESULT_INIT_ERROR`;
* corrected rather than repeated: the exact inaccessible overload count was
  70 in the tested generator, not the review's 73;
* retained as an explicit coverage warning: 35 of 121 imported dmSDK headers
  contain Clang diagnostics in the current source-tree import, even though no
  declarations remain untyped. Packaged SDK re-import and platform-matrix
  conformance are still required before claiming full native compatibility.

# Completion gates

`typeSurfaceUnresolvedCount === 0` means every discovered position has a TypeScript
representation. It does not mean every opaque is usable or every call executes.
Intentional opaques, diagnostic-bearing source headers, runtime-pending calls,
linked symbols, and target conformance remain separate manifest counts.

The full API is resolved only when every public symbol has provenance, a
reviewed semantic token, generated target projections, and at least one
conformance disposition. Tree shaking may remove unreachable implementation
code from a release; it must never remove editor types or compatibility ledger
entries.
