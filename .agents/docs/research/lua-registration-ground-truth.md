---
type: Design and Verification Report
title: Lua registration ground truth
description: A generated verifier that derives a target's registered Lua surface from its C/C++ sources and diffs it against the declared surface, applied to the pinned Defold engine and to the two ingested third-party extensions.
tags: [research, bindings, script-api, verification, fail-closed, extensions, engine]
status: verified-generation
generated: { by: claude/opus-5, at: 2026-09-18T21:30:00-04:00 }
sources:
  - id: route-availability
    resource: ../../../scripts/generate-script-route-availability-profiles.mjs
    title: Source-derived route availability profiles
    author: team:ts-defold
  - id: extension-ingestion
    resource: ./real-extension-ingestion.md
    title: Real third-party extension ingestion and the `.script_api` blocker taxonomy
    author: team:ts-defold
  - id: discovery-decision
    resource: ../decisions/project-extension-discovery.md
    title: Discover project extensions before generating project bindings
    author: team:ts-defold
  - id: verifier
    resource: ../../../scripts/generate-lua-registration-surface.mjs
    title: Registered-vs-declared Lua surface verifier
    author: team:ts-defold
  - id: parser
    resource: ../../../scripts/lib/lua-c-registration.mjs
    title: Lua C API registration and stack-usage parser
    author: team:ts-defold
  - id: targets
    resource: ../../../packages/bindings/overrides/lua-registration-surface-targets.json
    title: Verifier target policy
    author: team:ts-defold
  - id: report
    resource: ../../../packages/bindings/generated/defold-lua-registration-surface.json
    title: Generated registered-vs-declared surface report
    author: team:ts-defold
  - id: defold-engine
    resource: ../../../upstream/defold/engine
    title: Pinned Defold engine tree at upstream.lock DEFOLD_REV
    author: team:defold
  - id: defold-astar-upstream
    resource: https://github.com/selimanac/defold-astar/tree/1471c5445b0c0376bd23c377e8ef8d84e52b43bf
    title: defold-astar sources at the pinned revision
    author: person:selimanac
  - id: defold-xmath-upstream
    resource: https://github.com/thejustinwalsh/defold-xmath/tree/f1f27eff87d66e11521aff310e0522ac6cd7c5d6
    title: xMath sources at the pinned revision
    author: person:thejustinwalsh
---

# Problem

`.script_api` files and the reference documentation are *declarations*. The only
ground truth for a Lua-shaped API is the Lua C API registration and how the
registered C function bodies use the Lua stack. Two independent findings had
already shown the declarations are not reliable:

* [Route availability profiles](../../../scripts/generate-script-route-availability-profiles.mjs)
  parse real `luaL_register` arrays out of engine sources and found Box2D v3
  routes registered but undocumented, plus documented routes commented out of
  registration. It covers four features and 26 `core` functions; the rest of the
  engine had no source-derived evidence at all.
* [Real extension ingestion](./real-extension-ingestion.md) found `.script_api`
  files carrying `map_id[optional]` optionality in prose and a member missing
  `type: function`, which made déherm emit wrong signatures for nine of eleven
  defold-astar functions.

Neither covered the general case: *given any extension root, dependency archive,
or the pinned engine tree, what is actually registered, and where does the
declaration disagree?*

# What was built

`scripts/generate-lua-registration-surface.mjs` plus the parser in
`scripts/lib/lua-c-registration.mjs` derive a target's **registered** surface
from its C/C++ sources and diff it against its **declared** surface. Targets are
declared in `packages/bindings/overrides/lua-registration-surface-targets.json`;
the generated report is
`packages/bindings/generated/defold-lua-registration-surface.json`.

There is no per-route and no per-module list anywhere in the lane. The policy
names source roots, the mutually exclusive build variants a target selects
between, and where its declaration lives. Which names exist is what the parse
decides.

## What is derived from source

**Registration.** `luaL_reg`/`luaL_Reg` arrays and their `luaL_register`,
`luaL_openlib`, `lua_register` and `lua_pushcfunction`+`lua_setglobal` call
sites. The module path comes from an abstract Lua stack machine over the
recognised C API calls, so `lua_newtable` + `luaL_register(L, 0, Chain_functions)`
+ `lua_setfield(L, -2, "chain")` resolves to `b2d.chain` without anyone writing
`b2d.chain` down, and `lua_getfield(L, -1, "collision_object")` reopens an
existing sub-table rather than registering into its parent. Registration split
across translation units is followed through the call graph: a callee inherits a
copy of the caller's stack, so a table it creates and names attaches to the
caller's namespace while a generic helper such as `dmScript::RegisterUserType`,
whose array arguments are runtime parameters, cannot desynchronise the
namespaces above it. Entries produced by function-like macros
(`REGGETSET(Position, position)`) are expanded in place, including `#`
stringification and C's adjacent-string-literal concatenation. A **commented-out
entry is evidence of absence** and is recorded as such, reusing the idea the
route-availability generator already models.

**Arity, types, optionality.** For each registered C function the body is read:
`luaL_check*` and the `dmScript::Check*`/`Resolve*` helpers make a slot
*required*; `luaL_opt*` makes it *optional*; `lua_to*`, `lua_is*`,
`lua_isnoneornil` observe a slot that may be absent, which is exactly what
`map_id[optional]` was trying to say in prose. Argument positions come from
integer literals, from single-assignment integer locals, from
`AbsIndex(L, <literal>)`, and from helpers that take a literal slot and hand its
index back (`int def_index = CheckDefinitionTable(L, 3);`).

**The helper vocabulary is enumerated, not listed.** Declared helpers come from
the pinned dmSDK headers: any free function whose first parameter is `lua_State*`
and which addresses an `int index` slot, with its family read from the verb
prefix and its types from its own name suffix (`CheckHashOrString` accepts
`hash|string` because the alternation is written into its name) and declared
return type. Helpers *defined* in the target's own sources are then typed by
reading their bodies to a fixed point, so Box2D's private `CheckBody` resolves to
the user type `b2Body` - the name it was registered under via
`dmScript::RegisterUserType` - and astar's `get_map(lua_State* L, int nArg)`
resolves to an optional number because its body calls `luaL_optinteger` on that
slot. Which integer parameter is a stack index is decided by the body, never by
its name.

**Results and constants.** Literal `return N` values, `DM_LUA_STACK_CHECK`, and
tail delegation (`return Other(L);`) give result arity; the push sequence gives
result types where a single-result function pushes one kind.
`lua_pushnumber`/`lua_pushinteger` + `lua_setfield` inside a registration
function are recorded as constants.

## Fail closed

Everything the parser cannot decide is an explicit blocker with a code, a
location and a reason, and never a silent pass. A target that ships a
declaration but no implementation is reported `status: "unverifiable"` rather
than counted as agreement. The comparison itself refuses to guess: a declared
spelling with no mapping rule (`b2d.query_filter`, `gui.PROP`) and a derived
type outside the Lua vocabulary both produce `undecided` with the unmapped
token named, so "we agree" and "we could not tell" are never mixed.

Blocker families seen on the engine: `dynamic-stack-index` (a slot addressed
through a value the parser cannot resolve), `unresolved-c-function` (the
registered symbol is produced by a function-like macro expansion, as in
`bitop.c`'s `BIT_OP(bit_band, &=)`), `argument-slot-without-stack-access`,
`undecided-result-arity`, `ambiguous-registration-callee`,
`duplicate-registration` (the same name registered by two platform variants,
e.g. `http.request` from `script_http.cpp` and `script_http_js.cpp`),
`declared-module-never-registered`, and `unresolved-registration-name`.

## Archives are read in place

Defold dependencies are ZIPs. A `dependency-archive` target reads `.script_api`
and `src/**` straight out of the archive with `fflate`'s `unzipSync`, keeping the
full entry listing while decompressing only the files it reads - the same shape
`packages/cli/src/project.mjs` already uses for discovery. Nothing is unpacked to
disk.

# Applied to the pinned engine

Both Box2D backends are separate targets because they define the same
registration symbols and are selected against each other at link time.

| | box2d-v3 | box2d-v2 |
| --- | ---: | ---: |
| C/C++ sources parsed | 905 | 905 |
| Registration entry points | 41 | 41 |
| Registered namespaces | 51 | 51 |
| **Registered routes** | **924** | **836** |
| Registered constants | 433 | 440 |
| Documented routes (pinned script API IR) | 926 | 926 |
| Registered **and** documented | 867 | 793 |
| **Documented but unregistered** | **61** | **135** |
| **Registered but undocumented** | **57** | **43** |
| Commented-out registrations found | 2 | 4 |
| Per-route verdict: agree | 259 | 227 |
| Per-route verdict: partially undecided | 290 | 255 |
| Per-route verdict: disagree | 270 | 263 |
| Per-route verdict: undecided | 48 | 48 |
| Parameter slots compared | 1,508 | 1,409 |
| Parameter slots disagreeing | 348 | 336 |
| Parameter slots undecided | 522 | 478 |
| **Blockers (unparseable)** | **391 over 302 routes** | **394 over 309 routes** |

The documented surface is 926 routes. On the v3 build 867 of them are actually
registered; 61 are not. Coverage counted against documentation is therefore not
coverage: 57 registered routes have no documentation at all, and only 259 of the
867 matched routes agree on every parameter, arity and result.

## What the disagreements are

**The documented name is wrong.** `sys.set_render_enable` is documented under
that name in `engine/src/script/script_engine.cpp` (`@name sys.set_render_enable`,
and the example calls `sys.set_render_enable(false)`), but the registration array
in the same file registers `{"set_render_enabled", EngineSys_SetRenderEnabled}`.
The documented spelling is not callable. déherm would have emitted the
uncallable name.

**Registered but undocumented, inside documented namespaces (22 on v3).** The
fourteen `b2d.shape.*` routes the route-availability generator already found, plus
`sprite.set_scale`, `profiler.get_lua_ref_count`,
`sys.set_debugger_lightweight_hook`, `sys.set_render_enabled`, and the luasocket
`socket.serial` / `socket.unix` / `socket.__unload` entries.

**Documented but unregistered (61 on v3).** The breakdown is
`b2d.fixture` 16, `b2d.joint` 15, `socket` 10, `b2d.body` 7, `resource` 7,
`socket.dns` 5, `sys` 1. The Box2D rows are the v2-only surface, correctly absent
from a v3 build - the mirror target shows the complement, with 135 documented
routes absent from a v2 build. Two of the `b2d.body` rows,
`b2d.body.get_user_data` and `b2d.body.set_user_data`, are carried by the
commented-out registration evidence at `script_box2d_body_v3.cpp:1056-1057`,
independently reproducing the route-availability generator's finding. The seven
`resource.*` rows (`resource.atlas`, `resource.font`, `resource.material`,
`resource.buffer`, `resource.texture`, `resource.tile_source`,
`resource.render_target`) are independently corroborated: the repository's own
borrowed-handle classification already labels all seven `declaration-token`, so
they are `go.property` declaration tokens rather than registered functions. The
`socket` and `socket.dns` rows are luasocket's Lua-side modules, which have no C
registration by construction.

**Optionality the C body does not enforce.** The largest disagreement family is a
slot documented as required whose C body reads it with a non-raising accessor, so
a missing argument is silently defaulted rather than refused. Each such row names
the accessor that decided it.

**Branch-dependent arity is not claimed.** When the body branches on
`lua_gettop`, a `luaL_check*` below the branch does not prove the slot is always
required, so the arity verdict is `undecided` with reason
`branch-dependent-minimum` rather than a false `disagree`.

# Applied to the two ingested extensions

`tests/fixtures/defold-extension-ingestion` deliberately vendors interface
description only - `ext.manifest` and `.script_api` - and no third-party native
source, for the licence reasons recorded in `extensions.lock.json`. Both fixture
targets therefore report `status: "unverifiable"` with a single
`no-native-source-in-target` blocker. That is the point: an unchecked declaration
must not read as agreement.

The verification below was run against the upstream sources at the pinned
revisions, fetched from GitHub's archive endpoint. It is reproducible from those
archives, whose digests are recorded here rather than vendored:

| Extension | Revision | Archive sha256 |
| --- | --- | --- |
| defold-astar | `1471c5445b0c0376bd23c377e8ef8d84e52b43bf` | `5b1eb9181c7a9141a062b1f18e7ae3a0785c95fe48c8c1ef81a27f9c76aec7cf` |
| defold-xmath | `f1f27eff87d66e11521aff310e0522ac6cd7c5d6` | `9970579a4fc328fd075efbf51ea05d90f9ef717d2f75e4e2a75624bfc56115d4` |

| | defold-astar | xMath |
| --- | ---: | ---: |
| C/C++ sources parsed | 7 | 1 |
| Registered routes | 19 | 37 |
| Registered constants | 10 | 0 |
| Declared routes | 11 | 37 |
| Registered and declared | 11 | 37 |
| Documented but unregistered | 0 | 0 |
| **Registered but undocumented** | **8** | **0** |
| Per-route agree | 9 | 34 |
| Per-route disagree | 2 | 3 |
| Blockers | 0 | 0 |

## The astar defects, rediscovered from C source alone

* **`astar.use_zero` has no `type: function`.** The `.script_api` member carries
  `parameters:` and a description but no `type:` key, while the C source proves
  it is registered as a Lua C function (`{"use_zero", astar_use_zero}`). The
  report flags `declaration.missingFunctionType: true` next to the registration
  that contradicts it.
* **`map_id[optional]` is decoded and kept visible.** The trailing marker is
  recorded as `optionalitySpelling: "trailing-optional-marker"`, and the C body
  independently agrees: `get_map(L, n)` reads that slot with `luaL_optinteger`,
  so the slot really is optional. Nine functions carry the marker; all nine now
  agree with the C source on that parameter.
* **A new defect the declaration hid.** `astar.use_zero`'s first parameter is
  documented required and typed `boolean`, but the C body reads it with
  `lua_toboolean(L, 1)`, which never raises. `astar.use_zero()` with no arguments
  silently toggles to `false` rather than erroring.
* **Eight registered functions are undocumented**: `astar.clear_path`,
  `astar.map_hflip`, `astar.map_vflip`, `astar.print_map`, `astar.reset`,
  `astar.set_entities`, `astar.set_map_type`, `astar.use_entities`. The
  `.script_api` describes 11 of the 19 registered functions.
* `astar.get_at` declares one return value; the C body returns `1` on success and
  `0` when the map does not exist.

## The xMath defect the prose carried

`xmath.matrix4_scale` declares two parameters. The C body branches on
`lua_gettop` and accepts a four-argument form
`matrix4_scale(m, x, y, z)` - which the description mentions in prose ("or 3
numbers for x, y, z scale") but does not declare structurally. The verifier
reports slots 3 and 4 as `registered-only`. `xmath.clamp` and `xmath.lerp`
disagree only on result arity, because both return `0` on their guard path.

# Boundary

This is **generation and static-analysis evidence only**. Nothing here was
compiled, linked, or executed. The verifier reads C source; it does not prove
that a registered route behaves as its body suggests at runtime, and a
disagreement it reports is a disagreement between two static descriptions, not a
runtime failure. The 391 blockers on the v3 engine target are exactly the places
where the static reading stopped, and they are reported rather than assumed away.

The lane owns its own generator registry
(`luaRegistrationSurfaceGenerator` in `scripts/lib/script-generator-pipeline.mjs`)
rather than joining the script clean-room graph, because its inputs cannot be
enumerated ahead of the parse: which files register which Lua names is exactly
what it decides, while the clean-room check copies an enumerated evidence subset
into a temporary root. It is verified by `pnpm check:lua-registration-surface`
and `tests/lua-registration-surface.test.mjs` instead.
