#!/usr/bin/env node
// Split one pinned Sprite Fusion animation into raw frame cutouts and a
// nearest-neighbor registration preview. This reports edge contact; it does
// not infer that a touching source frame is unclipped or production-ready.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { alphaBounds, decodeRgbaPng, encodeRgbaPng } from "./generate-world-art.mjs";

const root = resolve(import.meta.dirname, "..");
const request = process.argv[2];
if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(request ?? "")) {
  throw new Error("Usage: node tools/inspect-sprite-fusion-animation.mjs <request-name>");
}
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const manifest = JSON.parse(await readFile(resolve(root, `art/source/sprite-fusion/requests/${request}.json`), "utf8"));
assert.equal(manifest.operation, "animate");
assert.equal(manifest.outputs?.length, 1);
const output = manifest.outputs[0];
assert.ok(output.spritesheet?.path && output.frameCount > 0);
const sourceBytes = await readFile(resolve(root, output.spritesheet.path));
assert.equal(sha256(sourceBytes), output.spritesheet.sha256, "animation sheet differs from its pinned request");
const source = decodeRgbaPng(sourceBytes);
assert.equal(source.width % output.frameCount, 0, "animation frames do not divide the source sheet");
const frameWidth = source.width / output.frameCount;
const frameHeight = source.height;
// A provider spritesheet may be auto-trimmed right against the silhouette.
// Review cells need their own gutter; this cannot restore missing source pixels.
const cell = Math.max(64, frameWidth + 16, frameHeight + 16);
const zoom = 4;
const previewWidth = output.frameCount * cell * zoom;
const previewHeight = cell * zoom;
const preview = Buffer.alloc(previewWidth * previewHeight * 4);
const presentation = Buffer.alloc(preview.length);
const riskMarker = [255, 94, 72, 255];
for (let index = 0; index < preview.length; index += 4) {
  preview[index] = 29;
  preview[index + 1] = 40;
  preview[index + 2] = 43;
  preview[index + 3] = 255;
  presentation[index] = 53;
  presentation[index + 1] = 105;
  presentation[index + 2] = 60;
  presentation[index + 3] = 255;
}

const outputDir = resolve(root, `build/evidence/sprite-fusion-animation/${request}`);
await mkdir(outputDir, { recursive: true });
const frames = [];
const markSourceEdge = (x, y) => {
  for (let dy = 0; dy < zoom; dy += 1) {
    for (let dx = 0; dx < zoom; dx += 1) {
      const to = ((y * zoom + dy) * previewWidth + x * zoom + dx) * 4;
      for (let channel = 0; channel < 4; channel += 1) presentation[to + channel] = riskMarker[channel];
    }
  }
};
for (let frame = 0; frame < output.frameCount; frame += 1) {
  const pixels = Buffer.alloc(frameWidth * frameHeight * 4);
  for (let y = 0; y < frameHeight; y += 1) {
    source.pixels.copy(
      pixels,
      y * frameWidth * 4,
      (y * source.width + frame * frameWidth) * 4,
      (y * source.width + (frame + 1) * frameWidth) * 4,
    );
  }
  // Transparent RGB from animated WebP may retain a green matte. Canonical
  // cutouts clear invisible color so previews cannot show a false green halo.
  for (let index = 0; index < pixels.length; index += 4) {
    if (pixels[index + 3] === 0) pixels.fill(0, index, index + 3);
  }
  const image = { width: frameWidth, height: frameHeight, pixels };
  const bounds = alphaBounds(image);
  assert.ok(bounds, `animation frame ${frame} is empty`);
  const framePng = encodeRgbaPng(frameWidth, frameHeight, pixels);
  const framePath = resolve(outputDir, `frame-${frame + 1}.png`);
  await writeFile(framePath, framePng);
  const xOrigin = frame * cell + Math.floor((cell - frameWidth) / 2);
  const yOrigin = cell - 8 - (bounds[3] + 1);
  const registeredBounds = [
    xOrigin - frame * cell + bounds[0],
    yOrigin + bounds[1],
    xOrigin - frame * cell + bounds[2],
    yOrigin + bounds[3],
  ];
  assert.ok(
    registeredBounds[0] >= 8 &&
      registeredBounds[1] >= 8 &&
      registeredBounds[2] < cell - 8 &&
      registeredBounds[3] < cell - 8,
    `animation frame ${frame} has insufficient review gutter`,
  );
  const edgeContacts = {
    left: bounds[0] === 0,
    top: bounds[1] === 0,
    right: bounds[2] === frameWidth - 1,
    bottom: bounds[3] === frameHeight - 1,
  };
  for (let y = 0; y < frameHeight; y += 1) {
    for (let x = 0; x < frameWidth; x += 1) {
      const from = (y * frameWidth + x) * 4;
      const alpha = pixels[from + 3];
      if (alpha === 0) continue;
      const red = Math.round((pixels[from] * alpha + 29 * (255 - alpha)) / 255);
      const green = Math.round((pixels[from + 1] * alpha + 40 * (255 - alpha)) / 255);
      const blue = Math.round((pixels[from + 2] * alpha + 43 * (255 - alpha)) / 255);
      for (let dy = 0; dy < zoom; dy += 1) {
        for (let dx = 0; dx < zoom; dx += 1) {
          const to = ((yOrigin * zoom + y * zoom + dy) * previewWidth + (xOrigin + x) * zoom + dx) * 4;
          preview[to] = red;
          preview[to + 1] = green;
          preview[to + 2] = blue;
          preview[to + 3] = 255;
          presentation[to] = Math.round((pixels[from] * alpha + 53 * (255 - alpha)) / 255);
          presentation[to + 1] = Math.round((pixels[from + 1] * alpha + 105 * (255 - alpha)) / 255);
          presentation[to + 2] = Math.round((pixels[from + 2] * alpha + 60 * (255 - alpha)) / 255);
          presentation[to + 3] = 255;
        }
      }
    }
  }
  // The green review gutter is added *after* Sprite Fusion returned the
  // animation. Mark the original cell edges that contain opaque pixels so
  // the padded screenshot cannot be mistaken for unclipped source art.
  if (edgeContacts.left) for (let y = yOrigin; y < yOrigin + frameHeight; y += 1) markSourceEdge(xOrigin - 2, y);
  if (edgeContacts.right)
    for (let y = yOrigin; y < yOrigin + frameHeight; y += 1) markSourceEdge(xOrigin + frameWidth + 1, y);
  if (edgeContacts.top) for (let x = xOrigin; x < xOrigin + frameWidth; x += 1) markSourceEdge(x, yOrigin - 2);
  if (edgeContacts.bottom)
    for (let x = xOrigin; x < xOrigin + frameWidth; x += 1) markSourceEdge(x, yOrigin + frameHeight + 1);
  frames.push({
    index: frame,
    path: framePath,
    sha256: sha256(framePng),
    canvas: [frameWidth, frameHeight],
    opaqueBounds: bounds,
    registeredBounds,
    edgeContacts,
  });
}
const previewPng = encodeRgbaPng(previewWidth, previewHeight, preview);
const previewPath = resolve(outputDir, "registration-preview.png");
const presentationPng = encodeRgbaPng(previewWidth, previewHeight, presentation);
const presentationPath = resolve(outputDir, "presentation-preview.png");
const reportPath = resolve(outputDir, "inspection.json");
await writeFile(previewPath, previewPng);
await writeFile(presentationPath, presentationPng);
await writeFile(
  reportPath,
  `${JSON.stringify({ schemaVersion: 3, request, spritesheetSha256: output.spritesheet.sha256, frameCount: output.frameCount, fps: output.fps, reviewCellPixels: cell, reviewGutterPixels: 8, paddingOnly: true, sourceEdgeMarker: riskMarker, sourceEdgeContactFrames: frames.filter(({ edgeContacts }) => Object.values(edgeContacts).some(Boolean)).map(({ index }) => index), previewPath, previewSha256: sha256(previewPng), presentationPath, presentationSha256: sha256(presentationPng), frames }, null, 2)}\n`,
);
console.log(`sprite-fusion-animation-inspection:${reportPath}:${previewPath}:${presentationPath}`);
