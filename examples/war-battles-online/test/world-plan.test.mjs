import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import { DEFAULT_ARENA_SEED } from "../core/playable.ts";
import {
  MAP_CELLS,
  MAP_HEIGHT,
  MAP_WIDTH,
  TILE_PIXELS,
  TILE_UNITS,
  UNITS_PER_PIXEL,
  WORLD_MIN_X,
  WORLD_MIN_Y,
  WORLD_PIXEL_ORIGIN_X,
  WORLD_PIXEL_ORIGIN_Y,
} from "../core/constants.ts";
import { hexCellAt, hexCentreAtSimulation } from "../core/hex-landscape.ts";
import { isometricScreenX, isometricScreenY } from "../core/isometric-projection.ts";
import {
  HEX_LANDMARK_SPRITE_OFFSET_Y,
  WORLD_PROP_PROJECTED_BOUNDS,
  worldPropSpritesOverlap,
} from "../core/world-visual-footprints.ts";
import {
  WORLD_HEX_COUNT,
  WORLD_HEX_Q_MIN,
  WORLD_HEX_Q_MAX,
  WORLD_HEX_R_MIN,
  WORLD_HEX_R_MAX,
  WORLD_PLAN_MAX_PROPS,
  WORLD_PLAN_SPAWN_COUNT,
  WORLD_PLAN_START_COUNT,
  WORLD_BUILT_NONE,
  WORLD_BUILT_PAD,
  WORLD_BUILT_ROUTE,
  WORLD_PROP_BUILDING,
  WORLD_PROP_DEPOT,
  WORLD_PROP_ROCK,
  WORLD_PROP_TREE,
  buildWorldPlan,
  worldHexIndex,
  worldHexNeighbor,
  worldHexQ,
  worldHexR,
} from "../core/world-plan.ts";

test("selected prop art fits the projected placement envelopes", () => {
  const manifest = JSON.parse(
    readFileSync(resolve(import.meta.dirname, "../defold/assets/derived/arena/arena-art.json"), "utf8"),
  );
  const variants = [
    [WORLD_PROP_TREE, "landmark-conifer-tall.png"],
    [WORLD_PROP_TREE, "landmark-conifer-broad.png"],
    [WORLD_PROP_TREE, "landmark-conifer-leaning.png"],
    [WORLD_PROP_ROCK, "landmark-rock-outcrop.png"],
    [WORLD_PROP_ROCK, "landmark-low-cover-stone.png"],
    [WORLD_PROP_ROCK, "landmark-low-cover-rubble.png"],
    [WORLD_PROP_BUILDING, "landmark-field-bunker.png"],
    [WORLD_PROP_BUILDING, "landmark-supply-dump.png"],
    [WORLD_PROP_BUILDING, "landmark-gun-nest.png"],
    [WORLD_PROP_DEPOT, "tank-depot.png"],
  ];
  for (const [kind, file] of variants) {
    const art = manifest.sprites.find((sprite) => sprite.file === file);
    assert.ok(art, `${file} is emitted by the art owner`);
    const index = variants
      .filter(([variantKind]) => variantKind === kind)
      .findIndex(([, variantFile]) => variantFile === file);
    const bounds = WORLD_PROP_PROJECTED_BOUNDS[kind]?.[index];
    assert.ok(bounds, `${file} has a placement envelope`);
    const [width, height] = art.size;
    const [left, top, right, bottom] = art.opaqueBbox;
    const offset = kind === WORLD_PROP_DEPOT ? 0 : HEX_LANDMARK_SPRITE_OFFSET_Y;
    assert.equal(left - width / 2, bounds.left, `${file} left bound differs from emitted art`);
    assert.equal(right - width / 2, bounds.right, `${file} right bound differs from emitted art`);
    assert.equal(offset + height / 2 - bottom, bounds.bottom, `${file} bottom bound differs from emitted art`);
    assert.equal(offset + height / 2 - top, bounds.top, `${file} top bound differs from emitted art`);
  }
});

test("projected prop spacing catches diagonal overlap beyond the cell-circle clearance", () => {
  const tree = 20 * MAP_WIDTH + 21;
  const building = 27 * MAP_WIDTH + 28;
  assert.ok(Math.hypot(7, 7) > 3 + 4 + 2, "the old cell-circle rule would admit this pair");
  assert.equal(worldPropSpritesOverlap(0, tree, WORLD_PROP_TREE, building, WORLD_PROP_BUILDING), true);
  assert.equal(worldPropSpritesOverlap(0, tree, WORLD_PROP_TREE, building + 5, WORLD_PROP_BUILDING), false);
});

function tankClearCells(cellLand, propSolid) {
  const clear = new Uint8Array(MAP_CELLS);
  for (let y = 1; y < MAP_HEIGHT - 1; y += 1) {
    for (let x = 1; x < MAP_WIDTH - 1; x += 1) {
      let open = true;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const cell = (y + dy) * MAP_WIDTH + x + dx;
          if (cellLand[cell] === 0 || propSolid[cell] !== 0) open = false;
        }
      }
      if (open) clear[y * MAP_WIDTH + x] = 1;
    }
  }
  return clear;
}

function reachableTankCells(clear, start) {
  const visited = new Uint8Array(MAP_CELLS);
  const frontier = new Int32Array(MAP_CELLS);
  let head = 0;
  let tail = 1;
  frontier[0] = start;
  visited[start] = 1;
  while (head < tail) {
    const cell = frontier[head++];
    const x = cell % MAP_WIDTH;
    for (const next of [cell - MAP_WIDTH, cell + MAP_WIDTH, x > 0 ? cell - 1 : -1, x < MAP_WIDTH - 1 ? cell + 1 : -1]) {
      if (next < 0 || next >= MAP_CELLS || clear[next] === 0 || visited[next] !== 0) continue;
      visited[next] = 1;
      frontier[tail++] = next;
    }
  }
  return visited;
}

test("every planned hex floor anchor round-trips through the isometric projection", () => {
  const plan = buildWorldPlan(DEFAULT_ARENA_SEED);
  for (let index = 0; index < WORLD_HEX_COUNT; index += 1) {
    if (plan.land[index] === 0) continue;
    const q = worldHexQ(index);
    const r = worldHexR(index);
    const centre = hexCentreAtSimulation(q, r);
    const screenX = isometricScreenX(centre.x, centre.y);
    const screenY = isometricScreenY(centre.x, centre.y);
    const u = (screenX - WORLD_PIXEL_ORIGIN_X) / Math.SQRT1_2;
    const v = (screenY - WORLD_PIXEL_ORIGIN_Y) / (Math.SQRT1_2 * 0.5);
    const worldX = (u + v) * 0.5;
    const worldY = (v - u) * 0.5;
    const actual = hexCellAt(worldX - WORLD_MIN_X / UNITS_PER_PIXEL, worldY - WORLD_MIN_Y / UNITS_PER_PIXEL);
    assert.deepEqual([actual.q, actual.r], [q, r], `planned hex ${q},${r} uses its floor anchor`);
  }
});

test("seeded hex geography has one connected irregular island and exact coast edges", () => {
  for (let seed = 0; seed < 512; seed += 1) {
    const plan = buildWorldPlan(seed);
    assert.equal(plan.land.length, WORLD_HEX_COUNT);
    assert.ok(plan.landCount >= 220 && plan.landCount <= 400, `land capacity for seed ${seed}`);
    assert.equal(plan.land[worldHexIndex(2, 17)], 1, "the combat core remains land");
    for (const q of [WORLD_HEX_Q_MIN, WORLD_HEX_Q_MAX]) {
      for (const r of [WORLD_HEX_R_MIN, WORLD_HEX_R_MAX]) {
        assert.equal(plan.land[worldHexIndex(q, r)], 0, "the island never clips at a tilemap corner");
      }
    }
    let coast = 0;
    let builtPads = 0;
    let builtRoutes = 0;
    const biomeCounts = new Uint16Array(5);
    for (let index = 0; index < WORLD_HEX_COUNT; index += 1) {
      const q = worldHexQ(index);
      const r = worldHexR(index);
      if (plan.land[index] === 0) {
        assert.equal(plan.biome[index], 0, "ocean has no land biome");
        assert.equal(plan.builtSurface[index], WORLD_BUILT_NONE, "manufactured surfaces never cross ocean");
        assert.equal(plan.coastEdges[index], 0, "ocean has no land-facing coast edge");
        continue;
      }
      assert.ok(plan.biome[index] >= 1 && plan.biome[index] <= 4, "ground biome is natural material only");
      biomeCounts[plan.biome[index]] += 1;
      if (plan.builtSurface[index] === WORLD_BUILT_PAD) builtPads += 1;
      else if (plan.builtSurface[index] === WORLD_BUILT_ROUTE) builtRoutes += 1;
      else assert.equal(plan.builtSurface[index], WORLD_BUILT_NONE, "built surface is a declared role");
      let expectedEdges = 0;
      for (let direction = 0; direction < 6; direction += 1) {
        const neighbor = worldHexNeighbor(q, r, direction);
        if (neighbor < 0 || plan.land[neighbor] === 0) expectedEdges |= 1 << direction;
        else assert.ok(Math.abs(plan.elevation[index] - plan.elevation[neighbor]) <= 1, "driveable tiers stay shallow");
      }
      assert.equal(plan.coastEdges[index], expectedEdges, "coast side masks derive exactly from neighboring land");
      if (expectedEdges !== 0) coast += 1;
    }
    assert.ok(coast >= 40 && coast <= 130, `visible coastline remains bounded for seed ${seed}`);
    assert.ok(biomeCounts[3] >= 10, `basalt remains visible for seed ${seed}`);
    assert.ok(biomeCounts[4] >= 10, `ash remains visible for seed ${seed}`);
    assert.equal(builtPads, 1, "one small command-post pad, not a manufactured biome");
    assert.ok(builtRoutes <= 24, "infrastructure remains sparse over natural ground");
    const builtVisited = new Uint8Array(WORLD_HEX_COUNT);
    const builtFrontier = new Int16Array(WORLD_HEX_COUNT);
    const pad = plan.builtSurface.indexOf(WORLD_BUILT_PAD);
    let builtHead = 0;
    let builtTail = 1;
    builtFrontier[0] = pad;
    builtVisited[pad] = 1;
    while (builtHead < builtTail) {
      const index = builtFrontier[builtHead++];
      const q = worldHexQ(index);
      const r = worldHexR(index);
      for (let direction = 0; direction < 6; direction += 1) {
        const neighbor = worldHexNeighbor(q, r, direction);
        if (neighbor < 0 || plan.builtSurface[neighbor] === WORLD_BUILT_NONE || builtVisited[neighbor] !== 0) continue;
        builtVisited[neighbor] = 1;
        builtFrontier[builtTail++] = neighbor;
      }
    }
    assert.equal(builtTail, builtPads + builtRoutes, "infrastructure is one connected sparse overlay");
    assert.equal(builtVisited[worldHexIndex(2, 17)], 1, "the command route reaches the arena core");

    assert.equal(plan.cellLand.length, MAP_CELLS);
    assert.equal(plan.reserved.length, MAP_CELLS);
    assert.equal(plan.spawnCells.length, WORLD_PLAN_SPAWN_COUNT);
    assert.equal(plan.playerStartCells.length, WORLD_PLAN_START_COUNT);
    const hex = { q: 0, r: 0, dx: 0, dy: 0 };
    for (let cell = 0; cell < MAP_CELLS; cell += 1) {
      hexCellAt(((cell % MAP_WIDTH) + 0.5) * TILE_PIXELS, (Math.floor(cell / MAP_WIDTH) + 0.5) * TILE_PIXELS, hex);
      const hexIndex = worldHexIndex(hex.q, hex.r);
      assert.equal(
        plan.cellLand[cell],
        hexIndex < 0 ? 0 : plan.land[hexIndex],
        "cell land projects exact hex identity",
      );
    }
    assert.ok(
      plan.propCount >= 20 && plan.propCount <= WORLD_PLAN_MAX_PROPS,
      `bounded scenic density for seed ${seed}`,
    );
    const expectedSolid = new Uint8Array(MAP_CELLS);
    let buildings = 0;
    for (let prop = 0; prop < plan.propCount; prop += 1) {
      const cell = plan.propCells[prop];
      const kind = plan.propKinds[prop];
      assert.ok(
        kind === WORLD_PROP_TREE ||
          kind === WORLD_PROP_ROCK ||
          kind === WORLD_PROP_BUILDING ||
          kind === WORLD_PROP_DEPOT,
      );
      if (kind === WORLD_PROP_BUILDING) buildings += 1;
      const x = cell % MAP_WIDTH;
      const y = Math.floor(cell / MAP_WIDTH);
      const visualRadius = plan.propVisualRadius[prop];
      const solidRadius = kind === WORLD_PROP_BUILDING ? 2 : 1;
      for (let dy = -visualRadius; dy <= visualRadius; dy += 1) {
        for (let dx = -visualRadius; dx <= visualRadius; dx += 1) {
          if (dx * dx + dy * dy > visualRadius * visualRadius) continue;
          const footprintCell = (y + dy) * MAP_WIDTH + x + dx;
          assert.equal(plan.cellLand[footprintCell], 1, "whole visual footprint stays on land");
          if (kind !== WORLD_PROP_DEPOT || dx * dx + dy * dy <= 1)
            assert.equal(plan.reserved[footprintCell], 0, "a solid footprint never enters protected spawn space");
          if (dx * dx + dy * dy <= solidRadius * solidRadius) expectedSolid[footprintCell] = 1;
        }
      }
      for (let previous = 0; previous < prop; previous += 1) {
        const priorCell = plan.propCells[previous];
        assert.equal(
          worldPropSpritesOverlap(seed, cell, kind, priorCell, plan.propKinds[previous]),
          false,
          `prop ${prop} projects clear of prop ${previous}`,
        );
        const separation = visualRadius + plan.propVisualRadius[previous] + 2;
        assert.ok(
          Math.hypot(x - (priorCell % MAP_WIDTH), y - Math.floor(priorCell / MAP_WIDTH)) >= separation,
          `prop ${prop} does not overlap prop ${previous}`,
        );
        if (kind === WORLD_PROP_ROCK && plan.propKinds[previous] === WORLD_PROP_ROCK) {
          const firstX = WORLD_MIN_X + (x + 0.5) * TILE_UNITS;
          const firstY = WORLD_MIN_Y + (y + 0.5) * TILE_UNITS;
          const priorX = WORLD_MIN_X + ((priorCell % MAP_WIDTH) + 0.5) * TILE_UNITS;
          const priorY = WORLD_MIN_Y + (Math.floor(priorCell / MAP_WIDTH) + 0.5) * TILE_UNITS;
          const screenDx = Math.abs(isometricScreenX(firstX, firstY) - isometricScreenX(priorX, priorY));
          const screenDy = Math.abs(isometricScreenY(firstX, firstY) - isometricScreenY(priorX, priorY));
          assert.ok(screenDx >= 112 || screenDy >= 64, `rock ${prop} crowds rock ${previous} in screen space`);
        }
      }
    }
    assert.ok(buildings >= 1, `seed ${seed} retains a grounded structure`);
    for (const slot of [0, 4, 8, 12]) {
      const facade = plan.depotFacadeCells[slot];
      assert.ok(facade >= 0, `depot ${slot} has a grounded facade`);
      assert.equal(plan.propKinds[plan.propCells.indexOf(facade)], WORLD_PROP_DEPOT);
      assert.equal(plan.propSolid[facade], 1, `depot ${slot} has real collision`);
    }
    assert.deepEqual(plan.propSolid, expectedSolid, "all blocking props come from their declared footprints");
    const clear = tankClearCells(plan.cellLand, plan.propSolid);
    const reachable = reachableTankCells(clear, plan.spawnCells[0]);
    for (let slot = 0; slot < WORLD_PLAN_SPAWN_COUNT; slot += 1) {
      const cell = plan.spawnCells[slot];
      assert.equal(clear[cell], 1, `spawn ${slot} clears a tank hull`);
      assert.equal(plan.reserved[cell], 1, `spawn ${slot} has a protected apron`);
      assert.equal(reachable[cell], 1, `spawn ${slot} can reach the same connected battlefield`);
      for (let other = 0; other < slot; other += 1) {
        const previous = plan.spawnCells[other];
        assert.ok(
          Math.hypot(
            (cell % MAP_WIDTH) - (previous % MAP_WIDTH),
            Math.floor(cell / MAP_WIDTH) - Math.floor(previous / MAP_WIDTH),
          ) >= 8,
          `spawns ${slot} and ${other} have tank-scale separation`,
        );
      }
    }
    for (let slot = 0; slot < WORLD_PLAN_START_COUNT; slot += 1) {
      const cell = plan.playerStartCells[slot];
      assert.equal(clear[cell], 1, `player start ${slot} clears a tank hull`);
      assert.equal(reachable[cell], 1, `player start ${slot} reaches the same battlefield`);
      assert.equal(plan.reserved[cell], 1, `player start ${slot} protects its footprint`);
      for (let other = 0; other < slot; other += 1) {
        const previous = plan.playerStartCells[other];
        assert.ok(
          Math.hypot(
            (cell % MAP_WIDTH) - (previous % MAP_WIDTH),
            Math.floor(cell / MAP_WIDTH) - Math.floor(previous / MAP_WIDTH),
          ) >= 8,
          `player starts ${slot} and ${other} have eight-cell separation`,
        );
      }
    }
  }
});

test("the plan is reproducible and seed changes affect more than a cosmetic shoreline", () => {
  const reference = buildWorldPlan(DEFAULT_ARENA_SEED);
  const repeat = buildWorldPlan(DEFAULT_ARENA_SEED);
  for (const field of [
    "land",
    "biome",
    "elevation",
    "coastEdges",
    "builtSurface",
    "cellLand",
    "cellBiome",
    "cellElevation",
    "reserved",
    "spawnCells",
    "playerStartCells",
    "propCells",
    "propKinds",
    "propVisualRadius",
    "propSolid",
  ]) {
    assert.deepEqual(reference[field], repeat[field], `${field} is deterministic`);
  }
  const alternate = buildWorldPlan(1);
  let commonLand = 0;
  let differentBiome = 0;
  let differentLand = 0;
  let eitherLand = 0;
  for (let index = 0; index < WORLD_HEX_COUNT; index += 1) {
    if (reference.land[index] !== 0 || alternate.land[index] !== 0) eitherLand += 1;
    if (reference.land[index] !== alternate.land[index]) differentLand += 1;
    if (reference.land[index] === 0 || alternate.land[index] === 0) continue;
    commonLand += 1;
    if (reference.biome[index] !== alternate.biome[index]) differentBiome += 1;
  }
  assert.ok(differentBiome / commonLand >= 0.2, "seeded Voronoi geography should not repeat the same biome wedges");
  assert.ok(differentLand / eitherLand >= 0.08, "island outlines should vary appreciably across seeds");
});
