import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { ArenaMap, CELL_SANDBAG, CELL_CRATE, CELL_WALL, cellCentreX, cellCentreY } from "../core/arena.ts";
import {
  HEX_CLIFF_VARIANT_FAMILIES,
  HEX_LANDMARK_KIND,
  HEX_LANDMARK_SPRITE_OFFSET_Y,
  deriveTankDepotPresentationSites,
  deriveWorldPlanPropAnchors,
  projectWorldPlanPropCoverage,
} from "../core/hex-cliffs.ts";
import { isometricScreenX, isometricScreenY } from "../core/isometric-projection.ts";
import { visibleTankDepotMarkerSite } from "../core/arena-visual.ts";
import { BattleWorld } from "../core/world.ts";
import {
  WORLD_PLAN_VISIBLE_DEPOT_SLOTS,
  WORLD_PROP_ROCK,
  worldPlanSurfaceRoleAtSimulation,
} from "../core/world-plan.ts";
import { MAP_CELLS, MAP_HEIGHT, MAP_WIDTH, PLAYER_MODE_INFANTRY } from "../core/constants.ts";
import { DEFAULT_ARENA_SEED } from "../core/playable.ts";
import { alphaBounds, decodeRgbaPng } from "../tools/generate-world-art.mjs";

const root = resolve(import.meta.dirname, "..");
const seededWorlds = [DEFAULT_ARENA_SEED, 0, 1, 0xffff_ffff];

test("replacement-tank floor guidance appears only for the exposed local driver", () => {
  const world = new BattleWorld(17, DEFAULT_ARENA_SEED);
  assert.equal(visibleTankDepotMarkerSite(world, -1), -1);
  assert.equal(visibleTankDepotMarkerSite(world, 0), -1);
  world.addPlayer(1);
  assert.equal(visibleTankDepotMarkerSite(world, 0), -1, "tank drivers do not need every depot painted on the floor");
  world.playerMode[0] = PLAYER_MODE_INFANTRY;
  assert.equal(visibleTankDepotMarkerSite(world, 0), world.nearestTankDepot(1));
  assert.equal(visibleTankDepotMarkerSite(world, 1), -1, "another inactive slot cannot select the local guide");
  world.playerHealth[0] = 0;
  assert.equal(visibleTankDepotMarkerSite(world, 0), -1, "a dead driver cannot acquire a tank");
});

test("every plan-owned prop collider has one grounded visible sprite and no square wall tile", () => {
  for (const seed of seededWorlds) {
    const map = new ArenaMap(seed);
    const before = map.cells.slice();
    const anchors = deriveWorldPlanPropAnchors(map);
    const hiddenWallCells = new Uint8Array(MAP_CELLS);
    hiddenWallCells.fill(255);
    projectWorldPlanPropCoverage(map, hiddenWallCells);
    assert.equal(anchors.length + deriveTankDepotPresentationSites(map).length, map.plan.propCount);
    assert.deepEqual(anchors, deriveWorldPlanPropAnchors(new ArenaMap(seed)));
    const rockLooks = new Set();
    for (let index = 0; index < anchors.length; index++) {
      const anchor = anchors[index];
      const cell = map.plan.propCells[anchor.propIndex];
      assert.equal(anchor.cellX, cell % MAP_WIDTH);
      assert.equal(anchor.cellY, Math.floor(cell / MAP_WIDTH));
      assert.equal(anchor.worldX, cellCentreX(anchor.cellX));
      assert.equal(anchor.worldY, cellCentreY(anchor.cellY));
      assert.equal(map.plan.propSolid[cell], 1, "the sprite has its own collider");
      assert.equal(map.cellAt(anchor.cellX, anchor.cellY), CELL_WALL);
      assert.ok(anchor.kind >= 0 && anchor.kind < Object.keys(HEX_LANDMARK_KIND).length);
      if (map.plan.propKinds[anchor.propIndex] === WORLD_PROP_ROCK) rockLooks.add(anchor.kind);
      assert.notEqual(worldPlanSurfaceRoleAtSimulation(map.plan, anchor.worldX, anchor.worldY), "W");
    }
    if (seed === DEFAULT_ARENA_SEED) {
      assert.deepEqual(
        [...rockLooks].sort((a, b) => a - b),
        [HEX_LANDMARK_KIND.rockOutcrop, HEX_LANDMARK_KIND.lowCoverStone, HEX_LANDMARK_KIND.lowCoverRubble].sort(
          (a, b) => a - b,
        ),
        "the default battlefield shows all three grounded stone silhouettes",
      );
    }
    assert.deepEqual(hiddenWallCells, map.plan.propSolid, "coverage replaces stale bytes and equals the prop collider");
    assert.deepEqual(map.cells, before, "presentation does not edit authority");
  }
});

test("the island coast uses shallow source-colored hex faces over animated water", () => {
  const image = decodeRgbaPng(readFileSync(resolve(root, "defold/assets/derived/world/island-coast.png")));
  const manifest = JSON.parse(readFileSync(resolve(root, "defold/assets/derived/world/island-coast.json"), "utf8"));
  const collection = readFileSync(resolve(root, "defold/main/main.collection"), "utf8");
  const coastMaterial = readFileSync(resolve(root, "defold/main/island-coast.material"), "utf8");
  const coastShader = readFileSync(resolve(root, "defold/main/island-coast.fp"), "utf8");
  const pixel = (x, y) => Array.from(image.pixels.subarray((y * image.width + x) * 4, (y * image.width + x) * 4 + 4));
  assert.deepEqual([image.width, image.height], [1536, 800]);
  assert.equal(manifest.owner, "tools/generate-coast.mjs");
  assert.equal(manifest.placement.scale, 2, "half-resolution art is pixel-aligned at 2× scene scale");
  assert.equal(
    manifest.source.cells.length,
    Object.values(HEX_CLIFF_VARIANT_FAMILIES).reduce((count, family) => count + family.count, 0),
    "the coast consumes each selected rock-source variant",
  );
  assert.deepEqual(manifest.coastWall, {
    shape: "forward-facing water pixels extruded from the exact planned hex top-face mask",
    faceDepthByTier: [3, 5, 7],
    palette: "median lower-wall source colors from the selected raised-hex family",
    anchor: "logical floor top-face; relief is entirely below the land mask",
  });
  assert.equal(pixel(768, 400)[3], 0, "transparent interior reveals the aligned hex terrain");
  let facePixels = 0;
  let tallestFace = 0;
  for (let x = 0; x < image.width; x++) {
    let run = 0;
    for (let y = 0; y < image.height; y++) {
      if (image.pixels[(y * image.width + x) * 4 + 3] === 255) {
        facePixels++;
        run++;
      } else {
        tallestFace = Math.max(tallestFace, run);
        run = 0;
      }
    }
    tallestFace = Math.max(tallestFace, run);
  }
  assert.ok(facePixels > 3_000);
  assert.equal(tallestFace, 7, "high coast relief remains seven half-resolution pixels");
  const ocean = pixel(768, 744);
  assert.ok(ocean[2] > ocean[1] && ocean[1] > ocean[0] && ocean[3] === 252);
  assert.equal(manifest.wavelets.source, manifest.waterSource.path);
  assert.equal(manifest.wavelets.sourceSampling, "nearest-neighbor half-size, clipped to water material alpha");
  assert.ok(manifest.wavelets.count > 0 && manifest.wavelets.pixels > manifest.wavelets.count);
  assert.equal(manifest.animation.pixelCell, 1, "foam must not return to enlarged four-pixel checker cells");
  assert.match(coastMaterial, /type: CONSTANT_TYPE_TIME/u);
  assert.match(coastShader, /pixel\.a > 0\.97 && pixel\.a < 0\.995/u);
  assert.match(collection, /id: "island_coast"\s+prototype: "\/main\/island-coast\.go"/u);
});

test("depot sprites clear plan props and keep four compass landmarks across seeds", () => {
  let compared = 0;
  for (const seed of [DEFAULT_ARENA_SEED, ...Array.from({ length: 256 }, (_, index) => index)]) {
    const map = new ArenaMap(seed);
    const depots = deriveTankDepotPresentationSites(map);
    assert.deepEqual(depots, deriveTankDepotPresentationSites(new ArenaMap(seed)));
    for (const slot of WORLD_PLAN_VISIBLE_DEPOT_SLOTS)
      assert.ok(depots.includes(slot), `seed ${seed} keeps depot ${slot}`);
    assert.equal(depots.length, WORLD_PLAN_VISIBLE_DEPOT_SLOTS.length, "every visible depot has a plan-owned facade");
    for (const site of depots) {
      const facade = map.plan.depotFacadeCells[site];
      assert.ok(facade >= 0);
      assert.equal(map.plan.cellLand[facade], 1, "depot facade is grounded on the island");
      assert.equal(map.plan.propSolid[facade], 1, "depot facade blocks a tank");
      assert.equal(map.cellAt(facade % MAP_WIDTH, Math.floor(facade / MAP_WIDTH)), CELL_WALL);
    }
    for (const prop of deriveWorldPlanPropAnchors(map)) {
      for (const site of depots) {
        const facade = map.plan.depotFacadeCells[site];
        const facadeX = cellCentreX(facade % MAP_WIDTH);
        const facadeY = cellCentreY(Math.floor(facade / MAP_WIDTH));
        const dx = Math.abs(isometricScreenX(prop.worldX, prop.worldY) - isometricScreenX(facadeX, facadeY));
        const dy = Math.abs(
          isometricScreenY(prop.worldX, prop.worldY) +
            HEX_LANDMARK_SPRITE_OFFSET_Y -
            isometricScreenY(facadeX, facadeY),
        );
        assert.ok(dx >= 62 + 56 || dy >= 45 + 48, `seed ${seed} prop ${prop.propIndex} overlaps depot ${site}`);
        compared++;
      }
    }
  }
  assert.ok(compared > 0);
});

test("packaged landmark and compact-cover sprites share the ground-contact line", () => {
  const prototype = readFileSync(resolve(root, "defold/main/arena-landmark.go"), "utf8");
  const spriteOffset = Number(
    prototype.match(/embedded_components\s*\{[\s\S]*?id: "sprite"[\s\S]*?position\s*\{[^}]*?y:\s*([\d.]+)/u)?.[1],
  );
  assert.equal(spriteOffset, HEX_LANDMARK_SPRITE_OFFSET_Y);
  const manifest = JSON.parse(readFileSync(resolve(root, "defold/assets/derived/arena/arena-art.json"), "utf8"));
  const spriteByFile = new Map(manifest.sprites.map((sprite) => [sprite.file, sprite]));
  const filesByKind = [
    "field-bunker",
    "rock-outcrop",
    "supply-dump",
    "tank-wreck",
    "fuel-cluster",
    "gun-nest",
    "radio-mast",
    "scrap-barricade",
    "shell-crater",
    "conifer-tall",
    "conifer-broad",
    "conifer-leaning",
    "low-cover-earth",
    "low-cover-stone",
    "low-cover-timber",
    "low-cover-rubble",
    "low-cover-neutral",
  ];
  assert.equal(filesByKind.length, Object.keys(HEX_LANDMARK_KIND).length);
  for (const file of filesByKind) {
    const sprite = spriteByFile.get(`landmark-${file}.png`);
    assert.ok(sprite, `atlas contains ${file}`);
    assert.deepEqual(sprite.size, [160, 128]);
    const footOffset = spriteOffset - (sprite.opaqueBbox[3] - sprite.size[1] / 2);
    assert.ok(Math.abs(footOffset) <= 1, `${file} foot meets its collider within one pixel`);
    const image = decodeRgbaPng(readFileSync(resolve(root, `defold/assets/derived/arena/landmark-${file}.png`)));
    const [, , , bottom] = alphaBounds(image);
    assert.ok(Math.abs(bottom - 119) <= 1, `${file} has a ground-contact line within one source pixel`);
  }
});

test("loaded director and generated wall layer use plan props, not former raised wall stamps", () => {
  const map = new ArenaMap(DEFAULT_ARENA_SEED);
  const director = readFileSync(resolve(root, "defold/main/arena.script.ts"), "utf8");
  const tilemap = readFileSync(resolve(root, "defold/main/arena.tilemap"), "utf8");
  assert.match(director, /deriveWorldPlanPropAnchors\(world\.map\)/u);
  assert.doesNotMatch(
    director,
    /deriveHexMeadowScatterAnchors/u,
    "landmark trees must come from collidable plan props",
  );
  assert.match(director, /projectWorldPlanPropCoverage\(world\.map/u);
  assert.match(director, /syncCoverSprites\(self\)/u);
  assert.doesNotMatch(director, /deriveHexCliffAnchors|deriveHexLandmarkAnchors|deriveHexFoliageAnchors/u);
  const start = tilemap.indexOf('  id: "walls"');
  const end = tilemap.indexOf('  id: "marks"', start);
  assert.ok(start > 0 && end > start);
  const wallCells = new Set();
  for (const [, x, y] of tilemap.slice(start, end).matchAll(/cell \{\s+x: (\d+)\s+y: (\d+)\s+tile:/gu)) {
    wallCells.add(Number(y) * MAP_WIDTH + Number(x));
  }
  assert.ok(wallCells.size > 0 && wallCells.size < MAP_CELLS);
  for (let cell = 0; cell < MAP_CELLS; cell++) {
    if (map.plan.propSolid[cell] !== 0)
      assert.equal(wallCells.has(cell), false, `prop collider ${cell} has a square wall`);
    if (map.cells[cell] === CELL_CRATE || map.cells[cell] === CELL_SANDBAG) {
      assert.equal(wallCells.has(cell), false, `cover sprite ${cell} has a duplicate square wall tile`);
      assert.ok(map.coverPanelByCell[cell] >= 0, `cover sprite ${cell} has no authoritative panel`);
    }
  }
  for (let x = 0; x < MAP_WIDTH; x++) {
    assert.equal(map.cellAt(x, 0), CELL_WALL);
    assert.equal(map.cellAt(x, MAP_HEIGHT - 1), CELL_WALL);
  }
});
