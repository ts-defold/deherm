---
type: Design and Verification Report
title: dmSDK bounded C-string arena wave
description: Generator-first production and exact-call adapters for the deterministic C-string subset of arena-backed spans.
tags: [research, bindings, dmsdk, arena, cstring, codegen, exact-call]
status: active
generated: { by: codex/gpt-5, at: 2026-09-21T12:00:00-04:00 }
---

# Outcome

The pinned dmSDK ABI census contains 79 `arena-backed-spans` declarations.
Five declarations previously classified as
`cstring-termination-or-capacity-policy` now have generated production C ABI
adapters and same-recipe exact-call twins:

1. `dmResource::GetCanonicalPath`
2. `dmStrError`
3. `dmStrTrim`
4. `dmURI::Encode`
5. `ResourceGetCanonicalPath`

Selection remains structural. Four exact ABI-shape recipes cover the five
declarations; the C and C++ canonical-path declarations share one recipe. The
generator verifies the pinned header text that defines each capacity,
termination, result-length, or bytes-written contract before emitting code.
There is no symbol allowlist in the selection step. The same structural
selection is joined to the revision-matched generated archive census; a row is
promoted only when it is header-only or externally linked in every target and
debug, release, and headless variant. The exact census content is hashed into
the family report.

The callable-route promotion joins those same five recipe identities into the
generated-adapter call index. The complete dmSDK release partition therefore
moves from 566 universal-ready, 59 generated-adapter, and 736
specialization-required recipes to 566, 64, and 731 respectively. Universal
recipe coverage remains 1,361/1,361 with zero silent omissions; the five
usage-materialized fallback recipes remain present as a fail-safe path.

The complete partition changed from 12 declarations covered by prior waves and
67 blocked declarations to 12 prior-wave declarations, five generated C-string
arena declarations, and 62 blocked declarations. The remaining exclusive
blocker counts are 33 handle/context, 19 record layout or borrowed lifetime,
six template element/specialization, and four opaque byte-pointee/lifetime.
Overlap and unaccounted counts are zero.

# ABI and scratch contract

The bridge accepts a counted input byte span and caller-owned output storage.
It rejects inputs above 4,095 bytes and output capacities outside 1..4,096,
rejects embedded NUL bytes, copies the input into a 4,096-byte thread-local
scratch array, and appends exactly one terminator. The validated input is fully
staged before output storage is cleared, preserving Defold-supported in-place
and partially overlapping calls such as `dmStrTrim(dst, size, dst)`. Generated
glue requires an in-bounds terminator after the call and clears the output and
result record on transport error, native error, or unterminated output.

The input scratch and output pointer are borrowed only for the synchronous
call. Generated code contains no heap allocation primitive. A thread-local
active guard rejects same-thread nested dispatch before shared scratch is
modified, so reentrancy cannot corrupt the outer call.

Each generated row now prefers the direct arena dispatcher after the generated
report, production implementation, and exact twin agree on its family-local
ID. The universal usage-materialized recipe remains in the catalog as a
fallback. Unsupported shapes remain specialization-required and are not
silently omitted.

# Verification boundary

`scripts/generate-dmsdk-arena-span-blockers.mjs` emits the report, public C
header, production source, and recording exact source in one pass. Both call
paths are rendered from the same shape recipe and ordered native call plan.
Focused tests compile the production calls against pinned SDK headers, compile
and link the exact twins with ABI-compatible fake callees, execute every vector
under AddressSanitizer and UndefinedBehaviorSanitizer, and cover same-buffer
and partial-overlap input staging, embedded-NUL failure clearing, plus
nested-dispatch rejection. Every successful vector checks native status,
visible output length, and required length; URI required length includes its
terminating NUL. A controllable `RESULT_TOO_SMALL_BUFFER` fake also proves that
native failure clears the complete output arena and result record. A clean-room
test reproduces all owned artifacts byte-for-byte and rejects source or symbol
evidence drift.

The authenticated generated-adapter corpus also covers all five family-local
IDs and binds their production dispatcher, native ABI, and shape mode to exact
vectors. A focused sanitizer harness runs 100,000 warmed dispatches while
counting C++ heap allocation and requires zero allocations.

This is exact bridge, source-ABI, and generated all-target archive-census
evidence. It does not claim packaged-engine behavior or browser/Static Hermes
projections.
