---
name: sprite-fusion-defold-art
description: Create and integrate coherent Sprite Fusion pixel art for Defold games. Use for Sprite Fusion API requests, style matching, directional characters, animation, Defold tilesets or tilemaps, nine-slice HUD art, atlas cleanup, credit-aware iteration, and browser/native visual QA.
---

# Sprite Fusion + Defold art

Build a coherent game-art system, not a pile of unrelated generated images.
Use Sprite Fusion for source pixels and focused transformations; use deterministic
repository generators for runtime layout, IDs, atlases, nine-slice assets,
tile topology, collision data, and Defold resources.

## Start with evidence

1. Capture the current HTML5 and native game at representative gameplay states.
2. Inventory the existing palette, outline weight, projection, native pixel grid,
   anchors, animation timing, UI safe areas, and tile roles.
3. Define the asset's runtime role and acceptance checks before spending credits.
4. Preserve original source art and every accepted API response.

If the native desktop is inaccessible, continue the source and HTML5 work, record
that boundary, and do not claim native visual verification.

## Choose the correct Sprite Fusion operation

| Intent | Operation | Rules |
| --- | --- | --- |
| New subject without a source | `generate` | Describe one subject; set `size` in the request. |
| Targeted change preserving a sprite | `edit` | Primary image first; request one focused change; state what must remain. |
| New subject matching established art | `style-reference` | Prefer a coherent pack of 4–8 references; describe the new subject neutrally. |
| Eight facing directions | `direction-set` | Exactly one input; no prompt. |
| Animation | `animate` | Start from a cleaned, action-ready pose; set frames/colors as fields. |

Never ask Sprite Fusion for a grid, atlas, contact sheet, packed spritesheet, or
complete autotile set. The API already returns variations. Generate separate
subjects or poses, then let deterministic tooling pack them.

Avoid prompt noise such as “transparent background,” “crisp pixel art,” pixel
dimensions, and repeated style adjectives. Describe the desired result and the
few visual traits that distinguish it.

## Spend credits deliberately

1. Check the credit balance before a wave.
2. Make one high-leverage request and inspect every variation.
3. Select by stable request ID, asset ID, and output index.
4. Use `edit` on the strongest candidate instead of repeatedly starting over.
5. Stop a direction when silhouette, projection, or palette is fundamentally
   wrong; revise the source or references before requesting animation.

Do not automatically retry an interrupted SSE generation. Recover persisted
outputs first because a request may already have consumed credits.

## Style-reference packs

- Use 4–8 references that agree on projection, scale, outline weight, palette,
  and density. Do not include a large mixed asset sheet.
- Crop references around the relevant visual language. A portrait, HUD panel,
  and terrain tile are not interchangeable style evidence.
- For War Battles, preserve the tutorial's chunky military silhouettes, muted
  olive/steel palette, cream highlights, orange explosions, and readable dark
  outlines while allowing the volcanic-refinery theme to add basalt and heat.
- Generate modular props and motifs at 32 or 64 px when 16 px results lose form;
  reduce and clean them on the native pixel grid afterward.

## Production cleanup

Follow the `pixel-art-atlas` skill for extraction and atlas work. In particular:

- remove only edge-connected backgrounds;
- use explicit, possibly nonuniform frame crops;
- align frames to a semantic anchor;
- pad cells to prevent texture bleed;
- record edge-contact QA and reject clipped silhouettes;
- preserve source pixels separately from corrected runtime derivatives.

For HUDs, generate or draw small true nine-slice primitives whose corners,
edges, and center are intentionally repeatable. Never nine-slice a composite
panel containing portraits, labels, separators, or unequal decorative regions.

## Tiles and maps

Sprite Fusion's Tilemap Editor authors layouts; it does not replace art cleanup.
Import a tilesheet whose dimensions are exact multiples of the tile size. Use
autotile layers and explicit 3×3 rules for connected terrain, walls, roads,
water, cliffs, and transitions. Exercise every required neighbor mask and use
weighted variants only after seams are correct.

Defold export can provide `.tilemap`, `.tilesource`, `tilesheet.png`, collision
layers, and `tile_data.json`. In this repository, normalize those semantics into
the authoritative generators rather than making a manual editor export an
untracked runtime dependency.

## Required records and verification

- Keep request specs, request IDs, operation, prompt, input hashes, asset IDs,
  output indices, local paths, and remaining credits.
- Save project-owned copies; do not hotlink hosted assets.
- Regenerate runtime assets through their owning tools.
- Run art determinism and generated-state checks.
- Capture and inspect HTML5 and native screenshots at real gameplay scale.
- Check seams, clipping, nearest-neighbor sampling, anchor jitter, legibility,
  aspect-ratio behavior, and nine-slice stretching.
- Update the relevant OKF record with evidence boundaries and credit usage.

## Official references

- [Agent guide](https://www.spritefusion.com/docs/pixel-art-generator/api/agent-guide)
- [Generate and transform sprites](https://www.spritefusion.com/docs/pixel-art-generator/api/generate-and-transform-images)
- [Style consistency](https://www.spritefusion.com/docs/pixel-art-generator/generate-pixel-art-with-style-consistency)
- [Editing](https://www.spritefusion.com/docs/pixel-art-generator/edit-your-pixel-art)
- [Animation preparation](https://www.spritefusion.com/docs/pixel-art-generator/animation-tips)
- [Eight directions](https://www.spritefusion.com/docs/pixel-art-generator/generate-8-directions-for-your-pixel-art)
- [Autotile system](https://www.spritefusion.com/docs/tilemap-editor/editor/autotile-system)
- [Defold export](https://www.spritefusion.com/docs/tilemap-editor/exporting-maps/defold)
