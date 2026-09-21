# Repository instructions

This repository builds **déherm**, a deterministic TypeScript binding compiler
and Hermes runtime integration for Defold.

## Knowledge base

- The canonical Open Knowledge Format bundle is `.agents/docs/`.
- Do not preload the knowledge base or recursively follow the index. Search it
  with `pnpm knowledge:search -- <terms>`, then open only the matched documents
  and sections needed for the current task. The search command intentionally
  returns a small, bounded result set so repository history does not poison the
  working context.
- Inspect a matched document with
  `pnpm knowledge:outline -- <relative-document.md>`, then retrieve only the
  needed section with
  `pnpm knowledge:section -- <relative-document.md> <heading terms>`.
- The disposable SQLite graph lives below `.deherm/cache/`; use
  `pnpm knowledge:sql -- <read-only-query>` for unusual joins. Query results are
  bounded, and the cache is never an authority or correctness dependency.
- Read `.agents/docs/index.md` only when navigation or bundle structure is the
  task. Read large generated policy/evidence files through their owning summary
  or verification commands; do not dump them into agent context.
- Put new project knowledge under `.agents/docs/`.
- When behavior, evidence, or an architectural decision changes, update the
  relevant OKF document in the same change. Run `pnpm check:knowledge`.

## Generated code and evidence

- Do not hand-edit generated bindings. Change their declared inputs, policies,
  or generators, then regenerate.
- Keep generation, compilation, linkage, runtime, packaged-engine behavior,
  sanitizer results, and allocation evidence separate. Never promote one stage
  from evidence belonging to another.
- Defold and Hermes ground truth is pinned by `upstream.lock`; preserve exact
  identities, revisions, and clean-room reproducibility.
- Prefer structural value-shape/effect rules over symbol or route allowlists.
  Unsupported cases must fail closed with machine-readable blockers.
- Product examples and game-specific probes consume generated bindings; they
  must not be inputs to the core binding generator or its clean-room graph.

## Verification

- Use `pnpm check` for generated-state, type, clean-room, and OKF checks.
- Use focused runtime and sanitizer scripts from `package.json` for changed
  native families; passing metadata tests alone is not runtime evidence.
- Preserve unrelated user changes and keep target-specific capability gaps
  explicit in the canonical lowering plan and `.agents/docs/`.

## Human authorship and agent provenance

- Git commits are authored and committed only as
  `Justin Walsh <contact.me@thejustinwalsh.com>` and must carry his configured
  SSH signature.
- Never add an AI system, model, vendor, or agent through `Co-Authored-By`,
  `Signed-Off-By`, `Authored-By`, or any equivalent Git attribution trailer.
  Agents hold no authorship, ownership, copyright, or contributor claim.
- Agent provenance is permitted in the Open Knowledge Format `generated.by`
  metadata under `.agents/docs/`. That metadata records which tool produced a
  knowledge artifact; it is not Git authorship or a legal contribution claim.
- Run `node scripts/check-commit-provenance.mjs` before pushing. Do not bypass a
  provenance failure by changing or weakening this policy.
