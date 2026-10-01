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
