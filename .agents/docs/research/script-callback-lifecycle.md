---
type: Research
title: Generated script callback lifecycle frontier
description: Source-pinned lifecycle metadata and fixed-capacity ownership rules for all callback-shaped Defold script APIs.
tags: [research, generated, script-api, callbacks, lifecycle, memory]
status: active
---

# Generated script callback lifecycle frontier

`scripts/generate-script-callback-lifecycle.mjs` accounts for all 25 routes
classified as `callback-lifecycle` at the pinned Defold revision. A reviewed
policy file records the callback parameter, owner, invocation context, thread
affinity, lifetime, payload blockers, and exact source anchors for every route.
The generator rejects classifier, signature, source-hash, source-anchor, route
census, and stable-ID drift.

The current lifetime partition is 14 one-shot callbacks, four terminal-event
callbacks, five persistent replaceable callbacks, and two higher-order
closures. The first 23 can use the fixed-capacity lifecycle registry. The two
higher-order closures fail closed because returning or composing a Lua closure
requires a different ownership and invocation contract.

The registry is a structure-of-arrays generational pool layered over existing
rooted callback handles. Construction owns its fixed storage; retain, invoke,
cancel, owner cancellation, deferred reentrant release, and teardown have no
heap fallback. Leases bind runtime, slot, generation, owner, route, lifetime,
and owner-thread token. One-shot callbacks release after the first attempted
invocation, terminal callbacks release only on the terminal event, persistent
callbacks survive until replacement/cancellation, and teardown rejects new
retains.

Native tests cover one-shot, terminal, replacement, reentrant cancellation,
wrong-thread rejection, stale leases, teardown, closure rejection, and zero
observed C++ allocations after construction. The generated C++ table and
TypeScript file are metadata only. None of the 25 routes is promoted to the
executable accounting set until a generated route-specific engine adapter and
its callback payload codecs are wired and then observed independently.

The callback generator, reviewed policy, and four generated artifacts are part
of the central script pipeline registry. Clean-room regeneration includes the
23 pinned Defold source files and currently reproduces all 49 script artifacts
byte-for-byte.
