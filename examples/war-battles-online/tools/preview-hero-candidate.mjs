#!/usr/bin/env node
// Compare a Sprite Fusion eight-view candidate with the current tutorial hero
// at native atlas scale. Evidence only: this never changes game selection.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { alphaBounds, decodeRgbaPng, encodeRgbaPng } from "./generate-world-art.mjs";

const root = resolve(import.meta.dirname, "..");
const request = process.argv[2] ?? "rook-infantry-directions-v1";
if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(request)) throw new Error("invalid request name");
const directions = ["se", "s", "sw", "w", "e", "nw", "n", "ne"];
const oldSources = ["down-d", "down", "down-d", "side", "side", "up-d", "up", "up-d"];
const mirrored = new Set([2, 3, 5]);
const heights = [22, 28, 32];
const cell = 64;
const width = directions.length * cell;
const height = heights.length * cell;
const pixels = Buffer.alloc(width * height * 4);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function plot(image, bounds, column, row, subjectHeight, flip) {
  const [left, top, right, bottom] = bounds;
  const subjectWidth = right - left + 1;
  const subjectSourceHeight = bottom - top + 1;
  const targetWidth = Math.max(1, Math.round((subjectWidth * subjectHeight) / subjectSourceHeight));
  const startX = column * cell + Math.floor((cell - targetWidth) / 2);
  const startY = row * cell + 48 - subjectHeight;
  assert.ok(startX >= column * cell && startX + targetWidth <= (column + 1) * cell);
  for (let y = 0; y < subjectHeight; y += 1) {
    const sourceY = top + Math.floor((y * subjectSourceHeight) / subjectHeight);
    for (let x = 0; x < targetWidth; x += 1) {
      const sourceX = left + Math.floor(((flip ? targetWidth - x - 1 : x) * subjectWidth) / targetWidth);
      const from = (sourceY * image.width + sourceX) * 4;
      const to = ((startY + y) * width + startX + x) * 4;
      image.pixels.copy(pixels, to, from, from + 4);
    }
  }
  return targetWidth;
}

const manifestPath = resolve(root, `art/source/sprite-fusion/requests/${request}.json`);
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
assert.equal(manifest.operation, "direction-set");
assert.equal(manifest.outputs?.length, directions.length);
const outputRecords = [];
for (let index = 0; index < directions.length; index += 1) {
  const output = manifest.outputs.find((entry) => entry.index === index);
  assert.ok(output, `direction ${index} missing`);
  const bytes = await readFile(resolve(root, output.path));
  assert.equal(sha256(bytes), output.sha256, `direction ${index} source changed`);
  const image = decodeRgbaPng(bytes);
  const bounds = alphaBounds(image);
  assert.ok(bounds, `direction ${index} is empty`);
  const oldImage = decodeRgbaPng(
    await readFile(resolve(root, `defold/assets/units/infantry/${oldSources[index]}/1.png`)),
  );
  const oldBounds = alphaBounds(oldImage);
  assert.ok(oldBounds);
  plot(oldImage, oldBounds, index, 0, heights[0], mirrored.has(index));
  const widths = [plot(image, bounds, index, 1, heights[1], false), plot(image, bounds, index, 2, heights[2], false)];
  outputRecords.push({
    direction: directions[index],
    sourceIndex: index,
    path: output.path,
    sha256: output.sha256,
    canvas: [image.width, image.height],
    opaqueBounds: bounds,
    edgeContacts: {
      left: bounds[0] === 0,
      top: bounds[1] === 0,
      right: bounds[2] === image.width - 1,
      bottom: bounds[3] === image.height - 1,
    },
    targetWidths: widths,
  });
}
const outputDir = resolve(root, "build/evidence/hero-candidates");
await mkdir(outputDir, { recursive: true });
const png = encodeRgbaPng(width, height, pixels);
const imagePath = resolve(outputDir, `${request}-scale-comparison.png`);
const zoom = 3;
const zoomed = Buffer.alloc(width * zoom * height * zoom * 4);
for (let y = 0; y < height; y += 1) {
  for (let x = 0; x < width; x += 1) {
    const from = (y * width + x) * 4;
    for (let dy = 0; dy < zoom; dy += 1) {
      for (let dx = 0; dx < zoom; dx += 1) {
        const to = ((y * zoom + dy) * width * zoom + x * zoom + dx) * 4;
        pixels.copy(zoomed, to, from, from + 4);
      }
    }
  }
}
const zoomedPng = encodeRgbaPng(width * zoom, height * zoom, zoomed);
const zoomedPath = resolve(outputDir, `${request}-scale-comparison-3x.png`);
const reportPath = resolve(outputDir, `${request}-scale-comparison.json`);
await writeFile(imagePath, png);
await writeFile(zoomedPath, zoomedPng);
await writeFile(
  reportPath,
  `${JSON.stringify({ schemaVersion: 1, request, rows: heights, columns: directions, imagePath, imageSha256: sha256(png), zoomedPath, zoomedSha256: sha256(zoomedPng), outputs: outputRecords }, null, 2)}\n`,
);
console.log(`war-battles-hero-candidate:${reportPath}:${zoomedPath}`);
