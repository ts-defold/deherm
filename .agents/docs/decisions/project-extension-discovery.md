---
type: Architecture Decision
title: Discover project extensions before generating project bindings
description: Build a deterministic extension inventory from local Defold resources and Bob-resolved dependency archives, then require explicit native ABI policy.
tags: [decision, cli, extensions, bindings, codegen]
status: accepted
generated: { by: codex/gpt-5, at: 2026-09-17T14:50:00-04:00 }
sources:
  - id: bob-project
    resource: https://github.com/defold/defold/blob/7f0f554f41f9dce1e0ddff99bf08200657d1ee05/com.dynamo.cr/com.dynamo.cr.bob/src/com/dynamo/bob/Project.java
    title: Bob project dependency cache layout
    author: team:defold
  - id: editor-extensions
    resource: https://github.com/defold/defold/blob/7f0f554f41f9dce1e0ddff99bf08200657d1ee05/editor/src/clj/editor/engine/native_extensions.clj
    title: Defold native extension resource discovery
    author: team:defold
  - id: script-api
    resource: https://defold.com/manuals/extensions/#api-documentation
    title: Native extension API documentation
    author: team:defold
---

# Decision

The npm package owns project-aware discovery. Before generating or compiling a
game, `defold-hermes` reads `game.project`, scans project-local extension roots,
and reads Bob's resolved dependency archives under `.internal/lib`. It emits a
stable `.deherm/extensions.json` inventory plus TypeScript declarations
derived from extension `.script_api` files. The normalized
`.deherm/bindings.ir.json` sits between discovery and every emitter.

This is the front door for third-party modules such as xMath. Authors should not
have to manually repeat which Defold extensions their project already uses.

# Discovery contract

An extension begins at `ext.manifest`. For each local or resolved extension the
inventory records:

* extension name, origin, manifest, and declared platform keys;
* `.script_api` declarations for the Lua-shaped public surface;
* public headers under `include`;
* implementation files under `src` and `commonsrc` for diagnostics and build
  planning;
* whether script metadata is usable and whether a native binding schema is
  still required.

The importer preserves raw Defold/module names, creates collision-checked
idiomatic TypeScript names, normalizes types structurally, assigns stable symbol
ids, and records target-specific lowering status. Type declarations and
executable TypeScript SDK modules are emitted from that IR rather than directly
from YAML.

Local project files exclude build output, dependency caches, VCS metadata, and
`node_modules`. Dependency ZIPs are read directly rather than extracted. All
paths and output ordering are normalized so the generated inventory is suitable
for source control comparisons and cache keys.

Because discovery begins at `ext.manifest`, a resolved dependency that ships no
manifest contributes nothing. That is reported rather than silent: the inventory
records each such archive with its file and Lua-module counts, a warning
diagnostic names it, and both `deherm extensions` and `deherm doctor` print it.
Most published Defold libraries are pure Lua and land here; whether they gain an
ingestion route is a separate decision.

Dependency URLs are metadata, not identities. User information, passwords,
query strings, and fragments are removed before an inventory is printed or
persisted. This prevents signed URLs and private library credentials from
leaking into generated artifacts or CI logs.

# Binding boundary

`.script_api` is the authoritative discoverable description of an extension's
Lua-facing names and documentation, so it can immediately produce useful
TypeScript declarations. It does not define C symbols, ownership, thread
affinity, userdata lifetime, callback reentrancy, or fixed memory layout.

Projection from `.script_api` fails closed. A declared shape the lane cannot
represent produces a machine-readable blocker in `.deherm/bindings.ir.json`,
marks its member `disposition: "blocked"`, and emits that member as an
uninhabited `never` with its reason, never as `any` or `unknown`. Named Defold
value types resolve against the generated transparent value layouts rather than
being guessed, and a transparent value type with no declared TypeScript
projection fails generation. See
[Real third-party extension ingestion](../research/real-extension-ingestion.md)
for the blocker taxonomy and the pinned ingestion evidence.

Likewise, finding a C/C++ header does not make it safe to expose through JSI or
Static Hermes automatically. Public headers enter the Clang ingestion lane, but
native emission remains blocked until the generated IR has an explicit ABI and
lifetime policy. The extension-owned escape hatch is a versioned
`defold-hermes.bindings.json` beside `ext.manifest`. It selects include-relative
entry headers, chooses C or C++ parsing, optionally filters exact qualified
symbols, and optionally strips one C prefix from public member names:

```json
{
  "schemaVersion": 1,
  "headers": [
    {
      "path": "xmath.hpp",
      "language": "c++",
      "symbolPrefix": null,
      "symbols": ["xmath::dot", "xmath::Matrix::invert"]
    }
  ]
}
```

The same bounded parser reads this file from local extensions and directly from
Bob-resolved dependency ZIPs. Paths and symbols are canonicalized, duplicates
and unknown fields are rejected, qualified symbol grammar is validated, the
schema bytes participate in the project generation key, and
public headers not selected as entry points remain available as transitive
includes while being named in the native-generation report as intentionally
ignored. A requested header or symbol that does not exist becomes a
machine-readable blocker rather than silently disappearing.

Clang now projects schema-selected scalar, string, and enum C or C++ free
functions into the same production glue and generated exact-call twin. C++
methods, templates, records, pointers, and other shapes that still require
receiver, specialization, layout, bounds, ownership, or lifetime facts remain
public catalog rows with those explicit blockers. The schema's presentation
choices do not perturb the established C-route stable-id signature. Later
policy fields may satisfy those blockers without changing discovery or the
output ownership contract. Implicit compiler declarations never enter the
catalog, a method nested in a class template retains its specialization
blocker, and a configured symbol prefix changes only matching free-function
member names; it never truncates a method name. Qualified C++ enum and record
names use `$` between namespace segments in emitted TypeScript while retaining
their exact qualified spelling in native glue. Unqualified Clang type spellings
resolve against their enclosing C++ namespace/record scope instead of a global
short-name alias.

This gives extensions two compatible routes:

1. Lua compatibility route: generated cached stack thunks from `.script_api`.
2. Direct native route: generated JSI, Static Hermes, and Emscripten adapters
   from a reviewed extension schema and headers.

The ergonomic TypeScript module may combine both routes, but its generated
implementation always makes the performance boundary explicit.

# Build integration

Discovery itself is offline. If `game.project` declares libraries that are not
present in `.internal/lib`, the future `resolve` command will invoke pinned Bob
to populate the cache before discovery. The higher-level build sequence is:

```text
game.project -> Bob resolve -> extension inventory -> canonical binding IR
             -> TypeScript bundle + native adapters -> Bob build/bundle
```

The initial CLI implements `doctor`, `extensions`, and `generate`. A clean npm
tarball install has been exercised against the repository's sample Defold
project. Build, watch, and run orchestration will be layered on this inventory
rather than duplicating extension configuration.
