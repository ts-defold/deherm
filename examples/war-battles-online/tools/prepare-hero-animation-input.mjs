#!/usr/bin/env node
// Give a pinned Sprite Fusion pose room to move before asking it to animate.
// This only adds transparent canvas; it cannot reconstruct pixels missing
// from the selected still image.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { alphaBounds, decodeRgbaPng, encodeRgbaPng } from "./generate-world-art.mjs";

const root = resolve(import.meta.dirname, "..");
const name = process.argv[2];
const index = Number(process.argv[3]);
const check = process.argv[4] === "--check";
if (
  !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name ?? "") ||
  !Number.isInteger(index) ||
  index < 0 ||
  (process.argv.length > 4 && !check) ||
  process.argv.length > 5
) {
  throw new Error("Usage: node tools/prepare-hero-animation-input.mjs <pose-request> <output-index> [--check]");
}
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const manifest = JSON.parse(await readFile(resolve(root, `art/source/sprite-fusion/requests/${name}.json`), "utf8"));
assert.equal(manifest.operation, "edit", "only a selected action-ready pose can be padded for animation");
const output = manifest.outputs.find((candidate) => candidate.index === index);
assert.ok(output?.path && output?.sha256, `missing pinned pose ${name}/${index}`);
const sourceBytes = await readFile(resolve(root, output.path));
assert.equal(sha256(sourceBytes), output.sha256, "selected pose differs from its pinned request");
const source = decodeRgbaPng(sourceBytes);
const sourceBounds = alphaBounds(source);
assert.ok(sourceBounds, "selected pose is empty");
// Pick the smallest supported source canvas that leaves room for the whole
// selected pose. Some front-facing poses are taller than the 64 px source
// that suffices for side views; scaling them down before animation would lose
// pixel detail and still would not recover any cropped source pixels.
const canvas = [64, 80, 96, 112, 128].find((size) => source.width <= size - 16 && source.height <= size - 16);
assert.ok(canvas, "pose has insufficient canvas room");
const footRow = canvas - 8;
const originX = Math.floor((canvas - source.width) / 2);
const originY = footRow - 1 - sourceBounds[3];
assert.ok(originY >= 8 && originY + source.height <= canvas - 8, "pose has insufficient vertical room");
const pixels = Buffer.alloc(canvas * canvas * 4);
for (let y = 0; y < source.height; y += 1) {
  source.pixels.copy(pixels, ((originY + y) * canvas + originX) * 4, y * source.width * 4, (y + 1) * source.width * 4);
}
const padded = { width: canvas, height: canvas, pixels };
const bounds = alphaBounds(padded);
assert.ok(bounds && bounds[0] >= 8 && bounds[1] >= 8 && bounds[2] < canvas - 8 && bounds[3] < canvas - 8);
const png = encodeRgbaPng(canvas, canvas, pixels);
const outputDir = resolve(root, "art/source/sprite-fusion/inputs");
const basename = `${name}-${index}-padded-${canvas}`;
const metadata = `${JSON.stringify({ schemaVersion: 1, sourceRequest: name, outputIndex: index, sourceSha256: output.sha256, canvas, footRow, sourceBounds, paddedBounds: bounds, sha256: sha256(png) }, null, 2)}\n`;
if (check) {
  assert.deepEqual(await readFile(resolve(outputDir, `${basename}.png`)), png, "padded pose PNG is stale");
  assert.equal(
    await readFile(resolve(outputDir, `${basename}.json`), "utf8"),
    metadata,
    "padded pose manifest is stale",
  );
} else {
  await mkdir(outputDir, { recursive: true });
  await writeFile(resolve(outputDir, `${basename}.png`), png);
  await writeFile(resolve(outputDir, `${basename}.json`), metadata);
}
console.log(`hero-animation-input:${basename}:bounds=${bounds.join(",")}`);
