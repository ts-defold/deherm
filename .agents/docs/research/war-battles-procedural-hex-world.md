---
type: Research
title: One seeded hex-world plan for War Battles
description: Source-backed terrain, prop, collision, and rendering contract to replace independent hand-arranged world passes.
tags: [war-battles, procedural-generation, hex-grid, terrain, collision, defold]
status: proposed
generated: { by: codex/gpt-5, at: 2026-10-08T20:00:00-04:00 }
sources:
  - id: red-blob-hex-mapgen
    resource: https://www.redblobgames.com/x/2543-mapgen1-hexagons/
    title: Mapgen1 with hexagons
    author: person:amit-patel
  - id: red-blob-island-shaping
    resource: https://www.redblobgames.com/maps/terrain-from-noise/islands.html
    title: Island shaping functions
    author: person:amit-patel
  - id: red-blob-mapgen2
    resource: https://www.redblobgames.com/maps/mapgen2/
    title: Mapgen2 Procedural Island Map Generator
    author: person:amit-patel
  - id: red-blob-voronoi
    resource: https://www.redblobgames.com/x/2022-voronoi-maps-tutorial/
    title: Voronoi maps tutorial
    author: person:amit-patel
  - id: bridson-blue-noise
    resource: https://www.cs.ubc.ca/~rbridson/docs/bridson-siggraph07-poissondisk.pdf
    title: Fast Poisson Disk Sampling in Arbitrary Dimensions
    author: person:robert-bridson
  - id: metanet-npp-level-design
    resource: https://blog.playstation.com/archive/2014/12/04/ins-outs-ups-downs-lefts-rights-designing-n-levels
    title: The ins and outs of designing N++ levels
    author: team:metanet
  - id: nms-building-worlds
    resource: https://www.gdcvault.com/play/1024514/Continuous-World-Generation-in-No
    title: Building Worlds Using Math(s)
    author: person:sean-murray
  - id: spore-worlds
    resource: https://www.cs.cmu.edu/afs/cs.cmu.edu/user/ajw/www/s2007/0251-SphericalWorlds.pdf
    title: Creating Spherical Worlds
    author: team:maxis
  - id: spore-object-distribution
    resource: https://www.cs.cmu.edu/~ajw/s2007/0312-ObjectDistribution.pdf
    title: Fast Object Distribution
    author: person:andrew-willmott
  - id: generative-critics
    resource: https://www.pcgworkshop.com/archive/compton2013generative.pdf
    title: Generative Methods
    author: person:kate-compton
  - id: defold-tilemap
    resource: https://defold.com/ref/tilemap-lua/
    title: Defold tilemap API
    author: team:defold
  - id: supernova-isometric-hex
    resource: https://www.supernovafiles.com/blog/creating-a-hexagonal-isometric-tilemap
    title: Creating a Hexagonal Isometric Tilemap
    author: team:supernova-files
---

# Finding

War Battles does not yet have one world generator. `core/hex-landscape.ts`
repeats an authored 12×12 biome and relief macro regardless of `mapSeed`;
`core/arena.ts` separately creates a rectangular, seeded collision/stamp grid;
`core/hex-meadow-scatter.ts` places half-scale trees on a separate stride and
explicitly gives them no collider. `tools/generate-hex-terrain.mjs` paints the
macro into a rectangular floor resource. `tools/generate-coast.mjs` tests the
square simulation extent to decide where sea begins. The map therefore cannot
have a trustworthy irregular shoreline, seed-specific biomes, or prop/collider
parity. More artwork or a new coast strip will not repair that split.

The sources support a **single, deterministic world-plan pipeline**, not a
particular magic noise function. Red Blob's direct hex-map experiment assigns
attributes to each hex, then derives land/water, elevation, moisture, biome,
and coastline edges. Its island-shaping research separates a broad distance
field from local variation. Its Voronoi work shows how coarse regions can own
large-scale character without turning each small tile into random noise.
These are good fits for our finite, tank-scale island. The exact functions and
thresholds below are our proposed adaptation, not a claim that those sources
prescribe War Battles' values.

N++ is a useful **quality-control** reference, not evidence for an N++
procedural-terrain algorithm: Metanet says its levels were hand-crafted,
iterated, and culled. For our generator this argues for automated hard
constraints plus a contact sheet across many seeds and deliberate selection
of one showcase seed. Hello Games' GDC talk explicitly discusses generating
and testing vast terrain with a small team; it does not imply that we need
planet-scale voxels. Generative-methods research distinguishes a generator
from its critic: a candidate world is not shippable just because it was
produced. Bridson's blue-noise sampling supplies a principled spacing model
for visible props; our finite grid may use a cheaper deterministic candidate
ordering if it meets the same spacing contract.

Maxis' *Spore* notes are more directly useful for object placement than for
copying a planet renderer. Its terrain paper keeps a seeded attribute/height
field and derives texturing from terrain features; our finite hex arrays are
the equivalent source of truth. Its object-distribution paper uses a
reproducible, memory-light Halton sequence, density-map rejection and
attribute schedules so distinct objects fill gaps without arbitrary overlap.
Our static-prop stage should compare that candidate sequence with a bounded
blue-noise candidate set, then apply the same explicit footprint, biome,
reservation, and route constraints. We do **not** need Spore's spherical
parameterization or GPU brush implementation for this fixed-size island.

# Proposed authoritative data

`buildWorldPlan(mapSeed, rulesVersion)` runs once when a match/world starts.
Its outputs are immutable, bounded typed arrays and a bounded static-prop
table. The seed and rules version travel with the match; no terrain texture,
prop list, or static collision bitmap travels in snapshots.

| Field | Granularity | Consumer |
| --- | --- | --- |
| `land`, natural `biome`, `elevation`, `moisture`, `coastEdges` | finite axial hex grid | floor tiles, shallow side faces, ocean mask, natural prop eligibility |
| `builtSurface` and `structures` | hex overlay plus bounded anchored records | roads, service pads, depots, walls, buildings, and their collision footprints |
| `reserved` | 16-pixel simulation grid | spawn/depot aprons, pickup pads, route corridors, shoreline clearance |
| `solid` and mutable-cover indices | 16-pixel simulation grid | authoritative movement, projectiles, LOS, bot routing |
| `props` with kind, anchor, footprint, lift, variant | fixed-capacity records | both sprite instances and rasterized collision footprint |
| `tileIds[ground, low, standard, high, sides, water]` | bounded Defold tilemap layers | one-time projection on `mapSeed` change |

There is **one** coordinate conversion between axial hex, simulation cell,
and projected screen position. Side-face edge masks derive from neighboring
`land/elevation` values. A prop's collider is rasterized from the same
footprint used for placement; a visual-only grass tuft must be explicitly
labelled non-blocking. No renderer is allowed to invent a wall or tree after
the plan has been accepted.

# Generation order and hard constraints

1. **Island topology.** Start with a six-sided hex support shape, apply only
   low-frequency seeded variation at its boundary, and quantize to whole
   hexes. Water is outside that set, not a rectangular crop of an infinite
   floor. Keep one connected land mass. Reserve a minimum land margin around
   the actual coast for tank travel and visibility.
2. **Geography.** Use a small deterministic set of biome/Voronoi sites for
   broad meadow and dry-earth regions with restrained basalt and ash accents.
   Service plates are manufactured, not a biome; never give them a Voronoi
   territory. Blend/perturb
   edges without making one-hex checkerboard noise. Compute an independent
   smooth elevation field, then quantize to low/standard/high; adjacent
   drivable cells differ by at most one shallow tier. The current subtle
   continuous vehicle lift is retained, but it samples these plan tiers.
3. **Gameplay reservations.** Place the 16 tank-depot aprons, 32 distinct
   tank-capable player starts, objectives, pickup pads, and at least two
   tank-width routes between major regions before scenery. Protect them with
   clearance radii. Do not satisfy a 32-player test by reusing 16 depots with
   pairs of tanks barely one hull apart. The accepted arena must hold all 32
   slots with no blocked spawn hull and connected movement routes.
4. **Built surfaces and props.** Route sparse manufactured surfaces between
   accepted structures and objectives as a separate overlay over the natural
   biome/tier field. The source art's metal/service hexes belong here, never
   in the natural-ground classifier. Generate props per biome with seeded blue-noise
   spacing. Check the complete sprite-base footprint, coast margin, tier,
   reservations, and every existing footprint before acceptance. Buildings,
   trees, boulders, and heavy cover get static collision from that footprint;
   small grass and decals are explicitly pass-through. Destructible cover
   remains a separate bounded mutable layer over the immutable plan.
5. **Critic.** Reject or deterministically repair failed candidates based on
   land connectivity, tank-radius clearance, 32 spawn slots, minimum route
   count/width, prop non-overlap, reasonable sightlines, maximum coast slope,
   and visual density. No manual one-off placement patch for a single seed.
   Report the failed rule and seed so the rule can be improved.

# Defold realization and migration gate

The [Supernova Files hex-isometric TileMap example](https://sites.google.com/view/supernova-files/blog/creating-a-hexagonal-isometric-tilemap) is useful for a specific invariant: the
logical anchor is the floor/top face, while the visible height extends below
the grid cell, and tall tiles sort by their ground contact. The article's
160-pixel atlas region and 230-by-80 logical cell are different quantities;
we likewise must not infer world pitch from sprite canvas dimensions. Its particular
Godot tile-size numbers are not transferable to Defold. We must derive our
own pitch and origin from `hexCellAt`, `hexCentreAtSimulation`, and the
isometric scene transform; one round-trip test should prove each accepted hex
lands at its logical floor anchor.

Defold's documented `tilemap.set_tile()` can replace/clear tiles **inside
predeclared bounds**, not expand the tilemap. Our runtime wall/decor presenter
already uses it when `mapSeed` changes. The floor must adopt the same model:
a fixed bounded tilemap with ground, three relief, coast-face, and water layers,
using a finite atlas generated from the selected pixel-art source tiles.
The current repeated `hex-meadow.png` macro and rectangular coast texture
must be removed only once that renderer matches the authoritative plan for
the default seed and at least two non-default seeds. A build-time preview may
render one seed cheaply, but a network match may not choose a seed whose
visual plan is not available at runtime.

Tile-source grammar, not extra image-generation calls, is the immediate art
task: complete hex top, edge, shallow-height, and shoreline variants with
nearest-neighbor pixels; test all six neighbor edges for seams. Elevation
layers should move the top face a few pixels and expose matching stacked-hex
side cells, not stretch one cliff sprite vertically. Props use the current
authored sprite sheets but are placed by the plan.

Before wiring this into the live game, produce a deterministic seed atlas:
topology/biome/elevation/occupancy views plus a beauty preview for at least
64 seeds, with critic scores and rejection reasons. Then require:

- same seed + rules version yields byte-identical plan and visual tile IDs;
- no visible land without traversable/colliding semantics, and no collision
  obstacle without a corresponding drawn prop/side face;
- no floating/overlapping props, no coastline cut at the square tilemap edge,
  no seam gaps across any of six hex edges;
- 32 tank-capable spawns and reachable objectives across a seed sweep;
- a real packaged browser screenshot and native screenshot at gameplay zoom,
  followed by bot movement and collision probes on the selected showcase seed.

The current War Battles screenshot and focused coast tests prove neither this
pipeline nor these acceptance conditions. This is a **proposed system** and
the next implementation gate, not a claim that procedural terrain is done.

## First diagnostic prototype

`core/world-plan.ts` now builds a cold-path, bounded typed-array draft of the
island, natural Voronoi biome regions, shallow elevation tiers, and exact coast-side
masks from a seed. `tools/preview-world-plan.mjs` renders a nine-seed contact
sheet to `build/evidence/war-battles-world-plan-contact.png`; it is a topology
diagnostic, not final game art. The first preview exposed a fixed-compass biome
assignment and near-identical silhouettes across seeds. Seeded biome-role
permutation and a wider, still low-frequency coastline perturbation repaired
those visible faults. The plan now also projects its hex fields into the
simulation's 16-pixel cells, reserves 16 separated tank-depot aprons and 32
additional eight-cell-separated player starts,
and emits a fixed-capacity scenic table. A seeded Halton candidate stream
fills accepted footprints; each building, tree, or rock records both visual
clearance and an exact cell collider. The signature building prefers a
meadow footprint, then falls back to another valid land biome if no full
footprint fits; seed 355 previously exposed the need for a general fallback.
The prototype's second rules revision separates manufactured surfaces into
`builtSurface` (a single command pad and a short, connected dirt route)
instead of classifying metal as a natural biome. Basalt/ash are constrained
to an interior accent, and meadow wins closer region boundaries. This is a
source-art preview adjustment, not an approved playable palette.
`test/world-plan.test.mjs` checks 512 seeds for land capacity, connected land,
coast masks, shallow adjacent tiers, nontrivial between-seed variation,
hex-to-cell projection parity, 16 reachable tank depots, 32 reachable and
separated tank-capable starts, separated scenic
footprints, prop-collider derivation, and sparse connected infrastructure.
This is a **topology and contract
test**, not an actual tank movement or rendering test. The terrain compositor
retains its old macro as a separately tested source recipe and now emits a
single bounded, seed-pinned island floor for the experimental live map.
`tools/preview-world-plan-art.mjs` rendered the
selected-seed source-material floor to
`build/evidence/war-battles-world-plan-art-preview.png`; it composites a flat
water color only for inspection. `test/hex-terrain.test.mjs` checks that the
planned art pixel's land/transparent result matches the plan's cell projection
at every simulation-cell centre for two seeds. The first selected-seed beauty
preview was **rejected**: a large black/ash region and repeating metal service
tiles overwhelmed the earlier green-world art direction. The second rules
revision has removed service from natural biome classification and reduced
the broad dark field. Its newer preview is improved but not accepted as
gameplay art without props, coast, units, and camera-scale inspection.
A first experimental live switch of floor, coast, and
collision has run, but it is not a playable signoff: the focused 151-test run
passed 136 and failed 15. Some failures are old point-symmetry/snapshot
expectations that no longer describe an island; pickup, bot, prop, and visual
parity failures are real migration work, not assertions to delete blindly.
The live switch must not be released before those systems agree on one plan.

The plan now has 32 separate start cells across a 512-seed test sweep.
Before runtime wiring,
`PlayableBattle({ players: 32 })` on four sampled seeds has zero
blocked starting hulls, but its closest pair is only 48 pixels apart; this
does **not** satisfy the desired 32-start distribution. A read-only 4-cell
candidate scan found 67–74 eight-cell-separated, tank-clear placements on
those same seeds, suggesting the 120×90 simulation map has room if the start
selector uses it. That scan did not check full routes or visual composition
and was not an accepted spawn algorithm. The implemented plan selector uses a
seed-ordered finite candidate lattice, reserves each accepted tank footprint,
and verifies route reachability after scenery. Increasing its bounded Halton
scenery candidate pass from 512 to 1024 kept at least 27 props on each of the
first 512 seeds despite the extra start reservations. This is cold-path plan
evidence; real game starts and graphical prop placement remain open.

First-life `BattleWorld` admissions now consume the 32-start table; respawns
still use the enemy-aware tank-depot selector. Four sampled live maps (seeds
0, 77, the default, and 0xffffffff) each admitted 32 unblocked tanks with a
128-pixel closest pair. The actual 32-player start test passes. A broader
focused run currently passes 139/155 tests; old point-symmetric wall and
landmark assumptions no longer describe the island, while combat/bot
fixture placement and collision/visual parity still need investigation.
This is not browser/native visual or gameplay signoff.

## Loaded island alignment pass

The mutable-cover follow-up tested shorter 3×2/2×3 and 4×2/2×4 sandbag
stamps in a real Defold 1.14.0 WebGL2 package. The shorter shapes visually
reduced the two long pale strips on the shipped seed, and a five-second
WebTransport browser run under 65 ms one-way latency, 15 ms jitter, and 10%
configured loss had no presented step over 32 px. The broader deterministic
32-client network matrix contradicted that narrow success: the 3×2 layout
raised mobile-congested over-eight-pixel correction ratio to 0.106 (ceiling
0.10) and the edge maximum correction to 2,865 fixed units (ceiling 2,400);
4×2 still reached 0.105 on mobile. The short-stamp experiment was therefore
rejected, not promoted by relaxing the performance gate. The original
5×2/2×5 geometry remains, and the pale repeated sandbag art remains open.

One independent cover fix was retained: a bounded full-cell fallback adds a
2×2 crate only when no sparse-lattice stamp was accepted. It uses the same
clearance check, so it cannot bypass shore, scenery, or start protection.
Across seeds 0–511 the original-geometry cover range is now 4–62 panels,
with no coverless seeds; the nonadjacent `0xffffffff` seed has four instead
of zero, and the shipped default still has 24. The focused core suite checks
connected floor, cover ownership, and authoritative destruction. The three
32-client impairment profiles again meet their original correction ceilings
without changing test thresholds. Native pixel parity remains unverified
because the Mac desktop was locked. The retained source was synchronized and
rebuilt with Bob for HTML5 and arm64-macOS; packaged Chromium playability,
packaged native startup, the default/512-seed world owner checks, and
`verify:generated` passed. The full example suite passes 317/318 tests; its
only failure is an older VS Code screenshot lacking the inline `players`
value, which is not gameplay or cover evidence.

One `style-reference` Sprite Fusion prototype, `war-sandbag-module-v1`, used
the current cover module and four pinned low-cover provider assets. It cost
15 credits (195→180) and returned nine immutable 64×64 variations. The
first thumbnail review wrongly described them all as long rolls: an enlarged
nearest-neighbor nine-candidate sheet shows discrete stacked bags in several
outputs. The original 48px review cell was too narrow for this asset class;
the preview now sizes its review cell from the candidates rather than
rejecting them for a presentation-layout limit. Selected outputs 05 and 03
are pinned by asset ID in `sandbag-selection-v1.json` and normalized through
the owning generator into the existing 36×32 cover cells. A first 1:2
projection looked like dark rubble at gameplay scale; the retained 5:8
nearest-neighbor projection preserves more bag seams while keeping at least
two pixels of horizontal atlas gutter and the original ground line. In the
same 1280×720 packaged WebGL2 camera view, this replaces the pale continuous
rolls with darker short modular piles without changing 5×2/2×5 cover
placement or collision. The browser keyboard/fire/restart gate and 130
focused world/core tests pass. Source IDs, source/spec hashes, selected
variants, and projection rule are in `arena-art.json`; the focused art test
checks source provenance, output gutters, and the crate's separate OpenAI
source. `build/evidence/war-battles-sandbags-v1-1280.png` and
`war-battles-sandbags-v2-1280.png` preserve the two projection trials. This
improves one loaded scene, not whole-map repetition, native visual parity, or
the overall art direction; no further credits were spent on this integration.

The October 9 spacing follow-up added a cold-path projected-rock crowding
rule to `WorldPlan` (rules version 5). It uses the same isometric cell
projection as the art emitter and rejects rock centers closer than 112 screen
pixels horizontally **and** 64 vertically. On the default seed, the previous
plan had 36 props including 23 rocks and 12 too-close projected rock pairs;
the new plan has 32 props including 18 rocks and none of those pairs. The
0–511 seed audit passes with 23–36 props, and 64 nonadjacent seeds pass with
24–36. The owner verification passed 149 focused world/core tests; the Defold
1.14.0 HTML5/WebGL2 package passed playability with a 1280×720 screenshot at
`build/evidence/war-battles-rock-spacing-v5-1280.png`. Native Bob packaging
and packaged-engine startup also passed. This improves repeated rock spacing
in one loaded view, but repeated mound motifs and native visual parity remain
unreviewed quality gates. The sandbag selection above supersedes the pale
cover source; repeated cover/mound rhythm still needs whole-map review.

The experimental loaded map no longer selects immutable square wall stamps.
Its immutable collision is the same seed-pinned `WorldPlan` that paints the
floor: ocean cells and the accepted prop footprints. Destructible crates and
sandbags remain a separate bounded mutable overlay. Every accepted tree,
rock, and building collider now has one foot-sorted sprite derived from its
plan record; the same prop mask hides the square wall/face tiles that would
otherwise show beneath those sprites. The legacy repeating-hex biome lookup
was replaced in cliffs, small conifers, and ground decals with a lookup of
the actual planned floor/built-surface role. The plan's 32 first-life starts
are consumed by the runtime; 16 depots remain independent for respawn.

The user-linked Supernova Files article led to a shoreline experiment. Simply
cropping repeated raised-hex sprites made abrupt square-edged columns and was
rejected by packaged-browser screenshot. The retained coast generator instead
uses the exact planned hex land mask to draw source-colored forward faces
*below* the top-face anchor, with 3/5/7 half-resolution pixel depths for the
low/standard/high tiers. The generated coast test checks 4,302 face pixels
and a maximum continuous vertical face run of seven pixels; the source PNGs
remain unchanged and no Sprite Fusion credits were spent.

The current packaged HTML5 capture is
`build/evidence/war-battles-edge-face-live.png`. It shows the tall coast
columns gone and planned props visible at gameplay zoom; it is visual review
of one camera/seed, not proof of all seams, props, or controls. The HTML5
playability gate passed WebGL2, keyboard admission, restart and sound markers.
The arm64-macOS Bob archive built and the packaged native runtime gate passed
engine/TypeScript/arena markers with graceful exit. A native *visual*
screenshot has not been captured, so pixel parity on native remains open.

The focused island/arena suite was 140/156 immediately after this pass, with
16 failures. Some test fixtures still require point symmetry or long raised
stamps that no longer exist; other failures exposed real work. In particular,
pickup pads were selected by open cell without tank-radius clearance, so a
tank explicitly spawned on a pad could be pushed away and never collect it.
Pickup and hazard placement now asks `nearestOpen` for full tank clearance;
the focused pickup and hazard authority tests pass. The cover test now checks
island-local, unique, prop-free cover cells and a real open firing lane, not
an impossible mirror pair; it passes. The remaining suite must be rerun after
these changes, and collision, bot, and network tests are not yet green.

After regeneration and rebuilding both targets with those fixes, the HTML5
playability and native packaged-runtime gates passed again. The rerun focused
suite is 143/156: 13 failures remain, including six stale raised-stamp art
contracts and seven combat, bot-trace, symmetry, and client-prediction
scenarios. The two-client failure is a 35-unit local/authority difference with
the client two ticks ahead (303 versus 301); this is diagnosed, not yet
accepted as a tolerance or fixed. No native image has been inspected.

## Cover placement follows the irregular island

The Supernova Files article's anchor rule is already embodied in the shared
isometric projection and foot-based Z sort, and the floor-anchor round-trip
test covers coordinates. It does not supply Defold's terrain layout or solve
gameplay connectivity. A separate live-world defect remained: reactive cover
was point-mirrored from the old square arena, then clipped by the irregular
island. A read-only flood fill found one inaccessible open cell on the default
seed and nine on `0x0badf00d`, where sandbags closed narrow coast passages.

Cover now samples each lattice point independently, accepts a whole stamp only
when its footprint and two-cell driving halo are on planned land and clear of
scenery/other cover, and excludes protected starts from the stamp footprint.
The cover-cell budget is bounded before stamping, so every crate/sandbag cell
has a mutable panel record. The focused test checks reproducibility, full
open-cell connectivity, plan-owned collision, and cover-table completeness
across 512 seeds; a separate direct sweep also found zero disconnected seeds
and zero orphaned cover cells. This is map-construction evidence, not a claim
that every combat fixture, bot path, or network prediction test passes.

## Live-world foot and depot contract

At the time of this foot/depot pass, the world-plan rules were version 3. Four compass depot pads are
reserved before scenic placement, and both the plan and the Defold selector
use one projected-footprint overlap predicate. The bounded Halton pass has
2,048 candidate slots so the reserved pads do not starve scenery. In a
read-only 512-seed sweep, every seed produced at least four visible depots
and 28–36 accepted props. This guards the map layout and gameplay spawn
space; it is not an all-seed image comparison.

The loaded scene no longer runs the obsolete raised-square-wall stamp passes.
It renders exactly the plan-owned prop anchors, meadow scatter, mutable
cover, and depot sprites, with collision and visual prop masks sharing the
plan records. The old raised-stamp tests were replaced by live-world tests
for projected prop/collider parity, coast pixels, ground-foot alignment,
depot/prop non-overlap across 257 seeds, and absence of duplicate square
walls. The focused arena, coast, terrain, and plan suite is 147/147 green.
The two-client prediction test now compares a same-tick authoritative
snapshot after the server catches up to the client's intentional two-tick
lead; its prior 35-unit mismatch was a cross-tick comparison.

The generated Defold source mirror, terrain, coast, and tilemap all pass
their owner checks. The latest Bob HTML5 bundle passed the real Chromium
WebGL2 playability gate (input, restart, sound), and a 1280×720 live capture
is `build/evidence/war-battles-island-live-2026-10-08.png`. Bob's arm64
bundle built, and the packaged native engine loaded the TypeScript bundle,
entered the arena, and exited cleanly. The macOS UI was locked during a
native screenshot attempt; no native *visual* parity is claimed. One real
WebTransport/QUIC browser impairment run at 65 ms one-way latency, ±15 ms
jitter, and 10% packet loss passed with 35 snapshots, 307 accepted inputs,
maximum 15-pixel local correction, and zero corrections above 32 pixels.
This is one bounded run, not proof under every network condition.

### Pass-through conifer correction (2026-10-09)

The loaded scene still had a second, independent scenery pass after the
plan-owned props: 25 half-scale conifers on the default seed, instantiated as
visible landmark sprites without any collision. They looked like trees a tank
should hit. That violated the intended visual/collision affordance even though
the pass was deterministic and had floor-clearance tests. The pass and its
unused shared module were removed; substantial conifers now enter the scene
only as plan-owned `WORLD_PROP_TREE` records with `propSolid` cells. The
default plan still has 32 collidable scenery props, and a fresh packaged
1280×720 browser capture shows a clearer open meadow rather than a barren
one. `verify-world` passed the default seed and a 512-seed sweep after the
change; its focused suite passed. A fresh Bob wasm-web package passed real
browser keyboard/fire/restart playability, and a fresh arm64-macOS package
loaded the TypeScript bundle, entered the arena, and exited cleanly. These
checks did not prove every decorative depot facade was solid or establish
native visual parity; the facade issue is addressed in the later v6 pass below.

### Grounded depot facades (2026-10-09)

Version 6 replaces the four screen-shifted depot buildings with plan-owned
`WORLD_PROP_DEPOT` records. The facade centre is selected from a bounded
land-and-reservation-checked neighborhood of its gameplay apron, aiming for
the old readable upscreen separation but falling back to another grounded
nearby cell where the coast prevents it. Its visible sprite and immutable
collision share `depotFacadeCells[slot]`; twelve other tank-reacquisition
aprons remain clear without decorative buildings. The original fixed offset
could project a default-seed building centre over water and was pass-through.

The world skill's default and 512-seed audits require exactly four grounded,
blocking facade records. Its 155 focused tests cover deterministic placement,
prop separation, connected tank starts, and authoritative tank driving into
the new collider. Source mirrors and terrain/coast/tilemap were regenerated
through their owners. Both local Bob targets built; packaged Chromium WebGL2
playability passed, and the packaged arm64-macOS engine entered the arena and
exited cleanly. The browser capture at
`build/evidence/war-battles-html5.png` is one default-camera visual sample.
Native pixel appearance, all-seed visual quality, and WAN smoothness are not
established by these checks.

The broader `pnpm test` run produced 278 passes and 19 failures before one
live-world decor assertion was repaired. That assertion still read the old
repeating hex biome instead of the rendered world-plan surface; it now checks
the actual plan and passes. Most other failures are source-bound evidence
inventories or old fixture expectations that require their owners to
regenerate and review. Two 16-client network limits are substantive and were
not relaxed: clean-play maximum correction measured 268 fixed units against
the current 160-unit limit, and an edge-congested run accepted 93.79% of
generated inputs against the test's >94% limit. Both runs converged; they
still need diagnosis. A native visual comparison and a fully green example
suite remain open.

## Reusable world-generation workflow

The validated rules now have a repository skill at
`.codex/skills/defold-hex-world/SKILL.md`. Its read-only
`scripts/audit-world.mjs` reports land, coast, biome, shallow elevation,
scenery, starts, and visible-depot distributions over a chosen seed range;
it rejects invalid coast masks, elevation jumps, unknown roles, or obscured
protected depots. `scripts/verify-world.mjs` runs the owning generated-state
checks and focused tests by default. Explicit `--write` regenerates terrain,
coast, tilemap, and Defold source mirrors through their existing owners;
`--preview` writes contact images under `build/evidence/`. The skill does not
duplicate world-plan generation or treat structural metrics as visual proof.

The companion Sprite Fusion skill now names this seam: paid/source artwork
supplies selected faces and silhouettes, while the plan owns island topology,
elevation, placement, collision, and derived resources. Running the new
read-only verifier on rules version 3 passed 148 focused tests and all four
owner checks. Its 512-seed audit saw land 250–327 hexes, coast 58–74 hexes,
28–36 props, four to seven visible depot sprites, and 32 starts per seed.
These are structural bounds for that sample, not aesthetic acceptance.

The skill's next usage exposed a sampling gap: `--seed 0 --count 64` did not
include the shipped default seed. The audit now accepts `--seed default` from
`DEFAULT_ARENA_SEED` and prints biome/elevation distributions in its text
summary; `verify-world.mjs` now runs this default audit as well as its 512-seed
sweep. On rules v3, the actual default (`1463898690`) has 290 land hexes,
62 coastal hexes, 36 props, five visible depots, and 32 starts; natural
biomes are 205 meadow, 80 earth, five basalt, and zero ash. The 0–63 sweep
remains a separate structural sample. Neither result is visual acceptance:
candidate previews reuse one output path, and default-seed packaged gameplay
at camera scale still controls the aesthetic judgment.

## Selected-source ocean pass (2026-10-09)

The shipped default now uses world-plan rules v4. The read-only audit saw 290
land hexes, 62 coastal hexes, 36 props, four visible protected depots, and 32
starts; a separate 0–63 seed sweep retained valid coast masks and shallow
adjacent tiers. These counts establish layout constraints, not art quality.

At 1205×678 actual Chromium/WebGL2 gameplay scale, the former coast shader's
four-source-pixel diagonal foam cells visibly formed a teal checkerboard in
the ocean. `tools/generate-coast.mjs` now uses a quiet two-tone sea and scatters
nearest-neighbor half-size wave motifs from the already-pinned Sprite Fusion
coastal-water source. The fragment shader animates one-source-pixel segmented
foam rows instead of enlarged blocks. The generator's land mask still clips
all wavelets to water, and its existing 3/5/7-pixel source-colored coast faces
still cover the same forward shoreline. No new paid asset request or world-plan
placement change was made.

The rebuilt Bob `wasm-web` game passed the packaged keyboard/WebGL2
playability gate. Its default-seed gameplay capture is
`build/evidence/war-battles-water-wavelets-live-v2.png`; visual inspection
shows the ocean's square checker pattern removed, with one visible cyan source
wavelet at this camera position. The first animation gate run failed because
its fixed "ocean" rectangle had become terrain after the island layout moved.
The gate now classifies a broad live sea-color region and requires at least
5,000 sampled sea pixels: over 430 ms, 716 of 63,191 sampled sea pixels
changed. A second color/adjacency mask samples the source-colored coast
candidate pixels; three repeat captures changed only 3–6 of about 620 such
pixels, within a 1% allowance for animated objects touching shore. This is
packaged-browser animation evidence for one scene, not native visual parity or
all-camera coast inspection. `verify-world.mjs` passed its four owner checks,
149 focused tests, the shipped default audit, and a 512-seed structural sweep.

## Projected prop clearance, rules v7 (2026-10-09)

The earlier cell-circle placement rule did not guarantee that tall sprites
would stay apart after isometric projection. A read-only audit of the selected
art's opaque rectangles found projected overlaps in 413 of seeds 0–511 (836
pairs total), although the shipped default seed had none. This is a visual
placement defect, not evidence of overlapping colliders.

Rules v7 checks the exact selected variant's opaque screen-space rectangle
against every already accepted prop. Placement and rendering now share the
same deterministic variant selector; a test checks the selected art manifest
against all ten declared rectangles, then checks accepted pairs over 512
seeds. A first, broader class-wide rectangle removed enough cover to break
the bot combat threshold, so it was rejected without weakening that test.
The narrower variant-specific rule retains 32 props on the shipped seed.

The owner `verify-world --write --preview` passed generated-state checks,
161 focused tests, the default audit (290 land hexes, 62 coast hexes, four
depots, 32 starts, 32 props), and a 512-seed sweep (25–40 props). The full
example check passed 351/351 tests after source-bound records were regenerated by
their owners. Current native and wasm-web Bob bundles built; packaged native
startup/arena/fire/move/exit, browser WebGL2 playability, and a short browser
QUIC impairment run passed. The latter sampled a 21-pixel maximum raw local
correction, 6-pixel local and 18-pixel remote maximum presented steps under
65 ms one-way latency, 15 ms jitter, and 10% packet loss. Those measurements
do not establish long-match smoothness. The browser frame is
`build/evidence/war-battles-v7-final-1280.png`; native gameplay pixels,
multi-camera visual review, and extended WAN/network quality remain open.

## Seed-aware shoreline framing (2026-10-09)

A 30-second packaged WebGL2/QUIC contact sheet exposed a composition problem
outside the floor generator: a driver travelling along the north coast could
leave most of the viewport as empty ocean, hiding playable land and combat at
the bottom. The camera now reads the active match's authoritative `WorldPlan`
land mask and uses a cold-cached list of projected floor anchors. On each
target message it computes a bounded, continuous landward offset; the driver
remains within the central half of the view. No per-frame object or array is
allocated by this framing pass. It neither moves the actor nor changes
collision, world generation, or network state.

Focused tests cover both opposite shores, near-centered interior play, the
maximum offset, and continuity under small actor movement. The new camera
source compiled into current wasm-web and arm64-macOS Bob bundles. Packaged
browser WebGL2 playability passed and a new 30-second 1280×720 online clip is
`build/evidence/war-battles-landward-online-30s.mp4`. One-frame-per-second
contact-sheet review showed more visible battlefield during the north-coast
drive than the pre-change clip; this is a visual comparison, not a pixel-
classified coverage score or an all-seed aesthetic signoff. The current
default and seeds 0–511 still pass world topology/placement audits on rules
v7. Packaged native startup, arena engagement, firing, movement and graceful
exit passed, but native gameplay pixels were not captured.

The networking concern remains separate: a prior 30-second video-backed
standard impairment run failed once on a >32-pixel **raw** local correction,
while another run passed. The probe now prints correction/lifecycle/window
context and preserves the clip on a future assertion failure. The post-camera
30-second 65±15 ms/10%-loss run passed with 1,757 accepted and 29 late
inputs, but that single pass does not close the intermittent correction or
establish WAN smoothness.

The owner regenerated the source-bound Static Hermes release projection and
gameplay/load/performance/QUIC evidence after the camera edit. The full
example `pnpm check` then passed 353/353 tests.
