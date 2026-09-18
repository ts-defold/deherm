---
type: Research Note
title: Runtime log harvesting and the deduplicated bug pool
description: One shared rejected-diagnostic classifier, a normalized-signature harvester over dev session logs and packaged transcripts, and the evidence boundary that keeps the pool out of conformance rows.
tags: [research, tooling, dev-loop, diagnostics, evidence, hermes, defold]
status: verified
generated: { by: claude/opus-5, at: 2026-09-18T00:00:00-04:00 }
sources:
  - id: dev-session-log
    resource: tests/fixtures/dev-session-war-battles.log
    title: Verbatim excerpt of the recorded déherm development session log, 2026-09-18
    author: tool:deherm-dev
  - id: shared-classifier
    resource: packages/cli/src/dev/runtime-diagnostics.mjs
    title: Shared rejected-diagnostic classifier and signature normalizer
    author: team:deherm
  - id: harvester
    resource: packages/cli/src/dev/bug-pool.mjs
    title: Runtime bug-pool harvester, recorder, and pool document
    author: team:deherm
---

# Runtime log harvesting and the deduplicated bug pool

## Problem

Real defects were already being written to disk and nothing read them.
`deherm dev` writes every engine, Bob, resource-server, and dev-loop line to
`<project>/.deherm/dev/session.log`, and the packaged runtime harness captures a
full engine transcript. Both were discarded: the session log is truncated at the
start of every session, and the packaged transcript survives only as a SHA-256
digest inside the evidence document. A hand grep of one recorded session found
two genuine defects in minutes.

## Shared classification

`REJECTED_DIAGNOSTICS` previously lived inside the War Battles packaged-runtime
harness, so its definition of "this output is a defect" applied to exactly one
harness's own runs. It now lives in `packages/cli/src/dev/runtime-diagnostics.mjs`
and is consumed by three callers:

* the packaged-runtime evidence gate, which still scans a whole transcript in
  declaration order via `firstRejectedDiagnostic`;
* the development loop, which classifies each emitted event as it happens;
* the harvester, which classifies a stored log line by line.

Whole-transcript scanning and per-line classification want different orders.
`error-severity` matches almost every line the engine prints once something has
already failed, so `classifyDiagnosticText` walks a specificity order
(`bundle-rejected`, `missing-lua-provider`, `component-runtime-unavailable`,
`script-error`, `lua-traceback`, `fatal-severity`, `error-severity`,
`javascript-failure`) while `REJECTED_DIAGNOSTICS` keeps its declaration order
for the gate. The families themselves are unchanged, so the packaged gate's
behaviour is byte-identical.

## Normalized signatures

Occurrences group by a signature computed from the classification, the
normalized opening diagnostic, and the normalized stack frames. Normalization
strips ISO timestamps, wall-clock times, hex addresses, IPv4 addresses, pids,
ports, generation numbers, digests and trace ids, absolute directory prefixes
(the basename is kept, because it discriminates), line/column offsets, and
numeric runs of three digits or more. The same defect therefore collapses to one
entry across many runs and across machines.

Re-harvesting is idempotent: an occurrence whose timestamp already falls inside a
signature's observed `[firstSeen, lastSeen]` window is a re-read of output
already pooled. Occurrences arrive in time order, so the only thing this
collapses is two sightings of one defect inside the same millisecond.

## Fail-open and bounded storage

An `ERROR`-level line that matches no family is pooled as `unclassified`. The
whole point of the pool is catching what was not anticipated, so nothing is
dropped for being unrecognised. Stored occurrences per signature are capped
(default 5, first sighting always retained) while `occurrenceCount` keeps the
true total, so one noisy defect cannot grow the pool without bound.

## Defects the recorded session produced

A live `<project>/.deherm/dev/session.log` is truncated at the start of every
session, so the excerpt that produced these findings is pinned as
`tests/fixtures/dev-session-war-battles.log`. Harvesting it yields four
signatures, including the two found by hand:

* `ERROR:SCRIPT: Structured Lua call has no captured Defold instance`, classified
  `error-severity`, source `engine`, with frames `at post
  (deherm:///deherm/app.dehermc:957:38)` / `at final` / `main/player.script:32`.
  The harvester resolves the source location to the authored script rather than
  the generated bundle offset. `msg.post` from a component's `final()` fails
  because the Lua instance is detached before `final` runs.
* A repeated `build-failed` whose recorded trigger is
  `["README.md", "README.md.tmp.<pid>.<digest>"]`. The watcher scheduled a
  TypeScript rebuild on prose and on an atomic-write scratch file that had
  already been renamed away - a self-inflicted build failure. Fixed in the same
  change: `createWatchPathFilter` drops every atomic-write scratch name
  (`*.tmp`, `*.tmp-<pid>[-<digest>]`, `*.tmp.<pid>.<digest>`,
  `*.deherm-tmp-<pid>[-<sequence>]`, editor scratch and backup names), and the
  dev session filters documentation-only batches out before requesting either a
  TypeScript or a Defold build.

## Evidence boundary

The pool records how déherm itself behaved during runs. It is not conformance
evidence, it proves nothing about API coverage or lowering correctness, and a
pool entry must never be promoted into a
[full-stack completion matrix](full-stack-completion-matrix.md) row. Generation,
compilation, linkage, runtime, packaged-engine, sanitizer, and allocation
evidence stay separate from it; the pool document carries that statement in its
`note` field and the CLI prints it on every report.

## Surfaces

* `deherm bugs [--project <path>] [--pool <path>] [--session-log <path>]
  [--transcript <path>] [--no-harvest] [--json]` harvests and prints the pool.
  It is a reporting surface, never a gate, and always exits 0.
* `deherm dev` records into `<project>/.deherm/dev/bug-pool.json` as it runs, so
  the pool accumulates during normal development rather than only on demand.
* `examples/war-battles-online/integration/check-packaged-runtime.mjs` harvests
  its transcript on both success and failure without changing the gate outcome.
* `bugPoolDocument` output is deterministic and sorted by signature, so the TUI
  or any other consumer can read the JSON directly.
