# War Battles art direction

This directory preserves approved visual targets. These images are design
evidence, not runtime atlases. Runtime sprites, tiles, anchors, collision, and
Defold resources remain deterministic generated outputs with explicit source
records.

## `gameplay-target-v2.png`

The target establishes the production grammar for the showcase:

- a 16 px logical terrain grid;
- tanks approximately 30–36 native pixels long;
- ejected drivers approximately 18–24 native pixels tall;
- separate, readable scout, assault, bulwark, and artillery silhouettes;
- persistent driver/team colour identity without recolouring the whole tank;
- tutorial olive, cream, warm stone, charcoal steel, and dark-plum outlines;
- sparse high-value props, tracks, craters, cover, and landmarks; and
- no decorative tanks baked into terrain or collision tiles.

The source was generated from the pinned tutorial tank and map, the approved
driver portrait, the approved refinery depot, and a live browser capture. It
must not be sliced directly into production sprites. Each runtime family is
generated or authored separately, corrected to the native pixel grid, aligned
to semantic anchors, packed with padding, and verified in the live game.

## `tank-silhouette-target-v3.png`

This is a four-class shape study, not a runtime sprite sheet. It was generated
with the built-in image tool from the Scout/Assault/Bulwark/Artillery brief; its
source SHA-256 is
`bd86ced0ba03d070c15dbb1805a6137a76545a4476f7998f4a3f9692c02bfa3d`.
The 1254×1254 composition is a visual target only: it has one facing, uneven
logical pixel scale, and no independent hull/turret layers or foot-contact
anchors. Do not slice it directly into the runtime atlas.

The shape read to carry into production is narrow fins/antenna on Scout,
wide dozer prow and paired gun barrels on Assault, slab armor and blunt nose
on Bulwark, and a long rail chassis with rear outriggers on Artillery. The
current runtime atlas has four separate eight-direction hull and turret
source families and class markings. This satisfies the directional source
count, but not the target's visual-approval bar: each source pair still needs
explicit ground and turret-socket registration, mixed-facing review, and a
gameplay-scale comparison against this shape study.

## Directional unit registration

The tank direction order is `se,s,sw,w,e,nw,n,ne` at runtime. Source indices
come from `art/source/sprite-fusion/tank-selection-v2.json`; never infer order
from a contact sheet. `tools/preview-tank-v2.mjs` creates the eight-facing
four-chassis source composite under `art/preview/`. Scout, Assault, and
Bulwark now join Artillery with source-declared mounts. This establishes a
shared atlas target for every selected hull and turret direction, not final
aesthetic acceptance of every independently aimed pose. Source images and
output hashes remain pinned in their Sprite Fusion request manifests.
The source QA tool now emits one registration sheet and one 8×8 mixed-aim
matrix per chassis. Rows in the latter are hull headings, columns turret
headings, both in the runtime direction order. The magenta centre guide marks
the canvas centre; it is not itself a socket annotation. Reviewing the older
matrices exposed a concrete Artillery source defect: the selected v2 hull
includes a raised superstructure, and the v2 turret carries another one.
Independent aim can show both at once. The older v1 hull was also previewed;
its frames range from 64–88 px (six exceed 80 px, versus the current 64 px
source), visibly changing scale and
palette, and still does not give a clean mount with the v2 turret. Neither
source should be silently substituted as a production fix. Obtain or author a
turretless, scale-matched hull set, record its per-view socket/ground anchors,
then make the generator register the turret to those anchors and repeat the
mixed-aim and live-game review.

The subsequent `artillery-low-deck-directions-v3b` source replaces that v2
hull. Its raised second cabin is absent in the generated 8×8 mixed-aim matrix.
The source selection now declares one hull ring and one turret-base mount per
facing, tied to the exact selected request names. `tank-registration.mjs`
projects both layers onto one fixed atlas-cell mount; the runtime generator
and QA preview use the same rule. An archived or new candidate does not
inherit these anchors. The 8×8 preview and two freshly captured packaged
mixed-angle poses show more of the tracked hull under the turret than the
previous canvas-centred output. This is source-measured registration for
Artillery, not a native visual signoff or proof that every 8×8 pairing looks
good in motion. Scout, Assault, and Bulwark subsequently received the same
per-facing registration contract. Their candidate 8×8 sheets were reviewed,
then six packaged-browser captures sampled same-facing and mixed-aim poses
across those classes; see `build/evidence/registered-three-class-browser-review.png`.
The sampled layers look mounted at gameplay scale. Ground-contact rotation
jitter, every mixed pairing in motion, and native visual parity are still open.

The selected ejected drivers are Rook, Brass, Spark, and Mud. Each has eight
Sprite Fusion direction-set idle sources and eight separately requested
four-frame walk loops. `art/source/hero-source-selection.json` pins the exact
request names, runtime direction order, and the few side-view corrections;
`tools/generate-hero-art.mjs` normalizes their source crops to a shared 40×40
canvas and 36-pixel foot baseline. The generator rejects missing or clipped
frames, and the atlas skill's strict registration check independently checks
the emitted PNGs and anchors. Packaged browser contact sheets and videos exist
for all four families under `build/evidence/hero-directional-runtime*/`.
There are 32 persistent call-sign identities but four visual families, so
several players can share a look; switching tanks does not change a driver's
identity. Each family now pins a Sprite Fusion firing-pose edit and an
eight-view firing direction-set. The generator emits an eight-facing,
three-frame one-shot fire sequence selected by the real shot cooldown;
`PLAYBACK_ONCE_FORWARD` is required because `PLAYBACK_NONE` freezes the idle
first frame. Four packaged Chromium gallery sheets and videos exercise idle,
walk, and fire selection through the real player component. One natural
on-foot Rook shot was also captured; the gallery is not a natural online
combat test.
All four families now pin Sprite Fusion edits for eight hit and eight collapsed
death views. The generator emits one-shot atlas animations selected by the real
player component. The hit poses are visually subtle and natural online
combat-state selection remains unverified. The first browser contact sheet used a crop
that cut off several helmets even though the game sprite was intact; the
capture now retains a full-viewport frame and uses a 112-pixel crop around
each rendered pose. Inspect both artifacts before diagnosing atlas clipping.

## Landscape tile contract

The battlefield floor is a connected landscape, not a random-detail carpet.
The runtime grammar uses a shared meadow substrate plus broad worn-earth,
basalt, and scorch regions. Each non-meadow material has every four-neighbour
mask and four coordinate phases. Sprite Fusion sources may contribute texture
rhythm and relative values, but only the local generator owns mask topology,
palette projection, tile ids, Defold border extrusion, and seam verification.
Solid collision cells render as porous, ground-seated rock cover. They must not
reintroduce the old raised metal slab, safety-stripe, or floating facade shape.

Acceptance is mechanical before it is aesthetic: all connected edges must
match byte-for-byte, every generated role must resolve for every theme, the
complete floor and wall role space must remain byte-sized, and the packaged
WebGL game must pass the playability gate without atlas-bleed seams.

`frontier-hex-earth-track-v1` and `frontier-hex-service-scar-v1` are archived
Sprite Fusion requests, not selected floor material. Both resemble raised
blocks at gameplay scale. The transparent
`art/source/imagegen/frontier-cliff-edge-study-v1.png` is also a rejected
runtime candidate, not a tile sheet: its cropped segments produced isolated
walls even after correcting their ground contact. A future cliff edge must
follow the arena collision contour continuously and put its face outside the
playable surface.

## Hex frontier title background

`art/source/imagegen/title-hex-frontier-v4.png` is the selected 1672×941 title
source (SHA-256
`9c8ef090784984b8006a47a243f9fc096661c06cd152adf9464868eec02107ce`).
The exact prompt and source dimensions live in its adjacent JSON manifest. It
uses a continuous aligned hex island, low traversable terraces, a basalt
cliff coast, turquoise water, a refinery, and distinct grounded tanks. It was
generated against the approved hex-world direction and an actual gameplay
capture so the tank scale and materials follow the game more closely than the
earlier tropical panorama. The center remains reserved for the existing
interactive title card and logo; no lettering was baked into the image.
`pnpm title-art` validates the source and projects it with nearest-neighbor
sampling to the 1280×720 runtime background; `pnpm title-art:check` detects
stale output. This source used the built-in image generator, consuming no
Sprite Fusion credits. Sprite Fusion's sponsorship remains credited by a
separate GUI node and is not a claim that this background used Sprite Fusion.

The earlier v1, v2, and v3 sources remain archived for comparison; none is
selected by the title-art emitter.

The title is a presentation background, not a tile or collision source. Only
the composite runtime capture is evidence for legibility at game scale.

## Hex relief contract

Every floor cell is positioned by the 96-pixel hex lattice; changing its
relief tier does not move its center or create a second offset grid. The
authored 12×12 relief map has contiguous low, standard, and high regions with
a standard-height border for periodic tiling. The visual height shift is only
2.5 screen-world pixels per tier and is interpolated during tank traversal.
The compositor draws low lips at tier boundaries; these are driveable ground
variation, not tall cover. A future multi-tilemap implementation must preserve
the same centers, collision map, and sampling contract before replacing this
single terrain component.

Raised cliff sprites use those exact hex centers too. A collision stamp is
still an authoritative square-grid wall, so a stamp without a hex center
inside it keeps its visible wall top rather than receiving an off-grid raised
sprite or becoming an invisible collider. Grounded buildings and foliage keep
their existing wall-stamp coverage. This does not add a second terrain grid.

The island's waterline is a separate generated presentation layer. Its front
edge uses two short, interlocking courses of the checked hex-cliff art, not a
single stretched rock strip. The foundation is 48 screen-world pixels deep;
each source cell is projected into a 40×18 image-pixel footprint with a
10-pixel lower-course offset. This keeps the land close to the ocean while
leaving taller blocked hex landforms available inside the world. The coast
texture does not alter the collision map or floor relief tiers.

## Dry-earth blocked stamps

The generated atlas retains three ochre raised-hex candidates at indices
12–14, but only index 12 is selected by the coast emitter. The larger
inland candidates read as isolated plates at the 2× camera scale. The runtime
therefore seats compact earthwork or neutral-cover sprites on dry-earth wall
stamps: one on a short stamp, a paired silhouette on a long stamp. This is a
presentation choice in `core/hex-cliffs.ts`; the authoritative blocked cells
and collision remain unchanged. The source candidates stay archived for a
future coherent raised-landform treatment, not silently deleted or substituted.
The seeded stamp tests and packaged browser capture verify the current path;
the native pixels of this revision still need visual review.
