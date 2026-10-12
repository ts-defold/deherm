#!/usr/bin/env node
// Deterministic composition study for source hex art, not a gameplay asset.
// It exposes mismatched footprints, edge gaps and style drift before import.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { alphaBounds, decodeRgbaPng, encodeRgbaPng } from "./generate-world-art.mjs";
import { HEX_MACRO_CELLS, hexVisualRole } from "./generate-hex-terrain.mjs";
import { HEX_TILE_SELECTION_PATH, loadHexFamilySources, readHexSourceSelection } from "./hex-source-selection.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { selection } = readHexSourceSelection(root);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const hash32 = (x, y, seed) => {
  let v = Math.imul(x ^ seed, 0x9e3779b1) ^ Math.imul(y ^ (seed >>> 3), 0x85ebca6b);
  v = Math.imul(v ^ (v >>> 16), 0x7feb352d);
  return (v ^ (v >>> 15)) >>> 0;
};
const seed = 0x51a7;
const tiles = {};
for (const role of Object.keys(selection.families)) {
  tiles[role] = loadHexFamilySources(root, selection, role, decodeRgbaPng).map((source) => {
    const bounds = alphaBounds(source.image);
    if (!bounds) throw new Error(`empty Sprite Fusion source: ${source.path}`);
    return { ...source, bounds };
  });
}

const width = 640;
const height = 450;
const pixels = Buffer.alloc(width * height * 4);
for (let i = 0; i < width * height; i++) {
  pixels[i * 4] = 22;
  pixels[i * 4 + 1] = 23;
  pixels[i * 4 + 2] = 28;
  pixels[i * 4 + 3] = 255;
}
function draw(image, centerX, centerY) {
  const [minX, minY, maxX, maxY] = image.bounds;
  const source = image.image;
  const boxWidth = maxX - minX + 1;
  const boxHeight = maxY - minY + 1;
  // Normalize each generated variant to one 52x48 silhouette, nearest pixel.
  for (let y = 0; y < 48; y++) {
    const sy = minY + Math.min(boxHeight - 1, Math.floor((y * boxHeight) / 48));
    const dy = centerY + y - 24;
    if (dy < 0 || dy >= height) continue;
    for (let x = 0; x < 52; x++) {
      const sx = minX + Math.min(boxWidth - 1, Math.floor((x * boxWidth) / 52));
      const dx = centerX + x - 26;
      if (dx < 0 || dx >= width) continue;
      const s = (sy * source.width + sx) * 4;
      const alpha = source.pixels[s + 3] / 255;
      if (!alpha) continue;
      const d = (dy * width + dx) * 4;
      for (let c = 0; c < 3; c++)
        pixels[d + c] = Math.round(source.pixels[s + c] * alpha + pixels[d + c] * (1 - alpha));
    }
  }
}

const cells = [];
for (let r = 0; r < HEX_MACRO_CELLS; r++) {
  for (let q = 0; q < HEX_MACRO_CELLS; q++) {
    const role = hexVisualRole(q, r);
    const variants = tiles[role];
    const variant = variants[hash32(q, r, seed) % variants.length];
    // Top faces overlap slightly; cliff faces are painted back-to-front.
    cells.push({ q, r, role, variant, x: 75 + q * 42, y: 58 + r * 27 + (q & 1) * 13 });
  }
}
cells.sort((a, b) => a.y - b.y || a.x - b.x);
for (const cell of cells) draw(cell.variant, cell.x, cell.y);
const output = "art/preview/hex-source-composition-v1.png";
const outputBytes = encodeRgbaPng(width, height, pixels);
const manifest = {
  schemaVersion: 1,
  owner: "tools/preview-sprite-fusion-hex-world.mjs",
  purpose: "art-direction composition study; not a runtime terrain asset",
  selection: HEX_TILE_SELECTION_PATH,
  seed,
  output,
  sha256: sha256(outputBytes),
  cells: cells.map(({ q, r, role, variant }) => ({
    q,
    r,
    role,
    request: variant.request,
    index: variant.index,
    path: variant.path,
    sha256: variant.sha256,
  })),
};
const manifestPath = "art/preview/hex-source-composition-v1.json";
const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
if (process.argv.includes("--check")) {
  if (
    !readFileSync(resolve(root, output)).equals(outputBytes) ||
    !readFileSync(resolve(root, manifestPath)).equals(manifestBytes)
  ) {
    throw new Error("hex source composition is stale; run pnpm hex:preview");
  }
} else {
  mkdirSync(dirname(resolve(root, output)), { recursive: true });
  writeFileSync(resolve(root, output), outputBytes);
  writeFileSync(resolve(root, manifestPath), manifestBytes);
}
console.log(
  `hex-source-composition:${process.argv.includes("--check") ? "fresh" : "ok"}:${cells.length} cells:${output}`,
);
