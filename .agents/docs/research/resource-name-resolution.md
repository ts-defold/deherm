---
type: Research Note
title: Resource name resolution from Defold project files
description: Defold declares every addressable name in protobuf text resources, so literal names passed to bindings can be resolved at compile time instead of failing silently at runtime.
tags: [research, defold, ttsc, compiler, diagnostics, language-service]
status: proposed
generated: { by: claude/opus-5, at: 2026-09-18T21:30:00-04:00 }
sources:
  - id: war-battles-resources
    resource: ../../../examples/war-battles-online/defold
    title: Observed declaration shapes in a real project
    author: project:deherm
  - id: hash-literals
    resource: ./compile-time-hash-literals.md
    title: Compile-time Defold hash literals
    author: project:deherm
---

# Finding

Defold resources are protobuf text format and readable. Every name a script can
address is declared in one of them. A binding call that passes a literal name is
therefore checkable at compile time, and today it is not checked at all: a typo
in `gui.get_node("backrop")` is a runtime error in a packaged engine, discovered
by a black screen.

# Declaration namespaces

| Resource | Declares | Example call site |
| --- | --- | --- |
| `*.input_binding` | action ids | `action_id === hash("fire")` |
| `*.atlas`, `*.tilesource` | animation ids | `sprite.playFlipbook(url, "rocket")` |
| `*.go` | component ids, component paths | `msg.post("#battle", ...)` |
| `*.gui` | node ids, texture, font, layer, layout names | `gui.getNode("backdrop")` |
| `*.collection` | instance ids | address literals |
| `*.material` | constant and sampler names | constant setters |
| `*.font` | font resource paths | GUI font references |

Observed directly in `examples/war-battles-online/defold`: `game.input_binding`
declares `action: "up"`; `tutorial-sprites.atlas` declares `id: "player-down"`,
`id: "rocket"`, `id: "explosion"`; `battle.go` declares `id: "battle"` with
`component: "/main/battle.gui"`.

# Why this is close to free here

Three pieces already exist:

* The binding IR classifies parameters by value shape, including `DefoldHash`,
  `DefoldAddressLiteral` and `DefoldUrl`. It knows *which arguments are names*.
* `inspectDefoldProject` already walks a Defold project and the component proxy
  generator already pairs a `*.gui.ts` component with its `.gui` scene, so the
  scoping information needed to resolve a node id is present.
* The ttsc transform is already enabled in generated projects and already does
  contextual literal analysis for `DefoldHash` lowering
  (`packages/compiler/ttsc/hash-literal/hash_literal.go`). The same checker
  position that decides to lower a literal can decide whether it resolves.

The missing piece is one field: a **resource namespace** on each name-shaped
parameter, saying which declaration kind the literal must resolve against.

# Proposed shape

1. Extend the parameter classification with `resourceNamespace`, derived
   structurally from the pinned API documentation rather than a symbol
   allowlist. Routes whose namespace cannot be determined carry an explicit
   unresolved marker and are never checked.
2. Generate a project **symbol table** from the project's protobuf text
   resources during `deherm generate`: namespace -> declared names -> source
   file and line.
3. Have ttsc resolve literal arguments at namespaced positions against that
   table and emit a TypeScript diagnostic on a miss, with the candidate list.
4. Expose the same table to the language service so the editor offers completion
   and go-to-definition into the `.go`, `.gui` or `.atlas` that declares the
   name.

# Scoping rules that must hold

* `gui.getNode` resolves against the specific `.gui` scene the component is
  attached to, not against every scene in the project. The proxy generator
  already owns that pairing.
* `msg.post("#component")` resolves within the owning game object; `"/instance"`
  resolves within the collection.
* Animation ids resolve against the atlas or tilesource bound to the sprite
  component being addressed, not against all atlases.

# Fail-open boundary

Only literal arguments are checkable. A name computed at runtime, read from a
property, or assembled from parts must pass without diagnostic. This check
tightens a case that is currently unchecked; it must never reject a legitimate
dynamic program. A miss on a literal is a diagnostic; absence of a literal is
silence.

# Secondary payoff

The same table supports the inverse direction: reporting declared names that no
code references, which is how dead GUI nodes, unused input actions and orphaned
animations accumulate in a project.
