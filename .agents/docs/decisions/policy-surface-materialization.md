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

The boundary check also parses the actual public runtime graph with the
package's JS/TS bundler. Every `exports` target and binary is an entrypoint; a
relative input that exists in the checkout but is absent from npm's inventory
is therefore a hard failure, as is any graph edge into `packages/generator/`
or `scripts/lib/`. The gate reads the exact `DEFOLD_REV` identity from
`upstream.lock` and rejects that exact byte sequence anywhere in the packed
files. The same gate rejects the 12-character display form and Base64 of the
20-byte revision identity, so shortening or binary serialization cannot turn a
revision-derived fact into package machinery. On 2026-09-24 the measured tarball contained 214 files; its 14 public
entrypoints reached 87 local runtime inputs, with zero omitted inputs, zero
repository policy-production inputs, and zero files containing the pinned
Defold revision.

The script and dmSDK SDK boundaries are physically split as well. The packed
`packages/compiler/src/sdk/*-sdk.mjs` modules export only deterministic
IR/model-to-source emitters. Archive parsing, checked-repository paths,
reviewed overrides, generated-file writes, and generator runners live in the
private `packages/generator/src/sdk/` modules used by repository command shims.
The inventory classifier gives those emitters an exact stable class, rejects
the private generator tree, and now fails when any packed path is unclassified;
package metadata and binaries are positive classes rather than implicit
exceptions. The focused export-shape test prevents a repository runner from
silently returning to the packed emitter modules.

# Current executable cut

The authenticated `@compiler` subtree is now a **67,380-byte manifest**, not a
21 MB container. It references 20 independently content-addressed semantic
documents, a 28-entry SDK manifest, and a 118-entry revision-output manifest.
Of those outputs, 12 are package-rendered and 106 remain compatibility sources.
This keeps each object shareable and makes the remaining migration
debt enumerable; it does not pretend the referenced bytes have disappeared.
The current reachable object graph is 25,078,691 bytes across 194 subtrees.
The 17,792,680-byte canonical lowering plan is already rebuilt locally from a
2,689,701-byte authenticated recipe-facts document. Twelve SDK support sources
and 106 revision-output compatibility sources remain to be replaced by compact
facts plus package emitters.

Schema-2 materialized surfaces authenticate policy-derived IR descriptor entries
against the authenticated `@compiler` document manifest and its
content-addressed object subtree, after separately checking the mutable
descriptor hash. The two lowering-plan outputs are the explicit derived
exception: package code regenerates them from the manifest's authenticated
recipe-facts entry. A route profile whose `defaultProfileId` was changed and
whose descriptor hash was edited to match is rejected as “not authenticated by
policy”. The focused materialization/client suite passes 16/16, and
`pnpm check:knowledge` passes its 15 OKF tests.

`packages/compiler/src/policy-surface-materializer.mjs` owns the public
realization contract. It restores the selected revision, resolves and validates
the manifest's authenticated references, regenerates sixteen script and
dmSDK TypeScript files from semantic documents or compact manifest facts,
verifies their policy SHA-256 values, writes 12 SDK support files and 106
revision outputs from explicitly labelled authenticated compatibility sources,
renders 12 revision outputs from package machinery, and records a revision-keyed
`surface.json` descriptor. The repository generator owns extraction and policy
production; it no longer owns the public materialization contract.

The compatibility snapshots are migration debt, not a claim that generated
source belongs in the final policy schema. Each becomes package-side emitter
code as its generator is extracted. The mode is recorded per file so local
generation and authenticated materialization cannot be conflated.

## Cache reopen authentication

A cached `surface.json` is an index and receipt, not an authority. Reopening a
materialized surface authenticates every SDK and repository-output path against
the compiler manifests sealed into the selected policy root. The filesystem
inventory must match exactly, symlinks and unsupported entries are rejected,
and every file is revision-abstracted before its content digest is checked.
Changing both a cached file and its mutable descriptor therefore cannot bless
the mutation.

The materialized IR retains the authenticated lowering-recipe facts. On every
cache reopen, package compiler code regenerates the lowering plan and sentinel
from those facts and compares the exact bytes. Toolchain facts are likewise
revision-abstracted, resealed, and compared with the policy root's
`@toolchain` object identity. Negative tests cover self-consistent descriptor
forgeries for SDK sources, repository outputs, toolchain facts, and both
lowering products. The focused materializer suite passes 4/4 and the broader
policy, hydration, revision, package-smoke, and materialization suite passes
100/100.

Realized surfaces are immutable directories below
`surfaces/<revision>/r/<realization-prefix>`. The 32-hex path component is a
local 128-bit addressing prefix; the descriptor retains the full 256-bit
identity, and readers recompute and compare that full identity before accepting
the directory. The shorter internal name keeps the measured default Windows
surface path below the classic path limit without weakening authenticated
identity checks.

The realization identity binds the authenticated policy root, policy generator
identity, installed package version, required capability set, and artifact
options. Materialization writes a unique short staging sibling, then atomically
renames the complete directory; only afterward does an atomically replaced
`current.json` select it for that revision. Concurrent writers authenticate and
reuse an identical winner, but never overwrite it. Dead-process staging
directories older than six hours are reclaimed across identities before a
retry. The age guard prevents a PID-namespace disagreement on a shared cache
from deleting a live writer. A replacement policy or artifact mapping publishes
a new sibling while the prior realization remains intact.

Cache reopening still performs full content authentication: immutable placement
prevents mixed publication, but is not treated as proof that local bytes were
not corrupted. If an existing immutable directory fails that same verifier, it
is atomically quarantined under `.bad-*` and rebuilt through staging. This makes
`deherm policy` a recovery path again without ever repairing or deleting an
immutable directory in place. The real-content test concurrently publishes one
policy through both writers, verifies the winning directory, reclaims an
abandoned stage, corrupts a generated SDK file, and proves the retry quarantines
and reconstructs the authenticated surface.

## Compiler document inventory

The manifest references these revision-derived documents. “Copied” means the
consumer currently materializes the document unchanged; it is not a claim that
the document is a minimal policy input.

| Document | Compact bytes | Current role | Required steady-state change |
| --- | ---: | --- | --- |
| `defold-binding-lowering-recipe-facts.json` | 2,560,034 | normalized source-derived lowering selections | package emitter rebuilds the plan byte-for-byte |
| `defold-dmsdk-universal-bindings.json` | 2,985,651 | copied recipe catalog | normalize catalog facts and emit locally |
| `defold-sdk-ir.json` | 2,706,350 | source-derived dmSDK semantics | retain as policy facts or normalize without loss |
| `defold-dmsdk-sdk-documentation.json` | 31,615 | source-derived dmSDK notes and deprecations | retain as policy facts; documentation must not enter runtime ABI identity |
| `defold-script-api-ir.json` | 1,350,464 | source-derived script semantics | retain as policy facts or normalize without loss |
| `defold-script-sdk-documentation.json` | 452 | source-derived script deprecations | retain as policy facts; documentation must not enter runtime ABI identity |
| `defold-script-route-availability-profiles.json` | 1,221,105 | copied derived profile product | rebuild from profile facts |
| `defold-script-handle-lowering.json` | 773,592 | emitter consumes only `handleKinds` | retain the 12,350-byte fact slice; rebuild the rest |
| `defold-script-api-accounting.json` | 742,371 | copied evidence report | keep in evidence/reporting, not realization input |
| `defold-script-universal-value-bindings.json` | 564,298 | copied recipe catalog | normalize and emit locally |
| `defold-dmsdk-scalar-thunks.json` | 80,331 | copied recipe catalog | normalize and emit locally |
| `defold-script-scalar-dispatch.json` | 50,068 | copied dispatch product | rebuild from route facts |
| `defold-value-layouts.json` | 8,074 | ABI/layout facts | retain as policy facts |
| `defold-component-proxy-contract.json` | 3,288 | lifecycle, proxy suffix, property, and resource facts | retain as policy facts; package owns only lowering recipes |

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

The existing sixteen SDK renderers consume the two primary IR documents, two
small documentation augmentations, the handle-lowering report, and the
script/dmSDK universal recipe catalogs. The documentation augmentations are
keyed by the same declaration IDs as the runtime IR and carry only fields that
affect generated TSDoc. Keeping them separate prevents an upstream prose change
from invalidating bridge descriptors or runtime evidence while still making a
policy-only client reproduce the exact SDK bytes and manifest digest. Six
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
Every other one of the 118 outputs remains explicitly classified as a
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
digest. Sixteen files (3,908,177 bytes) are locally rendered; 12 files
(105,573 bytes) remain authenticated compatibility sources, and the test names
all 12 so migration debt cannot change silently. A second pass requires zero
writes, proving keyed idempotence. The materializer invokes no parser and reads
no Defold checkout. The same test requires all 118 revision outputs (1,723,658
bytes) to match the source pipeline byte for byte: 12 package-rendered files
(5,372 bytes) and 106 authenticated snapshots (1,720,303 bytes).

The `<5 MB` compiler-object budget is enforced; the current manifest is 67,380
bytes. This is a structural transfer boundary, not yet a total-size victory.
The 12 SDK support-source objects and 106 revision-output objects must still be
replaced by compiler-owned emitters over compact semantic facts. Those changes
will reduce total transfer size without changing the consumer contract; the
work is tracked in [#93](https://github.com/ts-defold/deherm/issues/93).

This proves policy-only realization for the pinned Defold revision and, through
the independent Defold 1.13.1 derivation described in
`revision-parametric-derivation.md`, for a second historical revision using the
same package/compiler implementation. The historical policy reconstructed all
28 SDK files and 118 revision outputs byte-for-byte and reconstructed its 20
non-sentinel semantic IR documents equivalently. Routine revision changes therefore stay on
the policy side of the boundary; an actually new recipe capability remains the
explicit condition that can require a package upgrade.
