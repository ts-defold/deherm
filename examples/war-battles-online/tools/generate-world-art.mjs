#!/usr/bin/env node

// Derive the approved SpriteFusion world references without contacting
// SpriteFusion. The source files remain immutable; deterministic local pixel
// motifs provide sharper gameplay silhouettes on the native 16px tile grid.

import { createHash } from "node:crypto";
import { deflateSync, inflateSync } from "node:zlib";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const defaultExampleRoot = path.resolve(here, "..");
const selectionRelativePath = "art/source/sprite-fusion/selection.json";
const sourceRootRelativePath = "art/source/sprite-fusion";
const outputRelativePath = "defold/assets/derived/world/refinery-props.png";
const metadataRelativePath = "defold/assets/derived/world/refinery-props.json";
const cellSize = 16;
const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// The imported refinery details are useful reference material, but their
// 18–23px source canvases become noisy when squeezed into one 16px map tile.
// These compact, hand-authored motifs retain the selected sources as
// provenance while giving each gameplay role a clear silhouette at native
// scale. Colours are sampled from the game's existing tutorial palette.
const motifPalette = {
  o: [44, 40, 57, 255], // outline
  d: [69, 58, 78, 255], // deep shadow
  m: [81, 84, 84, 255], // metal shadow
  s: [115, 132, 133, 255], // steel
  h: [188, 204, 204, 255], // steel highlight
  r: [201, 94, 43, 255], // ember
  f: [252, 187, 102, 255], // hot highlight
  g: [204, 170, 57, 255], // refinery gold
};

const motifs = {
  "pickup-pedestal": [
    "................",
    "................",
    ".....oooooo.....",
    "....ohhhhhho....",
    "...ohhgggghho...",
    "...ohggffggho...",
    "...ohhgggghho...",
    "....ohhhhhho....",
    ".....ommmmo.....",
    "....omssssmo....",
    "...omssssssmo...",
    "...ommmmmmmmo...",
    "....ooddddoo....",
    ".....oooooo.....",
    "................",
    "................",
  ],
  "thermal-vent": [
    "................",
    ".......rr.......",
    "......rffr......",
    ".......rr.......",
    "......ommo......",
    ".....omssmo.....",
    "....omssssmo....",
    "....omssssmo....",
    "....ommmmmmo....",
    "...omssssssmo...",
    "...ommmmmmmmo...",
    "..oommmmmmmmoo..",
    "..oooooooooooo..",
    "...dddddddddd...",
    "................",
    "................",
  ],
  "lava-fissure": [
    "................",
    "................",
    "................",
    ".......o........",
    "......oro.......",
    ".....orfo.......",
    "....orffro......",
    "...odrffro......",
    "....odrffro.....",
    ".....odrro......",
    "......odro.......",
    ".......oo........",
    "................",
    "................",
    "................",
    "................",
  ],
  "floor-vent": [
    "................",
    "................",
    "................",
    "...oooooooooo...",
    "..ommmmmmmmmo...",
    "..omsssssssmo...",
    "..omsssssssmo...",
    "..ommmmmmmmmo...",
    "..omgmgmgmgmo...",
    "..ommmmmmmmmo...",
    "...ooooooooo....",
    "................",
    "......rr........",
    ".....rffr.......",
    "......rr........",
    "................",
  ],
  "pipe-junction": [
    "................",
    "......oooo......",
    ".....ommmmo.....",
    ".....omssmo.....",
    ".....omhhmo.....",
    ".....omssmo.....",
    "..ooooomssmooooo",
    "..omsssssmmmmmmo",
    "..omsssssmmmmmmo",
    "..oooooooooooooo",
    ".....omssmo.....",
    ".....omhhmo.....",
    ".....omssmo.....",
    ".....ommmmo.....",
    "......oooo......",
    "................",
  ],
  "pipe-run": [
    "................",
    "................",
    "................",
    "................",
    "..oooo........oo",
    ".ommmmo......ommm",
    ".omssmooooooomssm",
    ".omshmmmmmmmomshm",
    ".omssmooooooomssm",
    ".ommmmo......ommm",
    "..oooo........oo",
    "................",
    "................",
    "................",
    "................",
    "................",
  ],
};

function drawMotif(role) {
  const rows = motifs[role];
  if (
    !rows ||
    rows.length !== cellSize ||
    rows.some((row) => row.length > cellSize + 2 || [...row].some((glyph) => glyph !== "." && !motifPalette[glyph]))
  ) {
    fail(`${role} has no valid ${cellSize}px authored motif`);
  }
  const pixels = Buffer.alloc(cellSize * cellSize * 4);
  for (let y = 0; y < cellSize; y += 1) {
    for (let x = 0; x < cellSize; x += 1) {
      const rowOffset = Math.floor((rows[y].length - cellSize) / 2);
      const glyph = rows[y][x + rowOffset] ?? ".";
      const color = motifPalette[glyph];
      if (!color) continue;
      pixels.set(color, (y * cellSize + x) * 4);
    }
  }
  return { width: cellSize, height: cellSize, pixels };
}

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function fail(message) {
  throw new Error(`world art validation failed: ${message}`);
}

function paeth(left, above, upperLeft) {
  const estimate = left + above - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const aboveDistance = Math.abs(estimate - above);
  const cornerDistance = Math.abs(estimate - upperLeft);
  if (leftDistance <= aboveDistance && leftDistance <= cornerDistance) return left;
  return aboveDistance <= cornerDistance ? above : upperLeft;
}

/** Decode non-interlaced 8-bit RGB/RGBA source PNGs into one RGBA buffer. */
function decodeRgbaPng(bytes) {
  if (!bytes.subarray(0, 8).equals(signature)) fail("source is not a PNG");
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  const bitDepth = bytes[24];
  const colorType = bytes[25];
  const interlace = bytes[28];
  if (!width || !height || bitDepth !== 8 || (colorType !== 2 && colorType !== 6) || interlace !== 0) {
    fail("source PNG must be non-interlaced 8-bit RGB or RGBA");
  }

  let offset = 8;
  const idat = [];
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    const end = offset + 12 + length;
    if (end > bytes.length) fail("source PNG chunk exceeds file length");
    if (type === "IDAT") idat.push(bytes.subarray(offset + 8, offset + 8 + length));
    offset = end;
    if (type === "IEND") break;
  }
  if (!idat.length) fail("source PNG has no IDAT chunk");

  const encoded = inflateSync(Buffer.concat(idat));
  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  const decoded = Buffer.alloc(stride * height);
  const expectedLength = (stride + 1) * height;
  if (encoded.length !== expectedLength)
    fail(`source PNG scanline length is ${encoded.length}, expected ${expectedLength}`);

  let cursor = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = encoded[cursor++];
    const row = y * stride;
    const previous = row - stride;
    for (let x = 0; x < stride; x += 1) {
      const raw = encoded[cursor++];
      const left = x >= channels ? decoded[row + x - channels] : 0;
      const above = y > 0 ? decoded[previous + x] : 0;
      const upperLeft = y > 0 && x >= channels ? decoded[previous + x - channels] : 0;
      let value;
      if (filter === 0) value = raw;
      else if (filter === 1) value = raw + left;
      else if (filter === 2) value = raw + above;
      else if (filter === 3) value = raw + ((left + above) >> 1);
      else if (filter === 4) value = raw + paeth(left, above, upperLeft);
      else fail(`unsupported PNG filter ${filter}`);
      decoded[row + x] = value & 0xff;
    }
  }
  if (channels === 4) return { width, height, pixels: decoded };
  const pixels = Buffer.alloc(width * height * 4);
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    decoded.copy(pixels, pixel * 4, pixel * 3, pixel * 3 + 3);
    pixels[pixel * 4 + 3] = 255;
  }
  return { width, height, pixels };
}

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function pngChunk(type, body) {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(body.length, 0);
  header.write(type, 4, "ascii");
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([header.subarray(4), body])), 0);
  return Buffer.concat([header, body, checksum]);
}

/** Encode with fixed scanline filters and zlib level so bytes are reproducible. */
function encodeRgbaPng(width, height, pixels) {
  const stride = width * 4;
  if (pixels.length !== stride * height) fail("encoder pixel buffer has the wrong size");
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const outputOffset = y * (stride + 1);
    raw[outputOffset] = 0;
    pixels.copy(raw, outputOffset + 1, y * stride, (y + 1) * stride);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    signature,
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function alphaBounds(image) {
  let minX = image.width;
  let minY = image.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      if (!image.pixels[(y * image.width + x) * 4 + 3]) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  return maxX < 0 ? null : [minX, minY, maxX, maxY];
}

/** Map source pixels to the gameplay grid; never blends neighbouring pixels. */
function normalizeToCell(image) {
  const pixels = Buffer.alloc(cellSize * cellSize * 4);
  for (let y = 0; y < cellSize; y += 1) {
    const sourceY = Math.floor((y * image.height) / cellSize);
    for (let x = 0; x < cellSize; x += 1) {
      const sourceX = Math.floor((x * image.width) / cellSize);
      const sourceOffset = (sourceY * image.width + sourceX) * 4;
      const targetOffset = (y * cellSize + x) * 4;
      image.pixels.copy(pixels, targetOffset, sourceOffset, sourceOffset + 4);
    }
  }
  return { width: cellSize, height: cellSize, pixels };
}

function checkRelativePath(value, label) {
  if (typeof value !== "string" || !value || path.isAbsolute(value) || value.split("/").includes("..")) {
    fail(`${label} is not a safe repository-relative path`);
  }
  return value;
}

async function readJson(root, relativePath, label) {
  const safePath = checkRelativePath(relativePath, label);
  try {
    return {
      value: JSON.parse(await readFile(path.join(root, safePath), "utf8")),
      bytes: await readFile(path.join(root, safePath)),
    };
  } catch (error) {
    fail(`${label} is missing or invalid (${safePath}): ${error.message}`);
  }
}

function assertOutputRecord(manifest, selected, requestName, label) {
  if (!manifest || manifest.schemaVersion !== 1 || !Array.isArray(manifest.outputs))
    fail(`${requestName} request manifest is invalid`);
  const output = manifest.outputs.find((candidate) => candidate?.index === selected.selectedIndex);
  if (!output) fail(`${label} selected index ${selected.selectedIndex} is absent from ${requestName}`);
  if (output.assetId !== selected.assetId) fail(`${label} asset id disagrees with ${requestName} request manifest`);
  if (output.path !== selected.source) fail(`${label} source path disagrees with ${requestName} request manifest`);
  if (typeof output.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(output.sha256))
    fail(`${label} has no valid source hash`);
  return output;
}

async function resolveSelected(root, selected, roles, label) {
  if (!selected || typeof selected.request !== "string") fail(`${label} has no request name`);
  if (!Number.isInteger(selected.selectedIndex) || selected.selectedIndex < 0)
    fail(`${label} has an invalid selected index`);
  if (typeof selected.assetId !== "string" || !selected.assetId) fail(`${label} has no asset id`);
  checkRelativePath(selected.source, `${label}.source`);
  const manifestRelativePath = `${sourceRootRelativePath}/requests/${selected.request}.json`;
  const manifestFile = await readJson(root, manifestRelativePath, `${label} request manifest`);
  if (!manifestFile.value.spec?.path || !/^[a-f0-9]{64}$/u.test(manifestFile.value.spec.sha256 ?? "")) {
    fail(`${label} request manifest has no valid spec hash`);
  }
  const specFile = await readJson(root, manifestFile.value.spec.path, `${label} request spec`);
  if (sha256(specFile.bytes) !== manifestFile.value.spec.sha256)
    fail(`${label} request spec hash does not match its request manifest`);
  if (specFile.value.size !== cellSize) fail(`${label} request spec does not declare a ${cellSize}px output`);
  const output = assertOutputRecord(manifestFile.value, selected, selected.request, label);
  const sourceBytes = await readFile(path.join(root, selected.source)).catch((error) =>
    fail(`${label} source is missing: ${error.message}`),
  );
  const sourceHash = sha256(sourceBytes);
  if (sourceHash !== output.sha256) fail(`${label} source hash does not match its request manifest`);
  const sourceImage = decodeRgbaPng(sourceBytes);
  if (output.width !== sourceImage.width || output.height !== sourceImage.height) {
    fail(`${label} source dimensions disagree with its request manifest`);
  }
  const normalized = normalizeToCell(sourceImage);
  const sourceBounds = alphaBounds(sourceImage);
  const normalizedBounds = alphaBounds(normalized);
  if (!normalizedBounds) fail(`${label} source has no visible pixels`);
  return {
    id: roles ?? selected.disposition,
    role: roles ?? selected.disposition,
    request: selected.request,
    selectedIndex: selected.selectedIndex,
    assetId: selected.assetId,
    source: selected.source,
    sourceSha256: sourceHash,
    requestManifest: manifestRelativePath,
    requestManifestSha256: sha256(manifestFile.bytes),
    requestSpec: manifestFile.value.spec.path,
    requestSpecSha256: sha256(specFile.bytes),
    sourceSize: [sourceImage.width, sourceImage.height],
    sourceBounds,
    normalizedBounds,
    anchor: [8, 8],
    normalized,
  };
}

async function buildWorldArt({ exampleRoot = defaultExampleRoot, check = false } = {}) {
  const selectionFile = await readJson(exampleRoot, selectionRelativePath, "selection");
  const selection = selectionFile.value;
  const selectionProjection = Buffer.from(`${JSON.stringify({ world: selection.world })}\n`);
  if (selection.schemaVersion !== 1 || !selection.world || !selection.runtimePlan)
    fail("selection schema is unsupported");

  const pedestal = await resolveSelected(
    exampleRoot,
    selection.world.pickupPedestal,
    "pickup-pedestal",
    "pickup pedestal",
  );
  const hazardSelection = selection.world.industrialHazards;
  if (!Array.isArray(hazardSelection?.selectedIndices) || !Array.isArray(hazardSelection.roles)) {
    fail("industrial hazard selection is incomplete");
  }
  if (hazardSelection.selectedIndices.length !== hazardSelection.roles.length)
    fail("industrial hazard roles do not match selected indices");
  if (new Set(hazardSelection.selectedIndices).size !== hazardSelection.selectedIndices.length)
    fail("industrial hazard selection contains duplicate indices");
  const hazardManifestRelativePath = `${sourceRootRelativePath}/requests/${hazardSelection.request}.json`;
  const hazardManifestFile = await readJson(exampleRoot, hazardManifestRelativePath, "hazard request manifest");
  const hazards = [];
  for (let index = 0; index < hazardSelection.selectedIndices.length; index += 1) {
    const selectedIndex = hazardSelection.selectedIndices[index];
    const output = hazardManifestFile.value.outputs?.find((candidate) => candidate?.index === selectedIndex);
    if (!output)
      fail(
        `hazard role ${hazardSelection.roles[index]} selected index ${selectedIndex} is absent from ${hazardSelection.request}`,
      );
    hazards.push(
      await resolveSelected(
        exampleRoot,
        {
          request: hazardSelection.request,
          selectedIndex,
          assetId: output.assetId,
          source: output.path,
        },
        hazardSelection.roles[index],
        hazardSelection.roles[index],
      ),
    );
  }

  const props = [pedestal, ...hazards];
  const atlasPixels = Buffer.alloc(props.length * cellSize * cellSize * 4);
  const cellBytes = [];
  for (let index = 0; index < props.length; index += 1) {
    const motif = drawMotif(props[index].role);
    motif.pixels.copy(atlasPixels, index * cellSize * cellSize * 4);
    cellBytes.push(encodeRgbaPng(cellSize, cellSize, motif.pixels));
  }
  const atlasBytes = encodeRgbaPng(props.length * cellSize, cellSize, atlasPixels);
  const atlasSha256 = sha256(atlasBytes);
  const outputProps = props.map((prop, index) => {
    const { normalized: _normalized, ...metadataProp } = prop;
    return {
      ...metadataProp,
      renderMode: "authored-16px-motif",
      cell: [index * cellSize, 0, cellSize, cellSize],
      outputSha256: sha256(cellBytes[index]),
    };
  });
  const metadata = {
    schemaVersion: 1,
    owner: "tools/generate-world-art.mjs",
    cellSize: [cellSize, cellSize],
    sampling: "nearest",
    atlas: {
      path: outputRelativePath,
      width: props.length * cellSize,
      height: cellSize,
      columns: props.length,
      rows: 1,
      bytes: atlasBytes.length,
      sha256: atlasSha256,
    },
    sources: {
      selection: {
        path: selectionRelativePath,
        keys: ["world"],
        projectionSha256: sha256(selectionProjection),
      },
    },
    rendering: {
      method: "hand-authored 16px motifs",
      palette: "sampled tutorial palette",
      reason: "Selected source motifs exceed the 16px logical tile and lose their role silhouettes when reduced.",
    },
    roles: outputProps,
  };
  const metadataBytes = Buffer.from(`${JSON.stringify(metadata, null, 2)}\n`);

  async function emit(relativePath, bytes) {
    const absolute = path.join(exampleRoot, relativePath);
    if (check) {
      const current = await readFile(absolute).catch((error) =>
        fail(`generated output is missing (${relativePath}): ${error.message}`),
      );
      if (!current.equals(bytes)) fail(`generated output is stale: ${relativePath}`);
      return;
    }
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, bytes);
  }
  await emit(outputRelativePath, atlasBytes);
  await emit(metadataRelativePath, metadataBytes);
  return { metadata, atlasBytes, metadataBytes };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--check")) throw new Error("Usage: node tools/generate-world-art.mjs [--check]");
  const result = await buildWorldArt({ check: args.includes("--check") });
  console.log(
    `war-battles-world-art:${args.includes("--check") ? "fresh" : "generated"}:props=${result.metadata.roles.length}:sha256=${result.metadata.atlas.sha256}`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

export { alphaBounds, buildWorldArt, decodeRgbaPng, encodeRgbaPng, normalizeToCell };
