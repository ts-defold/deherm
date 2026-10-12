#!/usr/bin/env node
// Inspect every generated frame at integer zoom before and after Defold packs
// the atlas. The transparent pixel grid and common baseline remain visible.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { alphaBounds, decodeRgbaPng, encodeRgbaPng } from "./generate-world-art.mjs";

const root = resolve(import.meta.dirname, "..");
const character = process.argv[2] ?? "rook";
const selection = JSON.parse(await readFile(resolve(root, "art/source/hero-source-selection.json"), "utf8"));
if (process.argv.length > 3 || !selection.families.some((family) => family.character === character)) {
  throw new Error(
    `Usage: node tools/preview-hero-runtime-art.mjs [${selection.families.map((family) => family.character).join("|")}]`,
  );
}
const directions = ["se", "s", "sw", "w", "e", "nw", "n", "ne"];
const family = selection.families.find((candidate) => candidate.character === character);
const frames = [
  "idle",
  "walk-1",
  "walk-2",
  "walk-3",
  "walk-4",
  ...(family.fireRequest === undefined ? [] : ["fire"]),
  ...(family.hitRequest === undefined ? [] : ["hit"]),
  ...(family.deathSources === undefined ? [] : ["death"]),
];
const cell = 48;
const zoom = 4;
const width = directions.length * cell;
const height = frames.length * cell;
const pixels = Buffer.alloc(width * height * 4);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const records = [];
for (let index = 0; index < pixels.length; index += 4) {
  pixels[index] = 28;
  pixels[index + 1] = 38;
  pixels[index + 2] = 44;
  pixels[index + 3] = 255;
}
for (const [column, direction] of directions.entries()) {
  for (const [row, frame] of frames.entries()) {
    const path = `defold/assets/units/infantry-${character}/${direction}/${frame}.png`;
    const bytes = await readFile(resolve(root, path));
    const image = decodeRgbaPng(bytes);
    if (image.width !== 40 || image.height !== 40) throw new Error(`wrong frame size: ${path}`);
    const bounds = alphaBounds(image);
    if (!bounds || bounds[3] !== 35) throw new Error(`wrong baseline: ${path}`);
    const xOrigin = column * cell + 4;
    const yOrigin = row * cell + 4;
    for (let y = 0; y < image.height; y += 1) {
      for (let x = 0; x < image.width; x += 1) {
        const from = (y * image.width + x) * 4;
        const to = ((yOrigin + y) * width + xOrigin + x) * 4;
        const alpha = image.pixels[from + 3] / 255;
        for (let channel = 0; channel < 3; channel += 1) {
          pixels[to + channel] = Math.round(image.pixels[from + channel] * alpha + pixels[to + channel] * (1 - alpha));
        }
      }
    }
    records.push({ direction, frame, path, sha256: sha256(bytes), opaqueBounds: bounds });
  }
}
const scaled = Buffer.alloc(width * zoom * height * zoom * 4);
for (let y = 0; y < height; y += 1) {
  for (let x = 0; x < width; x += 1) {
    const from = (y * width + x) * 4;
    for (let dy = 0; dy < zoom; dy += 1) {
      for (let dx = 0; dx < zoom; dx += 1) {
        pixels.copy(scaled, ((y * zoom + dy) * width * zoom + x * zoom + dx) * 4, from, from + 4);
      }
    }
  }
}
const png = encodeRgbaPng(width * zoom, height * zoom, scaled);
const directory = resolve(root, "build/evidence/hero-candidates");
await mkdir(directory, { recursive: true });
const imagePath = resolve(directory, `${character}-infantry-runtime-atlas-review.png`);
const reportPath = resolve(directory, `${character}-infantry-runtime-atlas-review.json`);
await writeFile(imagePath, png);
await writeFile(
  reportPath,
  `${JSON.stringify({ schemaVersion: 1, character, columns: directions, rows: frames, imageSha256: sha256(png), records }, null, 2)}\n`,
);
console.log(`war-battles-hero-runtime-atlas-review:${imagePath}`);
