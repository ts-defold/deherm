---
type: Architecture Decision
title: Make ttsc, hot reload, CDP debugging, and profiling one development loop
description: Use ttsc for semantic transforms, reload complete runtime generations safely, and expose Hermes/browser debugging through CDP and VS Code.
tags: [decision, ttsc, hot-reload, vscode, debugging, profiling]
status: proposed
generated: { by: codex/gpt-5, at: 2026-09-17T15:20:00-04:00 }
sources:
  - id: hermes-cdp
    resource: https://github.com/facebook/hermes/tree/4947871513667919bf2fe225134af3e3a1a3772c/API/hermes/cdp
    title: Pinned Hermes Chrome DevTools Protocol API
    author: team:meta-hermes
  - id: hermes-profiler
    resource: https://github.com/facebook/hermes/blob/4947871513667919bf2fe225134af3e3a1a3772c/API/hermes/hermes.h
    title: Pinned Hermes sampling profiler API
    author: team:meta-hermes
  - id: defold-resource
    resource: https://github.com/defold/defold/blob/7f0f554f41f9dce1e0ddff99bf08200657d1ee05/engine/resource/src/dmsdk/resource/resource.hpp
    title: Defold resource reload callback API
    author: team:defold
---

# Decision

`ttsc` owns checking, target restrictions, API sugar lowering, and intrinsic
rewrites. A bundler remains responsible only for ESM graph resolution,
tree-shaking, chunking, and source-map composition. Babel is not part of the
default pipeline. Dynamic Hermes consumes the resulting JavaScript or matched
Hermes bytecode; Static Hermes consumes the stricter ttsc output and generated
C ABI imports.

VS Code is the sole TypeScript code editor. Defold remains the scene, resource,
build, and run editor; first-class `.ts` editing inside Defold is out of scope.
This removes the need for an editor fork in the normal workflow.

The npm package will ship an editor-neutral language server and debug adapter,
with a thin VS Code extension acting as their client:

* TypeScript's built-in language service owns syntax, types, generated TSDoc,
  source navigation, and ordinary refactors.
* The Defold-Hermes LSP adds project semantics: resource paths, collection and
  component addresses, message payloads, material constants, dependency
  extensions, and generated-source provenance.
* The DAP owns breakpoints, stack/scopes, watches, inline runtime values, and
  profile/debug transport. Hermes CDP is its JavaScript-debug backend; a small
  Defold introspection channel supplies live game-object, component, property,
  and message state that CDP alone cannot know.

An optional Defold editor hook passes `editor.engine_sha1`, notifies the CLI,
and advertises the active game-session endpoint. It does not implement a code
editor.

# Reload transaction

TypeScript-only edits do not rebuild Hermes or the custom engine:

```text
save -> precompiled dehermc transform -> incremental bundle -> source map
     -> dev transport/resource reload -> candidate runtime generation
     -> restore explicit state -> atomic swap or rollback
```

The old runtime remains live until the candidate bundle loads and its restore
hook succeeds. At the frame boundary, the host swaps generations, then invokes
the old dispose/final hook. A failed candidate is discarded and the game keeps
running on the previous generation.

Callbacks and native wrappers already carry runtime/slot/generation/type. The
reload implementation extends routing from one global runtime to a runtime-id
registry so callbacks created during candidate initialization reach the correct
realm. Committing the swap invalidates and drains the old generation. Engine
handles are re-resolved from stable ids; raw pointers and JSI values never cross
the generation boundary.

State retention is explicit:

```ts
defineDefoldApp(() => ({
  hot: {
    dispose: () => ({ score, level }),
    restore: (state) => { score = state.score; level = state.level; }
  }
}));
```

The first transport uses Defold's resource-reload callback for the generated JS
resource. A local WebSocket transport follows for remote devices and reloads
that should not require an editor resource build.

# Debugger transport

The pinned Hermes source contains `CDPDebugAPI`, `CDPAgent`, Debugger, Runtime,
Profiler, and HeapProfiler domains. Development builds now embed `CDPDebugAPI`
and `CDPAgent`. The extension connects through a bounded, loopback-only,
newline-delimited JSON transport to the CLI; the CLI owns HTTP discovery and a
standard `/devtools/page/deherm` WebSocket endpoint. This keeps HTTP/WebSocket
parsing off the game frame while remaining directly consumable by Chrome and
VS Code CDP clients. The engine accepts one debugger frontend and pumps Hermes
debugger work only at extension-owned JavaScript safe points.

The target archive cache retains both release and debugger Hermes builds, but a
project exposes exactly one under the canonical archive name. `deherm dev`
selects the debugger build and writes the compile-time selector; release builds
compile the transport out and link no CDP symbols. Hermes can call its debugger
callbacks from arbitrary threads, so runtime tasks and outbound messages are
queued under a mutex and delivered at the engine safe point. The transport caps
each direction at four MiB and disconnects rather than accumulating unbounded
backpressure.

Source URLs remain stable across rebuilds, and ttsc plus the bundler preserve a
composed source map back to authored `.ts`. A candidate HMR runtime attaches to
the same engine transport before bundle evaluation; a rejected candidate
rebinds the prior runtime, while an accepted candidate keeps the frontend
WebSocket open across the swap. The remaining DAP work owns breakpoint
reapplication and authored-TypeScript source presentation. HTML5 uses the
browser's existing CDP endpoint with the same authored source paths.

# Profiling

The development Hermes build enables sampling-profiler support and carries the
Hermes CDP Profiler and HeapProfiler domains. CLI commands still need to capture
CPU profiles, allocation tracking, and heap snapshots into standard artifacts
that VS Code or browser tooling can open.
Release performance measurement uses a separate instrumented profile; the lean
shipping runtime does not carry the debugger server.

# Acceptance gates

1. Break in authored TypeScript during `init`, `update`, and a native callback.
2. Preserve correct source/line mapping after ttsc transforms and bundling.
3. Edit a module, reject an invalid build without disturbing the old runtime,
   then atomically load a valid build without restarting Defold.
4. Prove old-generation callbacks cannot enter the new runtime.
5. Capture a Hermes CPU profile and heap snapshot from the CLI and open both in
   standard tooling.
6. Run the equivalent breakpoint and reload smoke test on HTML5 through browser
   CDP.
7. Show live instance, component, and property values beside authored
   TypeScript in VS Code, visibly invalidate stale generation handles, and
   navigate a live Defold address back to its project resource.
