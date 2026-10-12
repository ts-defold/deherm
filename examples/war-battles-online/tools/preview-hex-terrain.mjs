#!/usr/bin/env node
// Pre-integration art-direction preview. Not runtime evidence.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { decodeRgbaPng, encodeRgbaPng } from "./generate-world-art.mjs";
import { hexGroundPixel } from "./generate-hex-terrain.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = decodeRgbaPng(
  readFileSync(resolve(root, "art/source/sprite-fusion/outputs/frontier-hex-meadow-v1/00.png")),
);

const width = 960,
  height = 540,
  pixels = Buffer.alloc(width * height * 4);
for (let y = 0; y < height; y++)
  for (let x = 0; x < width; x++) {
    const u = x * Math.SQRT2,
      v = -y * 2 * Math.SQRT2;
    pixels.set(hexGroundPixel(source, (u + v) / 2, (v - u) / 2), (y * width + x) * 4);
  }
function stamp(name, cx, cy) {
  const image = decodeRgbaPng(readFileSync(resolve(root, `defold/assets/derived/arena/${name}.png`)));
  for (let y = 0; y < image.height; y++)
    for (let x = 0; x < image.width; x++) {
      const i = (y * image.width + x) * 4,
        tx = Math.round(cx - image.width / 2 + x),
        ty = Math.round(cy - image.height / 2 + y);
      if (tx < 0 || ty < 0 || tx >= width || ty >= height) continue;
      const a = image.pixels[i + 3] / 255,
        o = (ty * width + tx) * 4;
      for (let c = 0; c < 3; c++) pixels[o + c] = Math.round(image.pixels[i + c] * a + pixels[o + c] * (1 - a));
    }
}
stamp("landmark-field-bunker", 690, 145);
stamp("landmark-rock-outcrop", 190, 310);
stamp("tank-depot", 800, 410);
for (const [team, x, y] of [
  ["blue", 450, 290],
  ["red", 650, 370],
  ["sand", 300, 140],
  ["green", 780, 270],
]) {
  stamp(`tank-${team}-hull-se-1`, x, y);
  stamp(`tank-${team}-turret-se`, x, y);
}
writeFileSync(process.argv[2] ?? "/private/tmp/war-hex-proposal.png", encodeRgbaPng(width, height, pixels));
