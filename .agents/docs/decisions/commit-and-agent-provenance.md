---
type: Decision
title: Git commits have one human author while the knowledge base may record agent provenance
description: Separate legal Git authorship from tool provenance in agent-facing Open Knowledge Format documents.
tags: [git, signatures, provenance, authorship, agents]
status: accepted
generated: { by: codex, at: 2026-09-20T02:00:00-04:00 }
---

# Decision

Every déherm Git commit is authored and committed only as
`Justin Walsh <contact.me@thejustinwalsh.com>` and carries his configured SSH
signature. AI systems, models, vendors, and agents never appear in Git
authorship, co-authorship, sign-off, or equivalent contribution trailers. They
hold no authorship, ownership, copyright, or contributor claim.

The Open Knowledge Format documents under `.agents/docs/` may retain
`generated.by` values naming the agent or model that produced the document.
That field is operational provenance for other agents. It is not Git
authorship, legal attribution, or a contribution claim.

# Enforcement

`scripts/check-commit-provenance.mjs` checks every locally reachable commit for
the exact human author and committer identity, a Git signature block, and the
absence of any secondary authorship, sign-off, or contribution trailer. It cryptographically verifies each commit
with `git verify-commit` against the repository's confined
`.github/allowed_signers` file; a signature header alone does not pass. The
`commit-provenance` workflow runs this check over the complete history on every
push to `main` and every pull request targeting `main`. GitHub's verified badge
is corroborating external evidence, not a substitute for the repository check.
