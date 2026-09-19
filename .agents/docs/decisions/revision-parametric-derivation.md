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
`upstream.lock`, materialises `upstream/` for the revision being derived, and
runs the unmodified chain there.

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
environment so a stale export cannot license a different derivation, recorded to
a ledger the derivation reports, and never a substitute for the substantive
checks. Those run unchanged and against the revision being derived: the SHA-256
and anchors of every cited Defold source, the expected route and feature
censuses, the membership of every reviewed route id in the mechanically
discovered one. They read that revision's bytes, which a string comparison never
did.

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

Deriving Defold 1.13.1 (`574678c7`) from the current `dev` pin (`7f0f554f`) now
runs to a complete, reviewable answer instead of an assertion failure - and the
answer is that it is **not derivable**: **110 of 125 reviewed claims across 12
reviewed inputs do not hold**, 15 of them because the file does not exist at
1.13.1 at all. The whole `bullet3d` physics backend is one of those: it is
present on `dev` and absent from stable, so six reviewed inputs cite sources
1.13.1 does not have.

So the structural blocker is fixed and the substantive one is now visible and
attributed. Deriving a stable release from a `dev` pin is a real engine
difference requiring real review; deriving a revision whose declared surface did
not move is what the carry mechanism and the content-addressed store make cheap,
and is the steady state the nightly was designed for.

What is *not* established: nothing here re-reviews anything automatically, and
nothing here lets a stale review pass. A carried review whose evidence moved
still fails, at the evidence, with the file and both hashes named - which is what
happened on the 1.13.1 run and is the correct outcome.
