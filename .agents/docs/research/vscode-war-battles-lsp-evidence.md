---
type: Research Note
title: Installed War Battles language-server and VS Code client evidence
description: Package-consumer protocol and actual VS Code renderer evidence for Defold semantic completion, live values, hover, definition, diagnostics ownership, and context-specific projections.
tags: [research, evidence, vscode, lsp, war-battles, diagnostics]
status: verified
generated: { by: codex/gpt-5, at: 2026-09-23T14:35:00-04:00 }
sources:
  - id: package-manifest
    resource: ../../package.json
    title: Published deherm package manifest and language-server entrypoint
    author: team:ts-defold
  - id: lsp-server
    resource: ../../packages/cli/src/lsp/server.mjs
    title: Editor-neutral LSP protocol server
    author: team:ts-defold
  - id: semantic-index
    resource: ../../packages/cli/src/lsp/resource-semantics.mjs
    title: Generated Defold resource semantic projections
    author: team:ts-defold
  - id: war-battles-symbols
    resource: ../../examples/war-battles-online/defold/.deherm/generated/resource-symbols.json
    title: War Battles generated Defold resource-symbol table
    author: team:ts-defold
  - id: lsp-tests
    resource: ../../tests/language-server.test.mjs
    title: Focused LSP protocol and route-scoping tests
    author: team:ts-defold
  - id: vscode-tests
    resource: ../../editors/vscode/test
    title: Thin VSIX client tests
    author: team:ts-defold
  - id: visual-evidence
    resource: ../../examples/war-battles-online/evidence/vscode-live-values.json
    title: Source-bound inline live-value observation
    author: team:ts-defold
  - id: visual-screenshot
    resource: ../../examples/war-battles-online/evidence/vscode-live-values.png
    title: Actual VS Code renderer capture
    author: team:ts-defold
---

# Observation

On 2026-09-23, the packed `@ts-defold/deherm@0.0.0` artifact was created with
`pnpm pack` and its `deherm-language-server.mjs` was run from an installed
package directory against a temporary consumer copy of the War Battles
generated symbol table. The server initialized and exited cleanly (exit code
0). The package tarball SHA-256 for the final visual observation was
`d1b3e7c487b1495884b774541344c454404fbf7853b7dc767ea6ca4a2497cdaf`.
The packaged thin VSIX SHA-256 was
`e0225916fa8b58938607e73ff0e85a4a10458abbe9748afafb3c19a0498f5a76`.

The protocol observation returned all of the following:

* `main/player.script.ts`: completion included `/arena#arena`; hover described
  it as the `arena` component on `/main/arena.go`; definition resolved to
  `/main/arena.go` line 2.
* `main/ui.gui.ts`: completion included `status` with `gui:node` detail; hover
  cited `/main/ui.gui`; definition resolved to `/main/ui.gui` line 69.
* A temporary render attachment projection derived from the same War Battles
  table: `render.enableMaterial("world")` completed `world` with
  `render:material` detail; hover and definition resolved to `/main/world.render`
  line 6. The project currently has no authored `.render.ts` component, so this
  is a route/context projection check, not a claim of a shipped War Battles
  render source file.
* Receiver-side project message literals now use the generated
  `projectMessages.receiver` projection: a canonical
  `hashLiteral("#add_score")` at an evidence coordinate offers only receiver-
  evidenced message ids, with hover and definition retaining the bounded
  sender/receiver evidence locations. An arbitrary `hashLiteral(...)` outside
  that coordinate remains empty.
* `textDocument/diagnostic` returned `-32601 Method not found`. This is the
  intended ownership boundary: the deherm server advertises completion, hover,
  and definition only; ordinary TypeScript diagnostics remain VS Code's
  built-in service.

Focused verification passed:

```text
/tmp/deherm-installed/node_modules/@ts-defold/deherm/bin/deherm.mjs typecheck --project examples/war-battles-online/defold
# ok TypeScript contexts: shared, game-object, GUI, render
pnpm test:lsp       # 12 passed
pnpm test:resource-names # 22 passed
pnpm test:vscode    # 15 passed
pnpm package:vscode # VSIX emitted, client-only manifest
git diff --check
```

On 2026-09-24 the distinct visual gate was recorded from an actual VS Code
1.129.1 renderer despite the macOS desktop remaining locked. An isolated VS
Code profile installed the packaged VSIX, the project-local package was the
exact `npm pack` artifact above, and the existing packaged arm64 engine was
launched with the active dev resource and inspector ports. The authenticated
state endpoint reported current-schema arena instance `0:1`, 39 projected live
instances, and zero omissions. The rendered editor displayed source-owned inlay
hints directly beside the four declarations in `main/arena.script.ts`:

```text
players: property.number(8),             = 8
botSkill: property.number(2),            = 2
mapSeed: property.number(0),             = 0
autoEngageSeconds: property.number(0),   = 0
```

The compact labels carry no duplicated property or instance text. Hover retains
the target, component, instance identity, property name, and any additional
live values.

The 2880x1800 renderer screenshot, exact inline texts, live values, source inputs,
package/VSIX digests, and screenshot digest are bound by
`vscode-live-values.json`. `pnpm runtime:vscode:check` revalidates that record
offline. This closes the literal VS Code presentation boundary; it does not
claim that a locked macOS display was unlocked or that hosted Extender produced
a new engine during this observation.

The receiver projection is intentionally narrower than sender projection: it
requires the generated static-evidence source, one-based line/column join, and
the canonical SDK `hashLiteral` wrapper. Missing, stale, dynamic, shadowed, or
unrelated receiver code therefore fails closed and does not create a diagnostic
or a broad project-wide message list.
