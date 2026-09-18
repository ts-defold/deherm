---
type: Research Note
title: Real third-party extension ingestion and the `.script_api` blocker taxonomy
description: End-to-end ingestion of the published xMath and defold-astar extensions at pinned revisions, the four projection defects real `.script_api` files exposed, the fail-closed blocker taxonomy that replaced silent degradation, and the new blocker families the ecosystem's own spelling conventions surfaced.
tags: [research, extensions, script-api, ingestion, blockers, provenance, fail-closed]
status: verified-ingestion
generated: { by: claude/opus-5, at: 2026-09-18T00:00:00-04:00 }
sources:
  - id: candidate-survey
    resource: defold-extension-candidates.md
    title: Real Defold extension candidates for the War Battles showcase
    author: team:ts-defold
  - id: discovery-decision
    resource: ../decisions/project-extension-discovery.md
    title: Discover project extensions before generating project bindings
    author: team:ts-defold
  - id: defold-xmath
    resource: https://github.com/thejustinwalsh/defold-xmath/tree/f1f27eff87d66e11521aff310e0522ac6cd7c5d6
    title: xMath allocation-free math extension at the pinned revision
    author: person:thejustinwalsh
  - id: defold-xmath-api
    resource: https://github.com/thejustinwalsh/defold-xmath/blob/f1f27eff87d66e11521aff310e0522ac6cd7c5d6/xmath/api/xMath.script_api
    title: xMath `.script_api` declaration surface
    author: person:thejustinwalsh
  - id: defold-astar
    resource: https://github.com/selimanac/defold-astar/tree/1471c5445b0c0376bd23c377e8ef8d84e52b43bf
    title: A* Path Finding extension at the pinned revision
    author: person:selimanac
  - id: defold-astar-api
    resource: https://github.com/selimanac/defold-astar/blob/1471c5445b0c0376bd23c377e8ef8d84e52b43bf/astar/api/astar.script_api
    title: defold-astar `.script_api` declaration surface
    author: person:selimanac
  - id: asset-portal-astar
    resource: https://github.com/defold/asset-portal/blob/17a1f3d8a3f50e7840fbb6677465d1cb7799a15e/assets/apathfinding.json
    title: Asset portal entry claiming MIT for A* Path Finding
    author: team:defold
  - id: editor-script-api
    resource: upstream/defold/editor/src/clj/editor/script_api.clj
    title: Defold editor `.script_api` reader at the pinned engine revision
    author: team:defold
  - id: bob-library
    resource: upstream/defold/com.dynamo.cr/com.dynamo.cr.bob/src/com/dynamo/bob/util/Library.java
    title: Bob dependency cache filename derivation
    author: team:defold
  - id: value-layouts
    resource: ../../../packages/bindings/generated/defold-value-layouts.json
    title: Generated transparent and opaque Defold value layouts
    author: team:ts-defold
  - id: projection
    resource: ../../../packages/cli/src/generate.mjs
    title: `.script_api` normalization, blocker taxonomy, and TypeScript projection
    author: team:ts-defold
  - id: discovery
    resource: ../../../packages/cli/src/project.mjs
    title: Extension discovery and dependency archive reporting
    author: team:ts-defold
  - id: ingestion-tests
    resource: ../../../tests/extension-ingestion.test.mjs
    title: Ingestion and projection regression tests
    author: team:ts-defold
  - id: ingestion-fixture
    resource: ../../../tests/fixtures/defold-extension-ingestion/extensions.lock.json
    title: Pinned ingestion fixture identities, digests, and licence provenance
    author: team:ts-defold
---

# What this establishes

Two published third-party Defold extensions, pinned to exact revisions, are
resolved by a fixture project the way Bob resolves a real dependency, discovered
from their `ext.manifest`, projected from their own `.script_api`, and emitted as
TypeScript declarations that type-check together with an authored consumer
script. Nothing about either extension was hand-written.

| Extension | Revision | Members | Projected | Blocked |
| --- | --- | ---: | ---: | ---: |
| [xMath](https://github.com/thejustinwalsh/defold-xmath) | `f1f27eff87d66e11521aff310e0522ac6cd7c5d6` | 37 | 37 | 0 |
| [defold-astar](https://github.com/selimanac/defold-astar) | `1471c5445b0c0376bd23c377e8ef8d84e52b43bf` | 16 | 15 | 1 |

The single blocked member is real and is described below. It is the deliverable,
not a shortfall: before this change it was a member typed `unknown` with no
diagnostic anywhere.

# The four defects the survey predicted, confirmed and fixed

All four were invisible against synthetic fixtures and all four were reproduced
by executing `deherm generate` over the real files.

1. **YAML sequence unions became `any`.** `normalizeType` handled unions only in
   the string form `"a|b"`, so xMath's `type: [vector3, vector4]` fell through to
   `"any"`. The Defold editor renders exactly that sequence by joining its
   members with `|`, which settles that a sequence is an alternation rather than
   a tuple; the generator now normalizes the sequence and the string spelling to
   an identical union node. Every one of xMath's in-place vector operations was
   affected.

2. **Named Defold value types rendered `unknown`.** `vector3`, `vector4`,
   `quaternion`, and `matrix4` reached the `default` branch and both `named` and
   `unknown` rendered as TypeScript `unknown`, even though the repository derives
   exact layouts for all six transparent value types from pinned dmSDK headers.
   The resolution table is now *derived from* `defold-value-layouts.json` rather
   than written by hand: each transparent value type must have a declared
   TypeScript projection or the generator throws at load. A value type the engine
   keeps opaque produces an explicit blocker rather than a guess.

3. **Nested fields spelled `members:` were dropped.** The record branch read
   `value.parameters` only. Defold's own editor resolves nested arguments as
   `(or parameters members)`, so the generator now does the same, in that
   precedence. This is what extension-websocket's `params` table and its callback
   `data` payload are written with.

4. **All three degraded silently.** This was the defect that mattered, because
   `AGENTS.md` requires unsupported cases to fail closed with machine-readable
   blockers. There is now a blocker taxonomy: an unprojectable shape yields a
   `{ kind: "unprojectable", code }` IR node, the member carrying it is marked
   `disposition: "blocked"`, and it is emitted as `readonly name: never` with a
   `/** blocked: site=code */` comment rather than as a callable signature. The
   generated runtime module emits a throwing `never` getter, so the member cannot
   reach the extension bridge at runtime either. `bindings.ir.json` carries the
   full enumeration plus a `coverage` block, `manifest.json` records the same
   coverage under `coverage.projectExtensions`, and `deherm generate` prints the
   blocked count and the per-code histogram.

# Blocker taxonomy

Every code is derived structurally from the declared shape. None of them is a
symbol or route allowlist.

| Code | Meaning | Seen in |
| --- | --- | --- |
| `unresolved-named-type:<name>` | A named type with no transparent layout and no engine-value classification | synthetic |
| `opaque-defold-value-type:<name>` | An engine value type the layout generator classified opaque, so it has no pinned projection | synthetic |
| `missing-type` | A parameter, field, or return with no `type` key at all | synthetic |
| `empty-type-union` | A `type:` sequence with no members | synthetic |
| `call-signature-without-function-type` | A member declaring `parameters:`/`returns:` but not `type: function` | **defold-astar `astar.use_zero`** |
| `unrecognized-name-marker:<marker>` | A bracketed name marker that is neither the editor's bracketed-name form nor `[optional]` | synthetic |

A blocker's `site` locates it exactly - `parameter[3]:map_id`, `return`,
`parameter[0]:params.handle` for a nested record field, `value` for a
non-function member - and every blocker carries a stable `id` of the form
`script:<module>.<member>#<site>`.

# New blocker and projection families these real extensions surfaced

The survey predicted four defects. Executing ingestion found three more, all of
which are properties of how the ecosystem actually writes `.script_api` rather
than of any synthetic fixture.

* **A member that declares a call signature without `type: function`.**
  `astar.use_zero` carries a `parameters:` list and a description of its two
  arguments but no `type:` key. The previous projection silently produced a
  *value* member typed `unknown`, erasing the call signature. Inferring "function"
  from the presence of parameters would be a silent repair of an upstream
  authoring bug, so it fails closed instead. This is the one blocker in either
  published extension, and it is worth reporting upstream: adding
  `type: function` to that member resolves it completely.

* **Optionality spelled as a trailing name marker.** defold-astar writes
  `name: map_id[optional]`, which is not `optional: true` and is not the editor's
  bracketed-name form (`bracketname?` in `script_api.clj` tests the *first*
  character). Defold's own editor therefore renders that parameter literally as
  `map_id[optional]`, and déherm previously mangled it into the identifier
  `mapIdOptional` while leaving it required. Nine of defold-astar's eleven
  functions are affected. The marker is unambiguous and mechanically decodable,
  so it is decoded rather than blocked - but the decoding is recorded in the IR
  as `nameSpelling: "trailing-optional-marker"` so the non-standard spelling
  stays visible, and any *other* bracketed marker blocks. The clean upstream fix
  is `optional: true`.

* **SCREAMING_SNAKE constants were camel-cased into collisions.**
  `astar.DIRECTION_FOUR` projected as `dIRECTIONFOUR`. Beyond being unusable,
  the transform is lossy: `DIRECTION_FOUR` and `DIRECTIONFOUR` would collide.
  Member names matching SCREAMING_SNAKE now keep their exact spelling, which is
  what the generated core SDK already does for `go.EASING_LINEAR`.

* **A one-entry `returns:` sequence is one return value, not a 1-tuple.**
  `astar.new_map_id` and `astar.get_at` each declare a single `returns:` entry
  and previously projected as `[number]`. They now project as `number`.
  Multi-value returns keep their tuple shape: `astar.solve` is
  `[number, number, number, Readonly<Record<string, unknown>>]`.

# Recorded, not blocked: undescribed tables

`astar.set_map(world)`, `astar.set_costs(costs)`, and the `path` element of
`astar.solve`'s return are declared `type: table` with no described members.
They project as `Readonly<Record<string, unknown>>`. That is restrictive rather
than permissive - a TypeScript array is not assignable to it, so the caller
cannot pass the 2D grid the extension actually wants without the projection
objecting - so the lane is not silently accepting an unsound shape. It is still
a real loss of fidelity that only the extension author can fix, by describing the
table's members. It is recorded here rather than turned into a blocker because
the shape *is* projectable; the description is what is missing.

# Discovery now reports Lua-only dependencies

The survey's structural finding was that 43 of the 61 most-starred portal assets
ship no `ext.manifest` and are therefore invisible to discovery, which is rooted
at `ext.manifest`. Solving that needs a separate Lua-module ingestion decision
and is not attempted here. What changed is that silence became a report:
`dependencyExtensions` keeps the full entry listing of every resolved archive
while decompressing only the extension-defining files, so an archive with no
`ext.manifest` now produces a warning diagnostic naming the archive, its file
count, and its Lua module count, an entry in
`inventory.dependencyArchivesWithoutManifest`, a `no-ext-manifest` row in
`deherm extensions`, and a count in `deherm doctor`. A project that depends on
Druid now learns that its dependency contributed nothing, and why.

# Fixture design and provenance

`tests/fixtures/defold-extension-ingestion/` holds the pinned inputs.
`materialize.mjs` builds each extension into a dependency archive whose name
reproduces Bob's own cache-key scheme - `sha1hex(dependencyUrl)` followed by a
base64url etag - writes them under `.internal/lib`, and verifies every vendored
file against the sha256 pinned in `extensions.lock.json` before packing. The
archives keep the upstream GitHub top-level directory, so root handling inside
the archive is exercised rather than assumed. Ingestion is therefore offline,
deterministic, and pinned.

Only `ext.manifest` and `.script_api` are vendored: the extensions' interface
descriptions, not their code. `extensions.lock.json` lists the upstream files
that were deliberately *not* vendored and why, and records the one classification
this causes the fixture to differ from upstream on - defold-astar ships public
headers and would classify `script-api+native-schema-required` in a real project,
where the fixture classifies `script-api`. The header lane has its own fixtures.

## defold-astar's licence is unresolved, and stays recorded as three facts

Following the house rule used for the War Battles art provenance, the sources are
recorded separately rather than collapsed into one claim, in
`licenses/defold-astar-PROVENANCE.txt`:

1. The repository at the pinned revision contains **no LICENSE file**, and
   GitHub's licence API returns **404** for it.
2. The **asset portal claims "MIT License"** in
   `assets/apathfinding.json` at portal revision
   `17a1f3d8a3f50e7840fbb6677465d1cb7799a15e`. That is the portal's metadata,
   uncorroborated by any file upstream.
3. The vendored **MicroPather is zlib**, transcribed verbatim from
   `astar/include/micropather/micropather.h` into
   `licenses/micropather-zlib.txt`, and carries its own attribution obligation.

Asking the author to add a `LICENSE` file would resolve this cleanly. Until then
the discrepancy must not be summarised as "MIT". The project owner reviewed this
and decided to proceed with ingesting the interface description. xMath is MIT and
its repository and the portal agree; the notice is at
`licenses/defold-xmath-MIT.txt`.

# Evidence boundary

This is **generation evidence only**. Both extensions' declarations are
generated, the generated project and an authored consumer script type-check
under the project's own `tsconfig.deherm.json`, and the blocked member is proved
uncallable by a `@ts-expect-error` that fails the suite if the member ever
becomes callable again.

Nothing here is compilation, linkage, runtime, or packaged-engine evidence.
Neither extension has been built by Extender, linked into an engine, or called
from a running Defold process. No extension was adopted into
`examples/war-battles-online`; that is a separate decision. The
`script-api` lowering for both is `lua-compatibility` on every target, with
`schema-required` for the direct-native route, exactly as the discovery decision
specifies.
