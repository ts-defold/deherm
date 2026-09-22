---
type: Research Note
title: Resource name resolution from Defold project files
description: Defold resource declarations and separate project-authored message evidence feed one deterministic symbol table without pretending message ids are resource declarations.
tags: [research, defold, ttsc, compiler, diagnostics, language-service]
status: active
generated: { by: claude/opus-5, at: 2026-09-18T21:30:00-04:00 }
sources:
  - id: defold-protos
    resource: ../../../upstream/defold/engine
    title: Pinned Defold protobuf resource definitions
    author: project:defold
  - id: bob-builders
    resource: ../../../upstream/defold/com.dynamo.cr/com.dynamo.cr.bob/src/com/dynamo/bob/pipeline
    title: Bob builder annotations binding a file extension to its source message
    author: project:defold
  - id: hash-literals
    resource: ./compile-time-hash-literals.md
    title: Compile-time Defold hash literals
    author: project:deherm
---

# Finding

Defold resources are protobuf text format and readable. Resource, component,
instance, and resource-member names a script addresses are declared in those
files, so a binding call that passes a literal name is checkable at compile
time. Until this wave it was not checked at all: a typo
in `gui.getNode("backrop")` was a runtime error in a packaged engine, discovered
as a black screen.

The check now runs inside the same ttsc checker position that lowers
`DefoldHash` literals, against a symbol table `deherm generate` writes from the
project's own resources.

Message ids are different: Defold documents `msg.post` but does not declare a
closed project message set. The symbol table therefore keeps them in a separate
versioned `projectMessages` projection. Direct literal `msg.post` arguments are
sender evidence, while a `hashLiteral("#name")` constant compared with an
`onMessage` message-id parameter is receiver-contract evidence. Neither is
promoted into the protobuf declaration namespaces.

# Where each piece comes from

Nothing in this lane is a hand-written symbol or route allowlist.

**The declaration schema** is derived from pinned upstream Defold sources by
`scripts/generate-defold-resource-schema.mjs`:

* Bob's own builders bind an extension to the message its text resources parse
  as - `@ProtoParams(srcClass = SceneDesc.class)` beside
  `@BuilderParams(inExts=".gui")` - and the Java import resolves that class to a
  `.proto` through `java_package` and `java_outer_classname`.
* A **declaration site** is a repeated sub-message field whose element carries an
  identity string field. The identity field is a non-`(resource)`,
  non-`(runtime_only)` string named `id` or `name`, or the element's only string
  field when it has exactly one - which is how `key_trigger { action: "fire" }`
  is recognized without naming input bindings anywhere.
* Sites whose element messages share a trailing CamelCase word merge into one
  namespace, so `components`/`embedded_components` and
  `instances`/`embedded_instances`/`collection_instances` are single addressable
  spaces rather than three.
* A site reached *through* another declaration site is nested and never becomes a
  namespace. That is what keeps `components[].properties[]` out of the table, so
  `go.set(url, "position")` is never judged against declared script properties.

This yields 30 namespaces over 18 resource kinds with zero blockers, including
`gui:node`, `gui:font`, `gui:layer`, `gui:layout`, `gui:material`,
`gui:particlefx`, `go:component`, `collection:instance`, `atlas:animation`,
`tilesource:animation`, `tilemap:layer`, `input_binding:action`,
`material:constant`, and `material:sampler`.

**The parameter classification** (`resourceNamespace`) is derived from the pinned
API documentation by `scripts/generate-script-resource-namespace-classification.mjs`:

* The parameter's **value shape** says whether it carries a name (`string|hash`)
  or a Defold address (`string|hash|url`).
* The **documented noun** selects the namespace kind. The parameter identifier
  naming the kind is sufficient; documentation prose alone is accepted only when
  it also pairs the kind with an identity word, which is what separates
  `gui.get_node`'s "id of the node" from `gui.new_text_node`'s "node text".
* The **module's own resource**, or a sibling address parameter, selects which
  resource the name is declared in.
* A namespace a declaring route can extend at runtime is never checked. The
  pinned API decides this for itself: `gui.new_texture` introduces a texture id,
  so `gui:texture` is open and `gui.set_texture` resolves nothing.

Of 926 routes, 24 parameters carry a resolvable namespace, 92 carry a Defold
address, and 139 carry an explicit unresolved marker with a machine-readable
reason.

**The symbol table** is written to `.deherm/generated/resource-symbols.json` on
every `deherm generate` and every component regeneration in `deherm dev`. It
carries declared names with their source line, the component bindings of every
game object, collection instances and their prototypes, and the attachment of
every component source - derived by finding the single resource that references
the proxy path the component compiles to.

Its optional `projectMessages/v1` view is a bounded deterministic TypeScript
token projection over every project TypeScript source, including ordinary
modules imported by components. It accepts named imports (including
aliases) only from the generated `@deherm/project` package or the public
`@ts-defold/deherm` SDK, preserves source/line/column and sender-vs-receiver
provenance, and carries route metadata that limits consumers to parameter 1 of
`MsgApi.post`. Dynamic expressions and unrelated local `msg`/`hashLiteral`
lookalikes are absent without diagnostics. Per-file byte and token ceilings are
recorded in the result, along with any skipped source. The scanner models block
and expression-bodied function scopes conservatively: parameter and
destructuring shadows suppress imported-API evidence, comparisons inside nested
message-id scopes do not become receiver contracts, and regular-expression
contents are never treated as source calls (including after control conditions,
`for await`, logical operators, and `yield`). Function-scoped `var` shadows are
hoisted to their owning function instead of treated as block locals. A slash
whose expression role cannot be proven causes that source to be listed as
skipped instead of producing evidence. Semicolonless canonical imports retain
the same binding provenance as terminated imports.
Receiver contracts are considered only in the lifecycle owned by the exported
`defineComponent({...})` object or exported `component(ClassName)` class;
arbitrary objects and classes with an `onMessage` member remain invisible.

# Scoping rules that hold

* `gui.getNode` resolves against the specific `.gui` scene whose `script` field
  names the compiled component's proxy, not against every scene in the project.
* `msg.post("#component")` resolves within the owning game object;
  `msg.post("/instance")` within the collection that instantiates it. A GUI
  script's owning object is the one whose component points at its scene.
* Animation ids resolve against the atlas or tilesource bound to the sprite
  component the sibling address argument names, not against all atlases.

# Editor route semantics

The language server consumes the same generated `routes`, argument positions,
namespace ids, component attachments, game objects, and collections as the
checker. It recognizes generated SDK property calls plus named/local aliases
and namespace imports rooted in `@deherm/project` or `@ts-defold/deherm`.
An unrelated import that happens to export `gui`, `sprite`, `render`, or `msg`
is not treated as a Defold SDK call.

Completion, hover, and definition all select candidates through one route
context:

* `attached-resource` offers declarations only from the resource attached to
  the current component source;
* `addressed-component-resource` follows a literal sibling address through its
  game-object component and bound resource;
* `component-address` offers only the current game object's `#components` and
  its collection's `/instances` and `/instance#component` addresses.

A string must be the entire argument expression, or the sole argument of an
exact `address(...)`/`hashLiteral(...)` wrapper. A nested helper call, suffix,
non-null assertion, or type assertion is not used to narrow another argument's
scope.

When the sibling address is dynamic, the editor deliberately widens only to
the route's declared namespaces. It does not mix in unrelated resources,
nodes, components, or paths. A recognized SDK argument with no generated
resource or project-message semantics offers nothing. Literals outside a
recognized call retain the broad project-symbol view as an explicit resource
exploration convenience. The optional `projectMessages/v1` projection is
consumed only for the route and parameter its own metadata names.

All three operations use LSP UTF-16 character offsets and preserve CRLF line
boundaries. The focused suite exercises an astral character before a call,
scoped duplicate declarations, dynamic-address fallback, canonical import
aliases, nested lexical shadows, unrelated-import rejection, direct argument
ownership, regular-expression opacity, approved literal wrappers, and
source-accurate navigation.

# Fail-open boundary

Only literal arguments are checkable, and the check is silent at every step it
cannot complete: no symbol table, no attachment, no literal argument, a
socket-qualified or bare relative address, a namespace the attached resource
declares nothing in, or an addressed component with no single bound resource all
produce no diagnostic. A name computed at runtime, read from a property, or
assembled from parts passes untouched. A miss on a literal is a diagnostic;
absence of a literal is silence.

The editor has a separate, non-diagnostic fail-open rule: when a dynamic
address cannot select one bound resource, suggestions widen to the classified
namespaces only. A literal address that resolves to no component or bound
resource offers nothing. Neither outcome changes the compiler's silence or can
reject a build.

The project-message view is suggestion/navigation evidence, not a closed-world
validator. A message assembled dynamically is ignored, and absence from the view
must never reject a build or produce an unknown-message diagnostic.

# Evidence

| Boundary | Evidence | Current result |
| --- | --- | --- |
| Declaration schema | `scripts/generate-defold-resource-schema.mjs --check` over the pinned Defold checkout | 18 resource kinds, 30 namespaces, 0 blockers, deterministic |
| Parameter classification | `scripts/generate-script-resource-namespace-classification.mjs --check` over the pinned API IR | 24 namespaced names, 92 addresses, 139 explicitly unresolved |
| Project symbol table | `tests/fixtures/resource-names` built through `buildProjectResourceSymbols` | Declarations with source lines, game-object bindings, collection instances, and all five component attachments |
| Project message evidence | Focused scanner and project-table tests | Deterministic sender/receiver separation, canonical-package import gating, exact authored locations, lexical-shadow and regex rejection, no mixing with resource declarations, and dynamic-expression silence |
| Language service route join | `tests/language-server.test.mjs` over generated-table-shaped fixtures | Exact call/argument filtering across all three scopes, namespace-only dynamic fallback, project-message opt-in, CRLF/UTF-16 safety, and completion/hover/definition parity |
| Actual ttsc host | Pinned `ttsc` compiles the fixture projects through the package plugin descriptor | A GUI node/layer/font/layout typo, a sprite animation typo, a `#component` typo, and a `/instance` typo each produce a diagnostic naming the namespace, the declaring resource, and the candidates |
| Fail-open | The same host compiles a component whose names are computed, templated, read from state, or context-relative | No diagnostic; removing the symbol table restores the previous behavior exactly |

# Honest limitations

* The compile-time resource findings are reported through the linked-plugin
  apply channel, which ttsc surfaces as a build-failing diagnostic line. They
  are not yet `ast.Diagnostic` values with source context rendering.
* `attached-resource` scopes only resolve for the resource kind a component is
  actually attached to. `font:style` is classified but no component attaches
  to a `.font`, so it is never checked.
* `model.play_anim` classifies against the animation namespaces, which is wrong
  for a model's animation set; it stays silent because a model component binds no
  atlas or tilesource, but the classification is imprecise rather than correct.
* The two generators are deterministic and self-verifying through `--check`, but
  they are not yet registered in the script clean-room regeneration graph, which
  would need the pinned `.proto` and builder sources added to its evidence set.
* The inverse report - declared names no project TypeScript source mentions - is a
  textual literal scan recorded in the symbol table under `unreferenced`. A name
  a program assembles at runtime appears there, so it is a review aid and
  deliberately never a diagnostic.
* Editor route recognition is a deterministic lexical projection, not the
  TypeScript type checker's symbol graph. It models canonical named and
  namespace imports, default-import shadows, direct local aliases, recursive
  object/array binding patterns, block declarations, functions, arrows,
  object/class methods, and catch parameters. Computed aliases are not
  inferred; those forms receive no route-specific claim. Slash classification
  follows expression-ending token state, and ambiguous post-block slashes fail
  closed as opaque regex text.

# Focused verification

```sh
pnpm check:defold-resource-schema
pnpm check:script-resource-namespaces
pnpm test:resource-names
node --test tests/language-server.test.mjs
```
