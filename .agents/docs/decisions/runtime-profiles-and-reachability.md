---
type: Architecture Decision
title: Ship precompiled development runtimes and generate reachable-only release bindings
description: Keep the edit loop free of native compilation while using the bundled module graph to remove unused JavaScript, adapters, ABI thunks, and exports in release builds.
tags: [decision, development, hot-reload, tree-shaking, bytecode, static-hermes]
status: accepted
generated: { by: codex/gpt-5, at: 2026-09-17T00:00:00-04:00 }
sources:
  - id: hermes-source
    resource: https://github.com/facebook/hermes/tree/static_h
    title: Hermes static_h source
    author: team:meta-hermes
---

# Decision

Development and release are deliberately different products built from the
same TypeScript API:

| Profile | Runtime | Program input | Binding surface | Native work per edit |
| --- | --- | --- | --- | --- |
| `dev` | dynamic Hermes | JavaScript source | complete, precompiled | none |
| `device-dev` | dynamic Hermes | host-produced Hermes bytecode | complete, precompiled | none |
| `release` | Static Hermes | native AOT output | reachable symbols only | final build only |

The development extension is published as precompiled platform binaries. It
contains the dynamic Hermes VM, complete generated JSI modules, the handle and
callback runtime, and the Lua compatibility backend. Editing game code never
rebuilds Hermes, Defold, the extension, or user C++. The editor watcher only
strips TypeScript types, bundles modules, optionally produces Hermes bytecode,
and reloads the program. Type checking runs concurrently and does not block a
reload unless configured to do so.

“No compilation during development” specifically means no native toolchain or
custom-engine build. Hermes must still parse JavaScript or consume bytecode.
Desktop editor builds may include source compilation for the shortest loop;
device builds may keep the compiler off-device and accept bytecode produced by
the editor host.

Hermes bytecode is version-coupled to its runtime. The downloadable editor
toolchain must therefore ship `hermesc` and the extension runtime from the same
pinned build, expose their bytecode version in diagnostics, and reject a
mismatch before evaluation. The local spike's `build:device-dev` command uses
that matched pair and `test:device-dev` executes the resulting `.hbc` in the
same precompiled runner.

# Reachability contract

The complete SDK is always available as declarations, but implementations are
paid for only when reachable. Direct generated imports are the analyzable API:

```ts
import { add } from "@defold-hermes/sdk/ExampleMath";
```

Every generated function lives in its own ESM input. After ttsc transforms and
esbuild tree shaking, the bundler metafile reports which function inputs
contributed bytes to each entrypoint. `scripts/build.mjs` converts that evidence
into an adjacent versioned `*.usage.json` manifest. This chain governs the
*extension module* surface, where one function is one module. The generated
Defold API surface is not module-granular - a namespace is one object - so its
reachability comes from the checker instead and lands in the adjacent
`*.defold-api-usage.json`. The binding compiler accepts
the manifest and emits a matching subset of TypeScript wrappers, C ABI
declarations, JSI functions, Static Hermes imports, Emscripten dependencies,
and memory layouts.

The reachability chain is therefore:

```text
TypeScript import graph
  -> retained generated ESM inputs
  -> versioned Defold symbol manifest
  -> type/layout dependency closure
  -> generated target adapters
  -> compiler function sections and linker dead stripping
```

The current executable spike proves the first four links. `sample.ts` imports
only `ExampleMath.add`; its release binding output omits
`ExampleMath.multiply` across the C and JSI projections. Native section-level
link flags and a Static Hermes AOT application link remain release-pipeline
work.

# Dynamic access and reflection

`DefoldModules.get(name)` remains an explicit compatibility escape hatch. If
the dynamic registry contributes code to an entrypoint, the manifest sets
`dynamicAccess: true` and conservatively retains the complete surface. Future
configuration may allow an explicit dynamic allow-list, but an unknown string
must never produce an unsound release artifact.

This applies to the *extension module* registry. Dynamic access to the generated
**Defold API** surface is no longer inferred at all: the checker detects a
computed member access on it, names the site, and a release build refuses until
the project declares `dynamicApiAccess`. See
[Take release reachability from ttsc](./release-reachability-and-native-lowering.md).

Callbacks, engine messages, serializers, and native module registration can
introduce edges that are not ordinary JavaScript calls. Their generators must
record those edges in the same manifest before reachability closure. A symbol
may be removed only because the compiler can prove it unreachable, never
because a generator failed to classify it.

# Browser behavior

HTML5 development executes JavaScript directly in the browser and uses the
complete precompiled Defold Wasm extension surface. Release uses the same usage
manifest to minimize raw Emscripten exports and generated memory codecs. Hermes
is not linked into the browser artifact.
