#!/usr/bin/env node
// Review the immutable eight-view source and both edited walk-pose candidates
// at a common runtime scale. This is evidence, not game art selection.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { alphaBounds, decodeRgbaPng, encodeRgbaPng } from "./generate-world-art.mjs";

const root = resolve(import.meta.dirname, "..");
const character = process.argv[2] ?? "rook";
if (process.argv.length > 3 || !/^[a-z]+$/u.test(character)) {
  throw new Error("Usage: node tools/preview-hero-walk-poses.mjs [character]");
}
const directions = ["se", "s", "sw", "w", "e", "nw", "n", "ne"];
const cell = 64;
const zoom = 3;
const columns = directions.length;
const rows = 3;
const width = columns * cell;
const height = rows * cell;
const pixels = Buffer.alloc(width * height * 4);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
for (let index = 0; index < pixels.length; index += 4) {
  pixels[index] = 28;
  pixels[index + 1] = 38;
  pixels[index + 2] = 44;
  pixels[index + 3] = 255;
}

async function readPinned(output) {
  const bytes = await readFile(resolve(root, output.path));
  assert.equal(sha256(bytes), output.sha256, `candidate changed: ${output.path}`);
  const image = decodeRgbaPng(bytes);
  const bounds = alphaBounds(image);
  assert.ok(bounds, `candidate empty: ${output.path}`);
  return { image, bounds };
}

function draw({ image, bounds }, column, row) {
  const [left, top, right, bottom] = bounds;
  const sourceWidth = right - left + 1;
  const sourceHeight = bottom - top + 1;
  const targetHeight = 32;
  const targetWidth = Math.max(1, Math.round((sourceWidth * targetHeight) / sourceHeight));
  const startX = column * cell + Math.floor((cell - targetWidth) / 2);
  const startY = row * cell + 48 - targetHeight;
  for (let y = 0; y < targetHeight; y += 1) {
    const sourceY = top + Math.floor((y * sourceHeight) / targetHeight);
    for (let x = 0; x < targetWidth; x += 1) {
      const sourceX = left + Math.floor((x * sourceWidth) / targetWidth);
      const from = (sourceY * image.width + sourceX) * 4;
      const to = ((startY + y) * width + startX + x) * 4;
      const alpha = image.pixels[from + 3] / 255;
      for (let channel = 0; channel < 3; channel += 1) {
        pixels[to + channel] = Math.round(image.pixels[from + channel] * alpha + pixels[to + channel] * (1 - alpha));
      }
    }
  }
}

const idleManifest = JSON.parse(
  await readFile(resolve(root, `art/source/sprite-fusion/requests/${character}-infantry-directions-v1.json`), "utf8"),
);
assert.equal(idleManifest.operation, "direction-set");
assert.equal(idleManifest.outputs?.length, directions.length);
const records = [];
for (let column = 0; column < directions.length; column += 1) {
  const direction = directions[column];
  const idle = idleManifest.outputs.find((output) => output.index === column);
  assert.ok(idle, `missing idle ${direction}`);
  draw(await readPinned(idle), column, 0);
  const editManifest = JSON.parse(
    await readFile(
      resolve(root, `art/source/sprite-fusion/requests/${character}-infantry-walk-pose-${direction}-v1.json`),
      "utf8",
    ),
  );
  assert.equal(editManifest.operation, "edit");
  assert.ok(
    editManifest.outputs?.length >= 1 && editManifest.outputs.length <= 2,
    `expected one or two pose candidates for ${character}/${direction}`,
  );
  for (const [row, output] of editManifest.outputs.entries()) draw(await readPinned(output), column, row + 1);
  records.push({
    direction,
    idle: idle.path,
    pose0: editManifest.outputs[0].path,
    pose1: editManifest.outputs[1]?.path ?? null,
  });
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
const path = resolve(directory, `${character}-infantry-walk-pose-review.png`);
await writeFile(path, png);
await writeFile(
  resolve(directory, `${character}-infantry-walk-pose-review.json`),
  `${JSON.stringify({ schemaVersion: 1, character, columns: directions, rows: ["idle", "pose0", "pose1"], sha256: sha256(png), records }, null, 2)}\n`,
);
console.log(`war-battles-hero-pose-review:${path}`);
