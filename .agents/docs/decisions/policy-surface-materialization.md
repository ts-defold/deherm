---
type: Architecture Decision
title: Materialize revision surfaces from policy plus the installed compiler
description: Defines the immutable compiler/runtime boundary, revision policy facts, project outputs, and the clean-machine reconstruction proof.
tags: [decision, generator, policy, compiler, sdk, distribution]
status: accepted
---

# Decision

`deherm policy` must do more than cache metadata. After authenticating a
revision's content-addressed objects it materializes the complete revision-keyed
surface consumed by `deherm generate`. A remote machine needs the npm package,
the published policy, and its own project/extensions. It does not need a Defold
source checkout, `ref-doc.zip`, or a previously generated SDK tree.

# Ownership boundary

| Installed npm package | Defold-revision policy | Project generation |
| --- | --- | --- |
| Parsers, policy schemas, generic identifier-safety rules, stable binding-identity algorithms, type/lowering recipe interpreters, code emitters, runtime templates, arena/scratch/callback/handle implementations, CLI/cache logic | Every fact defined by Defold: script and dmSDK declarations/docs, raw and public names, namespaces, semantic type vocabulary, registered routes, profile availability, source-backed semantic verdicts, deprecation/removal status, revision ABI/layout facts, and the recipe selections/parameters those facts require | Extension IR, selected target/profile, reachability plan, component proxies, extension bindings, emitted SDK/glue and final bundle |

The boundary is algorithm versus result. “Generate a borrowed-handle table” is
package code. The handle kinds and routes at one Defold revision are policy
data. Generic arena code is package code. The contracts using that arena are
policy data. Generated TypeScript, C++, and JavaScript are outputs. A package
emitter may know how to render a generic scalar, pointer, span, callback, or
borrowed-handle recipe. It must not contain a list of Defold module names, type
spellings, route names, context names, or rename decisions that can change when
Defold changes. Those are policy data even when they appear stable today.

# Realizer compatibility contract

Every published index entry and its authenticated policy root carry the same
realizer contract:

```json
{
  "minimumPackageVersion": "0.0.0",
  "requiredCapabilities": [
    "policy.compiler-surface.v1",
    "sdk.dmsdk.render.v1",
    "sdk.script.render.v1"
  ]
}
```

The small revision index is checked before the policy root or any subtree is
downloaded. If the installed `@ts-defold/deherm` is too old, or lacks a named
capability, the CLI stops with the installed version, required version, missing
capabilities, and an explicit package-upgrade command. After fetching the root,
the CLI requires its contract to exactly match the index; this prevents a
mutable index from weakening an authenticated policy requirement.

This is the release boundary:

* A normal Defold release changes policy data only. Nightly derivation publishes
  its new index/root/objects and every already-capable npm package can realize
  it without an npm release.
* An npm release is needed only when Defold exposes a construct the installed
  realizer cannot express, or when the generic compiler/runtime is improved.
  The new policy names that capability and raises its minimum package version.
* Capability identifiers are monotonic implementation contracts, not Defold
  version labels. They describe machinery such as a schema reader or lowering
  recipe family and never encode route, namespace, or type names.

Pinned host compilers and native Hermes libraries are a separate distributable
class. They never ship inside the npm package. Target-generated native config
such as `libhermesvm-config.h` belongs to the same archive as the library it
describes and is equally forbidden from the npm package. The CLI resolves the
matching host or Defold bundle-target archive from the release mapping
published beside the policy, downloads only that archive, and keeps it in the
platform-native per-user déherm cache. They are toolchain artifacts rather than
Defold API policy.

# Distribution boundary enforcement

`scripts/check-package-revision-boundary.mjs` inspects the file inventory npm
would actually pack, rather than inferring publication from workspace layout.
It also accepts an injected npm-inventory fixture so every classification can
be tested without changing the release manifest. A failure is one JSON report
whose `forbidden` object groups bundled policy/index objects, generated binding
IR and SDK/ABI output, legacy fixed module declarations, reviewed overrides and
probes, and revision-generated native, Static-Hermes, and web output.

Generated-looking files are not stable merely because their names have existed
for several releases. Exceptions are exact paths with package-side input
provenance. The dmSDK universal static-frame header, source, and Static-Hermes
transport are byte-reproduced from the compiler-owned bounded-frame emitter;
the empty project build-config skeleton and compiler/runtime component
capability header name their non-policy generators. An adjacent or newly named
`generated_*` file fails classification until equivalent provenance is added.
Generic compiler/CLI sources, runtime templates, and separately classified
toolchain assets remain package-owned, but those directory classifications are
evaluated only after all revision-output rules.

The repository's root `tsconfig.json` deliberately maps `@ts-defold/deherm`
and its generated module subpaths to the checkout's materialized SDK entry.
That alias exists only for source-checkout tests and examples. The published
package export remains the revision-neutral `package.ts`; consumer projects
receive revision modules through their generated `@deherm/project` surface.

# Current executable cut

The authenticated `@compiler` subtree is now a **64,441-byte manifest**, not a
21 MB container. It references 16 independently content-addressed semantic
documents, a 28-entry SDK manifest, and a 114-entry revision-output manifest.
Of those outputs, 12 are package-rendered and 102 remain compatibility sources.
This keeps each object shareable and makes the remaining migration
debt enumerable; it does not pretend the referenced bytes have disappeared.
The current complete object store is 32,019,304 bytes until the lowering-plan,
support-source, and revision-output emitters replace those objects.

`packages/compiler/src/policy-surface-materializer.mjs` owns the public
realization contract. It restores the selected revision, resolves and validates
the manifest's authenticated references, regenerates sixteen script and
dmSDK TypeScript files from semantic documents or compact manifest facts,
verifies their policy SHA-256 values, writes 12 SDK support files and 102
revision outputs from explicitly labelled authenticated compatibility sources,
renders 12 revision outputs from package machinery, and records a revision-keyed
`surface.json` descriptor. The repository generator owns extraction and policy
production; it no longer owns the public materialization contract.

The compatibility snapshots are migration debt, not a claim that generated
source belongs in the final policy schema. Each becomes package-side emitter
code as its generator is extracted. The mode is recorded per file so local
generation and authenticated materialization cannot be conflated.

## Compiler document inventory

The manifest references these revision-derived documents. “Copied” means the
consumer currently materializes the document unchanged; it is not a claim that
the document is a minimal policy input.

| Document | Compact bytes | Current role | Required steady-state change |
| --- | ---: | --- | --- |
| `defold-binding-lowering-recipe-facts.json` | 2,560,034 | normalized source-derived lowering selections | package emitter rebuilds the plan byte-for-byte |
| `defold-dmsdk-universal-bindings.json` | 2,985,651 | copied recipe catalog | normalize catalog facts and emit locally |
| `defold-sdk-ir.json` | 2,706,350 | source-derived dmSDK semantics | retain as policy facts or normalize without loss |
| `defold-script-api-ir.json` | 1,350,464 | source-derived script semantics | retain as policy facts or normalize without loss |
| `defold-script-route-availability-profiles.json` | 1,221,105 | copied derived profile product | rebuild from profile facts |
| `defold-script-handle-lowering.json` | 773,592 | emitter consumes only `handleKinds` | retain the 12,350-byte fact slice; rebuild the rest |
| `defold-script-api-accounting.json` | 742,371 | copied evidence report | keep in evidence/reporting, not realization input |
| `defold-script-universal-value-bindings.json` | 564,298 | copied recipe catalog | normalize and emit locally |
| `defold-dmsdk-scalar-thunks.json` | 80,331 | copied recipe catalog | normalize and emit locally |
| `defold-script-scalar-dispatch.json` | 50,068 | copied dispatch product | rebuild from route facts |
| `defold-value-layouts.json` | 8,074 | ABI/layout facts | retain as policy facts |

The lowering-plan cut replaces a 10,507,488-byte authenticated copy of the
derived aggregate with the 2,560,034-byte recipe-fact object above, a reduction
of 7,947,454 policy bytes (75.64%). The frozen old-pipeline plan itself is
16,750,538 pretty-printed bytes. `@deherm/compiler` owns the
`policy.compiler-document.binding-lowering-plan.v1` interpreter: it expands the
interned strings and object shapes, restores the historical property order, and
recreates those plan bytes exactly. The policy no longer contains either the
plan document or its checkout cache sentinel. Materialization creates both;
the sentinel key covers the package emitter bytes, source input hashes, and
source input paths, so an unchanged policy/compiler pair writes nothing while
an emitter or input-identity change gets a different key.

The existing sixteen SDK renderers consume the two primary IR documents, the
handle-lowering report, and the script/dmSDK universal recipe catalogs. Six
support emitters now live in `packages/compiler/src/sdk/support-sdk.mjs`:
script handle-lowering types, script universal-value metadata, dmSDK universal
metadata, the dmSDK browser arena, script browser-target support, and dmSDK
scalar wrappers. That measured cut—not an assumption
about the old 21 MB blob—shows that the current locally rendered SDK can be
driven entirely by semantic documents already present in the policy. The other documents remain available because
`deherm generate` still consumes them; deleting them before their local recipe
emitters exist would create a smaller policy that cannot build a game.

Three compact manifest recipes now replace SDK source snapshots:
`dmsdk/named-scalar.ts` carries only the emitted declaration count,
`script/url-target-support.ts` carries the route count and three target states,
and `script/value-target-support.ts` carries only browser-blocked route IDs.
The 12 remaining SDK snapshots are revision fact projections:
`dmsdk/{borrowed-handle,cstring-value,enum-value,scratch-scalar-out}.ts` and
`script/{callback-lifecycle,copied-value-record-blockers,dynamic-values,fixed-tuple-target-support,opaque-record-blockers,overload-dispatch-target-support,table-record-bindings,value-tail-target-support}.ts`.

`revision-output-emitter.mjs` is the exact package-owned output inventory. Eleven
entries are zero-input stable templates (JSI declarations, three Static Hermes
dispatch shims, and named-scalar empty-wave support); the universal dmSDK JSI
header is the twelfth and consumes only the authenticated catalog recipe count.
Every other one of the 114 outputs remains explicitly classified as a
revision-source snapshot until its semantic input projection is extracted; the
materializer does not infer stability from coincidentally unchanged bytes.

# The SDK manifest

`@compiler.sdk` is a versioned `deherm.policy.sdk-manifest`. Its `entries` map
is keyed by a confined POSIX-relative `.ts` output path. Each entry carries:

* `mode`: `render-and-verify` or the temporary
  `authenticated-compatibility-source` migration mode;
* `sha256`: the digest of revision-abstracted output bytes;
* `recipe`: the exact package capability that realizes the entry;
* `inputs`: the compiler-document names consumed by a local renderer; and
* `recipeInput`: optional compact revision facts for a local renderer; and
* `sourceObject` only for a compatibility source, naming its independently
  authenticated policy object.

The companion compiler-document manifest maps each confined `.json` name to
one authenticated object and repeats the selected recipe. The materializer
rejects unsafe paths, absent objects, kind/name mismatches, unknown recipes,
stale parallel recipe entries, undeclared inputs, source objects on locally
rendered files, and output digests that do not match. `assertNoRevisionLeak`
walks every sealed object, including both manifests and every referenced SDK
source. Policy production additionally requires snapshot digests to be
computed after replacing the Defold SHA with `${DEFOLD_REVISION}`, preventing a
revision-bearing source from leaking indirectly through its digest.

# Proven properties

`tests/policy-surface-materializer.test.mjs` materializes into a fresh temporary
directory and compares all 28 SDK files against size/SHA-256 evidence captured
from a frozen checkout-backed source-pipeline golden. Normal generation never
rewrites that fixture. Some source-pipeline and materializer emitters are
shared, so this is a regression oracle for accidental byte drift, not an
implementation-independent equivalence proof. A deliberate semantic change first regenerates
`packages/sdk/src/generated` through the source pipeline and then runs
`scripts/capture-policy-surface-old-pipeline.mjs --update`; the capture command
has a check-only default and records the Defold revision plus an aggregate tree
digest. Sixteen files (3,791,819 bytes) are locally rendered; 12 files
(78,435 bytes) remain authenticated compatibility sources, and the test names
all 12 so migration debt cannot change silently. A second pass requires zero
writes, proving keyed idempotence. The materializer invokes no parser and reads
no Defold checkout. The same test requires all 114 revision outputs (1,536,904
bytes) to match the source pipeline byte for byte: 12 package-rendered files
(5,385 bytes) and 102 authenticated snapshots (1,531,519 bytes).

The `<5 MB` compiler-object budget is enforced; the current manifest is 64,441
bytes. This is a structural transfer boundary, not yet a total-size victory.
The 12 SDK support-source objects and 102 revision-output objects must still be
replaced by compiler-owned emitters over compact semantic facts. Those changes
will reduce total transfer size without changing the consumer contract; the
work is tracked in [#93](https://github.com/ts-defold/deherm/issues/93).
