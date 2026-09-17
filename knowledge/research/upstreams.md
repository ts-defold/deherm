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
  - id: tmikov-github
    resource: https://github.com/tmikov?tab=repositories
    title: Tzvetan Mikov GitHub repositories
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

As of 2026-09-17, `https://github.com/tmikov/hermes-preview` returns
"repository not found." The referenced post says a new repository will be
created, probably under that name; it does not say one already exists.[^proposal]

The reproducible baseline is therefore Meta's `static_h` branch. The exact
revisions discovered with `git ls-remote` are recorded in `upstream.lock` and
must be used instead of a floating clone.

Tzvetan Mikov's existing `tmikov/hermes` fork defaults to `hermes-x`, but it is
not the promised `hermes-preview` channel. Treat it as research input, not the
build baseline, until its intended stability and deltas are reviewed.

Defold's `dev` branch is its current development head. The spike consumes source
for architecture research and SDK alignment; it should avoid carrying a forked
engine until a native extension can no longer prove the required behavior.

# Branch intent

| Project | Remote | Branch | Role |
|---|---|---|---|
| Defold | `defold/defold` | `dev` | Current engine and SDK surface |
| Hermes | `facebook/hermes` | `static_h` | Native runtime plus Static Hermes research |
| Hermes | `facebook/hermes` | `main` | Reference for released/runtime differences |
| Hermes fork | `tmikov/hermes` | `hermes-x` | Preview-adjacent research only |

# Refresh policy

Pins change only through an explicit refresh command and a reviewed knowledge
log entry. If `tmikov/hermes-preview` appears, compare it against the pinned
Meta revision before switching; preview features must not silently become core
dependencies.

[^proposal]: Tzvetan Mikov's public post proposing a higher-velocity preview repository.
