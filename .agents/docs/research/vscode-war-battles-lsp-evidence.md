---
type: Research Note
title: Installed War Battles language-server and VS Code client evidence
description: Package-consumer protocol evidence for Defold semantic completion, hover, definition, diagnostics ownership, and context-specific projections, with the remaining desktop visual limitation recorded explicitly.
tags: [research, evidence, vscode, lsp, war-battles, diagnostics]
status: active
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
---

# Observation

On 2026-09-23, the packed `@ts-defold/deherm@0.0.0` artifact was created with
`pnpm pack` and its `deherm-language-server.mjs` was run from an installed
package directory against a temporary consumer copy of the War Battles
generated symbol table. The server initialized and exited cleanly (exit code
0). The package tarball SHA-256 was
`8c7e5c3c98ba7f524b75e48fcb3c6babe1505a28140f5fed6004f44b95931a97`.
The packaged thin VSIX SHA-256 was
`e144fa30d7c6fbe134d395652545deae3fa01a0f24e8bfe19bd151bbf90fe51b`.

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

This evidence closes the installed protocol and route-projection portion of the
roadmap item. A distinct human-visible VS Code screenshot was not recorded: the
macOS desktop was locked, and native-app UI automation reported that it could
not unlock the display. No visual claim is made here; the literal VS Code visual
observation remains open until an unlocked Extension Host session can be
observed.

The receiver projection is intentionally narrower than sender projection: it
requires the generated static-evidence source, one-based line/column join, and
the canonical SDK `hashLiteral` wrapper. Missing, stale, dynamic, shadowed, or
unrelated receiver code therefore fails closed and does not create a diagnostic
or a broad project-wide message list.
