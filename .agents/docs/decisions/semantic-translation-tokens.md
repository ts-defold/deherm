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
