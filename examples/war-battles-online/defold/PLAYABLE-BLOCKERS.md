# Playable attachment evidence and remaining blockers

The visual slice, deterministic match, public-CLI generation, four-context
typecheck, generated-state verification, headless development build, Bob
resource compilation, and scoped packaged-engine execution now pass.

## Component runtime gate

`main/battle.gui_script` is generated with component ID
`deherm.component/v1/4e16dd70f081489323a1c2caab6c2042c4cd5286d8fe8af207dd4c031b987712`
and context `gui-scene`. It requires the `_deherm_` Lua module to provide:

```text
attachComponent(self, componentId, schemaFingerprint, context, properties)
dispatchLifecycle(self, componentId, lifecycle, ...)
dispatchInput(self, componentId, actionId, action)
detachComponent(self, componentId)
```

The generated global manifest still reports
`state: native-dynamic-hermes-harness-executable` and
`runtimeConformant: false`. The generation-only API readiness gate also keeps
`gameplayExecutionObserved: false`. Neither file is runtime evidence and neither
is promoted from this one example run.

The first pinned Bob arm64-macOS bundle was also launched on 2026-09-18. Defold
1.14.0 loaded the archive, initialized Vulkan, sound, and physics, then stopped
the GUI component at the generated proxy boundary with the exact diagnostic:

```text
main/battle.gui_script:18: attempt to index global '_deherm_' (a nil value)
Error when initializing gui component: RESULT_SCRIPT_ERROR.
```

That executable was the 7,993,552-byte vanilla engine. Its build said
`Downloading 0 archives`, and neither `nm` nor `strings` found a deherm
registration/provider marker. The example had not exposed the native extension
directory to Bob.

The example now exposes the monorepo extension through the local
`defold_hermes` dependency link, exports it from `[library]`, and sets
`script.shared_state = 1` so a generated GUI proxy participates in the Lua
state where a native provider is registered. Bob's `--debug-ne-upload` archive
contains `defold_hermes/ext.manifest`, `src/extension.cpp`, and the packaged
`lib/arm64-osx/libhermes.a`; Bob therefore selects a custom-engine build rather
than silently emitting another vanilla executable.

A fresh custom engine was subsequently built through the pinned local Extender.
The fail-closed harness launched it from `defold/build/default`, observed Defold
1.14.0, exact profile detection, bundle generation 1, and the game-owned marker
`war-battles-runtime:gui-init-rendered:32:160`, then observed another 1.5 seconds
and required `war-battles-runtime:first-update-rendered:32:160` without
error/fatal/script/traceback/bundle/component-runtime diagnostics. The first
marker occurs after TypeScript `init` resolves the fixed GUI pools, performs the
first render, and posts input focus; the second follows the first update/render.
The harness then sent SIGTERM and verified the actual process result
`exitCode: null, signal: SIGTERM`. Exact extension/project source inputs,
engine/archive/compiled-project/bundle outputs, and a canonical transcript
digest are stored in
`../evidence/packaged-runtime-arm64-macos.json` without a timestamp.

The dependency link is intentionally a monorepo development layout. A
standalone distribution must replace it with a versioned Defold library archive
whose root exports `defold_hermes`, then put that archive URL in
`project.dependencies#N`; merely retaining `[library].include_dirs` does not
download or vendor an extension.

## Required GUI routes

The example deliberately uses only predeclared GUI nodes. The current lowering
plan marks every route below as an existing generated entry selecting the
Dynamic Hermes backend. There is no remaining stable-ID lowering blocker in the
authored gameplay surface. The calls below execute during the observed TypeScript
initialization and first render through the packaged GUI-scene provider:

| Stable API ID | TypeScript signature used here |
| --- | --- |
| `script:gui.get_node` / `0x1e65bc4e` | `gui.getNode(id: string \| DefoldHash): Node` |
| `script:gui.set_position` / `0x57e22c89` | `gui.setPosition(node: Node, position: Vector3 \| Vector4): void` |
| `script:gui.set_enabled` / `0x148567ab` | `gui.setEnabled(node: Node, enabled: boolean): void` |
| `script:gui.set_color` / `0x289cacf1` | `gui.setColor(node: Node, color: Vector3 \| Vector4): void` |
| `script:gui.set_size` / `0x4f947bcf` | `gui.setSize(node: Node, size: Vector3 \| Vector4): void` |
| `script:gui.set_text` / `0x5843c90d` | `gui.setText(node: Node, text: string \| number): void` |
| `script:gui.set_euler` / `0xe9adddd7` | `gui.setEuler(node: Node, rotation: Vector3 \| Vector4): void` |
| `script:msg.post` / `0x4243998f` | `msg.post(receiver, messageId, message?): void` |

Two value constructors are also needed by every visual update:

| Stable API ID | Signature |
| --- | --- |
| `script:vmath.vector3` / `0xd01e1ade` | `vmath.vector3(x?: number, y?: number, z?: number): Vector3` |
| `script:vmath.vector4` / `0xd31e1f97` | `vmath.vector4(x?: number, y?: number, z?: number, w?: number): Vector4` |

The same plan selects Dynamic Hermes for those constructors and for
`script:hash`/`0xa994c4c0`; their use precedes the observed marker. This proves
the exact War Battles path, not every overload or API input shape.

## Optional routes intentionally avoided

Runtime GUI allocation is unnecessary for this slice. These routes are now
generated Dynamic Hermes entries but are not called:

| Stable API ID | Signature |
| --- | --- |
| `script:gui.new_box_node` / `0xfdb31d1e` | `gui.newBoxNode(position, size): Node` |
| `script:gui.new_text_node` / `0x2d7bdf44` | `gui.newTextNode(position, text): Node` |

The fixed scene pool is retained as a deterministic, bounded presentation
choice rather than a lowering workaround. It does not remove the component/GUI
provider requirement above.

## Online boundary

This scene currently runs the authoritative simulation locally with 31 bots.
No Defold WebTransport client is attached. Browser WebTransport, Deno, Quinn,
Colyseus H3, WebRTC, and WebSocket adapters remain behind the existing typed
transport boundary and retain their documented protocol labels. Offline bot
play is not presented as network evidence.
