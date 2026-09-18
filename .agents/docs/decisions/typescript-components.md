---
type: Architecture Decision
title: TypeScript game-object components
description: Preserve Defold's attach-a-script workflow with generated proxy resources before graduating to a native component type.
tags: [defold, hermes, typescript, components, lifecycle]
status: accepted-for-first-game
generated: { by: codex/gpt-5, at: 2026-09-17T00:00:00-04:00 }
sources:
  - id: dmsdk-component
    resource: upstream/defold/engine/gameobject/src/dmsdk/gameobject/component.h
    title: Defold component type API
    author: team:defold
---

# Decision

The authored game-object component resource is `*.script.ts`. GUI and render
components use the parallel `*.gui.ts` and `*.render.ts` conventions. The first
production backend generates sibling Defold `.script`, `.gui_script`, and
`.render_script` proxies whose only job is to bind the correct Defold execution
context to the TypeScript component instance.
Application authors attach the generated resource exactly as they attach any
other Defold script. They write no proxy Lua and no gameplay Lua.

A later backend may register a native `.deherm` component/resource type through
dmSDK. Both backends consume the same component manifest and present the same
TypeScript contract, so game code does not change when the native component is
ready.

# Authoring contract

An application module exports a component definition rather than process-wide
singleton hooks. A representative shape is:

```ts
export default defineComponent({
  properties: {
    speed: property.number(120),
    projectile: property.factory("/main/projectile.factory"),
  },
  init(self) {},
  update(self, dt) {},
  final(self) {},
  onMessage(self, messageId, message, sender) {},
  onInput(self, actionId, action) {},
  onReload(self) {},
});
```

The exact public syntax remains generator-owned and may become class- or
function-based. The semantic requirements do not change:

* one state object per Defold component instance;
* typed properties initialized from Defold's authored/spawned properties;
* correct current-instance behavior for Lua-only API calls;
* stable component and game-object URLs;
* deterministic destruction and callback/root release;
* hot reload that can migrate or recreate instances explicitly.

# Generated artifacts

For each context-suffixed entry, generation emits:

1. a component manifest with the module id, schema fingerprint, lifecycle
   capabilities, property codecs, and target availability;
2. a minimal sibling proxy of the matching Defold resource kind with lifecycle
   forwarding; only `.script` proxies may contain generated `go.property(...)`
   declarations;
3. a bundled TypeScript module-registration record;
4. native and browser dispatch metadata keyed by stable component type id;
5. compile-time TypeScript types for the component's `self`, properties,
   messages, inputs, and spawned-property overrides.

Render scripts expose no `final` or `on_input` callback in the pinned Defold
function table. The generator rejects those hooks in `*.render.ts`, emits no
fake finalizer, and records teardown as requiring an unimplemented render
attachment provider. GUI and game-object contexts support all six ordinary
lifecycle callbacks.

The native/browser registration records and manifests live below
`.deherm/generated/` and are safe to delete and regenerate. The proxy is
placed beside its source so `player.script.ts` has the editor-facing
`player.script` path Defold users expect. It contains a generator marker,
source-relative path, source hash, schema fingerprint, and no user-owned
regions. Generation refuses to overwrite a sibling that lacks the marker.
Check mode fails on missing or stale proxies.

VS Code owns source editing, TypeScript diagnostics, hovers, transforms, and
debugging. Without a Defold editor plugin, the Defold editor indexes the
generated `.script`, not the `.script.ts` source. A future editor plugin may
associate the two resources, but the build does not depend on it.

# Runtime model

This section is the required model, not current runtime evidence. The generated
capability gate presently reports zero executable component-proxy methods and
fails all six Lua entry points closed until the model below exists.

Instance identity is a 64-bit logical value represented as index plus
generation. Dense SoA storage tracks the native/Lua instance reference,
TypeScript root, component type, lifecycle mask, and state flags. Destruction
increments the generation before a slot is reused, making stale queued events
fail closed.

Game-object and GUI proxies forward create/init, update, final, message, input,
and reload. Render proxies forward init, update, message, and reload; their
provider owns teardown because Defold supplies no render-script final callback.
Hot
paths enqueue fixed-layout events into bounded per-world buffers; a single
bridge entry drains a dense batch into Hermes. Initialization and calls that
must synchronously return a Defold result can use a direct path. No normal-frame
operation may allocate native heap storage after pool warm-up.

For Lua-backed API calls, dispatch temporarily restores the exact proxy script
instance before invoking the cached Lua closure, then restores the prior stack
and instance even when the call fails.

# Why the proxy comes first

The proxy preserves behavior Defold already implements for script components:

* editor attachment to game objects and collections;
* factory/collection-factory creation;
* script property authoring and spawned-property overrides;
* message/input routing and component URLs;
* script lifecycle timing and reload callbacks.

Registering a custom native component is technically possible through dmSDK,
but it also requires resource loading, component world ownership, creation,
update, message/input routing, property get/set/iteration, reload behavior,
inspection, and build/editor asset handling. That backend becomes eligible only
after its generated harness reproduces the proxy backend's observable contract.

# Performance boundary

The proxy adds one Lua-to-native dispatch at each forwarded lifecycle boundary.
It must not add one Lua transition per engine API call: once TypeScript owns the
instance, direct dmSDK bindings handle APIs with native equivalents, and the
cached Lua compatibility dispatcher handles only script-only behavior.

The generated conformance report records bridge transitions, batch sizes,
allocation counts, pool high-water marks, and time per lifecycle phase. A
native component backend is adopted when measurements show the proxy boundary
is material or when an engine feature cannot be represented correctly by a
normal script proxy.

# Release gates

* Two instances of one component retain independent state and properties.
* Factory-created and collection-created instances behave identically to
  editor-authored instances.
* Every lifecycle callback has ordering and exception tests.
* Messages, input, URLs, hashes, properties, and current-instance calls round
  trip with differential Lua fixtures.
* Destruction releases all Hermes roots and callback handles; stale handles are
  rejected after slot reuse.
* Native and browser profiles pass the same component trace.
* Sanitizers and repeated create/destroy soak tests report no leaks or invalid
  access, and hot update/message paths stay within their allocation budgets.
