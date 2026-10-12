#!/usr/bin/env node
// Build the selected-seed floor from source pixel materials without replacing
// the packaged game. Transparent pixels are planned water, not a square crop.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_ARENA_SEED } from "../core/playable.ts";
import { buildWorldPlan } from "../core/world-plan.ts";
import { buildHexGround } from "./generate-hex-terrain.mjs";
import { encodeRgbaPng } from "./generate-world-art.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = resolve(root, "../../build/evidence/war-battles-world-plan-art-preview.png");
const seedArgument = process.argv.indexOf("--seed");
const seed = seedArgument < 0 ? DEFAULT_ARENA_SEED : Number(process.argv[seedArgument + 1]);
if (!Number.isInteger(seed) || seed < 0 || seed > 0xffff_ffff) throw new Error("--seed requires a uint32");
const plan = buildWorldPlan(seed);
const floor = buildHexGround(plan);
const pixels = Buffer.from(floor.pixels);
for (let index = 0; index < pixels.length; index += 4) {
  if (pixels[index + 3] !== 0) continue;
  pixels[index] = 12;
  pixels[index + 1] = 65;
  pixels[index + 2] = 87;
  pixels[index + 3] = 255;
}
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, encodeRgbaPng(floor.width, floor.height, pixels));
console.log(
  `war-battles-world-plan-art-preview:seed=${seed}:land=${plan.landCount}:props=${plan.propCount}:${outputPath}`,
);
