---
type: Roadmap
title: Prove the npm package before tagging the consumer Action
description: An ordered release gate for an independent npm install, packaged Defold builds, and only then a tagged reusable workflow.
tags: [roadmap, npm, package, github-actions, release, consumer]
status: active
generated: { by: codex, at: 2026-10-12T16:00:00-04:00 }
sources:
  - id: package-smoke
    resource: ../../../tests/package-smoke.test.mjs
    title: Existing packed-package smoke
    author: project:deherm
  - id: consumer-workflow
    resource: ../../../.github/workflows/deherm-build.yml
    title: Reusable consumer build workflow
    author: project:deherm
  - id: package-manifest
    resource: ../../../package.json
    title: npm package manifest and prepack contract
    author: project:deherm
---

# Release order

The green source-workspace Action smoke is evidence that the reusable workflow
can build War Battles for `wasm-web` and `x86_64-linux` through Defold's hosted
Extender. It is **not** evidence that an independent developer can install the
unpublished npm package. The Action's tag is not the first release gate.

1. **Prove the exact npm tarball.** Run `npm pack` with its normal `prepack`
   hook, inspect the inventory and version-independent package boundary, then
   install the tarball in a temporary project with no symlink to the monorepo
   or its `node_modules`. Invoke its bin and exported modules. Assert the
   pinned Hermes public-header closure is present and target libraries and
   Defold-revision facts are not bundled.
2. **Prove an independent project.** From the installed tarball, create or
   configure a Defold project, resolve the published policy and tool artifacts,
   generate, type-check, compile, and Bob-bundle at least browser and one native
   target. Keep generation, compile, native link, and runtime observations
   separate. Do not substitute workspace links or contributor caches for this
   proof.
3. **Prove the release inputs.** Check package version/changelog/licensing,
   public artifact availability and integrity, package exports, and the
   publish workflow. Publish no npm version until the independent proof and
   repository gates pass. The release-candidate gate retains the **exact
   tested `.tgz`** beside a report naming its SHA-256 and clean source commit;
   publish that archive, not a newly packed approximation. A tag must
   reference the exact tested commit and package version.
4. **Then release the Action.** Publish the npm package, use a full commit SHA
   for the first external consumer smoke, and create a semantic `v0.1.0` tag
   only after that smoke passes. Call the reusable workflow and its required
   `action-ref` at the same immutable commit/tag. Marketplace listing and a
   moving `v0` alias are optional later steps, not prerequisites for direct
   GitHub `uses:` references.

# Evidence and open work

- `@ts-defold/deherm` is currently absent from the public npm registry; the
  README also labels it unpublished. A source-workspace `pnpm install` is not
  an external installation.
- The existing packed smoke extracts a tarball but symlinks the repository's
  `node_modules` and later symlinks the package into a project. It is useful
  materialization evidence but does not close item 1 or item 2 above.
- A local manual proof on 2026-10-12 packed `0.1.0` into a 934,335-byte archive
  (`sha256:e3513cfa61452e841b161d652e1021a01418eeaff9d7085e48c1771eeb4e488d`),
  installed it outside the monorepo without a symlink, scaffolded from the
  published policy, type-checked, and Bob-bundled `wasm-web` release JavaScript
  and `x86_64-linux` release Hermes bytecode. Hosted Extender jobs
  `job7886604478045212855` and `job143934541425965810` compiled and linked;
  no packaged game was executed. The scaffolded `^0.1.0` dependency still
  required installing the exact tarball because npm has no published version.
- `node scripts/prove-npm-consumer.mjs` and the manual
  `.github/workflows/npm-release-candidate.yml` now encode that clean-consumer
  sequence, check all declared exports/binaries against the tarball, retain the
  candidate archive, and run the full repository gate before the consumer
  proof. `node scripts/prove-npm-consumer.mjs --pack-only` checks inventory
  locally without a policy fetch or Extender upload; it is **not** a consumer
  build. The automated local rerun remains
  **unproven**: its networked browser/Linux Extender upload was rejected by the
  local approval guard because the prior upload approval covered an Apple test,
  not this payload. The workflow has not run in GitHub CI yet. Do not infer
  CI success or runtime success from the earlier manual builds.
- `node scripts/prove-npm-snake.mjs` copies only Snake's authored files to a
  temporary directory, installs the exact tarball without a workspace link,
  starts from an empty isolated déherm cache, resolves the policy/artifacts,
  generates its game-object script and HUD GUI proxies, release-type-checks,
  compiles the game resource, locally lowers native release Hermes bytecode,
  projects browser release JavaScript, and verifies generated files. The
  game-object script drives Defold sprite factories and sends status to the HUD
  via `msg.post`; GUI is not the board renderer. The 2026-10-12 isolated proof
  passed against tarball SHA-256
  `f35020aae07c0f531cd31a3e1e727055591b674896fc7ecef6e0109546db461f`
  (32,704-byte development bundle; 46,529-byte native release bytecode). A
  separate local Bob arm64-macOS debug bundle and engine launch activated both
  component instances without script errors. The Mac remained locked, so that
  launch is runtime-log evidence, **not visual/play-input QA**. The manual CI
  workflow runs the isolated proof before any hosted Bob build, then requires
  the Bob proof to repack to identical candidate bytes.
- On 2026-10-13, native Snake was visually inspected after a fresh local
  arm64-macOS Bob bundle. Its sprite board, head, body, food, HUD, and
  self-playing attract mode rendered; score advanced as the demo collected
  food. A first direction is coded to reset the demo into a fresh player
  match, with pure-rule tests for steering and wall avoidance. Synthetic
  keyboard events sent through the current computer-use surface did not reach
  even an independent raw-Lua input probe, so manual player-input QA is still
  outstanding. This is visual/runtime evidence for attract movement, not a
  claim that end-user keyboard input was observed.
- CI run `38300168673` passed the caller-policy plan and hosted browser/Linux
  War Battles bundles. Local-runner and external-Extender modes still need
  their own consumer evidence; authored Static Hermes application mode remains
  an explicit fail-closed gap.
- There is no npm publish workflow in `.github/workflows/` yet. The standalone
  WebTransport release workflow is a separate artifact and version boundary.

# Completion rule

Mark this roadmap complete only when a clean, tarball-installed consumer test
passes, a publishable npm release is built from the same tested commit, and a
tagged external-repository Action call succeeds. Record any unavailable target
as an explicit preview limitation instead of silently upgrading a narrower
smoke to a cross-platform release claim.
