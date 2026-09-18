#!/usr/bin/env node
// Grows the War Battles tutorial tilemap into a scrolling world.
//
// Stage 1b of the showcase roadmap needs a world substantially larger than one
// screen. The tutorial map is 51x49 tiles (816x784 px) which is barely larger
// than a single camera view, so this tool composes a 120x90 tile world
// (1920x1440 px) out of *the art that already exists*: the same four ground
// tiles and the same 4x2 prop that the tutorial map uses. The authored
// tutorial map is preserved verbatim as a region of the larger map so the port
// keeps its original level, and the surrounding ground and props are generated
// from a fixed seed so the output is byte-reproducible.
//
//   node examples/war-battles-online/tools/generate-world-tilemap.mjs
//
// The script reads `main/tutorial-map.tilemap`, so it is idempotent only when
// run against a map it has not already grown; regenerate from git history if
// the source map changes.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, "..", "defold");
const sourcePath = resolve(projectRoot, "main", "tutorial-map.tilemap");
const targetPath = resolve(projectRoot, "main", "tutorial-world.tilemap");

/** Authored tutorial map extent, in tiles. */
const SOURCE_WIDTH = 51;
const SOURCE_HEIGHT = 49;
/** Generated world extent, in tiles. 120x90 at 16 px is 1920x1440 px. */
const WORLD_WIDTH = 120;
const WORLD_HEIGHT = 90;
/** Where the authored map sits inside the generated world, in tiles. */
const SOURCE_OFFSET_X = 34;
const SOURCE_OFFSET_Y = 20;

/** Ground tiles and their frequency in the authored map. */
const GROUND_WEIGHTS = [
  [28, 1910],
  [101, 289],
  [100, 193],
  [29, 107],
];

/**
 * The authored decoration prop, as tile ids in a 4 wide by 2 tall block.
 * Row 0 is the lower tile row: tilemap y grows upward.
 */
const PROP = [
  [74, 75, 76, 77], // y + 0
  [50, 51, 52, 53], // y + 1
];
const PROP_WIDTH = 4;
const PROP_HEIGHT = 2;

/** Authored prop density is one per ~147 ground cells; hold it across the world. */
const PROP_CELLS_PER_PROP = 147;

/** Fixed seed keeps the generated world byte-reproducible. */
const SEED = 0x57415242; // "WARB"

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function parseLayers(text) {
  const blocks = text.split(/\nlayers \{/);
  return blocks.slice(1).map((block) => {
    const id = /id: "([^"]+)"/.exec(block)[1];
    const z = /z: ([0-9.eE+-]+)/.exec(block)[1];
    const cells = new Map();
    const pattern = /cell \{\s*x: (-?\d+)\s*y: (-?\d+)\s*tile: (\d+)\s*\}/g;
    let match;
    while ((match = pattern.exec(block)) !== null) {
      cells.set(`${match[1]},${match[2]}`, {
        x: Number(match[1]),
        y: Number(match[2]),
        tile: Number(match[3]),
      });
    }
    return { id, z, cells };
  });
}

const source = readFileSync(sourcePath, "utf8");
const tileSet = /^tile_set: "([^"]+)"/m.exec(source)[1];
const material = /^material: "([^"]+)"/m.exec(source)[1];
const [sourceGround, sourceProps] = parseLayers(source);

const random = mulberry32(SEED);
const groundTotal = GROUND_WEIGHTS.reduce((sum, [, weight]) => sum + weight, 0);

function pickGroundTile() {
  let roll = random() * groundTotal;
  for (const [tile, weight] of GROUND_WEIGHTS) {
    roll -= weight;
    if (roll <= 0) return tile;
  }
  return GROUND_WEIGHTS[0][0];
}

// --- ground layer -----------------------------------------------------------

const ground = new Map();
for (let y = 0; y < WORLD_HEIGHT; ++y) {
  for (let x = 0; x < WORLD_WIDTH; ++x) {
    const sourceX = x - SOURCE_OFFSET_X;
    const sourceY = y - SOURCE_OFFSET_Y;
    const authored = sourceGround.cells.get(`${sourceX},${sourceY}`);
    ground.set(`${x},${y}`, { x, y, tile: authored ? authored.tile : pickGroundTile() });
  }
}

// --- prop layer -------------------------------------------------------------

const props = new Map();
const occupied = new Set();

function markOccupied(originX, originY) {
  // One tile of slack around a prop keeps the generated clusters readable.
  for (let y = originY - 1; y <= originY + PROP_HEIGHT; ++y) {
    for (let x = originX - 1; x <= originX + PROP_WIDTH; ++x) {
      occupied.add(`${x},${y}`);
    }
  }
}

function placeProp(originX, originY) {
  for (let row = 0; row < PROP_HEIGHT; ++row) {
    for (let column = 0; column < PROP_WIDTH; ++column) {
      const x = originX + column;
      const y = originY + row;
      props.set(`${x},${y}`, { x, y, tile: PROP[row][column] });
    }
  }
  markOccupied(originX, originY);
}

// Authored props first, translated into the world, so the tutorial level keeps
// its exact decoration layout.
const authoredOrigins = [];
for (const cell of sourceProps.cells.values()) {
  if (cell.tile !== PROP[0][0]) continue; // lower-left tile marks the origin
  authoredOrigins.push([cell.x + SOURCE_OFFSET_X, cell.y + SOURCE_OFFSET_Y]);
}
authoredOrigins.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
for (const [x, y] of authoredOrigins) placeProp(x, y);

const targetPropCount = Math.round((WORLD_WIDTH * WORLD_HEIGHT) / PROP_CELLS_PER_PROP);
const sourceLeft = SOURCE_OFFSET_X;
const sourceRight = SOURCE_OFFSET_X + SOURCE_WIDTH;
const sourceBottom = SOURCE_OFFSET_Y;
const sourceTop = SOURCE_OFFSET_Y + SOURCE_HEIGHT;

let placed = authoredOrigins.length;
let attempts = 0;
while (placed < targetPropCount && attempts < 100000) {
  ++attempts;
  const x = 1 + Math.floor(random() * (WORLD_WIDTH - PROP_WIDTH - 2));
  const y = 1 + Math.floor(random() * (WORLD_HEIGHT - PROP_HEIGHT - 2));
  // The authored region keeps its own layout untouched.
  if (x + PROP_WIDTH > sourceLeft && x < sourceRight &&
      y + PROP_HEIGHT > sourceBottom && y < sourceTop) continue;
  let blocked = false;
  for (let row = 0; row < PROP_HEIGHT && !blocked; ++row) {
    for (let column = 0; column < PROP_WIDTH; ++column) {
      if (occupied.has(`${x + column},${y + row}`)) { blocked = true; break; }
    }
  }
  if (blocked) continue;
  placeProp(x, y);
  ++placed;
}

// --- emit -------------------------------------------------------------------

function emitLayer(id, z, cells) {
  const ordered = [...cells.values()].sort((a, b) => a.y - b.y || a.x - b.x);
  const lines = [`layers {`, `  id: "${id}"`, `  z: ${z}`];
  for (const cell of ordered) {
    lines.push(`  cell {`, `    x: ${cell.x}`, `    y: ${cell.y}`, `    tile: ${cell.tile}`, `  }`);
  }
  lines.push(`}`);
  return lines.join("\n");
}

const output = [
  `tile_set: "${tileSet}"`,
  emitLayer(sourceGround.id, sourceGround.z, ground),
  emitLayer(sourceProps.id, sourceProps.z, props),
  `material: "${material}"`,
  ``,
].join("\n");

writeFileSync(targetPath, output);
process.stdout.write(
  `Wrote ${targetPath}\n` +
  `  world ${WORLD_WIDTH}x${WORLD_HEIGHT} tiles (${WORLD_WIDTH * 16}x${WORLD_HEIGHT * 16} px)\n` +
  `  authored map at tile offset ${SOURCE_OFFSET_X},${SOURCE_OFFSET_Y}\n` +
  `  ground cells ${ground.size}, prop cells ${props.size}, props ${placed}\n`,
);
