#!/usr/bin/env node
//
// Emits the Defold tilemap for the arena the simulation actually collides with.
//
// The arena grid in `core/arena.ts` is derived from a seed and is what decides
// where cover, chokepoints and sightlines are. The tilemap is the *picture* of
// that grid, and the two have to be the same thing or the player shoots at a
// wall the server does not have. This tool is the single place that turns one
// into the other, so they cannot drift:
//
//     node tools/generate-arena-tilemap.mjs            # write
//     node tools/generate-arena-tilemap.mjs --check    # verify, exit 1 if stale
//
// Tile identities come from `defold/assets/derived/arena/arena-art.json`, which
// the art generator writes, so renumbering the tile sheet cannot silently
// repaint the map either.
//
// NOTE ON TILE INDICES. The `.tilemap` file stores `cell.tile` ZERO-based: the
// engine copies it straight into the cell array, while Lua's `tilemap.set_tile`
// takes a one-based index and subtracts one
// (upstream/defold/engine/gamesys/src/gamesys/scripts/script_tilemap.cpp). The
// art manifest is one-based, so every id written below is `id - 1`.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ArenaMap,
  CELL_CRATE,
  CELL_FLOOR,
  CELL_SANDBAG,
  CELL_WALL,
  SPAWN_POINT_COUNT,
  cellOfX,
  cellOfY,
} from "../core/arena.ts";
import { MAP_HEIGHT, MAP_WIDTH, MAX_PICKUPS } from "../core/constants.ts";
import { DEFAULT_ARENA_SEED } from "../core/playable.ts";

const here = dirname(fileURLToPath(import.meta.url));
const exampleRoot = resolve(here, "..");
const projectRoot = resolve(exampleRoot, "defold");
const manifestPath = resolve(projectRoot, "assets/derived/arena/arena-art.json");
const targetPath = resolve(projectRoot, "main/arena.tilemap");

const TILE_SOURCE = "/main/arena-tiles.tilesource";
const MATERIAL = "/builtins/materials/tile_map.material";

const check = process.argv.includes("--check");
const seedArgument = process.argv.indexOf("--seed");
const seed = seedArgument >= 0 ? Number(process.argv[seedArgument + 1]) : DEFAULT_ARENA_SEED;
if (!Number.isInteger(seed) || seed < 0 || seed > 0xffff_ffff) {
  throw new Error("--seed requires an unsigned 32-bit integer");
}

let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
} catch (error) {
  throw new Error(
    `arena art manifest is missing or unreadable (${relative(exampleRoot, manifestPath)}): ${error.message}\n` +
    "Run: node tools/generate-art.mjs");
}
const tiles = manifest?.tileSheet?.map;
if (!tiles?.groundTileIds || !tiles?.wallTileIds) {
  throw new Error(`${relative(exampleRoot, manifestPath)} has no tileSheet.map; regenerate the art`);
}

const ground = tiles.groundTileIds;
const wall = tiles.wallTileIds;
const crateTile = tiles.crateTileId;
const sandbagTile = tiles.sandbagTileId;
const spawnPadTile = tiles.spawnPadTileId;
const pickupPadTile = tiles.pickupPadTileId;

const map = new ArenaMap(seed);

/**
 * Picks the wall tile for one cell from its four orthogonal neighbours. A
 * neighbour that is off the grid counts as wall, so the arena border reads as a
 * continuous block rather than as a ring of corners.
 *
 * Only a concrete wall counts. A crate standing against a wall is solid to the
 * simulation but is drawn on the overlay layer, so the wall keeps the edge tile
 * that tells the eye where the block actually ends.
 */
function isWall(cellX, cellY) {
  if (cellX < 0 || cellY < 0 || cellX >= MAP_WIDTH || cellY >= MAP_HEIGHT) return true;
  return map.cellAt(cellX, cellY) === CELL_WALL;
}

function wallTile(cellX, cellY) {
  const north = isWall(cellX, cellY + 1);
  const south = isWall(cellX, cellY - 1);
  const east = isWall(cellX + 1, cellY);
  const west = isWall(cellX - 1, cellY);
  if (north && south && east && west) return wall.centre;
  if (!north && !east && south && west) return wall.ne;
  if (!north && !west && south && east) return wall.nw;
  if (!south && !east && north && west) return wall.se;
  if (!south && !west && north && east) return wall.sw;
  if (!north && south && east && west) return wall.n;
  if (!south && north && east && west) return wall.s;
  if (!east && north && south && west) return wall.e;
  if (!west && north && south && east) return wall.w;
  // A one-cell-thick spur or an isolated block has no matching edge tile; the
  // solid centre is the honest fallback and still reads as impassable.
  return wall.centre;
}

/**
 * Ground variation is a hash of the cell, not a running generator, so a single
 * cell's tile never depends on how many cells were emitted before it.
 */
function groundTile(cellX, cellY) {
  let hash = (seed ^ Math.imul(cellX, 0x9e37_79b1) ^ Math.imul(cellY, 0x85eb_ca6b)) >>> 0;
  hash ^= hash >>> 15;
  hash = Math.imul(hash, 0x2545_f491) >>> 0;
  return ground[(hash >>> 3) % ground.length];
}

// Two layers, because the art manifest says so: ground and wall tiles are
// opaque, while crates, sandbags and floor markings are transparent overlays
// that need something drawn underneath them.
const groundCells = [];
const markCells = [];
const marked = new Set();
function mark(x, y, tile) {
  const key = `${x},${y}`;
  if (marked.has(key)) return;
  marked.add(key);
  markCells.push({ x, y, tile });
}

for (let cellY = 0; cellY < MAP_HEIGHT; cellY += 1) {
  for (let cellX = 0; cellX < MAP_WIDTH; cellX += 1) {
    const cell = map.cellAt(cellX, cellY);
    if (cell === CELL_WALL) {
      groundCells.push({ x: cellX, y: cellY, tile: wallTile(cellX, cellY) });
      continue;
    }
    groundCells.push({ x: cellX, y: cellY, tile: groundTile(cellX, cellY) });
    if (cell === CELL_CRATE) mark(cellX, cellY, crateTile);
    else if (cell === CELL_SANDBAG) mark(cellX, cellY, sandbagTile);
  }
}
for (let index = 0; index < SPAWN_POINT_COUNT; index += 1) {
  mark(cellOfX(map.spawnX[index]), cellOfY(map.spawnY[index]), spawnPadTile);
}
for (let index = 0; index < MAX_PICKUPS; index += 1) {
  mark(cellOfX(map.pickupX[index]), cellOfY(map.pickupY[index]), pickupPadTile);
}
markCells.sort((a, b) => a.y - b.y || a.x - b.x);

function emitLayer(id, z, cells) {
  const lines = ["layers {", `  id: "${id}"`, `  z: ${z}`];
  for (const cell of cells) {
    lines.push("  cell {", `    x: ${cell.x}`, `    y: ${cell.y}`, `    tile: ${cell.tile - 1}`, "  }");
  }
  lines.push("}");
  return lines.join("\n");
}

const output = [
  `tile_set: "${TILE_SOURCE}"`,
  emitLayer("ground", "0.0", groundCells),
  emitLayer("marks", "0.1", markCells),
  `material: "${MATERIAL}"`,
  "",
].join("\n");

if (check) {
  let existing;
  try {
    existing = readFileSync(targetPath, "utf8");
  } catch {
    console.error(`war-battles-arena-tilemap:missing:${relative(exampleRoot, targetPath)}`);
    process.exit(1);
  }
  if (existing !== output) {
    console.error(`war-battles-arena-tilemap:stale:${relative(exampleRoot, targetPath)}`);
    process.exit(1);
  }
  console.log(`war-battles-arena-tilemap:fresh:${groundCells.length}+${markCells.length} cells`);
} else {
  writeFileSync(targetPath, output);
  let solid = 0;
  for (let index = 0; index < MAP_WIDTH * MAP_HEIGHT; index += 1) if (map.cells[index] !== CELL_FLOOR) solid += 1;
  process.stdout.write(
    `Wrote ${relative(exampleRoot, targetPath)}\n` +
    `  arena ${MAP_WIDTH}x${MAP_HEIGHT} tiles (${MAP_WIDTH * 16}x${MAP_HEIGHT * 16} px), seed ${seed}\n` +
    `  ground cells ${groundCells.length}, solid ${solid} (${(100 * solid / (MAP_WIDTH * MAP_HEIGHT)).toFixed(1)}%), overlay cells ${markCells.length}\n`);
}
