---
type: Research Note
title: Real Defold extension candidates for the War Battles showcase
description: Survey of the published Defold asset ecosystem against deherm's ingestion paths, platform requirements, license provenance, and pinnability, with a recommended adoption order and the generator gaps real extensions expose.
tags: [research, extensions, ecosystem, war-battles, script-api, header-ingestion, html5, provenance]
status: active
generated: { by: claude/opus-5, at: 2026-09-18T00:00:00-04:00 }
sources:
  - id: asset-portal
    resource: https://github.com/defold/asset-portal/tree/17a1f3d8a3f50e7840fbb6677465d1cb7799a15e
    title: Defold asset portal index at survey revision
    author: team:defold
  - id: extension-websocket
    resource: https://github.com/defold/extension-websocket/tree/d8c3ececc7ab2aa097b2aff9f9f273f2bf7da2ca
    title: Defold WebSocket extension
    author: team:defold
  - id: extension-websocket-api
    resource: https://github.com/defold/extension-websocket/blob/d8c3ececc7ab2aa097b2aff9f9f273f2bf7da2ca/websocket/api/api.script_api
    title: WebSocket .script_api declaration surface
    author: team:defold
  - id: defold-xmath
    resource: https://github.com/thejustinwalsh/defold-xmath/tree/f1f27eff87d66e11521aff310e0522ac6cd7c5d6
    title: xMath allocation-free math extension
    author: person:thejustinwalsh
  - id: defold-xmath-api
    resource: https://github.com/thejustinwalsh/defold-xmath/blob/f1f27eff87d66e11521aff310e0522ac6cd7c5d6/xmath/api/xMath.script_api
    title: xMath .script_api declaration surface
    author: person:thejustinwalsh
  - id: defold-astar
    resource: https://github.com/selimanac/defold-astar/tree/1471c5445b0c0376bd23c377e8ef8d84e52b43bf
    title: A* Path Finding native extension over MicroPather
    author: person:selimanac
  - id: defold-daabbcc
    resource: https://github.com/selimanac/defold-daabbcc/tree/125211aa3faae7db62ba0e0c37d6aedfb612119c
    title: DAABBCC dynamic AABB broadphase native extension
    author: person:selimanac
  - id: extension-imgui
    resource: https://github.com/britzl/extension-imgui/tree/b865344693d4b1f8cd3fae6ab97d50fe02703c4b
    title: Dear ImGui Defold extension
    author: person:britzl
  - id: druid
    resource: https://github.com/Insality/druid/tree/95f1ca9c9b6ce1df443e71a2a420892d37971c94
    title: Druid GUI component framework
    author: person:insality
  - id: defold-orthographic
    resource: https://github.com/britzl/defold-orthographic/tree/387370806f7689114ade6d77f98a4341e6b5c062
    title: Orthographic camera library
    author: person:britzl
  - id: defold-rendy
    resource: https://github.com/whiteboxdev/library-defold-rendy/tree/3817110e27d893b1c41f89a974df3e841de6b6e6
    title: Rendy camera and render pipeline library
    author: person:whiteboxdev
  - id: nakama-defold
    resource: https://github.com/heroiclabs/nakama-defold/tree/dc42c3ff47a8447cda9d2320fbc12ad6e1ec441e
    title: Nakama Defold client
    author: org:heroiclabs
  - id: colyseus-defold
    resource: https://github.com/colyseus/colyseus-defold/tree/90c50d21204ee0d403fa4f5b322fb564c1ada3e8
    title: Colyseus Defold client
    author: org:colyseus
  - id: discovery-decision
    resource: ../decisions/project-extension-discovery.md
    title: Discover project extensions before generating project bindings
    author: team:ts-defold
  - id: header-generator
    resource: native-extension-header-generator.md
    title: Native extension header ingestion and generated ABI glue
    author: team:ts-defold
  - id: discovery-implementation
    resource: ../../../packages/cli/src/project.mjs
    title: Extension discovery, manifest parsing, and .script_api capture
    author: team:ts-defold
  - id: script-api-projection
    resource: ../../../packages/cli/src/generate.mjs
    title: .script_api type normalization and TypeScript projection
    author: team:ts-defold
  - id: war-battles-roadmap
    resource: ../roadmap/war-battles-showcase.md
    title: War Battles TypeScript showcase roadmap
    author: team:ts-defold
  - id: generated-script-inventory
    resource: ../../../packages/bindings/generated/defold-script-api-inventory.json
    title: Generated Defold script API inventory including the built-in camera module
    author: team:ts-defold
---

# Why this survey exists

deherm's product claim is that a third-party Defold extension is *ingested*, not
hand-bound. Today that claim rests on synthetic fixtures: one four-function C
header for the Clang lane and the repository's own `defold_hermes` extension for
discovery. Adopting a real published extension is simultaneously a feature the
War Battles showcase needs and the only honest end-to-end test of the ingestion
pipeline.

The survey was run against the asset portal index at
`17a1f3d8a3f50e7840fbb6677465d1cb7799a15e` (321 published assets, 230 of which
declare HTML5) and verified against each candidate's actual repository tree
rather than its portal description.

# The structural finding that reorders everything

**Most of the Defold ecosystem is invisible to deherm, and that is a property of
the ecosystem, not a defect in discovery.**

`packages/cli/src/project.mjs` roots discovery at `ext.manifest`: local
extensions are found by walking for `ext.manifest`, and dependency ZIPs are
filtered to `ext.manifest`, `.script_api`, `include/**.h*`, and
`src|commonsrc/**.c*`. A Defold *library* that ships only `.lua` modules has
none of those, so it produces no inventory entry, no IR, and no declarations.

Of the 61 most-starred distinct GitHub-hosted portal assets:

| Surface | Count | Meaning for deherm |
| --- | ---: | --- |
| Ships `ext.manifest` (native extension) | 18 | Enters the inventory |
| Ships any `.script_api` | 12 | Reaches the mature Lua-shaped path |
| Pure Lua library, no manifest | 43 | Not discoverable at all |

Every one of the community's marquee gameplay libraries - Druid, Orthographic,
Monarch, Gooey, Defold-Input, Rendy, Panthera, Tweener, the Nakama and Colyseus
clients - is in that 43. They are consumed from TypeScript today only by
declaring types by hand, which is exactly the thing deherm exists to eliminate.

That splits the recommendation into two independent tracks, and they should not
be conflated:

1. **Extensions worth adopting to exercise ingestion.** Native, `.script_api` or
   header bearing, HTML5 capable, pinnable. This is the product test.
2. **Pure-Lua libraries worth adopting for the game.** These need a *separate*
   decision about whether deherm grows a Lua-module ingestion route (annotations
   or hand-reviewed declaration packages), because today they bypass the
   compiler entirely.

# Recommendation table

| Candidate | Role | Ingestion path | HTML5 | License | Pinned revision | Verdict |
| --- | --- | --- | --- | --- | --- | --- |
| [xMath](https://github.com/thejustinwalsh/defold-xmath) | Allocation-free vmath | `.script_api` (mature) | yes | MIT | `f1f27eff87d66e11521aff310e0522ac6cd7c5d6` | **Adopt first** - smallest honest real-world ingestion |
| [extension-websocket](https://github.com/defold/extension-websocket) | Stage 2 transport | `.script_api` + C/C++ headers | yes (Emscripten `-lwebsocket.js`) | MIT | `d8c3ececc7ab2aa097b2aff9f9f273f2bf7da2ca` | **Adopt for Stage 2** - only first-party, all-platform transport |
| [defold-astar](https://github.com/selimanac/defold-astar) | Bot pathfinding | `.script_api` + C++ headers | yes | unstated in repo (see risk) | `1471c5445b0c0376bd23c377e8ef8d84e52b43bf` | **Adopt for Stage 3**, blocked on license clarification |
| [DAABBCC](https://github.com/selimanac/defold-daabbcc) | 32-player broadphase | headers only, no `.script_api` | yes | MIT | `125211aa3faae7db62ba0e0c37d6aedfb612119c` | **Adopt as header stress case**, not as a dependency yet |
| [extension-imgui](https://github.com/britzl/extension-imgui) | Dev overlay | `.script_api` (73 KB) | yes | MIT | `b865344693d4b1f8cd3fae6ab97d50fe02703c4b` | **Adopt as scale test**, dev profile only |
| Built-in `camera.*` | Stage 1b camera | already generated | yes | Defold | `upstream.lock` | **Use instead of a camera extension** |
| [Druid](https://github.com/Insality/druid) | GUI framework | none - pure Lua | yes | MIT | `95f1ca9c9b6ce1df443e71a2a420892d37971c94` | Defer - needs a Lua-module route first |
| [Nakama](https://github.com/heroiclabs/nakama-defold) / [Colyseus](https://github.com/colyseus/colyseus-defold) | Multiplayer stack | none - pure Lua over the websocket extension | yes | Apache-2.0 / MIT | `dc42c3ff…` / `90c50d21…` | Defer to a Stage 2 protocol decision |
| [Orthographic](https://github.com/britzl/defold-orthographic), [Rendy](https://github.com/whiteboxdev/library-defold-rendy) | Camera | none - pure Lua | yes | MIT / Zlib | `38737080…` / `3817110e…` | Not recommended - superseded by built-in camera |

# Stage 1b needs no camera extension

The roadmap's Stage 1b asks for follow, bounds clamping, zoom, and
screen-to-world conversion. The generated script inventory already contains the
engine's own camera module, including `camera.screen_to_world`,
`camera.screen_xy_to_world`, `camera.world_to_screen`,
`camera.get_orthographic_zoom` / `camera.set_orthographic_zoom`,
`camera.get_view`, `camera.get_projection`, and `camera.get_cameras`.

Orthographic and Rendy predate or duplicate that engine feature, and both are
pure-Lua libraries with no ingestible surface. Adopting either would mean
hand-writing declarations for a capability deherm already generates, while
adding nothing to the ingestion story. Follow, look-ahead, and world-edge
clamping are gameplay arithmetic that belongs in TypeScript on top of the
generated camera routes.

This is the single most consequential conclusion of the survey: **the highest
priority item on the extension wish list turns out not to need an extension.**

# Per-candidate assessment

## xMath - adopt first

* **Repository** `https://github.com/thejustinwalsh/defold-xmath`, revision
  `f1f27eff87d66e11521aff310e0522ac6cd7c5d6`, release `v1.0.1` (2026-07-11).
* **Ingestion path** Mature `.script_api`. Layout is
  `xmath/ext.manifest` (name `xMath`, no platform contexts),
  `xmath/api/xMath.script_api` (425 lines, 37 functions), `xmath/src/xMath.cpp`.
  No `include/` directory, so it takes the `.script_api` route exclusively -
  `bindingStatus` will be `script-api`, not `script-api+native-schema-required`.
* **Platforms** android, ios, macos, windows, linux, html5. The manifest
  declares no platform-specific context, so it compiles uniformly everywhere.
* **License** MIT, `LICENSE` present at the repository root. Attribution is the
  standard MIT copyright notice; record it as
  `licenses/defold-xmath-MIT.txt` alongside the existing War Battles license
  files.
* **Maintenance** 36 stars, low issue volume, CI and release workflows present,
  authored by this project's own maintainer - which makes it a low-risk first
  adoption where upstream fixes are actionable rather than a waiting game.
* **Why it is the right first ingestion** It is small enough to review
  exhaustively, and its surface is *exactly* the shape deherm already has
  runtime evidence for: Defold `vector3` / `vector4` / `quaternion` / `matrix4`
  values. The repository has already proven five generated POD vmath calls
  against a packaged engine, so a failure here is attributable to ingestion
  rather than to value marshalling.
* **What it will break** See the generator gaps section - xMath uses YAML list
  unions (`type: [vector3, vector4]`) and named Defold value types, and today
  both degrade silently to `unknown`.

## extension-websocket - adopt for Stage 2

* **Repository** `https://github.com/defold/extension-websocket`, revision
  `d8c3ececc7ab2aa097b2aff9f9f273f2bf7da2ca`, release `4.2.4` (2026-08-22).
* **Ingestion path** Both. `websocket/api/api.script_api` (178 lines, 27 named
  entries) drives the mature path, while `websocket/include/wslay/*.h` (8 C
  headers) and `websocket/src/*.cpp` mean discovery will classify it
  `script-api+native-schema-required`. The wslay headers are plain C, which is
  the friendliest possible input for the Clang lane - but they are the *vendored
  transport library*, not the extension's public Lua surface, so header
  ingestion here is a bonus test, not the route the game uses.
* **Platforms** all, including HTML5. The manifest's `web` context adds
  `linkFlags: ["-lwebsocket.js"]`, and `src/emscripten_callbacks.cpp` implements
  the browser path against Emscripten's WebSocket library. This is the only
  first-party Defold transport that covers native macOS, AOT/Static, and
  HTML5 from one API.
* **License** MIT (`LICENSE.md`). The vendored `wslay` sources carry their own
  MIT notice and must be recorded separately - two attribution entries, not one.
* **Maintenance** Maintained by the Defold Foundation, 3 open issues, CI through
  `defold/github-actions-common`, 51 stars (low for its importance because it is
  infrastructure).
* **Why it matters** Stage 2's transport decision is explicitly deferred in the
  roadmap, and the roadmap requires that any chosen native extension be
  *ingested* rather than hand-bound. This is the extension that clause was
  written for.
* **What it will stress** Its `.script_api` is the hardest real Lua-shaped
  surface in the ecosystem: a `connect(url, params, callback)` whose `params` is
  a nested table described with `members:`, whose `callback` receives
  `(self, connection, data)` with `data` itself a nested `members:` table, and
  whose `connection` is an opaque `object`. That touches the callback-lifecycle
  frontier (25 callback routes), the Lua-table record frontier, and opaque
  handle ownership all at once. Expect blockers - and expect them to be the
  useful output.

## defold-astar - adopt for Stage 3, license first

* **Repository** `https://github.com/selimanac/defold-astar`, revision
  `1471c5445b0c0376bd23c377e8ef8d84e52b43bf`, release `v1.2.3` (2026-04-16).
* **Ingestion path** `.script_api` present at `astar/api/astar.script_api`, plus
  `astar/include/micropather/*.h` and `astar/include/pather.h`, so
  `script-api+native-schema-required`. The `.script_api` itself is the most
  tractable real surface found: numbers, integer-domain ids, named constants
  (`astar.DIRECTION_FOUR` / `DIRECTION_EIGHT`), and numeric-array returns. It
  sits almost entirely inside the already-proven scalar/enum lane.
* **Platforms** CI builds `armv7-android`, `arm64-android`, `x86_64-linux`,
  `arm64-linux`, `js-web`, `wasm-web`, `wasm_pthread-web`, `x86_64-win32`,
  `x86-win32`, `arm64-macos`, `x86_64-macos`, `arm64-ios`. HTML5 is covered by
  three of those targets, which is stronger evidence than a portal claim.
* **License - open risk** The repository contains **no `LICENSE` file** and the
  GitHub licence API returns 404 for it. The asset portal entry claims "MIT
  License" and the README credits MicroPather without restating terms.
  MicroPather itself is zlib-licensed. Under this repository's provenance rules
  that is not adoptable as-is: the exact license text and the MicroPather
  attribution must be obtained from upstream (an issue or PR adding `LICENSE`)
  before it enters `licenses/`.
* **Maintenance** 111 stars, 1 open issue, active through April 2026, ships
  `AGENTS.md` and Lua annotations - a well-kept project.
* **Value to the game** Stage 3's "bots capable of filling all 32 slots" needs
  grid pathfinding on the tilemap. Writing A* in TypeScript is possible;
  adopting a C extension for it is the more interesting test.

## DAABBCC - adopt as the header stress case

* **Repository** `https://github.com/selimanac/defold-daabbcc`, revision
  `125211aa3faae7db62ba0e0c37d6aedfb612119c`, release `v3.0.8` (2026-04-24).
* **Ingestion path** **Header-only, and deliberately so.** It ships
  `daabbcc/ext.manifest`, seven headers under `daabbcc/include/daabbcc/`, six
  `.cpp` sources - and **no `.script_api`**. Its Lua surface is documented in
  `daabbcc/annotation.lua` (a Lua-LSP annotation file), a convention deherm does
  not read. Discovery will therefore classify it `native-schema-required` and
  emit no declarations at all.
* **What the headers contain** `daabbcc.h` opens `namespace daabbcc`, defines
  `struct ManifoldResult` and `struct GameUpdate` with default member
  initializers, embeds `b2Vec2` by value, and includes `dmsdk/dlib/array.h` and
  `dmsdk/dlib/hashtable.h` - C++ templates from the engine SDK. Against the
  documented header-lane blockers (C++ methods, templates, by-value record
  layout, pointer ownership) this is close to a worst case. That is precisely
  why it is valuable: it should produce a *large, exact, machine-readable
  blocker set*, and the quality of that blocker set is the deliverable.
* **Platforms** same CI matrix as astar, HTML5 included. `ext.manifest` sets
  `-std=c++11` for all platforms.
* **License** MIT (`LICENSE.md`). Note the vendored Box2D-derived dynamic-tree
  code, which carries its own MIT attribution.
* **Recommendation** Adopt it as a *fixture for the header lane*, checked into
  the ingestion test corpus, not as a runtime dependency of War Battles. Its
  real gameplay value (broadphase for 32 players) only unlocks after the
  `defold-hermes.bindings.json` schema escape hatch exists, or after upstream is
  persuaded to ship a `.script_api` beside its annotations - which is a
  reasonable upstream contribution to offer.

## extension-imgui - adopt as the scale test

* **Repository** `https://github.com/britzl/extension-imgui`, revision
  `b865344693d4b1f8cd3fae6ab97d50fe02703c4b`, release `2.14.0` (2026-05-25).
* **Ingestion path** `.script_api` at `imgui/api/imgui.script_api`, **73,438
  bytes** - by a wide margin the largest real `.script_api` in the ecosystem,
  plus 11 headers. No other candidate tests whether the mature path scales,
  whether name projection collides, or whether the inventory stays diff-clean at
  that size.
* **Platforms** all, HTML5 included. 84 stars, MIT.
* **Recommendation** Adopt for the development profile only. A debug overlay is
  genuinely useful for the 32-bot soak described in the roadmap's verification
  section, and it must not be linked into release bundles.

# Pure-Lua libraries the game wants but cannot ingest

These are real gaps in the *game's* wish list that the extension ecosystem does
not fill in an ingestible form. Listing them is the point, not adopting them.

* **GUI framework.** Druid (595 stars, MIT, all platforms, released 1.3.1 on
  2026-09-07, revision `95f1ca9c9b6ce1df443e71a2a420892d37971c94`) is the
  ecosystem's clear winner and has no `ext.manifest`. Gooey and Dirty Larry are
  the same shape. Meanwhile this repository already has a
  [React-over-Defold-GUI](react-defold-gui.md) direction which is a better fit
  for a TypeScript showcase than binding a Lua widget framework.
* **Screen management.** Monarch (218 stars, MIT, revision
  `954097522e7c2d4a710464dd9e8b48fb309685ab`) - pure Lua.
* **Input and gestures.** Defold-Input (168 stars, MIT, revision
  `8e34460ec15f3ac4609543f8c1b9968ad33e7934`) - pure Lua, and most of what it
  provides is gesture arithmetic over the engine's own `on_input`, which the
  generated bindings already deliver.
* **Tweening.** Defold Tweener (64 stars, MIT, revision
  `18dc800a115d55bbf89391ba90bba1cd26135a8a`, last commit 2025-11-25, no tagged
  releases) - pure Lua, and the engine's own `go.animate` / `gui.animate` cover
  most of the roadmap's needs.
* **Multiplayer stacks.** Nakama (Apache-2.0, revision
  `dc42c3ff47a8447cda9d2320fbc12ad6e1ec441e`, very active, but last tagged
  release `v3.4.0` in September 2024) and Colyseus (MIT, revision
  `90c50d21204ee0d403fa4f5b322fb564c1ada3e8`, release `0.18.1` on 2026-09-13)
  are both pure-Lua clients that sit *on top of* extension-websocket. Adopting
  either is a protocol architecture decision for Stage 2, not a binding
  decision, and the roadmap's server-authoritative fixed-tick design may well
  argue for a bespoke protocol over the websocket extension instead.

The honest conclusion is that a Lua-module ingestion route - reading
`annotation.lua` / Lua-LSP annotations, or accepting a reviewed declaration
package per library - is worth its own decision record. It would open 43 of the
61 top assets rather than 18, and it is the difference between deherm binding
*Defold* and deherm binding *the Defold ecosystem*.

# Not recommended, and why

| Candidate | Reason |
| --- | --- |
| Orthographic, Rendy, Starly, Operator | Camera duplicated by the engine's own `camera.*` module, which is already generated. Pure Lua, no ingestible surface. Rendy is Zlib, Operator MIT - licensing is not the objection. |
| Nakama, Colyseus | Pure Lua. Valuable, but they are Stage 2 architecture, and they depend on extension-websocket anyway - adopt the layer that is ingestible. Nakama's tagged releases lag its commits by two years, which complicates pinning to a release rather than a SHA. |
| Photon Realtime (`defold/extension-photon-realtime`) | **Disqualified on platforms**: iOS, Android, Windows, Linux, macOS - no HTML5. 225 vendored headers of C++ SDK. Fails the hard filter for core gameplay. |
| Photon Fusion | 3 stars, negligible adoption, and the same C++ SDK shape. |
| `extension-webrtc` (VitusVeit) | HTML5 **only**. The inverse disqualification: it cannot serve native macOS dev or the Static profile. |
| `defold-tiny-http` | No HTML5. |
| DefOS | CC0-1.0, has a `.script_api`, all platforms claimed - but its entire purpose is desktop window/OS manipulation, and 30 open issues is the highest in the survey. No gameplay value for a top-down 2D multiplayer game. |
| `defold-graph-pathfinder` | **License is disqualifying for this repository**: "free non-monetized; paid per commercial title". Custom, non-OSI, per-title commercial terms cannot be recorded as clean provenance. Use `defold-astar` instead. |
| Tiled | GPL, and it is an external editor, not a runtime extension. |
| `extension-spine`, `extension-rive` | Both ship `.script_api` and are first-party, but Rive vendors 1,062 headers and both solve animation problems War Battles does not have. Rive would be a defensible *future* scale test; it is not a showcase dependency. |
| `defold-luasocket`, `defold-websocket` (britzl) | Superseded by the official extension. britzl's websocket library last moved in 2020. |
| `defold-yoga` | Overlaps the React-GUI direction's own Yoga/Clay tradeoff, which is an open decision in this repository. Adopting it would prejudge that decision. |

# Binding surface and relink impact

Every native extension in the list forces an Extender rebuild and a full engine
relink for **each** target profile this project builds: native macOS arm64
(dynamic Hermes), the Static/AOT profile, and `js-web`/`wasm-web`. That cost is
per-extension-set, not per-extension, so the ordering matters more than the
count. Flagging the cases where surface growth is material:

* **xMath** - negligible. One `.cpp`, 37 functions, no vendored dependencies.
  Adds one small object file per target. This is the cheapest possible relink.
* **extension-websocket** - moderate. Adds wslay (6 `.c` files plus headers) and
  ~8 C++ sources, plus a browser link flag. Bundle growth is real but bounded,
  and the HTML5 path pulls in Emscripten's own websocket library rather than a
  vendored TLS stack.
* **defold-astar** - moderate. MicroPather is 5 `.cpp` files. Self-contained.
* **DAABBCC** - moderate in bytes but **large in binding surface**: seven public
  headers of C++ with engine-SDK template dependencies. If it is ever promoted
  from fixture to dependency, expect the blocker ledger rather than the binary
  to be the cost centre.
* **extension-imgui** - **large, and release-disqualifying**. Dear ImGui plus
  stb image, 11 headers, a 73 KB declaration surface, and a renderer. Gate it
  behind the development profile in the app manifest so it never reaches the
  Static or HTML5 release bundles, and treat any measurement of release bundle
  size taken with imgui linked as invalid.

Recommended adoption order, one at a time with a relink and a
generated-state diff between each: **xMath → extension-websocket → defold-astar**,
with **DAABBCC** and **extension-imgui** entering the ingestion corpus without
being linked into the game.

# Generator gaps this survey exposes

> **Status update.** All four gaps below were confirmed by executing
> `deherm generate` over the real xMath and defold-astar files and are now
> fixed, with a regression test each. Ingestion also surfaced three further
> defects this reading did not predict - a member declaring a call signature
> without `type: function`, optionality spelled as a trailing `[optional]` name
> marker, and SCREAMING_SNAKE constants camel-cased into potential collisions.
> See [Real third-party extension ingestion](real-extension-ingestion.md) for
> the evidence, the blocker taxonomy that replaced silent degradation, and the
> pinned fixture. The text below is preserved as the prediction it was.

Reading real `.script_api` files against
`packages/cli/src/generate.mjs`'s `normalizeType` surfaced four concrete defects.
They are recorded here because they are the actual reason to adopt a real
extension, and because two of them contradict a stated repository invariant.

1. **YAML list unions become `any`, silently.** `normalizeType` handles unions
   only in the string form `"a|b"`. xMath writes them as YAML sequences -
   `type: [vector3, vector4]` - so `typeof value?.type === "string"` is false,
   `raw` falls through to `"any"`, and the parameter renders as `unknown`. Every
   one of xMath's in-place vector operations is affected.

2. **Named Defold value types degrade to `unknown`.** `vector3`, `vector4`,
   `quaternion`, and `matrix4` hit `normalizeType`'s `default` branch, become
   `{ kind: "named" }`, and `renderType` maps both `named` and `unknown` to the
   TypeScript type `unknown`. The repository already generates exact layouts and
   TypeScript types for all four from pinned dmSDK headers; the `.script_api`
   lane simply does not join to them. A named-type resolution table is a small,
   deterministic fix with immediate payoff.

3. **Nested table fields spelled `members:` are dropped.** The record branch
   reads `value.parameters` only. extension-websocket describes its `params`
   table and its callback `data` payload with `members:`, so both collapse to
   `Readonly<Record<string, unknown>>` and the entire event protocol - event
   codes, message payload, error text - is lost from the generated types.

4. **These degradations are silent, which conflicts with the fail-closed
   rule.** `AGENTS.md` requires that unsupported cases "fail closed with
   machine-readable blockers." An unrepresentable `.script_api` type currently
   produces a well-typed-looking `unknown` with no diagnostic and no blocker
   record. Whatever is done about gaps 1-3, the lane should emit a blocker for
   any `.script_api` type it cannot project, so that coverage is measurable
   instead of assumed.

None of these are blocking for adoption - `unknown` is unsound but not unsafe at
the boundary. All of them are invisible without a real extension, which is the
argument this note was written to make.

# Boundaries of this survey

Repository contents, trees, licences, revisions, release tags, and CI platform
matrices were read directly from GitHub on 2026-09-18. Portal metadata
(star counts, declared platforms, category tags) is the portal's own claim at
revision `17a1f3d8a3f50e7840fbb6677465d1cb7799a15e` and was only trusted where
the repository corroborated it - the `defold-astar` licence discrepancy is the
one case where it did not.

At the time this survey was written no extension had been fetched into a
project, no `ext.manifest` had been resolved through Bob, no inventory had been
generated, and no engine had been relinked; the generator gaps were derived by
reading real `.script_api` sources against the projection code. That confirming
step has since been done for xMath and defold-astar - see
[Real third-party extension ingestion](real-extension-ingestion.md). No engine
has been relinked for either, and neither has been adopted into the game.
