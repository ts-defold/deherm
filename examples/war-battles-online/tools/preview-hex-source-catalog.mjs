#!/usr/bin/env node
// All accepted Sprite Fusion hex sources in one deterministic review sheet.
// The runtime art still comes only from the owning terrain/art generators.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { alphaBounds, decodeRgbaPng, encodeRgbaPng } from "./generate-world-art.mjs";
import { HEX_TILE_SELECTION_PATH, loadHexFamilySources, readHexSourceSelection } from "./hex-source-selection.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { selection, sha256: selectionSha256 } = readHexSourceSelection(root);
const families = Object.entries(selection.families).map(([role]) => ({
  role,
  sources: loadHexFamilySources(root, selection, role, decodeRgbaPng),
}));
const cell = 68;
const margin = 8;
const imageSize = 62;
const width = margin * 2 + Math.max(...families.map(({ sources }) => sources.length)) * cell;
const height = margin * 2 + families.length * cell;
const pixels = Buffer.alloc(width * height * 4);
const background = [25, 27, 32];
for (let offset = 0; offset < pixels.length; offset += 4) {
  pixels[offset] = background[0];
  pixels[offset + 1] = background[1];
  pixels[offset + 2] = background[2];
  pixels[offset + 3] = 255;
}

const entries = [];
for (const [row, { role, sources }] of families.entries()) {
  for (const [column, source] of sources.entries()) {
    const bounds = alphaBounds(source.image);
    if (!bounds) throw new Error(`empty selected hex source: ${source.path}`);
    const [left, top, right, bottom] = bounds;
    const sourceWidth = right - left + 1;
    const sourceHeight = bottom - top + 1;
    const scale = Math.min(imageSize / sourceWidth, imageSize / sourceHeight);
    const drawnWidth = Math.max(1, Math.floor(sourceWidth * scale));
    const drawnHeight = Math.max(1, Math.floor(sourceHeight * scale));
    const boxX = margin + column * cell;
    const boxY = margin + row * cell;
    const startX = boxX + Math.floor((cell - drawnWidth) / 2);
    const startY = boxY + Math.floor((cell - drawnHeight) / 2);
    for (let y = 0; y < drawnHeight; y++) {
      const sourceY = top + Math.min(sourceHeight - 1, Math.floor((y * sourceHeight) / drawnHeight));
      for (let x = 0; x < drawnWidth; x++) {
        const sourceX = left + Math.min(sourceWidth - 1, Math.floor((x * sourceWidth) / drawnWidth));
        const from = (sourceY * source.image.width + sourceX) * 4;
        const to = ((startY + y) * width + startX + x) * 4;
        const alpha = source.image.pixels[from + 3] / 255;
        for (let channel = 0; channel < 3; channel++) {
          pixels[to + channel] = Math.round(
            source.image.pixels[from + channel] * alpha + background[channel] * (1 - alpha),
          );
        }
      }
    }
    entries.push({
      role,
      row,
      column,
      request: source.request,
      index: source.index,
      path: source.path,
      sha256: source.sha256,
    });
  }
}

const output = "art/preview/hex-source-catalog-v2.png";
const manifestPath = "art/preview/hex-source-catalog-v2.json";
const png = encodeRgbaPng(width, height, pixels);
const manifest = Buffer.from(
  `${JSON.stringify(
    {
      schemaVersion: 1,
      owner: "tools/preview-hex-source-catalog.mjs",
      selection: HEX_TILE_SELECTION_PATH,
      selectionSha256,
      output,
      outputSha256: createHash("sha256").update(png).digest("hex"),
      width,
      height,
      cell,
      margin,
      families: families.map(({ role, sources }) => ({ role, count: sources.length })),
      entries,
    },
    null,
    2,
  )}\n`,
);
if (process.argv.includes("--check")) {
  if (!readFileSync(resolve(root, output)).equals(png) || !readFileSync(resolve(root, manifestPath)).equals(manifest)) {
    throw new Error("hex source catalog is stale; run pnpm hex:catalog");
  }
} else {
  mkdirSync(dirname(resolve(root, output)), { recursive: true });
  writeFileSync(resolve(root, output), png);
  writeFileSync(resolve(root, manifestPath), manifest);
}
console.log(
  `hex-source-catalog:${process.argv.includes("--check") ? "fresh" : "ok"}:${entries.length} sources:${output}`,
);
