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

| Intent                               | Operation         | Rules                                                                         |
| ------------------------------------ | ----------------- | ----------------------------------------------------------------------------- |
| New subject without a source         | `generate`        | Describe one subject; set `size` in the request.                              |
| Targeted change preserving a sprite  | `edit`            | Primary image first; request one focused change; state what must remain.      |
| New subject matching established art | `style-reference` | Prefer a coherent pack of 4–8 references; describe the new subject neutrally. |
| Eight facing directions              | `direction-set`   | Exactly one input; no prompt.                                                 |
| Animation                            | `animate`         | Start from a cleaned, action-ready pose; set frames/colors as fields.         |

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

Before including repository images as API inputs, confirm that exporting those
exact files to Sprite Fusion is authorized. If a host safety review denies the
upload, do not retry it through another transport or service. Preserve the
unrun request spec and continue with local source/runtime QA until the owner
approves those files explicitly.

Do not automatically retry an interrupted SSE generation. Recover persisted
outputs first because a request may already have consumed credits.
The project API wrapper refuses a reused request name _before_ sending a paid
request. If a request has no local manifest after interruption, inspect its
output directory, provider history, and credit balance before assigning a new
name; a failed local preflight is not permission to repeat an API operation.

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

For layered, directional units, review the _composite_ as well as each source:

- Confirm the runtime's direction order against the source request manifest; a
  complete eight-image response does not prove the facings are correctly named.
- Compare each direction-set output's _opaque footprint_ with the source and
  with neighboring facings. The requested 64×64 canvas can still contain a
  shrunken diagonal hull or an oversized side view. Reject that as a source
  selection problem before tuning runtime scale or pivots around it.
- Record a ground-contact point and turret/socket pivot for each view. Register
  hulls by the contact point and turrets by their mounting pivot, not by each
  PNG's canvas or opaque bounding-box centre; long barrels bias both centres.
- For Defold sprites that animate hull and turret independently at one object
  origin, project their measured source mounts to a shared atlas-cell target.
  Keep the mount table in selected source data, tied to the exact hull/turret
  request names; a new candidate starts unregistered. Share the projection
  helper between the runtime emitter and preview, then inspect an 8×8
  independent-aim matrix and selected combinations in the packaged game.
- Check every hull/turret pairing in a native-scale 8×8 composite sheet, then
  capture representative mismatched aims and facing transitions in the
  packaged game. The sheet tests source registration; it does not establish
  that runtime sprite selection or interpolation remains stable. A hull source
  that still contains a whole turret may be unsuitable for layering even when
  the two same-facing images look plausible.
- For ejected drivers, distinguish eight runtime facings from eight uniquely
  authored source views. Mirroring may fill a temporary direction gap, but a
  rotated front-facing sprite is not a perspective-correct walk cycle.
- A `direction-set` response with eight files is not a verified direction
  mapping. Review each output against the actual screen-space direction, then
  review the _animated result_. A pose edit can faithfully preserve a wrong
  source facing even when the prompt says “west.” Corrections such as a
  horizontal flip belong in an explicit selected-source recipe and apply to
  idle and walk frames together, not to individual PNGs by hand.
- Audit every ejected-driver facing as `authored` or `mirrored` in the source
  mapping, and inspect idle plus _all_ walk frames. Verify foot-contact
  stability and apparent facing in a timed loop; eight atlas animation IDs
  alone prove neither unique perspective nor convincing motion. When adding
  independently authored views, replace the mapping and source-anchor
  manifest through the generator, then capture each direction in the packaged
  game. Keep old mirrored views labeled provisional until that happens.
- Overlay pivots/foot baselines and inspect frame-to-frame jitter before atlas
  packing, then verify the mounted result in the packaged game. For transparent
  source frames, use the atlas skill's `inspect_frames.py --strict --anchors`
  gate rather than trusting the contact sheet alone. Pass `--inventory` using
  the generator's expected relative PNG paths so a missing frame is rejected
  even when both its image and anchor were accidentally omitted. Strict
  inspection rejects missing and stale anchor entries; add `--canvas 40x40` for these fixed-canvas hero PNGs. It does not prove generated animation IDs,
  direction order, or real runtime frame selection. Keep source anchors and
  source-view/mirror provenance in project-owned manifests that the runtime
  generator validates; a separate optional QA script must not be the only
  owner of registration correctness. Pass the _native atlas-cell dimension_
  with `--cell`; preview `--scale` must not alter the registered overflow
  verdict. Match the inspector report's per-PNG and anchor-manifest SHA-256
  against the selected inputs before citing it as evidence. The `footDrift`
  number is not a planted-foot measure when shadows, exhaust, or equipment
  extend below the feet. Reject a direction set with mismatched vehicle
  perspective or frame scale even when all eight files exist and strict bounds
  checks pass.
- For runtime turn QA, retain a short video and inspect _consecutive_ frames
  around direction-index changes, including a diagonal, a cardinal, and a
  hull/turret disagreement. A sparse filmstrip is useful for orientation but
  cannot rule out one-frame detachments or animation jitter. Record the actual
  sampled directions, asset selection, build target, and runtime in the OKF;
  do not label an uncaptured direction visually verified.
- In War Battles, run `node tools/preview-tank-v2.mjs` from the example root.
  Its per-chassis registration sheets show individual layers and same-facing
  composites; its 8×8 mixed-aim matrices show every independent hull/turret
  pair. Pass `--artillery-hull-request NAME --output-dir build/evidence/NAME`
  to compare a new or archived hull without changing the runtime selection.
  Treat `registration: unverified-canvas-centred` in the JSON report as a
  stop sign, not approval. A visually better candidate still needs matching
  native scale, palette, and declared source pivots.
- For War Battles infantry, the selected Rook, Brass, Spark, and Mud families are in
  `art/source/hero-source-selection.json`; each pins eight idle outputs, eight
  four-frame animation requests, facing corrections, a shared
  40×40 atlas canvas, and one foot baseline. Run
  `node tools/generate-hero-art.mjs --check` from the example root after
  changing selection or source requests; the generator checks every source
  digest and derives all runtime PNGs, the atlas, anchors, planned-frame
  inventory, and `art/derived/hero-source-edge-audit.json`. Inspect that audit
  separately from the padded runtime PNGs. Prioritize
  `walkHorizontalEdgeContactFrames` over the broad `edgeContactFrames` count
  when replacing old walk loops; provider auto-trimming can make still poses
  touch the top or bottom without demonstrating lost pixels. Source-cell edge contact is a
  clipping risk, not proof of lost pixels, and screenshot gutter cannot restore
  genuinely missing source content. Keep the browser contact-sheet crop wide
  enough to show transparent/gameplay-background margin around the full pose;
  do not infer source completeness from a neatly framed green screenshot.
  Run the atlas inspector separately on
  each selected `defold/assets/units/infantry-<character>` with
  `--glob '**/*.png' --cell 40 --canvas 40x40 --guide-y 36 --columns 5 --strict --trimmed`; use
  `art/derived/hero-anchors.json` and `hero-frame-inventory.json` for Rook,
  and the `-<character>` suffixed files for the other families. Review
  `node tools/preview-hero-walk-poses.mjs <character>` before choosing a pose;
  the report may honestly have one or two provider candidates per facing.
  Inspect each
  animation with `node tools/inspect-sprite-fusion-animation.mjs NAME`, and
  review each generated 8×5 sheet with
  `node tools/preview-hero-runtime-art.mjs <character>`. These sheets establish source
  registration and visual coherence, not actual runtime animation. Then run the
  packaged browser ejection capture with `node integration/record-ejected-driver.mjs`
  and inspect idle/walk images at game scale. That capture verifies one natural
  ejection and a moved on-foot driver, not every facing or every animation
  frame. For all-facing atlas QA, build the current HTML5 package and run
  `pnpm art:hero-directions` from the example root for Rook, then
  `pnpm art:hero-directions <character>` for each other selected family. Its browser-only frozen gallery
  selects the requested family through `artGalleryHeroVariant` while retaining
  the ordinary slot-to-driver selection outside gallery mode. It uses the real
  player component, saves an 8-column idle/walk sheet, source hashes, and a
  compositor video per family, and rejects a direction whose hero-local pixels
  remain static through the walk samples. Inspect the contact sheet and video
  for perspective, weapon-side consistency, foot contact, and frame jitter;
  the nonstatic-pixel assertion alone does not prove those semantics. This is
  a visual fixture, not proof of naturally driven turning, combat ejection,
  cross-family selection in a normal match, or native rendering. Keep the natural
  ejection capture and all-facing fixture as separate evidence.
- For fire/hit/death, prototype **one character and one action** before a
  paid matrix. Use a focused `edit` to make the action-ready pose, review its
  candidates, then use `direction-set` on the selected provider asset (one
  input, no prompt). Verify all eight apparent facings and feet against that
  character's idle views before requesting animation. An eight-view action
  pose is not yet an animation: the generator must emit timed frames and the
  game must choose the state from fire/damage/death events, with fallback
  behavior explicit for unfinished families. Estimate the complete matrix's
  credit cost from the live balance first; reserve credits for effects and
  correction requests. Never silently spend a whole budget on 4×8×3 blind
  requests or claim a source-only pose is playable.
- A `direction-set` may straighten a collapsed death pose or soften a hit
  recoil even when its eight facings are otherwise correct. Inspect the action
  silhouette in _every_ view before accepting it. For War Battles death poses,
  direct `edit` requests from each provider-owned, matching idle view preserved
  the collapsed silhouette better; plan those requests reproducibly with
  `tools/plan-hero-death-requests.mjs`, then pin the selected outputs. Do not
  describe a visually subtle hit pose as polished merely because the atlas and
  browser gallery select it.
- In Defold, a multi-frame one-shot atlas animation needs
  `PLAYBACK_ONCE_FORWARD`; `PLAYBACK_NONE` displays only the first frame. If
  that first frame is idle, a complete firing atlas can silently look as if
  the game never selected it. Verify the playback mode in the emitted atlas
  and capture early, middle, and late samples through the real component.
- Frame the browser gallery contact-sheet crop around the **rendered** sprite,
  not its 40×40 source cell. At the War Battles camera scale a 72-pixel crop
  cut off several helmets even though the atlas frames passed strict bounds
  inspection; the 112-pixel replacement still read tightly in some cells.
  Use the current 144-pixel gallery crop, save a full-viewport companion
  image, and inspect outer margins in idle, firing, hit, and death rows. A
  contact-sheet clipping failure is not proof of source or runtime clipping;
  compare all three before changing art or anchors.
- A tight provider-owned animation source can have a complete padded runtime
  atlas while the original animation cells still touch their edges. Inspect
  the raw sheet with `node tools/inspect-sprite-fusion-animation.mjs NAME` and
  review every cell, not just the atlas preview. Use its
  `presentation-preview.png` for green-background review screenshots rather
  than showing the provider's auto-trimmed `00-sheet.png` as if its cell edges
  were safe margins. Coral lines in that preview mark the _original source_
  sides with opaque edge contact; a green gutter outside those lines is not
  evidence of complete artwork. The JSON lists affected frame indices and
  marks the presentation sheet as padding-only; it cannot restore lost source
  pixels. Do not present a marked strip as a clipping repair.
  For a replacement animation,
  prepare a transparent source with at least an eight-pixel gutter from the selected pinned pose with
  `node tools/prepare-hero-animation-input.mjs POSE_REQUEST OUTPUT_INDEX`, then
  pass that project-owned PNG to Sprite Fusion `animate`. Test **one** direction
  and inspect all returned cells before spending on the remaining directions.
  The preparer chooses the smallest supported canvas that fits the pose (64px
  for Rook/east, 80px for the taller Rook/south); do not shrink a tall pose to
  force a 64px request or assume that the provider retained the input gutter.
  Add padding before animation; padding the returned atlas cannot recreate a
  boot, helmet, or weapon pixel already clipped by the source canvas. Keep
  the older request and the new request separately pinned, and do not switch
  runtime selection until the replacement also passes facing, anchor, atlas,
  and packaged-motion review.

The three gates for a directional unit are distinct: (1) source crop and
registration (`inspect_frames.py`, including the declared inventory), (2)
emitted Defold `.atlas` IDs and ordered frame references (`node --test
test/hero-art.test.mjs test/tank-livery.test.mjs` here), and (3) packaged
runtime motion (`pnpm art:hero-directions` plus a natural ejection/turn
capture). A pass at one gate must not be reported as a pass at the others.
Inspect the atlas source and the contact image together before spending more
credits to solve what may be a binding or pivot problem.

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

For War Battles' seeded isometric hex island, read
`.codex/skills/defold-hex-world/SKILL.md` before changing geography or map
placement. Sprite Fusion supplies selected source tile faces, props, effects,
and style-consistent variations; `WorldPlan` owns land/water, biomes, shallow
elevation, built surfaces, reserved starts, prop placement, collision, and
coast adjacency. Do not use a source tile's square image bounds as the map
boundary or infer the collider from its full alpha rectangle. Record each
asset's logical ground contact, intended footprint, native pixel scale, and
role before integrating it. Check seams and silhouette at the actual camera
zoom; a beautiful raw source image can become fuzzy or illegible after
downsampling. Preserve the source file and change its runtime derivative only
through the owning generator.

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
