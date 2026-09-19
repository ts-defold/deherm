---
type: Research Note
title: Upstream repositories and current revisions
description: Verified upstream locations, branch choices, and revision pins for Defold and Hermes.
tags: [research, upstream, defold, hermes]
status: draft
generated: { by: codex/gpt-5, at: 2026-09-17T00:00:00-04:00 }
sources:
  - id: proposal
    resource: https://x.com/tmikov/status/2095911349020700856
    title: Hermes preview repository proposal
    author: human:tmikov
  - id: meta-hermes
    resource: https://github.com/facebook/hermes
    title: Meta Hermes repository
    author: team:meta-hermes
  - id: defold
    resource: https://github.com/defold/defold
    title: Defold engine repository
    author: team:defold
---

# Findings

The baseline is `facebook/hermes` on `static_h`, which is the repository's
default branch and carries `project(Hermes VERSION 1.0.0)`, `tools/shermes` and
`$SHBuiltin`. It is Hermes 1.0 - one product, with `hermesc` and `shermes` as
two tools built from that single tree. The exact revision is recorded in
`upstream.lock` and must be used instead of a floating clone.

No other Hermes line is tracked. `facebook/hermes` `main` carries
`project(Hermes VERSION 0.12.0)`, has no `tools/shermes` and no `$SHBuiltin`,
and has diverged from `static_h` rather than being its ancestor; treating it as
the mainline is a live source of confusion and it is deliberately absent from
`upstream.lock`. `tmikov/hermes` is likewise untracked.

Defold's `dev` branch is its current development head. The spike consumes source
for architecture research and SDK alignment; it should avoid carrying a forked
engine until a native extension can no longer prove the required behavior.

# Branch intent

| Project | Remote | Branch | Role |
|---|---|---|---|
| Defold | `defold/defold` | `dev` | Current engine and SDK surface |
| Hermes | `facebook/hermes` | `static_h` (default) | Hermes 1.0: the runtime, `hermesc`, and `shermes` |

# Refresh policy

Pins change only through an explicit refresh command and a reviewed knowledge
log entry. Hermes moves only along `static_h`, the repository default and the
1.0 line; no other branch or fork is a candidate.
