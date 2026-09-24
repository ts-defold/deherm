---
type: Research Note
title: Defold hot reload and the deherm development control plane
description: Reproduced Defold editor-to-engine reload behavior and a staged Rezi operator-console architecture for safe Hermes generation swaps.
tags: [research, hot-reload, remote-target, resource, rezi, tui, tooling, hermes]
status: verified
generated: { by: codex/gpt-5, at: 2026-09-17T23:45:00-04:00 }
sources:
  - id: defold-hot-reload-manual
    resource: https://defold.com/manuals/hot-reload/
    title: Defold hot reload manual
    author: team:defold
  - id: defold-live-update-manual
    resource: https://defold.com/manuals/live-update/
    title: Defold Live Update manual
    author: team:defold
  - id: editor-hot-reload
    resource: https://github.com/defold/defold/blob/7f0f554f41f9dce1e0ddff99bf08200657d1ee05/editor/src/clj/editor/app_view.clj#L1717-L1758
    title: Pinned editor hot-reload command
    author: team:defold
  - id: editor-reload-request
    resource: https://github.com/defold/defold/blob/7f0f554f41f9dce1e0ddff99bf08200657d1ee05/editor/src/clj/editor/engine.clj#L57-L69
    title: Pinned editor resource-reload HTTP request
    author: team:defold
  - id: resource-reload-proto
    resource: https://github.com/defold/defold/blob/7f0f554f41f9dce1e0ddff99bf08200657d1ee05/engine/resource/proto/resource/resource_ddf.proto#L7-L10
    title: Pinned resource reload protocol
    author: team:defold
  - id: engine-service-post
    resource: https://github.com/defold/defold/blob/7f0f554f41f9dce1e0ddff99bf08200657d1ee05/engine/engine/src/engine_service.cpp#L128-L175
    title: Pinned engine service POST implementation
    author: team:defold
  - id: resource-reload-implementation
    resource: https://github.com/defold/defold/blob/7f0f554f41f9dce1e0ddff99bf08200657d1ee05/engine/resource/src/resource.cpp#L1089-L1207
    title: Pinned resource reload implementation
    author: team:defold
  - id: resource-sdk
    resource: https://github.com/defold/defold/blob/7f0f554f41f9dce1e0ddff99bf08200657d1ee05/engine/resource/src/dmsdk/resource/resource.h#L457-L593
    title: Pinned custom resource type API
    author: team:defold
  - id: script-component-reload
    resource: https://github.com/defold/defold/blob/7f0f554f41f9dce1e0ddff99bf08200657d1ee05/engine/gameobject/src/gameobject/comp_script.cpp#L788-L812
    title: Pinned Lua script-component reload implementation
    author: team:defold
  - id: editor-command-api
    resource: https://github.com/defold/defold/blob/7f0f554f41f9dce1e0ddff99bf08200657d1ee05/editor/src/clj/editor/command_requests.clj#L340-L348
    title: Pinned external editor hot-reload command
    author: team:defold
  - id: defold-debug-services
    resource: https://github.com/defold/defold/blob/7f0f554f41f9dce1e0ddff99bf08200657d1ee05/engine/docs/DEBUG_PORTS_AND_SERVICES.md#L3-L56
    title: Pinned Defold debug ports and services
    author: team:defold
  - id: rezi-repository
    resource: https://github.com/RtlZeroMemory/Rezi/tree/671a8a2600e5686316e0f124b316b669b33c8654
    title: Pinned Rezi repository
    author: RtlZeroMemory
  - id: rezi-architecture
    resource: https://rezitui.dev/docs/architecture
    title: Rezi architecture documentation
    author: RtlZeroMemory
  - id: rezi-core-npm
    resource: https://registry.npmjs.org/@rezi-ui%2fcore/latest
    title: Published Rezi core package metadata
    author: npm
---

# Result

Defold already supplies a usable native hot-reload transport. In a debug engine,
the editor rebuilds project resources, serves the changed artifacts over its
build HTTP server, and sends the running target a DDF `Resource.Reload` message.
The resource factory fetches and recreates each already-loaded resource at the
start of an engine frame. A custom `dehermc` resource type now uses this path to
stage a new dynamic-Hermes bundle. The extension constructs and initializes a
candidate runtime before replacing the active generation. A real Defold 1.14.0
debug-engine test has reproduced generation 1, changed the served resource,
posted the exact reload DDF, committed generation 2, and executed the changed
TypeScript result (`module:84`).

`deherm dev` should therefore be a headless daemon/controller first and a Rezi
operator console second. The console observes and commands that controller; it
must not own watchers, compiler processes, transports, or runtime state. The
published Rezi beta is suitable for the visual layer if exact-version pinned and
kept replaceable.

This note separates behavior reproduced in the pinned Defold and Rezi sources
or the local engine harness from design proposals that still require
implementation and on-device proof.

# Verified Defold behavior

## The editor-to-engine path

```mermaid
flowchart LR
  TS[generated app.dehermc on disk] --> SYNC[editor disk sync]
  SYNC --> BUILD[project build and ETag comparison]
  BUILD --> SERVE[editor /build resource server]
  BUILD --> POST[POST /post/@resource/reload]
  POST --> QUEUE[engine resource socket queue]
  QUEUE --> FRAME[UpdateFactory at next frame]
  FRAME --> FETCH[fetch changed artifact from resource.uri]
  FETCH --> RECREATE[resource Recreate callback]
  RECREATE --> STAGE[Deherm candidate generation]
  STAGE --> COMMIT[frame-safe validate and atomic commit]
  COMMIT --> ACK[structured activation event]
  ACK --> TUI[deherm dev controller and Rezi view]
```

1. The editor's hot-reload command performs a project build even for a resource
   subset, specifically to keep its build cache consistent. It compares build
   resource ETags and selects changed resources that the target already knows
   about. See `editor/src/clj/editor/app_view.clj:1717-1758`.
2. For each selected or launched target, the editor serializes
   `dmResourceDDF.Resource.Reload { resources: [...] }` and sends it as the body
   of `POST <target>/post/@resource/reload`. See
   `editor/src/clj/editor/engine.clj:57-69` and
   `engine/resource/proto/resource/resource_ddf.proto:7-10`.
3. The engine HTTP service derives the target socket and DDF type from the URL,
   decodes the body, and enqueues a Defold message. Its request buffer is 1,024
   bytes in this revision. An HTTP `200 OK` means the message was accepted for
   posting, not that any resource was successfully recreated. See
   `engine/engine/src/engine_service.cpp:128-175`.
4. The resource socket drains reload messages and calls `ReloadResource` for
   each path. See `engine/resource/src/resource.cpp:381-417`.
5. `dmResource::UpdateFactory` runs near the beginning of each engine frame,
   before extension update callbacks and before game-object update. This is a
   useful safe point, but the resource recreate callback itself must remain
   bounded. See `engine/engine/src/engine.cpp:2024-2046` and `:2084-2089`.

## What the resource factory guarantees

At the pinned revision, reload succeeds only when all of the following hold:

* The path already exists in the resource factory. A reload message does not
  create an arbitrary new loaded resource.
* Its registered type has a recreate callback.
* The new bytes can be fetched from the active resource provider.
* The recreate callback succeeds.

On success, the factory increments the resource version, invokes registered
reload callbacks, and destroys `m_PrevResource` when the recreate operation
provides one. See `engine/resource/src/resource.cpp:1089-1207`.

Resource reload support is enabled only when Defold is in debug mode; the engine
sets `RESOURCE_FACTORY_FLAGS_RELOAD_SUPPORT` conditionally at
`engine/engine/src/engine.cpp:1360-1370`. Shipping builds must not depend on this
development facility.

The public dmSDK exposes both reload listeners and custom resource-type create,
destroy, preload, and recreate callbacks. Its recreate contract explicitly
warns that outstanding pointers to a resource may exist, so a custom type must
replace data safely rather than invalidate consumers in place. See
`engine/resource/src/dmsdk/resource/resource.h:138-168`, `:457-593`, and
`:695-755`.

The current Deherm application is copied as a `custom_resources` file named
`/deherm/app.dehermc`, registered through `DM_DECLARE_RESOURCE_TYPE`, and loaded
with `dmResource::Get`. Its stable resource object owns the bytes and generation
counter. The recreate callback allocates and copies candidate bytes before
swapping them into the resource; allocation failure leaves the committed bytes
and generation unchanged.

## Lua script instance semantics

The official manual and pinned source agree on this behavior:

| Reloaded item | Verified outcome |
| --- | --- |
| A `.script` resource attached to an existing component | Defold re-executes the script source, replaces lifecycle function references, retains the existing script instance and its `self` table, does not call `init()`, and calls the new `on_reload(self)`. |
| A required Lua module | The module source is re-executed. Globals can reflect the update, but callers holding a previously returned local table do not automatically receive a replacement table. |
| A game-object prototype | Defold may finalize/destroy and recreate the game object. Do not generalize script-component state retention to prototype reload. |
| An `.input_binding` resource | Bob and the resource factory can accept replacement bytes, but an active collection keeps the action table created with its input stack. Déherm classifies the authored resource as restart-required and relaunches the debug engine after the successful Bob build. |
| A native extension binary | Not a resource-generation swap. It requires a custom-engine rebuild and process restart. |

The script resource reloads its Lua chunk and properties in
`engine/gameobject/src/gameobject/res_script.cpp:95-132`. Lifecycle references
are replaced by `LoadScript` at
`engine/gameobject/src/gameobject/gameobject_script.cpp:2453-2508`. The existing
component's script instance and data table are passed into `on_reload` at
`engine/gameobject/src/gameobject/comp_script.cpp:788-812`. Lua-module reload is
implemented at `engine/script/src/script_module.cpp:154-197`. Prototype-specific
recreation appears at `engine/gameobject/src/gameobject/gameobject.cpp:4300-4377`.

For generated `.script` proxies, this means Defold's Lua `self` and game object
can remain stable while Deherm replaces a Hermes application generation. Any
TypeScript component object, closure, promise, timer, or JSI value belongs to
the old Hermes realm and does not survive automatically.

## Remote targets

Defold debug engines publish an mDNS `_defold._tcp.local` service. Its metadata
includes the engine id, name, log port, version, platform, SHA-1, and schema.
The engine service normally starts on port 8001 or chooses a dynamic port; the
log service is also dynamic. See `engine/engine/src/engine_service_discovery.cpp`
and `engine/engine/src/engine_service.cpp:252-400`, summarized in the pinned
`engine/docs/DEBUG_PORTS_AND_SERVICES.md:3-56`.

When running on a remote device, the editor reboots the target with
`--config=resource.uri=http://<editor-address>:<editor-port>/build` and the
compiled `game.projectc` URL. The address is chosen so the device can reach the
editor host. See `editor/src/clj/editor/engine.clj:104-129` and
`editor/src/clj/editor/app_view.clj:776-777`. The editor serves artifacts with
ETags at `editor/src/clj/editor/hot_reload.clj:24-68`; Defold's HTTP resource
provider performs synchronous fetches and handles ETags/304 at
`engine/resource/src/providers/provider_http.cpp:136-335`.

The editor also exposes a useful integration seam. It writes its loopback port
and token under `.internal/editor.port` and `.internal/editor.token`, and
`POST /command/hot-reload` first syncs changed disk resources before invoking
the normal reload command. The endpoint is at
`editor/src/clj/editor/command_requests.clj:340-348`; startup files are written
at `editor/src/clj/editor/boot_open_project.clj:231-272`. Console history and a
streaming feed are exposed at `editor/src/clj/editor/console.clj:880-922`.

In this pinned source, the hot-reload handler itself does not call the same
authorization guard used by `/bob`. That observation is version-specific, not
a public security contract. `deherm dev` must bind its own services to loopback
by default, must not expose editor tokens in logs, and must treat editor command
and console endpoints as optional adapters with a version check.

## Hot reload is not Live Update

Defold Live Update is the shipped-game mechanism for packaging content outside
the initial application and downloading or mounting it later. It is not the
edit-time resource-reload protocol, does not replace a native extension binary,
and should not be used as the name for this feature. The two paths may later
share signed bundle artifacts, but they have different lifecycle and trust
models.

# Implemented native reload floor and proposed complete transaction

The typed resource, direct DDF transport, local resource server, and native
dynamic-Hermes generation swap have running-engine evidence. State
capture/restore, schema migration, browser-host activation, target discovery,
structured activation telemetry, and soak/leak certification remain open.

## Typed bundle resource

The implementation registers `.dehermc` and loads `/deherm/app.dehermc` with
the typed resource API so Defold tracks it. The current proof artifact is
JavaScript source plus a deterministic fingerprint; the production envelope
should contain:

* magic, format version, flags, and bounded section table;
* monotonically increasing build generation and content digest;
* exact Defold SHA, Hermes ABI/version, target, profile, and binding-schema hash;
* source or matched Hermes bytecode plus composed source map;
* component-registration and property-schema digests;
* optional state-migration id, never an unserialized JSI value or native pointer.

The resource object's address stays stable. `Recreate` allocates and copies the
candidate bytes before swapping them into the committed vector and incrementing
the resource generation. Runtime evaluation happens afterward in the extension
update, never in the resource callback. The bounded inactive-generation arena
and envelope validation are not implemented yet.

## Generation transaction

```mermaid
stateDiagram-v2
  [*] --> Active
  Active --> Staged: resource recreate validates bytes
  Staged --> Candidate: construct realm and evaluate
  Candidate --> Rejected: syntax, ABI, registration, or restore failure
  Rejected --> Active: discard candidate, retain last good generation
  Candidate --> Ready: capture explicit old state and restore candidate
  Ready --> Active2: atomically switch routing generation
  Active2 --> Retired: invalidate callbacks, dispose old realm
  Retired --> [*]: drain roots and arena
```

The general application transaction is:

1. Build a candidate Hermes runtime in an inactive runtime slot.
2. Evaluate the complete bundle and validate exported lifecycle/component tables.
3. Ask the active generation for a non-destructive, bounded serializable state
   snapshot. Restore that snapshot into the candidate. A raw Hermes object graph
   is never shared between realms.
4. At a frame boundary, atomically switch the active runtime id, bundle slot,
   dispatch tables, and component-generation routing.
5. Reject late callbacks from the old generation, invoke its `dispose`/`final`,
   drain roots and deferred releases, and reset its arenas.

This deliberately separates `capture()` from `dispose()`: a candidate failure
must leave the previous generation running. Existing Defold game objects and
Lua proxy `self` tables can survive. The proxy stores stable ids; generated
TypeScript component instances are reconstructed/rebound and may restore
explicit per-instance state. A proxy property-schema change takes the slower
editor build/reload path and may require a declared migration or reset.

Dynamic source or matched bytecode Hermes is the native development lane.
Static Hermes is still the native release/AOT lane, but an AOT binary cannot be
replaced by resource reload. HTML5 uses the host browser JavaScript engine and a
unique generation factory; it does not embed Hermes in Wasm by default.

Component-only native bundles now take a compatible fast path after the same
disposable candidate validation. The active Hermes realm clears its registration
globals, evaluates the candidate bundle, requires a new component registry and
64-hex build fingerprint, and validates every live component id, schema
fingerprint, context, and definition before replacing any definition. It then
swaps only the method-table objects. The existing `self` objects, handle slots,
generations, properties, and other authored state stay in the active realm. A
schema or context change restores the prior globals and definitions and leaves
the last-good generation callable. Each committed slot becomes reload-pending;
its next real proxy lifecycle dispatch consumes exactly one authored `onReload`
inside that proxy's already-active Defold instance context. An explicit Defold
proxy `on_reload` consumes the same pending callback. An accepted generation
therefore never needs a second `init`, and the extension never bulk-calls hooks
without the owning script instance. A bulk runtime shutdown has no owning proxy
context; if it reaches a still-pending slot, the runtime drops that obsolete
reload callback and calls `final` exactly once instead of executing `onReload`
under the bootstrap context.

This fast path is intentionally limited to compiler-generated component bundles,
whose top level is registration-only. The transaction restores déherm's three
registration globals and every live definition on failure; it cannot roll back
arbitrary external side effects performed by hand-written top-level JavaScript.
Application bundles still use the fresh-realm transaction above. Static Hermes
units remain installed in the active runtime and are not resource-reloaded.

## Two native transports and one browser transport

The first implementation should support:

1. **Editor adapter.** Watch and compile, write the generated `.dehermc` inside
   the project, detect `.internal/editor.port`, call the editor hot-reload
   command, and consume the editor console stream. This reuses Defold's build
   cache, resource server, remote-target selection, and exact protocol.
2. **Standalone adapter.** Own a content-addressed `/build` HTTP server, discover
   a debug target through mDNS or `--target host:port`, reboot/launch it with the
   same `resource.uri` shape used by the editor, and send the standard DDF
   `Resource.Reload` POST directly. This requires a real interoperability test;
   generated protocol code or a tiny verified encoder is preferable to a
   hand-maintained payload.
3. **HTML5 adapter - implemented, over CDP rather than a page-owned socket.**
   A browser page cannot expose the native engine service, so the daemon drives
   the page instead of waiting to be called: `packages/cli/src/dev/browser-target.mjs`
   serves the packaged `wasm-web` bundle on a scoped loopback port, opens it in
   a dedicated headless Chrome profile, and pushes each built bundle into the
   page through `globalThis.__defoldHermesDevV1.activate`. The page runs the
   same candidate/commit/rollback lifecycle described above and logs the same
   `DEHERM_EVENT bundle-activated fingerprint=... initial=false` line, so the
   controller joins a browser activation to a build exactly as it joins a native
   one. A page-owned outbound socket would remove the CDP dependency and remains
   the eventual shape; it is not needed for the edit loop.

Because the native engine responds before actual recreation, the controller
must wait for a structured `DEHERM_EVENT` activation or rejection event carrying
the build id, runtime generation, resource version, duration, and reason. The
first version can parse this from the Defold log service/editor console; a
length-prefixed telemetry channel can follow. HTTP success is never shown as a
successful activation.

# Rezi decision

The library the user means is
[`RtlZeroMemory/Rezi`](https://github.com/RtlZeroMemory/Rezi), a TypeScript TUI
framework for Node and Bun with `@rezi-ui/core`, `@rezi-ui/node`, an optional
native Zireael renderer, and test support. It is Apache-2.0 licensed. Its model
is a pure view over application state with `ui.*` widgets and support for
layouts, panels, tables, virtual lists, trees, logs, charts, forms, overlays,
and keybindings. That is a good match for an operator console.

The registry and repository do not currently name the same release:

* npm `latest` for `@rezi-ui/core`, `@rezi-ui/node`, and `@rezi-ui/native` was
  verified as `0.1.0-beta.2` on 2026-09-17. The package metadata requires Node
  18+ or Bun 1.3+ and declares Apache-2.0.
* Repository main at verified commit
  `671a8a2600e5686316e0f124b316b669b33c8654` is prepared as beta.3. APIs present
  only there, including newer inline-terminal helpers, are not published API.
* Rezi describes itself as beta. Its prebuilt native packages cover macOS
  x64/arm64, Windows x64/arm64, and glibc Linux x64/arm64; Alpine/musl is not a
  supported prebuilt target.

Adopt Rezi behind a `DevView` port, pin all published packages to the exact same
beta.2 version, and do not import it when stdin/stdout are not terminals. Every
operation must remain available through a plain line-oriented UI and stable
`--json` event stream. This makes CI, editor integration, accessibility, logs,
and a future TUI replacement independent of Rezi. Repository-only beta.3 APIs
may be used only after a published release or an explicit maintained fork.

Rezi/Zireael performance statements are upstream claims, not Deherm evidence.
Before making it the default interactive view, benchmark idle CPU, key-to-paint
latency, resize behavior, 10,000-line log ingestion, RSS growth, and install
fallbacks on each supported Deherm host.

## Implemented console shape

The operator console is now declarative rather than a fixed grid of static
text. `packages/cli/src/dev/tui/` is authored in TSX against `@rezi-ui/jsx`
(pinned to the same `0.1.0-beta.2` as core and node), imported through an
esbuild module hook registered by `packages/cli/src/dev/tsx-loader.mjs`. esbuild
is already a first-class dependency of the compiler pipeline, so the published
package gains no new toolchain and no build step.

Four properties follow from making every panel wrap exactly one focusable Rezi
widget rather than drawing text:

* **Focus and layers.** Panel focus is Rezi's own focus list, so Tab/Shift-Tab
  traversal and click-to-focus are the framework's. The focused panel's border
  switches to a double rule. Overlays (palette, help, log filter, target and
  generation detail) live on `createLayerStackState`, and `Escape` pops exactly
  one.
* **Panel-owned keys.** Rezi's chord trie stores one binding per sequence and
  evaluates `when` after the match; a rejected guard leaves the event unconsumed
  so it falls through to widget routing. Scoped keys are therefore registered
  once with a focus-scope guard: `up` scrolls the log panel when the log panel
  holds focus and otherwise reaches the focused table's row navigation.
* **Pointer.** Click-to-focus, wheel scrolling of logs and tables, table row
  activation, and the draggable edit-loop/targets divider are all the widget
  runtime's (`routeWheel`, `hitTestDivider`, `handleDividerDrag` inside
  `splitPane` mouse routing). No pointer code is hand-written except log
  selection.
* **Keymap as one source of truth.** `keymap.mjs` declares every key once; the
  footer, the fuzzy command palette, the `?` help overlay, and the registered
  bindings are projections of it. Entries the runtime routes rather than the
  console (Tab traversal, table `Enter`) are declared with their router instead
  of a handler so help stays complete without claiming a binding that does not
  exist.

Selection is the one place the framework is deliberately left behind.
`LogsConsole` has no selection model, so a drag in the log viewport computes a
caret range against the measured rect and swaps in a `VirtualList` whose rows
carry the highlight - windowing, wheel, and keyboard navigation stay with the
framework, and only the caret arithmetic and row painting are hand-written. The
copied text is produced from the same line array that is rendered, so what is
highlighted is byte-for-byte what is copied. Copy is written with OSC 52 through
the backend's raw-write marker so it reaches the operator's clipboard across
SSH, with a local `pbcopy`/`clip`/`wl-copy`/`xclip` fallback; a copy is only
reported when a transport actually accepted it.

The Targets view lists runtime, generation, bundle fingerprint, phase,
per-target telemetry and declared capability gaps with drill-in; the Generations view is the build timeline with bytes,
module delta, duration, and activation outcome, where `built` means produced and
`activated` means a runtime acknowledged that exact fingerprint. The Instances
view renders an explicit "requires runtime instance channel" empty state: the
engine emits `DEHERM_EVENT telemetry` once a second carrying
`component_instances`, `callback_roots`, and `lua_handles` as counts and nothing
that identifies an individual instance, so per-instance rows here could only be
fabricated. Listing identities needs a runtime instance channel, and that
protocol change is owned outside this console.

## The HTML5 target is a peer, not a mode

`w` launches or stops the packaged HTML5 build; `--web` does the same at
session start so a non-interactive run can drive the browser edit loop. Both
targets can run at once, and the Targets view says which runtime each one is,
because they do not measure the same things.

What the browser genuinely reports is reported: live component instances and
the pool capacity, live callback roots and their capacity, the engine's frame
delta where an application lifecycle is attached, and `performance.memory`
under its own `jsHeap*` names. What it cannot report is named with its reason
rather than left blank or filled in - the Hermes heap (there is no Hermes), the
Lua handle registry (inside the Wasm engine, with no export), the value
bridge's arena high-water mark (the generated bridge records none), and the
frame delta for a component-only bundle (the engine calls the host's
application update only through a bootstrap attachment). The target also
declares the gaps that are not counters at all: no typed-native transport, no
engine-service reload, no wasm relink inside the session, and no visual
verification of any kind.

`examples/war-battles-online/integration/check-browser-hot-reload.mjs`
(`pnpm test:html5:war-battles-hot-reload`) runs the shipped CLI in its JSON
event mode, launches the HTML5 target, records the fingerprint the page is
running, edits one TypeScript source, and requires the page to acknowledge the
exact new fingerprint as a non-initial activation. A rebuild that changes
nothing produces the running fingerprint and cannot satisfy it. Recorded as
`examples/war-battles-online/evidence/browser-hot-reload-wasm-web.json`. This
is event and page evidence; no claim is made about what the canvas draws.

The native and browser HMR gates share one local-development launch policy.
Unless `DEHERM_BUILD_SERVER` or `DEFOLD_HERMES_BUILD_SERVER` explicitly names a
different service, they use the repository's pinned Extender at
`127.0.0.1:9010`. This matters when the pinned Defold development SDK has a
newer Extender schema than Defold's production service. A browser build failure
is terminal for the gate and is reported immediately rather than being hidden
behind a target-connect timeout. The gate snapshots and restores its generated
lock and mirrored application artifacts after the complete dev process exits.

# `deherm dev` control plane

## Daemon/controller core

The long-lived controller owns all side effects and exposes an event-sourced
state snapshot to any presentation adapter:

```text
watcher -> content hashes -> resident ttsc Program -> incremental bundle
        -> immutable artifact store -> selected transport -> activation ack
        -> bounded event log/reducers -> Rezi, JSON, VS Code, tests
```

Coalesce file events by canonical path and content hash. Keep the TypeScript
program and bundler context resident, cancel or supersede stale builds, and
publish only the newest successful generation. A diagnostic, bundling,
transport, evaluation, or restore failure leaves the last good runtime active.
Cache entries are deterministic and keyed by toolchain/config digest, Defold
SHA, binding schema, target/profile, source graph, and content. Source-map URLs
stay stable so breakpoints can be reapplied after a generation commit.

Controller collections are bounded: diagnostic snapshot, log ring, API-trace
ring, generation history, counter tables, and profiler sample windows. The TUI
never holds authoritative component/runtime objects and never spawns or kills
compiler/engine processes directly. Commands become typed controller intents
with ids, authorization policy, progress, and terminal result events.

## Staged information architecture

The visual identity is a compact animated basalt/prism `déherm ♥` header, with
animation disabled for reduced-motion or low-refresh terminals. Decoration is
never allowed to delay events or consume unbounded CPU.

**Stage 1 — the edit loop**

* Persistent header: project, target, profile, engine SHA compatibility,
  connection, active/candidate generation, build and activation latency.
* Overview: watcher, ttsc, bundle, transfer, candidate, and commit pipeline with
  current state and most recent result.
* Diagnostics: deduplicated TypeScript/ttsc/bundler/runtime errors with
  file/line/column, generation, source-map origin, and open/copy actions.
* Logs: merged CLI, editor, engine, Hermes, and game streams in a virtualized
  bounded view, with source, severity, generation, search, pause, and export.

**Stage 2 — live game operator view**

* Targets: discovered/local/manual targets, platform, engine SHA, endpoint,
  resource/log reachability, RTT, selected target, and reconnect history.
* Instances: live generated component types and instances, stable ids, owning
  game object, proxy generation, lifecycle state, hot-state bytes, and last
  update/message. Details are paged and sampled, never polled wholesale/frame.
* Generations: build digest, component schema, state migration, commit/rollback,
  retained memory, stale callbacks, rejection reason, and explicit rollback.
* API traces: sampled generated-call ids, family, duration, status, Lua stack
  balance, arena use, and callback generation. Values are redacted/truncated by
  policy; tracing is off or sampled by default.

**Stage 3 — runtime health and profiling**

* Hermes: heap/GC counters, rooted values, callback/timer slots, deferred
  releases, runtime generations, JS exceptions, arena high-water marks, and
  allocations observed on marked hot paths.
* Frame: Defold frame/update/render time, Deherm dispatch time, percentile and
  hitch views, dropped telemetry, and sampled component costs.
* Debug/profiler: Hermes CDP/DAP state, breakpoints needing reapply, sampling
  profile and heap capture controls, browser CDP state, and Defold Remotery link.
* Memory: owned arenas/pools, capacity, high-water, failures, old-generation
  drain status, resource bytes, and leak-test baseline deltas.

**Stage 4 — commands and scaffolding**

* Command palette: reload, full rebuild, reconnect, select target, pause/resume
  telemetry, capture profile, inspect generation, rollback, launch/bundle, and
  copy a reproducible diagnostic report.
* Scaffold wizard: discover project, choose target profiles, preview changes,
  create package configuration, `tsconfig`, source/sample `.script.ts`, generated
  proxy and bundle paths, `game.project` custom resources/settings, and VS Code
  tasks/launch entries. It is deterministic, rerunnable, non-destructive, and
  has equivalent noninteractive flags for CI.

Default keys can include `r` reload, `b` rebuild, `t` targets, `i` instances,
`g` generations, `p` profiler, `d` diagnostics, `l` logs, `:` commands, `?` help,
and `q` detach/quit. Destructive or process-stopping commands require a visible
confirmation and name the exact target.

# Implementation and proof sequence

1. **Resource proof — complete for the direct engine transport:** register one
   `.dehermc` type, load it through the typed factory, modify served bytes, send
   the standard DDF reload, and prove generation 2 executes. Editor-command
   integration and stable proxy/self state are still open.
2. **Headless edit loop — implemented floor:** the event model, coalescing
   incremental bundler, generated-output/cache exclusions, resource-reload
   transport, line/JSON output, Bob change classification, and TUI controller
   intents are implemented. A process test runs these paths from an extracted
   npm artifact: one plain TypeScript edit produces one bundle reload without
   Bob; a component implementation-only edit likewise produces one bundle
   reload without changing its generated Defold proxy; an asset edit and a
   component schema/lifecycle edit each add a Bob build and compiled-resource
   reload; `.internal/cache` produces no work; and
   `--no-launch` suppresses startup while the `p` intent still launches. The
   process fixture substitutes bounded Bob/engine adapters, so it proves the
   installed controller and compiler flow, not packaged-engine activation.
   Native runtime acknowledgements are now fingerprint-bound: the compiler
   embeds the exact SHA-256 in the bundle, the extension reports that same
   fingerprint only after candidate evaluation, `init`, and atomic commit, and
   the controller joins it back to the corresponding build generation. The TUI
   remains at `awaiting-activation` after HTTP 200 and moves to `ready` only for
   that exact runtime acknowledgement; it displays runtime id, Defold resource
   generation, and the fingerprint prefix. Rejected candidates report a
   separate structured event and cannot acknowledge a newer pending build.
   Generated bundle, source-map, bytecode, lock, and proxy writes are excluded
   from watcher feedback. Bob change detection reuses stat identities but hashes
   touched compiled resources before signaling them, so a rewritten identical
   `game.projectc` or shader is not sent to an engine that never loaded it. The
   already-activated `.dehermc` is also removed from the later Bob resource
   batch, preventing a second activation of one compiler generation. The
   companion `.hbc` is a compiler artifact, not an engine-loaded resource, and
   is filtered from the same batch without claiming runtime activation. That
   filtering is conditional on a `reload-signalled` acknowledgement for the
   current native-engine compiler generation; after a failed post, Bob retains
   the bundle resource as the retry path.
3. **Runtime transaction:** add candidate runtime slots, state capture/restore,
   schema validation, atomic commit, rollback, old-generation callback rejection,
   root drain, and bounded arenas.
4. **Native transports:** prove editor-command integration, then direct DDF
   reload against a remote device. Local-engine fingerprint-bound log
   acknowledgements and stale-build suppression are implemented; remote log
   acquisition, disconnect/reconnect, and device identity remain open.
5. **Rezi adapter:** implement Stages 1 and 2 over recorded controller fixtures;
   test its reducer and keybindings with Rezi's deterministic renderer, then run
   PTY/install/performance measurements before enabling it by default.
6. **HTML5 parity:** add the outbound browser transport and run the same
   commit/rollback/state/callback conformance suite in the browser host VM.
7. **Observability and wizard:** add bounded telemetry, CDP/DAP/Remotery status,
   profiler controls, Stages 3 and 4, and dry-run golden tests for scaffolding.

The minimum acceptance suite must demonstrate all of these in a real Defold
debug engine:

* invalid TypeScript, a valid bundle whose evaluation throws, and a failed state
  restore all leave the last good generation running;
* game objects, Lua proxy `self`, stable component ids, and explicitly captured
  component state survive a compatible reload;
* old timers, callbacks, promises, and native roots cannot invoke the new realm
  under a stale generation;
* 1,000 successful and rejected reload cycles return to a bounded memory/root/
  registry baseline under ASan/UBSan and allocation instrumentation;
* native local, native remote-device, and HTML5 paths report activation rather
  than merely transport success;
* hot-path dispatch allocation, arena high-water, dropped telemetry, Lua stack
  balance, and frame impact are visible in both JSON and the console;
* Static Hermes remains tested as the release/AOT profile and is never described
  as source-hot-reloadable.

# Reproduced native rejection and recovery transaction

`npm run test:native-defold:hot-reload` launches the bundled debug engine with
an isolated `DM_SERVICE_PORT`, serves `defold/build/bob`, waits for generation
1 to execute, then runs two resource reloads. Generation 2 throws as the first
statement of its `init()` hook. The extension rejects it and reports generation
1 as retained only after generation 1 completes another update. Generation 3
then changes `add(20, 22)` to `add(40, 44)` and must initialize, finalize the old
generation, activate, and execute an update before the harness restores the
original artifact.

The implemented rollback-safe ordering initializes the candidate before it
finalizes the outgoing generation, so a rejected candidate cannot tear down the
last-good application. The outgoing finalizer now runs inside the same active
game-object context as ordinary script lifecycle code; `go.*` calls are valid.
This ordering deliberately means an outgoing finalizer runs after the accepted
candidate's `init()`. Applications must therefore keep finalizers scoped to
generation-owned resources until the future state-migration transaction can
stage teardown before commit without sacrificing rollback.

The first failing-candidate run exposed a real lifetime bug: the local
candidate `Runtime` was destroyed during C++ exception unwinding before the
retained `jsi::JSError` exception object was destroyed. The later JSError
destructor dereferenced its dead Hermes runtime and crashed. Candidate ownership
now outlives the catch block; the diagnostic is copied while the runtime is
alive, the exception is destroyed, and only then is the candidate discarded.

The required live-engine markers are:

```text
native-defold-hot-reload:transaction-ok
INFO:DEFOLD_HERMES: lifecycle:update:1
ERROR:DEFOLD_HERMES: TypeScript bundle generation 2 was rejected: deherm-hot-reload-rejected-candidate
INFO:DEFOLD_HERMES: TypeScript bundle generation 1 remained active after rejecting generation 2
INFO:DEFOLD_HERMES: module:84
INFO:DEFOLD_HERMES: Activated TypeScript bundle generation 3 from '/deherm/app.dehermc'
```

The first run timed out despite HTTP 200 because a prior Defold process still
owned port 8001: the new engine ran its bundle, but the reload request reached
the stale target. The verifier now reserves a unique loopback port and passes
it through `DM_SERVICE_PORT`. This is why HTTP acceptance is never treated as
activation or rollback evidence.

# Boundaries still to prove

The editor command adapter, mDNS discovery client, remote-device log transport,
browser activation transaction, state capture/restore, broader component state
migration, protobuf telemetry stream, rollback of native side effects performed
before a candidate init failure, and long-run memory/leak limits remain
unproven. Native local activation now has a structured, fingerprint-bound log
acknowledgement. A packaged War Battles run against Defold `7f0f554` observed
runtime profile `default-legacy-bullet` from 315 registered symbols, an initial
activation, two implementation-only `arena.script.ts` edits, exactly one build,
one reload signal, and one matching runtime activation for each edit, continuous
heap/component/Lua-registry telemetry, and no runtime error. The exact
fingerprints were `5de1ceb3...` -> `6334816a...` -> `5de1ceb3...`.

The installed-package soak no longer silently forces `DEHERM_OFFLINE=1`.
That default could combine the package's current stable runtime sources with an
older authenticated generated surface for the same Defold revision; the first
observable result was a native compile failure because the cached handle header
predated `LegacyHandleApi`. The correctness default now refreshes the published
policy, while an explicitly requested offline run still uses the authenticated
cache and fails closed if it is insufficient. The example harness also defaults
to the pinned local Extender at `127.0.0.1:9010`; an explicit build-server
override remains available. The production hosted service currently rejects the
pinned dev SDK's `r8Cmd` field before compilation, so that response is service
compatibility evidence rather than HMR evidence.

That run also made the former state boundary visible: the fresh-realm candidate
constructed a new Hermes component `self` and ran `init` when a live Lua proxy
first dispatched into it. War Battles restarted its match and spawned another
presentation set; observed component counts rose from 51 to 95 to 127.

The native runtime now has a same-realm component-only transaction that removes
that mechanism. Its standalone Dynamic Hermes executable preserves authored
`self` state, uses the replacement lifecycle table without a second `init`,
dispatches exactly one `onReload`, rejects schema/context drift without changing
the active behavior, and completes 1,000 alternating cycles (500 accepted, 500
rejected) with live component/callback counts fixed at their baseline and then
returned to zero. The same executable passes ASan and UBSan.

The first public packed-package soak preserved runtime id `1`, arena instance
`0:1`, and all 19 persistent identities, but its live component set climbed
from 51 to 222 while the simulation population fell. Independent review traced
that measured regression to a re-evaluated module-local arena singleton:
preserving component `self` did not preserve mutable module state, so newly
bound rocket and pickup definitions could no longer find the match and never
reached their deletion checks. That run is retained as negative evidence, not
described as harmless transient churn.

The revision-neutral `hmrPersistentState` cell below now retains the arena
singleton explicitly. A fresh six-edit soak through the packed npm package,
local Extender, Bob, and custom Defold engine kept runtime id `1`, arena
instance `0:1`, and all 19 persistent identities while gameplay advanced to
tick 918. Live component counts were `51, 49, 41, 42, 44, 33, 35`; transient
populations were `32, 30, 22, 23, 25, 14, 16`. Exact identity comparison
observed 56 transient detaches after the first accepted generation, with at
least five in every later transition. The current evidence at
`examples/war-battles-online/evidence/installed-hmr-soak-native.json` is bound
to packed-package tree digest `409b55cd...` and rejects the historical monotonic
accumulation trace.

Each edit window and a post-process-close whole-session sweep fail closed on
error-level JSON events, rejected activations, non-JSON stdout, or stderr, so
startup, inter-edit, and shutdown diagnostics cannot hide behind a successful
fingerprint acknowledgement.
On POSIX the driver probes and reaps the owned process group even after its CLI
leader exits, escalating from `SIGTERM` to `SIGKILL` on group liveness. Windows
uses `taskkill /T`, escalating to `/F`; failure to address the original tree is
an error even when the CLI leader has already exited, because leader exit is
not descendant-exit evidence. Process cleanup failure cannot skip restoration
of the temporary source edit. The installed CLI also rewrites the generated
`deherm.lock` and application bundle artifacts for the harness-only
`arena.script.ts` entry and each temporary source fingerprint. The harness now
snapshots those files before launch and restores their exact pre-run state only
after the owned process tree closes; if one did not exist before the run, the
harness removes the file it created. This keeps a successful or failed HMR
proof from changing the consumer project's next build. These paths are covered
by platform-neutral unit tests while live
Windows cleanup remains host-parity evidence. The standalone
1,000-cycle sanitizer run and installed War Battles
soak remain separately named evidence rather than being promoted into one
another. This closes the measured state-preservation boundary in
[issue #120](https://github.com/ts-defold/deherm/issues/120).

A fresh run of the repaired default installed command completed all six live
component edits without environment overrides. It retained the 40-entity game,
started from 51 live components, emitted seven telemetry samples, and peaked at
56 live components while transient gameplay continued. This proves the packed
npm package, refreshed policy, local Extender build, native engine activation,
fingerprint acknowledgement, and telemetry loop together on this macOS host. It
does not promote non-reloadable Defold resources into in-process HMR: project,
input-binding, and native-extension changes still take the documented rebuild
and graceful engine-restart lane.
The Rezi console exists and has deterministic renderer fixtures, but still
needs PTY/performance/platform evidence. Its focus, layer, pointer, selection,
and keymap behavior is covered by deterministic renderer and lifecycle tests
only; no run against a real PTY has been recorded, so mouse reporting, OSC 52
acceptance, and divider dragging are unobserved on an actual terminal. The
native swap, init-throw rejection recovery, and installed War Battles
state-preservation loop are proven for persistent identity and observed
transient detach; they do not by themselves prove every generated API route.

## Same-realm persistent module state

Revision-neutral projects may opt into `hmrPersistentState(key, create)` from
`@deherm/project`. It stores one caller-keyed mutable cell on the realm-owned
`globalThis.__dehermHmrPersistentStateV1` registry. Re-evaluating a compatible
bundle therefore reuses the cell without retaining a module namespace or
running its factory again; keys are explicit and independent, and an empty key
fails closed. This is deliberately a small state primitive, not an automatic
module cache or a promise to migrate arbitrary class instances.

War Battles' arena-match singleton uses the cell so newly evaluated component
definitions close over the same current match. The installed soak proves the
engine-side transient lifecycle separately through exact disappearing instance
identities; persistent arena identity alone is not promoted to that evidence.
