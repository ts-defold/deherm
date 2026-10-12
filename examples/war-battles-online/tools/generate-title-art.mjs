#!/usr/bin/env node

// Keep the authored title background separate from the 1280x720 runtime PNG.
// The source is immutable; one nearest-neighbour projection owns every pixel
// Bob places behind the game's title/logo/UI nodes.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { decodeRgbaPng, encodeRgbaPng } from "./generate-world-art.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(resolve(root, "art/source/imagegen/title-hex-frontier-v4.json"), "utf8"));
const outputPath = resolve(root, "defold/assets/ui/title-screen/background.png");
const width = 1280;
const height = 720;

export function buildTitleBackground() {
  if (manifest.schemaVersion !== 1) throw new Error("unsupported title-art source manifest");
  const bytes = readFileSync(resolve(root, manifest.path));
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== manifest.sha256) throw new Error("title-art source checksum mismatch");
  const source = decodeRgbaPng(bytes);
  if (source.width !== manifest.width || source.height !== manifest.height) {
    throw new Error("title-art source dimensions changed");
  }
  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    const fromY = Math.min(source.height - 1, Math.floor(((y + 0.5) * source.height) / height));
    for (let x = 0; x < width; x++) {
      const fromX = Math.min(source.width - 1, Math.floor(((x + 0.5) * source.width) / width));
      const from = (fromY * source.width + fromX) * 4;
      const to = (y * width + x) * 4;
      pixels[to] = source.pixels[from];
      pixels[to + 1] = source.pixels[from + 1];
      pixels[to + 2] = source.pixels[from + 2];
      pixels[to + 3] = source.pixels[from + 3];
    }
  }
  return encodeRgbaPng(width, height, pixels);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const output = buildTitleBackground();
  if (process.argv.includes("--check")) {
    if (!readFileSync(outputPath).equals(output)) throw new Error("title-art runtime background is stale");
    console.log("title-art:fresh");
  } else {
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, output);
    console.log("title-art:generated");
  }
}
