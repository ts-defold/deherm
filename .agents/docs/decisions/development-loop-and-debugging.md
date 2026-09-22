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
VS Code CDP clients. The engine accepts one debugger frontend. Its bounded
loopback reader runs on a transport thread, because a breakpoint blocks the
engine thread and resume/step must still arrive. `CDPAgent` accepts commands
from arbitrary threads; pinned Hermes' `RuntimeTaskRunner` races an integrator
queue against an async debugger interrupt and executes each command exactly
once with exclusive runtime access. Work that requires an idle runtime remains
on the extension-owned safe-point pump.

The target archive cache retains both release and debugger Hermes builds, but a
project exposes exactly one under the canonical archive name. `deherm dev`
selects the debugger build and writes the compile-time selector; release builds
compile the transport out and link no CDP symbols. Hermes can call its debugger
callbacks from arbitrary threads, so outbound protocol bytes enter a bounded,
mutex-protected transport queue immediately; deferring a `Debugger.paused`
notification to the engine safe point would deadlock the session. Runtime tasks
remain separately queued for the engine safe point when the async debugger did
not already claim them. The transport caps each direction at four MiB and
disconnects rather than accumulating unbounded backpressure. Disconnect sends
a best-effort resume before the engine safe point rebuilds the inspector agent,
so losing the frontend does not intentionally strand a paused game.

Source URLs remain stable across rebuilds, and ttsc plus the bundler preserve a
composed source map back to authored `.ts`. A candidate HMR runtime attaches to
the same engine transport before bundle evaluation; a rejected candidate
rebinds the prior runtime, while an accepted candidate keeps the frontend
WebSocket open across the swap. `deherm debug` is the editor-neutral DAP over
stdin/stdout. It maps authored `.ts` breakpoints and stack frames through the
live composed source map, exposes scopes, variables, watches and source
content, carries conditional breakpoints and exception policy, and reapplies
breakpoints whenever HMR reports the stable bundle URL as a newly parsed
script. Detaching while paused resumes before releasing the one native frontend.
HTML5 uses the browser's existing CDP endpoint with the same authored source
paths. The project-owned browser inspector descriptor records Chrome's exact
dynamic target WebSocket, while the DAP binds breakpoints by the
`defold-hermes://app(?:.<generation>).js` URL family so HMR generations inherit
the authored breakpoints. Only the newest matching script is projected through
the current source map; live closures from an older generation and unrelated
page scripts retain their raw URLs rather than acquiring a plausible but wrong
TypeScript location. A fresh War Battles `wasm-web` bundle proves the
public DAP stops Chrome on `arena.script.ts`, maps the top frame, evaluates the
live `dt`, resumes, and disconnects. The thin VS Code client remains.

# Profiling

The development Hermes build enables sampling-profiler support and carries the
Hermes CDP Profiler and HeapProfiler domains. A live development session writes
an atomic, mode-0600 `.deherm/dev/inspector.json` descriptor containing a random
session identity and loopback-only discovery URLs. The bridge removes that file
only when it still owns the recorded identity. Cleanup first atomically claims
the directory entry and restores a mismatched descriptor with create-if-absent
semantics; a replacement published before or during cleanup therefore wins and
an old session cannot erase it. Readers reject non-loopback URLs and require
discovery to return the exact WebSocket recorded by the descriptor.

`deherm profile cpu --duration <ms>` sends `Profiler.start`/`Profiler.stop` and
writes the returned standard `.cpuprofile`. `deherm profile heap` streams each
`HeapProfiler.addHeapSnapshotChunk` directly to a temporary file and atomically
publishes a `.heapsnapshot`; it does not retain the snapshot in JavaScript
memory. An already attached debugger is preserved by default. The operator must
pass `--replace-debugger` explicitly because the native transport currently
admits one frontend; the bridge enforces that choice again during the WebSocket
handshake so a discovery/connection race cannot evict the debugger. The
debugger-enabled checkout build forces Hermes memory
instrumentation to follow the selected variant even when a CMake cache was
previously configured for release; otherwise the domain exists but snapshots
fail at runtime.

Exact Node transport tests prove descriptor ownership, CDP request identity,
CPU artifact emission, and ordered heap streaming. The native pinned-Hermes test
separately compiles and executes an authored-bundle breakpoint/resume transaction,
CPU sampling, and a real heap snapshot. A second native test drives the production
background `InspectorClient` framing while the engine thread is paused and proves
the paused event and resume command cross that transport. A pinned
local Extender build of War Battles then captured both artifacts through the
public CLI from its running engine: five CPU nodes with 22 samples and a
654,011-byte heap graph with 63,924 nodes. That last run is integrated arm64
macOS evidence; it does not promote unexecuted host/target combinations.
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
