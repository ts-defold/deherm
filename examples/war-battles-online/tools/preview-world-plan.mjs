#!/usr/bin/env node
// A critic-facing contact sheet for the proposed seeded hex world. This is
// intentionally separate from live Defold art until visual/collision parity
// and runtime tilemap realization have been proven.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_ARENA_SEED } from "../core/playable.ts";
import { MAP_HEIGHT, MAP_WIDTH } from "../core/constants.ts";
import { hexCellAt } from "../core/hex-landscape.ts";
import {
  WORLD_BIOME_ASH,
  WORLD_BIOME_BASALT,
  WORLD_BIOME_EARTH,
  WORLD_BIOME_MEADOW,
  WORLD_BUILT_PAD,
  WORLD_BUILT_ROUTE,
  WORLD_PROP_BUILDING,
  WORLD_PROP_DEPOT,
  WORLD_PROP_TREE,
  buildWorldPlan,
  worldHexIndex,
} from "../core/world-plan.ts";
import { encodeRgbaPng } from "./generate-world-art.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = resolve(root, "../../build/evidence/war-battles-world-plan-contact.png");
const seeds = [DEFAULT_ARENA_SEED, 0, 1, 77, 101, 202, 303, 404, 0xffff_ffff];
const tileWidth = 480;
const tileHeight = 360;
const columns = 3;
const rows = Math.ceil(seeds.length / columns);
const width = columns * tileWidth;
const height = rows * tileHeight;
const pixels = Buffer.alloc(width * height * 4);
const palette = new Map([
  [WORLD_BIOME_MEADOW, [99, 143, 72]],
  [WORLD_BIOME_EARTH, [179, 131, 77]],
  [WORLD_BIOME_BASALT, [70, 75, 77]],
  [WORLD_BIOME_ASH, [116, 82, 69]],
]);

function marker(x, y, radius, color) {
  for (let dy = -radius; dy <= radius; dy += 1) {
    for (let dx = -radius; dx <= radius; dx += 1) {
      if (dx * dx + dy * dy > radius * radius) continue;
      const px = x + dx;
      const py = y + dy;
      if (px < 0 || py < 0 || px >= width || py >= height) continue;
      const offset = (py * width + px) * 4;
      for (let channel = 0; channel < 3; channel += 1) pixels[offset + channel] = color[channel];
      pixels[offset + 3] = 255;
    }
  }
}

for (let tile = 0; tile < seeds.length; tile += 1) {
  const plan = buildWorldPlan(seeds[tile]);
  const originX = (tile % columns) * tileWidth;
  const originY = Math.floor(tile / columns) * tileHeight;
  const hex = { q: 0, r: 0, dx: 0, dy: 0 };
  for (let y = 0; y < tileHeight; y += 1) {
    for (let x = 0; x < tileWidth; x += 1) {
      const localX = x * 4;
      const localY = (tileHeight - 1 - y) * 4;
      hexCellAt(localX, localY, hex);
      const index = worldHexIndex(hex.q, hex.r);
      const offset = ((originY + y) * width + originX + x) * 4;
      const isLand = index >= 0 && plan.land[index] !== 0;
      const base = isLand
        ? plan.builtSurface[index] === WORLD_BUILT_PAD
          ? [128, 122, 98]
          : plan.builtSurface[index] === WORLD_BUILT_ROUTE
            ? [162, 131, 82]
            : palette.get(plan.biome[index])
        : [13, 71, 98];
      if (base === undefined) throw new Error(`unrenderable biome ${plan.biome[index]}`);
      const elevation = isLand ? (plan.elevation[index] - 1) * 13 : 0;
      const edge = 64 - (Math.abs(hex.dy) * 2) / 3 - Math.abs(hex.dx);
      const line = isLand && edge < 2.3 ? -22 : 0;
      const coast = isLand && plan.coastEdges[index] !== 0 && edge < 5 ? -10 : 0;
      for (let channel = 0; channel < 3; channel += 1) {
        pixels[offset + channel] = Math.max(0, Math.min(255, base[channel] + elevation + line + coast));
      }
      pixels[offset + 3] = 255;
    }
  }
  function cellMarker(cell, radius, color) {
    const x = originX + Math.floor(((cell % MAP_WIDTH) + 0.5) * (tileWidth / MAP_WIDTH));
    const y = originY + Math.floor((MAP_HEIGHT - Math.floor(cell / MAP_WIDTH) - 0.5) * (tileHeight / MAP_HEIGHT));
    marker(x, y, radius, color);
  }
  for (let prop = 0; prop < plan.propCount; prop += 1) {
    const kind = plan.propKinds[prop];
    cellMarker(
      plan.propCells[prop],
      kind === WORLD_PROP_BUILDING || kind === WORLD_PROP_DEPOT ? 4 : 2,
      kind === WORLD_PROP_DEPOT
        ? [255, 121, 78]
        : kind === WORLD_PROP_BUILDING
          ? [244, 191, 87]
          : kind === WORLD_PROP_TREE
            ? [19, 64, 30]
            : [188, 189, 177],
    );
  }
  for (const spawn of plan.spawnCells) cellMarker(spawn, 3, [243, 245, 225]);
}

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, encodeRgbaPng(width, height, pixels));
console.log(`war-battles-world-plan-preview:${seeds.map((seed) => seed.toString(16)).join(",")}:${outputPath}`);
