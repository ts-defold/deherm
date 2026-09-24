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

The first language-server slice is deliberately additive rather than a second
TypeScript checker. `deherm language-server --stdio` reads the generated
project resource-symbol table and contributes Defold resource paths,
collection/component addresses, declaration provenance, hover text, and
go-to-definition. It does not advertise ordinary TypeScript diagnostics,
completion, hover, navigation, or refactors. The VS Code client continues to
leave those capabilities with VS Code's TypeScript service and starts one
workspace-local déherm server for each discovered `game.project`. The client
also launches the existing `deherm debug` DAP from that same local package, so
language, debugger, generator, and project policy cannot silently come from
different installed versions.

An optional Defold editor hook passes `editor.engine_sha1`, notifies the CLI,
and advertises the active game-session endpoint. It does not implement a code
editor.

Development HTML5 bundles are mutable tool output, not Defold project input.
The CLI writes Bob's `--bundle-output` to a project-keyed directory below the
platform-native déherm user cache and gives that same output root to the browser
target. Bob therefore never receives the reserved `<project>/build` directory,
successive bundles cannot be rediscovered as project resources, sibling
projects do not overwrite one another, and the installed CLI can reuse the
latest bundle without repository-specific paths. An explicit `--web-bundle`
continues to win and names the packaged directory containing `index.html`.
Only the internal default-cache path enables Bob-parent discovery so an
explicit path cannot guess or serve a stale nested child. The cache path can
remain stable while Bob creates its titled child.
Bob's intermediate wasm-web resources use a separate
`<project>/build/deherm-wasm-web` tree, never the native development engine's
`<project>/build/default` tree; starting both targets cannot rewrite shaders or
archives while the native engine is reading them, and failure diagnostics read
the `log.txt` from that exact `--output` tree. After Chrome connects, the
first bundle activation waits on a bounded CDP readiness predicate for the
Defold page host; a missing host times out explicitly instead of consuming and
rejecting the first generation during page bootstrap.

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

The development watcher treats files written by its own compiler, proxy,
toolchain-artifact, and runtime-variant stages as outputs rather than new source
events. The native artifact boundary is deliberately exact: the installed
archive/receipt tree, `libhermesvm-config.h`, and the generated runtime selector
are ignored, while authored extension C/C++ sources and headers remain watched.
Atomic replacement scratch names are ignored independently so a rename-based
writer cannot schedule a build against a temporary path that has already
disappeared. A clean launch must therefore converge after one initial build;
any later build requires an authored or external project input.

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

# Live instance and property channel

CDP knows JavaScript frames and values, but not which Defold component owns a
realm object. A private, versioned development channel therefore projects the
component registry at an engine-owned safe point. Native debugger builds emit
one newline-delimited envelope whose `channel` is `deherm-dev-v1`; HTML5 exposes
the same snapshot payload through the page's private development entry point.
Release native builds compile this sampler out. Immutable marker-bearing HTML5
templates live in the CLI package, while the checked-in/npm extension files are
generated release output. Before Bob, the toolchain always materializes the
exact requested profile into the project extension: debug retains the sampler;
release removes its state, retained roots, implementation, and public
development method. A browser dev launch always asks the builder for a fresh
debug `wasm-web` bundle before it opens or reuses a page, so an older release
bundle cannot silently disable the channel.

Each snapshot names its runtime and monotonically increasing sequence, then
lists deterministic `{slot,generation}` component identities, component and
schema identities, Defold context, and declared property values. The sampler
retains at most the first 32 distinct declared properties per component slot,
encodes strings only through 256 UTF-8 bytes, and caps the complete transport
frame at 512 KiB. A non-fitting component is rolled back as a whole and counted
under `omitted`; a partial JSON object is never emitted. Values are a closed
union of nil, boolean, finite number, string, hash, URL, vector3, vector4,
quaternion, or an explicit unavailable reason.

Inspection captures the pristine `Object.getOwnPropertyDescriptor` before user
code runs and reads own data descriptors only. It never walks a prototype or
invokes an accessor. Structured engine values carry an identity retained at the
engine crossing; an authored replacement fails closed before descriptor lookup,
and the old identity is released on the first mismatch. The browser encoder
uses captured intrinsics, null-prototype records, and explicitly defined array
lanes so hostile prototype setters and replaced reflection methods cannot run as
a side effect of observation. Native samples at most four times per second and only
while the private loopback inspector is connected. The existing four-MiB
transport queue remains the single bounded backpressure authority, and CDP
messages retain their existing framing and routing.

The CLI consumes the reserved native envelope before CDP forwarding and polls
browser telemetry plus the snapshot in one single-flight evaluation. Every
connection gets an epoch; stale sequences, old pages, late exit callbacks,
stopped engines, and disconnected targets clear rather than preserve plausible
live values or disturb a replacement page. Generated component
metadata joins a runtime row only when both component id and schema fingerprint
match. Mismatches are visibly stale. The TUI shows those genuine rows and keeps
aggregate telemetry as an explicitly separate fallback.

The existing loopback inspector server also exposes an authenticated,
`no-store`, ETagged state projection at the descriptor's private `stateUrl`.
The random bearer token and URL remain in the mode-0600 project descriptor;
the response contains no credential and grants no cross-origin access. This is
the editor seam for live values, not a second listener or a public game API.
Its schema-enriched projection has its own byte budget below the editor's two-MiB
intake cap, distributes that budget across targets, and omits only complete rows
with explicit per-target totals. The in-process TUI retains the complete bounded
runtime snapshot and is not reduced to satisfy the editor transport. The thin
VS Code client polls it with bearer authentication and ETag
revalidation, accepts only the owning project's loopback descriptor, and
renders only server-enriched rows whose schema is current. A bounded top-of-file
CodeLens shows at most six instances and three properties per instance. Aged,
disconnected, replaced-session, unknown, and schema-stale rows disappear rather
than retaining or guessing values; ordinary TypeScript semantics remain with
VS Code's built-in service.

Declaration inlays are deliberately smaller than the transport record: the
visible text is only `= <live value>` beside the authored property declaration.
Target, component, instance identity, property name, and additional live
instances remain available in the hover. The source already names the property
and its authored default, so repeating either in the inlay spends horizontal
space without adding information.

Each live-value CodeLens carries only the already-open document's normalized
project root and authored TypeScript path as its navigation payload. The thin
client's reveal command validates both fields against the refreshed project
registry and the authored resource suffix before opening the document; runtime
component data never supplies a URI or arbitrary path. Invalid, stale, or
foreign payloads are silent no-ops.

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
