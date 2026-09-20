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
class. They may ship with the npm package or release artifacts, but they are
toolchain artifacts rather than Defold API policy.

# Current executable cut

The authenticated `@compiler` subtree is now an **11,691-byte manifest**, not a
21 MB container. It references twelve independently content-addressed semantic
documents and 15 independently content-addressed compatibility sources. This
keeps each document shareable and makes the remaining migration debt
enumerable; it does not pretend the referenced bytes have disappeared. The
complete policy remains 28.29 MB until the lowering-plan and support-source
emitters below replace those objects.

`packages/compiler/src/policy-surface-materializer.mjs` owns the public
realization contract. It restores the selected revision, resolves and validates
the manifest's authenticated references, regenerates thirteen script and
dmSDK TypeScript files from IR, verifies their policy SHA-256 values, writes the
remaining support files from explicitly labelled authenticated compatibility
sources, and records a revision-keyed `surface.json` descriptor. The repository
generator owns extraction and policy production; it no longer owns consumer
emission.

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
| `defold-binding-lowering-plan.json` | 10,214,303 | copied derived aggregate | rebuild from normalized lowering recipes |
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
| `defold-binding-lowering-plan.sentinel.json` | 6,415 | copied output cache metadata | regenerate locally beside the plan |

The existing thirteen SDK renderers consume the two primary IR documents, the
handle-lowering report, and the script/dmSDK universal recipe catalogs. Six
support emitters now live in `packages/compiler/src/sdk/support-sdk.mjs`:
script handle-lowering types, script universal-value metadata, dmSDK universal
metadata, the dmSDK browser arena, script browser-target support, and dmSDK
scalar wrappers. That measured cut—not an assumption
about the old 21 MB blob—shows that the current locally rendered SDK can be
driven entirely by semantic documents already present in the policy. The other documents remain available because
`deherm generate` still consumes them; deleting them before their local recipe
emitters exist would create a smaller policy that cannot build a game.

# The SDK manifest

`@compiler.sdk` is a versioned `deherm.policy.sdk-manifest`. Its `entries` map
is keyed by a confined POSIX-relative `.ts` output path. Each entry carries:

* `mode`: `render-and-verify` or the temporary
  `authenticated-compatibility-source` migration mode;
* `sha256`: the digest of revision-abstracted output bytes;
* `recipe`: the exact package capability that realizes the entry;
* `inputs`: the compiler-document names consumed by a local renderer; and
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
digest. Thirteen files (3,784,443 bytes) are locally rendered; 15 files
(77,499 bytes) remain authenticated compatibility sources, and the test names
all 15 so migration debt cannot change silently. A second pass requires zero
writes, proving keyed idempotence. The materializer invokes no parser and reads
no Defold checkout.

The `<5 MB` compiler-object budget is enforced; the current manifest is 11,691
bytes. This is a structural transfer boundary, not yet a total-size victory.
The 10.21 MB canonical lowering plan is still a referenced derived output and
must be rebuilt locally from normalized recipe facts. The 15 support-source
objects must likewise be replaced by compiler-owned emitters. Those changes
will reduce total transfer size without changing the consumer contract; the
work is tracked in [#93](https://github.com/ts-defold/deherm/issues/93).
