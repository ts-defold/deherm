#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync, inflateSync } from "node:zlib";

const exampleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const selectionPath = path.join(exampleRoot, "art/source/sprite-fusion/selection.json");
const animationManifestPath = path.join(
  exampleRoot,
  "art/source/sprite-fusion/requests/driver-portrait-radio-idle-v1.json",
);
const metadataPath = path.join(exampleRoot, "defold/assets/derived/ui/driver-portrait.json");
const atlasPath = path.join(exampleRoot, "defold/main/war-battles-hud.atlas");
const check = process.argv.includes("--check");
const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function paeth(left, above, upperLeft) {
  const estimate = left + above - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const aboveDistance = Math.abs(estimate - above);
  const cornerDistance = Math.abs(estimate - upperLeft);
  if (leftDistance <= aboveDistance && leftDistance <= cornerDistance) return left;
  return aboveDistance <= cornerDistance ? above : upperLeft;
}

function decodeRgbaPng(bytes) {
  if (!bytes.subarray(0, 8).equals(signature)) throw new Error("HUD source is not a PNG");
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (bytes[24] !== 8 || bytes[25] !== 6 || bytes[28] !== 0) {
    throw new Error("HUD source must be non-interlaced 8-bit RGBA PNG");
  }
  let offset = 8;
  const idat = [];
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    if (type === "IDAT") idat.push(bytes.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
    if (type === "IEND") break;
  }
  const encoded = inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const pixels = Buffer.alloc(stride * height);
  let cursor = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = encoded[cursor++];
    const row = y * stride;
    const previous = row - stride;
    for (let x = 0; x < stride; x += 1) {
      const raw = encoded[cursor++];
      const left = x >= 4 ? pixels[row + x - 4] : 0;
      const above = y > 0 ? pixels[previous + x] : 0;
      const upperLeft = y > 0 && x >= 4 ? pixels[previous + x - 4] : 0;
      let value;
      if (filter === 0) value = raw;
      else if (filter === 1) value = raw + left;
      else if (filter === 2) value = raw + above;
      else if (filter === 3) value = raw + ((left + above) >> 1);
      else if (filter === 4) value = raw + paeth(left, above, upperLeft);
      else throw new Error(`Unsupported PNG filter ${filter}`);
      pixels[row + x] = value & 0xff;
    }
  }
  return { width, height, pixels };
}

function chunk(type, body) {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(body.length, 0);
  header.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([header.subarray(4), body])), 0);
  return Buffer.concat([header, body, crc]);
}

function encodeRgbaPng(width, height, pixels) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const output = y * (stride + 1);
    raw[output] = 0;
    pixels.copy(raw, output + 1, y * stride, (y + 1) * stride);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    signature,
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function extractFrame(sheet, index, frameWidth, frameHeight, padding) {
  const cellWidth = frameWidth + padding * 2;
  const cellHeight = frameHeight + padding * 2;
  const pixels = Buffer.alloc(cellWidth * cellHeight * 4);
  const sourceX = index * frameWidth;
  for (let y = 0; y < frameHeight; y += 1) {
    const sourceOffset = (y * sheet.width + sourceX) * 4;
    const outputOffset = ((y + padding) * cellWidth + padding) * 4;
    sheet.pixels.copy(pixels, outputOffset, sourceOffset, sourceOffset + frameWidth * 4);
  }
  return { width: cellWidth, height: cellHeight, pixels };
}

function edgeContact(sheet, index, frameWidth, frameHeight) {
  const sourceX = index * frameWidth;
  const counts = { top: 0, right: 0, bottom: 0, left: 0 };
  const alpha = (x, y) => sheet.pixels[(y * sheet.width + sourceX + x) * 4 + 3];
  for (let x = 0; x < frameWidth; x += 1) {
    if (alpha(x, 0)) counts.top += 1;
    if (alpha(x, frameHeight - 1)) counts.bottom += 1;
  }
  for (let y = 0; y < frameHeight; y += 1) {
    if (alpha(0, y)) counts.left += 1;
    if (alpha(frameWidth - 1, y)) counts.right += 1;
  }
  return counts;
}

async function emit(relativePath, bytes) {
  const absolute = path.join(exampleRoot, relativePath);
  if (check) {
    const current = await readFile(absolute);
    if (!current.equals(bytes)) throw new Error(`Generated HUD art is stale: ${relativePath}`);
    return;
  }
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, bytes);
}

const selection = JSON.parse(await readFile(selectionPath, "utf8"));
const selectionProjection = Buffer.from(
  `${JSON.stringify({ portrait: selection.portrait, runtimePlan: selection.runtimePlan })}\n`,
);
const animationManifest = JSON.parse(await readFile(animationManifestPath, "utf8"));
const animation = animationManifest.outputs[0];
if (!animation?.spritesheet?.path || animation.frameCount !== 8) {
  throw new Error("Selected SpriteFusion portrait animation must expose an eight-frame spritesheet");
}
const sheetBytes = await readFile(path.join(exampleRoot, animation.spritesheet.path));
const sheet = decodeRgbaPng(sheetBytes);
const [frameWidth, frameHeight] = selection.runtimePlan.nativeSize;
const padding = selection.runtimePlan.padding;
if (sheet.width !== frameWidth * animation.frameCount || sheet.height !== frameHeight) {
  throw new Error(`Unexpected SpriteFusion portrait sheet dimensions: ${sheet.width}x${sheet.height}`);
}

const frames = [];
for (let index = 0; index < animation.frameCount; index += 1) {
  const frame = extractFrame(sheet, index, frameWidth, frameHeight, padding);
  const bytes = encodeRgbaPng(frame.width, frame.height, frame.pixels);
  const relativePath = `defold/assets/derived/ui/driver-portrait/radio-idle-${String(index).padStart(2, "0")}.png`;
  await emit(relativePath, bytes);
  frames.push({
    index,
    sourceRect: [index * frameWidth, 0, frameWidth, frameHeight],
    cell: [0, 0, frame.width, frame.height],
    anchor: [selection.runtimePlan.anchor[0] + padding, selection.runtimePlan.anchor[1] + padding],
    edgeContact: edgeContact(sheet, index, frameWidth, frameHeight),
    path: relativePath,
    bytes: bytes.length,
    sha256: sha256(bytes),
  });
}

const baseBytes = await readFile(path.join(exampleRoot, selection.portrait.source));
const base = decodeRgbaPng(baseBytes);
const paddedBase = extractFrame(base, 0, frameWidth, frameHeight, padding);
const paddedBaseBytes = encodeRgbaPng(paddedBase.width, paddedBase.height, paddedBase.pixels);
const basePath = "defold/assets/derived/ui/driver-portrait/base.png";
await emit(basePath, paddedBaseBytes);

const metadata = {
  schemaVersion: 1,
  owner: "tools/generate-hud-art.mjs",
  sources: {
    selection: {
      path: path.relative(exampleRoot, selectionPath).replaceAll(path.sep, "/"),
      keys: ["portrait", "runtimePlan"],
      projectionSha256: sha256(selectionProjection),
    },
    animation: {
      path: path.relative(exampleRoot, animationManifestPath).replaceAll(path.sep, "/"),
      requestId: animationManifest.requestId,
      assetId: animation.assetId,
      spritesheetSha256: animation.spritesheet.sha256,
    },
  },
  nativeSize: selection.runtimePlan.nativeSize,
  atlasCellSize: selection.runtimePlan.atlasCellSize,
  padding,
  sampling: selection.runtimePlan.sampling,
  pixelGridCorrection: {
    applied: false,
    reason: "SpriteFusion supplied exact 64x64 non-interlaced RGBA frames on the native pixel grid.",
  },
  base: {
    path: basePath,
    anchor: [selection.runtimePlan.anchor[0] + padding, selection.runtimePlan.anchor[1] + padding],
    bytes: paddedBaseBytes.length,
    sha256: sha256(paddedBaseBytes),
  },
  animations: {
    "radio-idle": {
      fps: animation.fps,
      playback: "loop-forward",
      frames,
    },
  },
};
await emit(
  path.relative(exampleRoot, metadataPath).replaceAll(path.sep, "/"),
  Buffer.from(`${JSON.stringify(metadata, null, 2)}\n`),
);

const atlas = [
  "# Generated by tools/generate-hud-art.mjs. Do not edit.",
  "animations {",
  '  id: "driver-portrait-base"',
  "  images {",
  '    image: "/assets/derived/ui/driver-portrait/base.png"',
  "  }",
  "  playback: PLAYBACK_NONE",
  "}",
  "animations {",
  '  id: "driver-portrait-radio-idle"',
  ...frames.flatMap((frame) => [
    "  images {",
    `    image: "/assets/derived/ui/driver-portrait/${path.basename(frame.path)}"`,
    "  }",
  ]),
  "  playback: PLAYBACK_LOOP_FORWARD",
  `  fps: ${animation.fps}`,
  "}",
  "extrude_borders: 2",
  "",
].join("\n");
await emit(path.relative(exampleRoot, atlasPath).replaceAll(path.sep, "/"), Buffer.from(atlas));

console.log(`war-battles-hud-art:${check ? "fresh" : "generated"}:frames=${frames.length}`);
