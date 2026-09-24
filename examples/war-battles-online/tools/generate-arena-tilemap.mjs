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

import { ArenaMap, CELL_FLOOR } from "../core/arena.ts";
import { ARENA_VISUAL_CELL_COUNT, arenaThemeIndex, projectArenaVisualRoles } from "../core/arena-visual.ts";
import { MAP_HEIGHT, MAP_WIDTH } from "../core/constants.ts";
import { DEFAULT_ARENA_SEED } from "../core/playable.ts";
import {
  ARENA_ART_THEMES,
  arenaDecorTileId,
  arenaGroundTileId,
  arenaMarkTileId,
} from "../defold/src/generated-arena-art.ts";

const here = dirname(fileURLToPath(import.meta.url));
const exampleRoot = resolve(here, "..");
const projectRoot = resolve(exampleRoot, "defold");
const manifestPath = resolve(projectRoot, "assets/derived/arena/arena-art.json");
const outputArgument = process.argv.indexOf("--output");
const targetPath =
  outputArgument >= 0
    ? resolve(process.cwd(), process.argv[outputArgument + 1] ?? "")
    : resolve(projectRoot, "main/arena.tilemap");
if (outputArgument >= 0 && !process.argv[outputArgument + 1]) throw new Error("--output requires a file path");

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
      "Run: node tools/generate-art.mjs",
  );
}
const tiles = manifest?.tileSheet?.map;
if (!tiles?.themes || !tiles?.autotile || !Array.isArray(tiles.themeOrder)) {
  throw new Error(`${relative(exampleRoot, manifestPath)} has no tileSheet.map; regenerate the art`);
}
if (ARENA_ART_THEMES.length !== tiles.themeOrder.length)
  throw new Error("generated art contract theme count disagrees with manifest");
for (let index = 0; index < ARENA_ART_THEMES.length; index += 1) {
  const contract = ARENA_ART_THEMES[index];
  const record = tiles.themes[contract.id];
  if (
    contract.id !== tiles.themeOrder[index] ||
    !record ||
    JSON.stringify(contract.groundRoleTileIds) !== JSON.stringify(record.groundRoleTileIds) ||
    JSON.stringify(contract.decorRoleTileIds) !== JSON.stringify(record.decorRoleTileIds) ||
    JSON.stringify(contract.markRoleTileIds) !== JSON.stringify(record.markRoleTileIds)
  ) {
    throw new Error(`generated art contract theme ${contract.id} disagrees with manifest`);
  }
}

const map = new ArenaMap(seed);
const themeIndex = arenaThemeIndex(seed, DEFAULT_ARENA_SEED, ARENA_ART_THEMES.length);
const theme = ARENA_ART_THEMES[themeIndex];
const groundRoles = new Uint8Array(ARENA_VISUAL_CELL_COUNT);
const decorRoles = new Uint8Array(ARENA_VISUAL_CELL_COUNT);
const markRoles = new Uint8Array(ARENA_VISUAL_CELL_COUNT);
projectArenaVisualRoles(map, seed, groundRoles, decorRoles, markRoles);

// Two layers, because the art manifest says so: ground and wall tiles are
// opaque, while crates, sandbags and floor markings are transparent overlays
// that need something drawn underneath them.
const groundCells = [];
const decorCells = [];
const markCells = [];
for (let index = 0; index < ARENA_VISUAL_CELL_COUNT; index += 1) {
  const x = index % MAP_WIDTH;
  const y = Math.floor(index / MAP_WIDTH);
  groundCells.push({ x, y, tile: arenaGroundTileId(themeIndex, groundRoles[index]) });
  const decor = arenaDecorTileId(themeIndex, decorRoles[index]);
  const mark = arenaMarkTileId(themeIndex, markRoles[index]);
  if (decor !== 0) decorCells.push({ x, y, tile: decor });
  if (mark !== 0) markCells.push({ x, y, tile: mark });
}

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
  emitLayer("decor", "0.05", decorCells),
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
  console.log(`war-battles-arena-tilemap:fresh:${groundCells.length}+${decorCells.length}+${markCells.length} cells`);
} else {
  writeFileSync(targetPath, output);
  let solid = 0;
  for (let index = 0; index < MAP_WIDTH * MAP_HEIGHT; index += 1) if (map.cells[index] !== CELL_FLOOR) solid += 1;
  process.stdout.write(
    `Wrote ${relative(exampleRoot, targetPath)}\n` +
      `  arena ${MAP_WIDTH}x${MAP_HEIGHT} tiles (${MAP_WIDTH * 16}x${MAP_HEIGHT * 16} px), seed ${seed}\n` +
      `  theme ${theme.id} (${theme.name})\n` +
      `  ground cells ${groundCells.length}, solid ${solid} (${((100 * solid) / (MAP_WIDTH * MAP_HEIGHT)).toFixed(1)}%), decor cells ${decorCells.length}, overlay cells ${markCells.length}\n`,
  );
}
