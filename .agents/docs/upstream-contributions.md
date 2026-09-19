---
type: Engineering Process
title: Upstream contribution policy
description: Turn genuine integration defects into small, reproducible, well-tested Static Hermes or Defold pull requests.
tags: [process, upstream, static-hermes, defold, pull-request]
status: active
generated: { by: codex/gpt-5, at: 2026-09-17T00:00:00-04:00 }
sources:
  - id: hermes-contributing
    resource: https://github.com/facebook/hermes/blob/static_h/CONTRIBUTING.md
    title: Hermes contributing guide
    author: team:meta-hermes
  - id: defold-contributing
    resource: https://github.com/defold/defold/blob/dev/CONTRIBUTING.md
    title: Defold contributing guide
    author: team:defold
---

# Policy

Open upstream pull requests when the Defold integration exposes a general
Static Hermes, Hermes, or Defold defect or missing capability. Do not carry a
project-local workaround by default when the correct fix belongs upstream.
Likewise, do not open speculative PRs: a repository idea becomes an upstream
change only after the pinned source reproduces the problem.

Every PR must have one coherent purpose and include:

1. the smallest standalone reproducer, reduced from a real generated binding
   or application case;
2. the observed diagnostic, crash, invalid output, or unsupported construct,
   plus the expected behavior and language/ABI rationale;
3. a regression test in the upstream project's native test framework;
4. the smallest implementation change that fixes the root cause;
5. local results for the focused test and the relevant upstream suite;
6. before/after compiler output or a benchmark when behavior or performance is
   involved;
7. release-note or documentation updates when users can observe the change.

Avoid mixed refactors, generated noise, formatting churn, unrelated dependency
updates, and Defold-specific names in a generally useful compiler fix. Preserve
authorship and follow the upstream contribution guide, commit conventions, and
review feedback.

# Triage ledger

Record candidates here before opening external state:

| Candidate | Upstream | Reproducer | Status |
| --- | --- | --- | --- |
| Function-expression and arrow return annotations remain TS nodes after TS2Flow | Static Hermes | `test/AST/ts2flow/function-expression-return-types.ts` fails at pinned `4947871` and passes with commit `dcd175842` | [draft PR #2188](https://github.com/facebook/hermes/pull/2188); Meta CLA action required |
| `PassManager.h` uses `std::vector` without including `<vector>` | Hermes | Android NDK r25b compile at pinned `dcd175842` fails in `PassManager.cpp`; `toolchains/hermes/patches/pass-manager-vector.patch` supplies the direct include | Reproduced in [CI run 35465650406](https://github.com/ts-defold/deherm/actions/runs/35465650406); local patch carried pending upstream submission |

`pass-manager-vector.patch` is intentionally context-sensitive and the Android
image applies it with `git apply --check`. Every `HERMES_REV` change therefore
requires an explicit rebaseline: remove the patch when the new revision already
contains the include, or refresh its context and rerun the Android lane when it
does not. A revision bump must never weaken that failed-apply signal.

When a candidate appears, add its reduced fixture under the repository tests,
record the pinned upstream revision, and verify that it fails without the patch
and passes with it. Link the eventual issue or PR from this ledger and the
knowledge log.
