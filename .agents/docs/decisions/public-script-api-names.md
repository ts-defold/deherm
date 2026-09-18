---
type: Architecture Decision
title: Public TypeScript names for Defold script globals
description: Project Defold's raw global Lua functions through an idiomatic `defold` TypeScript namespace without changing source or ABI identity.
tags: [defold, typescript, bindings, generator, naming]
status: accepted
generated: { by: codex/gpt-5, at: 2026-09-18T00:00:00-04:00 }
sources:
  - id: defold-ref-doc
    resource: upstream/ref-doc.zip
    title: Pinned Defold Lua reference archive
    author: team:defold
---

# Decision

Defold's unqualified Lua globals (`hash`, `hash_to_hex`, and `pprint`) are
published to TypeScript as `defold.hash`, `defold.hashToHex`, and
`defold.pprint`. The generated public namespace is `defold`, not `builtins`.
The latter is an implementation-oriented name derived from the reference
archive's `doc/builtins.lua` filename and is not part of the TypeScript API.

The mapping is a deterministic generator policy in
`packages/compiler/src/script-public-api-policy.mjs`. Generators apply it to public
module paths, imports, type names, emitted probes, and source-coverage tokens.
The raw module path remains `builtins` inside source provenance, stable binding
IDs, Lua lookup paths, runtime descriptors, and historical engine evidence.
Renaming the public projection therefore cannot change an ABI identity or
silently invalidate an engine route.

# Collision and compatibility policy

Generation fails if two raw roots project to the same public root. In
particular, a future raw `defold` module cannot be merged silently with the
`builtins` projection; it requires an explicit, reviewed synonym decision.

No `builtins` compatibility export is emitted. The package is at `0.0.0`, all
repository-owned consumers have migrated, and keeping an alias would preserve
the misleading name indefinitely. A compatibility alias may be introduced
later only as an explicit deprecation policy for a released API; it must be a
direct ESM alias so bundlers can remove it when unused.

# Verification

The script SDK and value-probe generators own the emitted files. Their
`--check` modes and isolated script clean-room regeneration prove that no
hand-edited generated output is required. Type checking, package smoke tests,
and the War Battles API gate consume `defold` from the public package surface.
Internal reports may continue to say `builtins` when they identify the pinned
Defold source module rather than the TypeScript spelling.
