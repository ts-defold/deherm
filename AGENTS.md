# Repository instructions

This repository builds **déherm**, a deterministic TypeScript binding compiler
and Hermes runtime integration for Defold.

## Knowledge base

- The canonical Open Knowledge Format bundle is `.agents/docs/`.
- Start with `.agents/docs/index.md`, then follow its architecture, decisions,
  research, roadmap, evidence, and log links.
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
