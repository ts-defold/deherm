---
type: Architecture Decision
title: Generate, report, open issues - a generator never refuses
description: Every documented route is emitted. A route the generator cannot verify ships marked unverified, with a generated test, an issue, and a doc annotation, because a refusal tells a user nothing and costs hand-written code at every Defold release.
tags: [decision, generator, policy, verification, derivation, product]
status: accepted
generated: { by: claude/opus-5, at: 2026-09-19T14:00:00-04:00 }
sources:
  - id: revision-parametric
    resource: ./revision-parametric-derivation.md
    title: Derive another revision in a scratch workspace, never in the checkout
    author: project:deherm
  - id: generator-product-contract
    resource: ./generator-product-contract.md
    title: What the generator promises
    author: project:deherm
---

# Problem

This is a code-in, code-out generator: Defold's own source is the input and
TypeScript bindings are the output. Defold changing that source between releases
is therefore the job, not a failure of it.

The repository had drifted a long way from that. Generators refused when a cited
source's SHA-256 moved, when a reviewed count disagreed, when a cited file did
not exist, when two inputs carried different revision stamps. Deriving Defold
1.13.1 - a stable release - found **18 of 28 script-generation steps refusing**.
None of the eighteen was a type we could not map or a shape we could not lower.
Every one was a fact about the pinned revision encoded as an invariant.

Two properties made this expensive rather than merely wrong.

It was **invisible**. Nothing in `pnpm check` could find it, because `pnpm check`
generates the one revision every pinned assumption was written against. The
refusals surfaced one per nightly run, weeks apart, each costing a round of
hand-written code - which is the definition of unmaintainable for a tool whose
whole purpose is to absorb upstream change.

And it **told a user nothing**. A refusal is not a finding. "We declined to bind
this" and "we did not notice this" and "this is broken" all present identically:
the route is simply absent, with no way for anyone to discover why, report a
problem, or use the thing anyway.

# Decision

**Generate, report, open issues if needed.** That is the whole pipeline. When a
bug is found, fix the generator and regenerate.

Concretely, and in order of what it forbids:

**1. Never exclude a documented route.** Everything Defold documents is emitted.
There is no "we decided not to bind this" - a decision like that is invisible to
the person holding the API, and it is the judgement most likely to be wrong.

**2. Emit a test with every route.** The generator that emits a binding emits
the thing that exercises it. Verification is a derived property, not a
hand-maintained list.

**3. A failing test marks, it does not remove.** The route ships `unverified`,
an issue is opened for it, and its TypeScript documentation carries the
annotation and the issue link. A user can call it, find out, and report into the
issue that already exists. The finding is codified where the next person will
look, instead of being rediscovered.

**4. A generator failure means the GENERATOR is broken.** It is never a
statement about the API and never a reason a release is blocked. This is the
rule that makes the other three enforceable: if refusing is always a bug in us,
there is no temptation to reach for it when the engine surprises us.

## What may still be fatal, and why it is consistent

Two things, and both are cases of rule 4 - the generator, or the tree it
generates, is provably broken:

* **Internal consistency.** One of our artifacts checked against another - the
  binding patterns against the IR that produced them. A disagreement means a
  half-written intermediate, which is true at any revision.

* **An ordinary generation disagreeing with its own reviewed evidence.** At the
  pinned revision nothing about Defold moved, so a count that does not match is
  a regression in this tree. Inside a declared derivation of another revision
  the same comparison only says Defold changed, which is the measurement being
  taken, so there it is reported instead.

Neither is a judgement about the engine. Both say our own output is wrong.

# Consequences

**Verification is published, and its default is that the route works.** Defold
maintains this engine, documents its Lua API and registers it; that is the
product's contract and it is the overwhelming majority of the surface. Our own
execution evidence is a bonus on top, never the bar for shipping something
unmarked. The three statuses are `supported` (Defold documents and registers
it - no mark, no issue), `executed` (additionally observed running in a real
engine here) and `suspect` (our own evidence CONTRADICTS the documentation:
registered nowhere, or exercised and a property did not hold).

Only `suspect` earns a mark and an issue, and there are a few dozen. An earlier
version of this had the default inverted and labelled 450 routes "untested",
which says nothing true about the route and something untrue about the product.
Where we have not executed a route, that is recorded as a note about OUR
harness - a to-do list for us - and is not published as a caveat on the API.

**Upstream bugs become our data.** `engine/engine/src/script/script_engine.cpp`
documents `@name sys.set_render_enable` and registers
`{"set_render_enabled", EngineSys_SetRenderEnabled}` - the documented name is
missing a letter. Under the old model we emitted the broken name, omitted the
working one, and nothing said so. Under this one both observations are reported
and the mismatch is an issue with a source line in it.

**The measurement has to exist.** `scripts/check-cross-revision-derivation.mjs`
derives a control revision that is deliberately not the pinned one and reports
every step that refuses, with a baseline that only goes down. Without it this
decision is an intention; with it, it is enforced on the change that breaks it
rather than a fortnight later.

**Categories must be derived, not listed.** A hand-written set of "routes that
are not callable" is the same defect in miniature: it needs editing whenever
Defold adds one. Where the evidence to derive a category exists, it is used -
`declaredButUnregistered` in the registration surface, for instance, already
answers "is this registered anywhere" and was going unread.

# What this does not license

It does not license guessing. A route whose semantics nobody has established
ships as `unverified`, which is an honest statement, not a silent claim that it
works. Reviewed human judgement still scopes what it was read against, and
evidence that no longer holds withdraws that judgement for that revision - it
just never stops the run.
