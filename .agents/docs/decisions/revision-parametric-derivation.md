---
type: Architecture Decision
title: Derive another revision in a scratch workspace, never in the checkout
description: The generated surface is written to fixed repository paths for one revision, so deriving another one happens in a materialised workspace whose committed surface is proven untouched, and reviewed inputs are audited against that revision before anything runs.
tags: [decision, generator, policy, derivation, reproducibility, ci]
status: accepted
generated: { by: claude/opus-5, at: 2026-09-19T12:00:00-04:00 }
sources:
  - id: layered-cache
    resource: ./layered-api-policy-cache.md
    title: Cache source-derived API policies in layers, keyed by content hash
    author: project:deherm
  - id: api-source-resolution
    resource: ./api-source-resolution.md
    title: Resolve API ground truth from the exact Defold engine SHA
    author: project:deherm
---

# Problem

The layered-cache decision says a revision nobody has seen before is not an
error state: "the user derives a policy from source once, and the sha-to-root
mapping that produces is exactly what would otherwise be published. Local
derivation and CI derivation are the same operation."

The nightly that was supposed to do this had never succeeded once. A dispatched
run found all three tracked channels and every derivation failed identically,
three lines into the chain:

```
AssertionError: borrowed-handle classification Defold revision drifted
  actual:   '7f0f554f41f9dce1e0ddff99bf08200657d1ee05'   upstream.lock's pin
  expected: '574678c7d44be490d874fbed2d0ae6211feec4d9'   the revision being derived
```

Two separate causes sat behind that one message.

**The surface has one address, not one per revision.** Every generator reads and
writes fixed repository paths - `packages/bindings/generated/…`,
`packages/sdk/src/generated/…`, the generated C++ under
`defold/defold_hermes/…` - and the whole of it describes exactly one revision.
Deriving another one therefore meant repinning `upstream.lock` in place and
regenerating over the top, which is what the job did as its first step. A
scheduled job was mutating the artifact `pnpm check` verifies, and a run that
failed anywhere after the repin left a checkout describing a revision nobody
chose.

**Reviewed inputs are bound to a revision, and correctly so.** The policies
under `packages/bindings/overrides/` are not configuration. Each is a record of
a person reading Defold's C source: which routes are borrowed-handle producers,
which documented routes the registration array comments out, which call shapes
overload dispatch may emit. Each names the revision it was read at, and each
generator refused to run for a different one. That refusal is what the
derivation hit.

# Decision

## Derive in a materialised workspace

`scripts/derive-revision.mjs` copies every tracked and every new non-ignored
file into a scratch workspace, symlinks `node_modules`, repins the workspace's
`upstream.lock`, materialises `upstream/` for the revision being derived,
downloads and digest-verifies that revision's published Defold SDK inside the
workspace, and runs the unmodified chain there. The SDK step is mandatory: the
source checkout does not contain generated DDF and third-party headers, and a
scratch derivation must not accidentally read the repository pin's SDK.

A scratch *output root* was the alternative and is worse. It would mean teaching
roughly thirty generators, three ownership registries, two clean rooms and a
content-addressed store about an output root none of them has, and a single
generator that missed the redirect would write into the committed surface
silently. A workspace makes the committed surface **unreachable rather than
merely unwritten**: no generator can address a path outside the tree it was
started in.

The chain, its order, the engine slice it needs and the paths it may write are
declared in that script, where `tests/revision-derivation.test.mjs` checks them
against the ownership registries. They used to be eight inline `run:` lines in a
workflow, where nothing could execute them and nothing could check them - which
is how the engine slice came to omit `packages/`, and with it the vectormath
archive the dmSDK importer needs. That omission did not fail: the importer
parsed on without it, so a CI derivation and a local derivation of the *same*
revision produced different policy roots.

Script SDK generation is deliberately two-pass. The semantic pass reads the
target revision's reference archive and emits its IR/types without consulting a
runtime-profile catalog. Source-derived registration, handle classification and
route availability are then regenerated for that revision; only after that does
the final SDK pass emit constants and modules. This prevents a previously pinned
revision's generated availability catalog from bootstrapping the next revision.

The canonical lowering plan is an optimization authority for the revision that
produced it, not an availability authority for every revision. Until a target
revision has its own canonical plan, typed-native generation intersects the
carried plan's selected stable IDs with that revision's generated universal
frames. Missing routes are recorded as declined and remain callable through the
baseline JSI bridge; a missing frame under a same-revision plan still fails
closed as internal drift.

Named build profiles may expose the same exact Lua function-presence vector in
one Defold revision. Runtime-profile generation groups those profiles by that
observable vector, emits the lexicographically first profile as the deterministic
detection representative, and conservatively removes feature-scoped handle
capture unless every equivalent profile agrees. Truly different matching vectors
remain an ambiguous, fail-closed runtime result.

The revision workspace regenerates the complete dmSDK binding pipeline, not only
the TypeScript SDK projection. After both dmSDK and script families exist, it
force-rebuilds the canonical lowering plan from those revision-local inputs and
reruns the typed-native and recording consumers before sealing the policy. A
policy may therefore never combine a new SDK IR with scalar/universal recipes or
a lowering plan inherited from the checkout's pinned revision.

## Prove the checkout did not move

The derivation fingerprints every repository path any generator in the chain can
write, plus `upstream.lock`, before it starts and after it finishes, and refuses
if a single byte moved. Restricting the fingerprint to those roots is the point:
a repository-wide `git status` would also see unrelated work in the checkout and
could neither prove nor disprove anything about this chain.

`--adopt` is a separate step that copies the derived surface back, and it
fingerprints first, so adopting is never how an accidental in-place write gets
laundered into a commit. It also refuses a blocked derivation outright, so a run
that could not derive cannot open a pull request carrying half a surface.

Deriving the **pinned** revision in a workspace reproduces the committed surface
byte for byte - zero differing files across 487 generated artifacts - which is
the control that makes the zero-disturbance result mean something.

## Compare a reviewed input against the revision being derived, not against a pin

The revision comparison is kept and made sharper.

Three of the six generators that read a revision-bound reviewed input were
taking the revision they *emit* from the reviewed file itself.
`generate-lua-registration-surface.mjs` was the worst case: it stamped its whole
report with whatever revision `lua-registration-surface-targets.json` named and
never compared that against anything, so a hand-edited file could decide which
revision a generated artifact claimed to describe. Every one of them now takes
the emitted revision from a **derived** input - the imported script API IR, or
`upstream.lock` - and puts the reviewed file through one shared rule.

That rule, `scripts/lib/reviewed-revision.mjs`, refuses exactly as before for any
ordinary generation, naming both revisions. The one thing it adds is that a
**declared derivation of one named revision** may carry a review forward, and a
carry is opt-in per invocation, scoped to the single revision named in the
environment so a stale export cannot license a different derivation, recorded,
and never a substitute for the substantive checks. Those run against the
revision being derived: the anchors of every cited Defold source, the expected
route and feature censuses, the membership of every reviewed route id in the
mechanically discovered one. They read that revision's bytes, which a string
comparison never did.

## A changed Defold source is a new policy entry, not a failure

**Superseded:** the SHA-256 of a cited Defold source used to be asserted, and a
drift aborted the generator that read it. That is backwards. This project is the
authoritative generator for what changes between Defold revisions, so Defold
editing its own C++ between two releases is the *input* to the job rather than a
failure of it - and gating on it meant the nightly produced nothing in exactly
the case it exists for.

The rule now: **the ABI is what is load-bearing, and a changed ABI is a new
policy entry for that revision** - so we know how to emit code for it, and so an
entry can be added, removed or swapped per version. It never blocks a release.
`scripts/lib/revision-audit.mjs` classifies each cited source and records an
audit line; `scripts/report-revision-audit.mjs` renders the audit into the CI job
summary. The three classifications:

| | what happened | what it does to what we emit |
| --- | --- | --- |
| `holds` | the file hashes to what the review recorded | nothing; the entry applies |
| `moved` | the file changed, every reviewed anchor survived | nothing; the entry applies and the audit carries the new hash so the pin can be restated |
| `void` | a reviewed anchor is gone, or the file is | the entry is **withdrawn for this revision** - routes it covered degrade to unreviewed |

Only `void` changes anything, because it is the only case where the evidence for
emitting is gone. A withdrawal is a per-revision policy difference that shows up
as a visible change in the derivation's pull request - the reviewable event - and
as queued review work named in the run summary. It is still not a build failure.

The same reasoning removed two smaller gates of the same shape, where the
*reporting mechanism* could fail a run: an unset carry ledger, and an unwritable
audit path. A report that cannot be written is a lost report.

## Audit every reviewed input before running anything

Each generator checks its own reviewed input and stops at the first failure,
which reports one moved file and says nothing about the other hundred.
`scripts/lib/reviewed-evidence.mjs` reads every `sha256` beside a `path` or a
`source` in every overrides file - the shape they all already use, so a new
reviewed input joins the census by being written normally rather than by being
added to a list somebody must remember - and checks the lot against the revision
being derived before any generator runs.

The census distinguishes three dispositions, and the distinction is the useful
part: a source that **does not exist** at that revision, a source whose content
moved but **every reviewed anchor survived**, and one whose anchors are gone
too. The first is a feature that does not ship there; the second is a confirming
read; the third is a real re-review.

# What this establishes, and what it does not

Deriving Defold 1.13.1 (`574678c7`) from the current `dev` pin (`7f0f554f`) is
the acceptance test for this decision. It now passes with the unchanged package
and compiler code. The derivation hydrated the exact historical SDK, ran all 19
dmSDK and 31 script generator steps, rebuilt the canonical lowering plan and its
typed-native/recording consumers, and emitted a 19.50 MB content-addressed policy
with 56 namespaces and 197 subtrees. The historical surface contains 1,336
dmSDK universal recipes with zero omissions; source drift withdrew specialized
lanes locally while preserving their universal fallback.

Policy-only materialization of that historical policy then wrote 20 semantic
documents, all 28 SDK files, and all 118 revision outputs without a Defold tree
or source archive. A second pass wrote nothing. The 28 SDK files and 118 outputs
matched the historical source-pipeline tree byte for byte; the 19 non-sentinel
IR documents were semantically identical after canonical JSON parsing. This is
the decisive two-revision proof: both the current revision and 1.13.1 are
derived and realized by one package/compiler implementation.

The proof does not promise that every future Defold edit is already understood.
It establishes the required failure boundary: authoritative declarations are
always projected through the universal recipe; a specialization whose reviewed
anchors, signature, linkage, or target support moved is declined and reported
for that declaration rather than blocking the revision. New ABI shapes may
require a future compiler capability, which is expressed by the policy's
minimum-realizer contract rather than by embedding revision facts in the npm
package.

Nothing here re-reviews anything automatically, and nothing here lets a stale
optimization claim pass. A review whose anchors are gone does not quietly carry:
its specialized entry is withdrawn and named. The declaration itself remains in
the mirrored API unless Defold removed it from the authoritative source.

## Availability-equivalent profiles are a normal revision result

A revision may make two named app-manifest profiles expose the same generated
Lua router surface. This does not make the API ambiguous: for every route the
router can call, the profiles agree. The handle-lowering generator emits an
equivalence class, chooses its lexicographically first profile as the
deterministic detection representative, and records a warning. Feature-scoped
handle capture is retained only when every profile in the equivalence class
agrees, so the fallback is conservative without making the whole revision
underivable. A later specialized distinction is optimization and capability
work, not a reason for the nightly to fail.

## A pinned canonical plan cannot block another revision

The recording engine consumes the repository-wide canonical lowering plan when
that plan names the revision being derived. When it does not, the recording
generator derives a conservative contract table directly from that revision's
script projection and universal binding catalog. Every route remains present,
the report marks `canonical-lowering-plan-revision-unavailable`, and recording
evidence is explicitly unverified for that revision. A missing optimized plan
therefore creates follow-up work; it does not suppress the API or stop the
nightly policy.
