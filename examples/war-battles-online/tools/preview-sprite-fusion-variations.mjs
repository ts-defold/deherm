#!/usr/bin/env node
// Credit-aware candidate review: normalize each immutable provider output to
// gameplay height and show every variation before selecting a new source.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { alphaBounds, decodeRgbaPng, encodeRgbaPng } from "./generate-world-art.mjs";

const root = resolve(import.meta.dirname, "..");
const requestName = process.argv[2];
if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(requestName ?? "")) {
  throw new Error("Usage: node tools/preview-sprite-fusion-variations.mjs <request-name>");
}
const manifest = JSON.parse(
  await readFile(resolve(root, `art/source/sprite-fusion/requests/${requestName}.json`), "utf8"),
);
assert.ok(["generate", "style-reference", "edit"].includes(manifest.operation));
assert.ok(manifest.outputs.length > 0 && manifest.outputs.length <= 20);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const targetHeight = 32;
const candidates = await Promise.all(
  manifest.outputs.map(async (output) => {
    assert.ok(Number.isInteger(output.index) && output.index >= 0 && output.index < manifest.outputs.length);
    const bytes = await readFile(resolve(root, output.path));
    assert.equal(sha256(bytes), output.sha256, `candidate changed: ${output.path}`);
    const image = decodeRgbaPng(bytes);
    const bounds = alphaBounds(image);
    assert.ok(bounds, `empty candidate: ${output.path}`);
    const [left, top, right, bottom] = bounds;
    const sourceWidth = right - left + 1;
    const sourceHeight = bottom - top + 1;
    const targetWidth = Math.max(1, Math.round((sourceWidth * targetHeight) / sourceHeight));
    return { output, image, bounds, sourceWidth, sourceHeight, targetWidth };
  }),
);
const columns = Math.min(3, manifest.outputs.length);
const rows = Math.ceil(manifest.outputs.length / columns);
const cell = Math.max(48, ...candidates.map(({ targetWidth }) => targetWidth + 8));
assert.ok(cell <= 128, `candidate aspect ratio requires an unreasonable ${cell}px review cell`);
const zoom = 5;
const width = columns * cell;
const height = rows * cell;
const pixels = Buffer.alloc(width * height * 4);
for (let index = 0; index < pixels.length; index += 4) {
  pixels[index] = 28;
  pixels[index + 1] = 38;
  pixels[index + 2] = 44;
  pixels[index + 3] = 255;
}
const records = [];
for (const { output, image, bounds, sourceWidth, sourceHeight, targetWidth } of candidates) {
  const [left, top] = bounds;
  const column = output.index % columns;
  const row = Math.floor(output.index / columns);
  const originX = column * cell + Math.floor((cell - targetWidth) / 2);
  const originY = row * cell + cell - 8 - targetHeight;
  for (let y = 0; y < targetHeight; y += 1) {
    const sourceY = top + Math.floor((y * sourceHeight) / targetHeight);
    for (let x = 0; x < targetWidth; x += 1) {
      const sourceX = left + Math.floor((x * sourceWidth) / targetWidth);
      const from = (sourceY * image.width + sourceX) * 4;
      const to = ((originY + y) * width + originX + x) * 4;
      const alpha = image.pixels[from + 3] / 255;
      for (let channel = 0; channel < 3; channel += 1) {
        pixels[to + channel] = Math.round(image.pixels[from + channel] * alpha + pixels[to + channel] * (1 - alpha));
      }
    }
  }
  records.push({
    index: output.index,
    assetId: output.assetId,
    source: output.path,
    sha256: output.sha256,
    opaqueBounds: bounds,
    gameplayWidth: targetWidth,
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
const directory = resolve(root, "build/evidence/sprite-fusion-candidates");
await mkdir(directory, { recursive: true });
const imagePath = resolve(directory, `${requestName}.png`);
const reportPath = resolve(directory, `${requestName}.json`);
await writeFile(imagePath, png);
await writeFile(
  reportPath,
  `${JSON.stringify({ schemaVersion: 1, requestName, requestId: manifest.requestId, creditsRemaining: manifest.credits?.remaining, columns, rows, cell, imageSha256: sha256(png), records }, null, 2)}\n`,
);
console.log(`sprite-fusion-candidates:${imagePath}:${reportPath}`);
