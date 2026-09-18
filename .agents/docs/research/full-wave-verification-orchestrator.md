---
type: Verification Design and Operations Guide
title: Full-wave evidence orchestration
description: Deterministic, evidence-separated verification for repository generation, compilation, linkage, runtime, engine, sanitizer, allocation, clean-room, and target claims.
tags: [research, verification, evidence, testing, clean-room, runtime]
status: active
generated: { by: codex/gpt-5, at: 2026-09-18T15:00:00-04:00 }
---

# Purpose

The full-wave verifier turns the repository's existing proof commands and
known gaps into one machine-readable matrix. It does not replace family tests,
reinterpret their output, or infer that a later stage passed because an earlier
stage passed. Generation, compile, link, runtime, packaged-engine, sanitizer,
allocation, clean-room, and target evidence are independent cells.

The checked plan is `verification/full-wave-matrix.json`. It covers the script
binding stack, dmSDK stack, component runtime, compiler/generated projects,
Static Hermes, War Battles Online, release projection, and the OKF knowledge
contract. Every row must define all nine cells.

# Evidence states

A cell has exactly one of two authorities:

- `command` runs one or more existing argv-based commands without a shell. A
  cell becomes `passed` only when every command exits successfully. The first
  failed command stops later commands in that cell, which are retained as
  `not-run-after-cell-failure`. Other matrix cells continue.
- `declared` must be `blocked`, `unavailable`, or `unobserved`, with a reason.
  Declared cells cannot contain commands and cannot predeclare a green state.

Cells omitted by focused mode or an explicit row filter become `not-run`; they
do not become passed. The overall outcome remains
`focused-commands-passed-with-evidence-gaps` or
`full-commands-passed-with-evidence-gaps` while any declared or unselected gap
exists. A command failure produces `failed`, but only after the complete matrix
has been collected and persisted.

# Running it

From the repository root:

```sh
node scripts/run-full-wave-verification.mjs --mode focused
node scripts/run-full-wave-verification.mjs --mode full
node scripts/run-full-wave-verification.mjs --mode full --row dmsdk-binding-stack
```

Focused mode runs the fast cross-section recorded in the plan. Full mode adds
native builds, broader family tests, Static Hermes, release staging, and the
more expensive clean-room checks. `--row` narrows execution for diagnosis but
leaves every excluded cell in the report as `not-run`.

The default output root is `build/evidence/full-wave`. Each run gets an
immutable `runs/<run-id>/matrix.json` and one log per executed command;
`latest.json` is atomically replaced after a completed run. Every command
record includes resolved executable, exact argv, cwd, timeout, timestamps,
duration, exit code, signal, timeout state, and an absolute log path. Logs and
matrix snapshots are written to a sibling temporary file and renamed, so a
reader never observes a partially written JSON document or log.

# Verification of the verifier

Run:

```sh
node --test tests/full-wave-verification.test.mjs
```

The tests use real child processes backed by a deterministic fake command. They
prove schema closure over all nine stages, rejection of declared green states,
per-cell fail-fast behavior, continuation into later cells and rows, focused
versus full selection, exact command/log metadata, absence of temporary-file
residue, atomic final/latest reports, and CLI failure only after the complete
matrix is available.

# Current evidence boundary

The verifier faithfully exposes repository state. It never edits stale
generated artifacts, repairs failed commands, launches unavailable target
runtimes, or converts host harness evidence into packaged-engine evidence.
During concurrent integration a focused run may therefore be red while its
orchestrator tests remain green; the failed command logs are the intended
diagnostic result, not a reason to rewrite the cell as unavailable or passed.
