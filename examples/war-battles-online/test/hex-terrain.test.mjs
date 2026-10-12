import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { alphaBounds, decodeRgbaPng } from "../tools/generate-world-art.mjs";
import { cellCentreX, cellCentreY } from "../core/arena.ts";
import {
  HEX_LANDSCAPE,
  HEX_SERVICE_ROUTE,
  hexReliefLiftAtSimulation,
  hexTerrainRoleAtSimulation,
} from "../core/hex-landscape.ts";
import { MAP_HEIGHT, MAP_WIDTH, UNITS_PER_PIXEL, WORLD_MIN_X, WORLD_MIN_Y } from "../core/constants.ts";
import { DEFAULT_ARENA_SEED } from "../core/playable.ts";
import { buildWorldPlan } from "../core/world-plan.ts";
import {
  HEX_MACRO_CELLS,
  HEX_MACRO_EDGE,
  hexCellAt,
  HEX_DIRT_SPUR,
  buildHexGround,
  hexDirtPaintRole,
  hexForwardNeighbor,
  hexGroundRole,
  hexGroundPixel,
  hexTopFaceSample,
  hexServiceRoutePixel,
  hexServicePaintRole,
  hexRockPaintRole,
  hexReliefTier,
  hexTerrainRole,
  hexVisualRole,
} from "../tools/generate-hex-terrain.mjs";
import { loadHexFamilySources, readHexSourceSelection } from "../tools/hex-source-selection.mjs";

const root = resolve(import.meta.dirname, "..");
const source = decodeRgbaPng(
  readFileSync(resolve(root, "art/source/sprite-fusion/outputs/frontier-hex-meadow-v1/00.png")),
);

test("planned floor pixels use the exact hex land mask projected into simulation cells", () => {
  for (const seed of [DEFAULT_ARENA_SEED, 1]) {
    const plan = buildWorldPlan(seed);
    for (let y = 0; y < MAP_HEIGHT; y += 1) {
      for (let x = 0; x < MAP_WIDTH; x += 1) {
        const cell = y * MAP_WIDTH + x;
        const pixel = hexGroundPixel(source, x * 16 + 8, y * 16 + 8, plan);
        assert.equal(pixel[3] === 255 ? 1 : 0, plan.cellLand[cell], `seed=${seed} cell=${x},${y}`);
      }
    }
  }
});

test("the generated floor owns all curated Sprite Fusion hex source families", () => {
  const { selection, sha256 } = readHexSourceSelection(root);
  const generated = JSON.parse(readFileSync(resolve(root, "defold/assets/derived/world/hex-meadow.json"), "utf8"));
  assert.equal(generated.spriteFusionTiles.sha256, sha256);
  const counts = {};
  for (const role of Object.keys(selection.families)) {
    const sources = loadHexFamilySources(root, selection, role, decodeRgbaPng);
    counts[role] = sources.length;
    assert.deepEqual(
      generated.spriteFusionTiles.families[role].map(({ request, index, path }) => ({ request, index, path })),
      sources.map(({ request, index, path }) => ({ request, index, path })),
      `${role} source provenance is materialized without omission`,
    );
  }
  assert.deepEqual(counts, { G: 25, D: 19, B: 18, A: 16, M: 22, GD: 9, GB: 18, GM: 9, DB: 9, BA: 7, DA: 6, DM: 9 });
  const selectedRequests = new Set(
    Object.values(selection.families).flatMap(({ sources }) => sources.map(({ request }) => request)),
  );
  assert.ok(!selectedRequests.has("frontier-hex-earth-track-v1"), "raised track plates are not ground material");
  assert.ok(!selectedRequests.has("frontier-hex-service-scar-v1"), "raised service plates are not ground material");
});

test("floor samples stay on opaque top faces instead of projecting source side walls", () => {
  const { selection } = readHexSourceSelection(root);
  let sampled = 0;
  let opaque = 0;
  for (const role of Object.keys(selection.families)) {
    for (const { image } of loadHexFamilySources(root, selection, role, decodeRgbaPng)) {
      const bounds = alphaBounds(image);
      assert.ok(bounds, `${role} source has an opaque silhouette`);
      const [, top, , bottom] = bounds;
      for (const [dx, dy] of [
        [0, 0],
        [50, 0],
        [-50, 0],
        [25, 30],
        [-25, -30],
        [0, 40],
      ]) {
        const [x, y] = hexTopFaceSample(bounds, dx, dy);
        assert.ok(y <= top + (bottom - top + 1) * 0.56, `${role} sample stays above the side wall`);
        if (image.pixels[(y * image.width + x) * 4 + 3] >= 128) opaque += 1;
        sampled += 1;
      }
    }
  }
  assert.ok(opaque / sampled > 0.98, "inset top-face sampling retains source pixel coverage");
});

test("the legacy hex grammar remains a complete periodic source recipe", () => {
  const ground = buildHexGround();
  assert.equal(ground.width, HEX_MACRO_EDGE);
  assert.equal(ground.height, HEX_MACRO_EDGE);
  const roles = new Set();
  const visualRoles = new Set();
  for (let q = 0; q < HEX_MACRO_CELLS; q++) {
    for (let r = 0; r < HEX_MACRO_CELLS; r++) {
      roles.add(hexTerrainRole(q, r));
      visualRoles.add(hexVisualRole(q, r));
    }
  }
  assert.deepEqual([...roles].sort(), ["A", "B", "D", "G", "M"]);
  const meadowCells = HEX_LANDSCAPE.join("")
    .split("")
    .filter((role) => role === "G").length;
  assert.ok(meadowCells >= 100, "the walkable world reads as a connected meadow, not an even material checkerboard");
  for (const transition of ["BA", "DA", "DB", "DM", "GB", "GD", "GM"]) {
    assert.ok(visualRoles.has(transition), `transition ${transition} contributes to the macro`);
  }
  const tierCounts = [0, 0, 0];
  for (let q = 0; q < HEX_MACRO_CELLS; q++) {
    for (let r = 0; r < HEX_MACRO_CELLS; r++) {
      const tier = hexReliefTier(q, r);
      assert.ok(tier >= 0 && tier <= 2);
      tierCounts[tier]++;
      if (tier !== 1) {
        assert.ok(
          [
            [q - 1, r],
            [q + 1, r],
            [q, r - 1],
            [q, r + 1],
          ].some(([otherQ, otherR]) => hexReliefTier(otherQ, otherR) === tier),
          `relief cell ${q},${r} belongs to a low/high region, not an isolated plinth`,
        );
      }
    }
  }
  assert.ok(tierCounts[0] >= 8 && tierCounts[1] >= 100 && tierCounts[2] >= 8, "all three driveable tiers exist");
  for (let q = 0; q < HEX_MACRO_CELLS; q++) {
    assert.equal(hexReliefTier(q, 0), 1, "macro top edge returns to standard height");
    assert.equal(hexReliefTier(q, HEX_MACRO_CELLS - 1), 1, "macro bottom edge returns to standard height");
  }
  for (let r = 0; r < HEX_MACRO_CELLS; r++) {
    assert.equal(hexReliefTier(0, r), 1, "macro left edge returns to standard height");
    assert.equal(hexReliefTier(HEX_MACRO_CELLS - 1, r), 1, "macro right edge returns to standard height");
  }
  assert.deepEqual(hexForwardNeighbor(0, 0, 0, 47), { q: 0, r: 1 });
  assert.deepEqual(hexForwardNeighbor(0, 0, 46, 24), { q: 1, r: 0 });
  assert.deepEqual(hexForwardNeighbor(1, 0, -46, 24), { q: 0, r: 1 });
  for (let y = 0; y < HEX_MACRO_EDGE; y += 7) {
    for (let x = 0; x < HEX_MACRO_EDGE; x += 7) {
      const expected = hexGroundPixel(source, x, HEX_MACRO_EDGE - 1 - y);
      const offset = (y * ground.width + x) * 4;
      assert.deepEqual([...ground.pixels.subarray(offset, offset + 4)], expected, `pixel ${x},${y}`);
      assert.equal(expected[3], 255, `opaque ${x},${y}`);
    }
  }
  for (let offset = 0; offset < HEX_MACRO_EDGE; offset += 3) {
    assert.deepEqual(hexGroundPixel(source, 0, offset), hexGroundPixel(source, HEX_MACRO_EDGE, offset));
    assert.deepEqual(hexGroundPixel(source, offset, 0), hexGroundPixel(source, offset, HEX_MACRO_EDGE));
  }
});

test("the packaged floor is the selected seed's bounded island, not the repeated macro", () => {
  const ground = decodeRgbaPng(readFileSync(resolve(root, "defold/assets/derived/world/hex-meadow.png")));
  const manifest = JSON.parse(readFileSync(resolve(root, "defold/assets/derived/world/hex-meadow.json"), "utf8"));
  const plan = buildWorldPlan(DEFAULT_ARENA_SEED);
  assert.equal(ground.width, MAP_WIDTH * 16);
  assert.equal(ground.height, MAP_HEIGHT * 16);
  assert.deepEqual(manifest.worldPlan, {
    seed: DEFAULT_ARENA_SEED,
    rulesVersion: plan.rulesVersion,
    landHexes: plan.landCount,
    propCount: plan.propCount,
  });
  const tilemap = readFileSync(resolve(root, "defold/main/hex-meadow.tilemap"), "utf8");
  assert.deepEqual(
    [...tilemap.matchAll(/cell \{ x: (-?\d+) y: (-?\d+) tile: (\d+) \}/g)].map(([, x, y, tile]) => [x, y, tile]),
    [["0", "0", "0"]],
  );
  for (let y = 0; y < ground.height; y += 41) {
    for (let x = 0; x < ground.width; x += 37) {
      const offset = (y * ground.width + x) * 4;
      assert.deepEqual(
        [...ground.pixels.subarray(offset, offset + 4)],
        hexGroundPixel(source, x, ground.height - 1 - y, plan),
        `bounded floor pixel ${x},${y}`,
      );
    }
  }
});

test("the loaded landscape owns the floor and adjacent meadow hexes remain legible", () => {
  const level = readFileSync(resolve(root, "defold/main/level.go"), "utf8");
  const landscape = readFileSync(resolve(root, "defold/main/hex-meadow.tilemap"), "utf8");
  assert.match(level, /id: "landscape"\s+component: "\/main\/hex-meadow\.tilemap"/);
  assert.match(landscape, /tile_set: "\/main\/hex-meadow\.tilesource"/);
  // Defold's compiled tile index zero is the first tile; 0xffff is empty.
  const cells = [...landscape.matchAll(/cell \{ x: -?\d+ y: -?\d+ tile: (\d+) \}/g)];
  assert.ok(cells.length > 0, "the landscape places opaque terrain cells");
  assert.ok(
    cells.every(([, tile]) => tile === "0"),
    "the one-tile source uses compiled tile index zero",
  );

  const litEdge = hexGroundPixel(source, -23, -23);
  const shadowEdge = hexGroundPixel(source, 23, 23);
  const brightness = (pixel) => pixel[0] + pixel[1] + pixel[2];
  assert.ok(
    brightness(litEdge) - brightness(shadowEdge) >= 25,
    "equal-height meadow hexes retain a readable low-contrast bevel at gameplay scale",
  );
});

test("one wrapped crater-scale scar replaces individual basalt hex stamps", () => {
  assert.equal(hexRockPaintRole(2, 2, 0, 0, 194, 16), "B", "impact centre is dark rock");
  assert.equal(hexRockPaintRole(2, 2, 0, 0, 245, 16), "D", "the dark centre has a broad earth shoulder");
  assert.equal(hexRockPaintRole(2, 1, 0, 0, 144, -48), "G", "another basalt source cell is not a second disc");
  assert.equal(hexRockPaintRole(7, 7, 0, 0, 700, 700), "G", "distant meadow stays open");
  assert.equal(hexRockPaintRole(2, 2, 0, 0, 194, 16), hexRockPaintRole(2, 2, 0, 0, 194, 16 + HEX_MACRO_EDGE));
  assert.equal(hexRockPaintRole(2, 2, 0, 0, 194, 16), hexRockPaintRole(2, 2, 0, 0, 194 + HEX_MACRO_EDGE, 16));
});

test("the refinery service route is connected and has a coherent earth shoulder", () => {
  // This path is authored in the hex material map, not painted over a green
  // floor as a square-grid decal. Consecutive cells are 6-neighbor adjacent.
  let amberCenters = 0;
  for (const [q, r] of HEX_SERVICE_ROUTE) {
    assert.equal(hexTerrainRole(q, r), "M", `route ${q},${r}`);
    const worldX = q * 96;
    const worldY = r * 96 + (q & 1) * 48;
    assert.equal(hexServicePaintRole(q, r, 0, 0, worldX, worldY), "M", "route centre is steel");
    assert.ok(
      [
        [0, 38],
        [0, -38],
        [38, 0],
        [-38, 0],
      ].some(([dx, dy]) => hexServicePaintRole(q, r, dx, dy, worldX + dx, worldY + dy) === "G"),
      "at least one wide hex shoulder remains meadow",
    );
    const mark = hexServiceRoutePixel(q, r, 0, 0);
    assert.ok(mark === 1 || mark === 2, `route centre ${q},${r} has a centerline`);
    if (mark === 2) amberCenters++;
  }
  assert.ok(amberCenters >= 3, "route has recurring amber dashes");
  assert.equal(hexServicePaintRole(8, 4, 0, 0, 8 * 96, 4 * 96), "G", "unused M source cells do not draw steel plates");
  for (let index = 1; index < HEX_SERVICE_ROUTE.length; index++) {
    const [q, r] = HEX_SERVICE_ROUTE[index - 1];
    const [nextQ, nextR] = HEX_SERVICE_ROUTE[index];
    const adjacent =
      (nextQ === q && nextR === r + 1) ||
      (nextQ === q && nextR === r - 1) ||
      (nextQ === q + 1 && (nextR === r || nextR === r + (q & 1 ? 1 : -1)));
    assert.ok(adjacent, `service route edge ${q},${r} → ${nextQ},${nextR} is adjacent`);
  }
  for (const [q, r] of [
    [6, 4],
    [7, 4],
    [5, 5],
    [6, 5],
    [4, 6],
    [5, 6],
  ]) {
    assert.equal(hexTerrainRole(q, r), "D", `earth shoulder ${q},${r}`);
  }
});

test("the opening dirt road is a connected visual spur over unchanged meadow roles", () => {
  for (let index = 0; index < HEX_DIRT_SPUR.length; index++) {
    const [q, r] = HEX_DIRT_SPUR[index];
    assert.equal(hexTerrainRole(q, r), "G", "road overlay does not retag a cliff's biome");
    const u = q * 96;
    const v = r * 96 + (q & 1) * 48;
    assert.equal(hexDirtPaintRole(q, r, 0, 0, (u + v) / 2, (v - u) / 2), "D");
    if (index === 0) continue;
    const [previousQ, previousR] = HEX_DIRT_SPUR[index - 1];
    const du = (q - previousQ) * 96;
    const dv = (r - previousR) * 96 + ((q & 1) - (previousQ & 1)) * 48;
    assert.ok(du * du + dv * dv <= 96 * 96 + 48 * 48, "road centers form one continuous spur");
  }
  assert.equal(hexTerrainRole(5, 5), "D", "the spur meets the authored main road");
  assert.equal(hexTerrainRole(4, 2), "D", "isolated source semantics remain available to the generator");
  assert.equal(
    hexDirtPaintRole(4, 2, 0, 0, 288, -96),
    "G",
    "a disconnected source cell does not paint a tan hex island",
  );
  assert.equal(hexGroundRole(4, 2, 0, 0, 288, -96), "G", "the renderer honors the suppressed paint role");
});

test("hex cells own the floor while the square collision grid only paints objects", () => {
  const map = readFileSync(resolve(root, "defold/main/arena.tilemap"), "utf8");
  const groundLayer = map.match(/layers \{\s+id: "ground"\s+z: 0\.0\s*\}/);
  assert.ok(groundLayer, "the compatibility ground layer is empty");
  assert.match(map, /id: "walls"/);
  assert.match(map, /id: "decor"/);
  assert.match(map, /id: "marks"/);
  assert.equal(hexCellAt(14, 19).q, hexCellAt(14 + HEX_MACRO_EDGE, 19).q - HEX_MACRO_CELLS);
});

test("simulation landmarks sample the same local pixels that the landscape tilemap renders", () => {
  for (const [cellX, cellY] of [
    [0, 0],
    [19, 31],
    [60, 45],
    [93, 24],
    [119, 89],
  ]) {
    const localPixelX = cellX * 16 + 8;
    const localPixelY = cellY * 16 + 8;
    const { q, r } = hexCellAt(localPixelX, localPixelY);
    assert.equal(
      hexTerrainRoleAtSimulation(cellCentreX(cellX), cellCentreY(cellY)),
      hexTerrainRole(q, r),
      `cell ${cellX},${cellY} must match the generated floor's local pixel coordinates`,
    );
  }
});

test("tank presentation follows the low/standard/high lattice without snapping", () => {
  const centre = (q, r) => {
    const u = q * 96;
    const v = r * 96 + (q & 1) * 48;
    return {
      x: WORLD_MIN_X + ((u + v) / 2) * UNITS_PER_PIXEL,
      y: WORLD_MIN_Y + ((v - u) / 2) * UNITS_PER_PIXEL,
    };
  };
  for (let q = 0; q < HEX_MACRO_CELLS; q++) {
    for (let r = 0; r < HEX_MACRO_CELLS; r++) {
      const at = centre(q, r);
      const actual = hexReliefLiftAtSimulation(at.x, at.y);
      assert.ok(Math.abs(actual - hexReliefTier(q, r) * 2.5) < 1e-9, `centre ${q},${r}`);
      assert.ok(actual >= 0 && actual <= 5);
    }
  }
  const from = centre(2, 2);
  const to = centre(7, 8);
  let previous = hexReliefLiftAtSimulation(from.x, from.y);
  for (let step = 1; step <= 100; step++) {
    const t = step / 100;
    const value = hexReliefLiftAtSimulation(from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t);
    assert.ok(Math.abs(value - previous) <= 0.25, `no height snap between high and low regions at step ${step}`);
    previous = value;
  }
});
