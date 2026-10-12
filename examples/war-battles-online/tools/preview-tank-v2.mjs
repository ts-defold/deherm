#!/usr/bin/env node

// Source QA only. Runtime assets remain owned by generate-art.mjs.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { decodeRgbaPng, encodeRgbaPng, alphaBounds } from "./generate-world-art.mjs";
import { paintTankArmor } from "./tank-livery.mjs";
import { tankLayerPlacement } from "./tank-registration.mjs";

const root = resolve(import.meta.dirname, "..");
const archivedArtilleryHull = process.argv.includes("--artillery-hull-v1");
let alternateArtilleryHullRequest = archivedArtilleryHull ? "artillery-hull-directions-v1" : null;
let outputDirectory = resolve(root, "art/preview");
for (let index = 2; index < process.argv.length; index += 1) {
  const argument = process.argv[index];
  if (argument === "--artillery-hull-v1") continue;
  if (argument === "--artillery-hull-request" && process.argv[index + 1]) {
    if (archivedArtilleryHull) throw new Error("choose one alternate Artillery hull request");
    alternateArtilleryHullRequest = process.argv[++index];
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(alternateArtilleryHullRequest)) {
      throw new Error("alternate Artillery hull request must be lowercase kebab-case");
    }
    continue;
  }
  if (argument === "--output-dir" && process.argv[index + 1]) {
    outputDirectory = resolve(process.argv[++index]);
    continue;
  }
  throw new Error(
    "Usage: node tools/preview-tank-v2.mjs [--artillery-hull-v1 | --artillery-hull-request NAME] [--output-dir DIRECTORY]",
  );
}
const suffix = alternateArtilleryHullRequest
  ? archivedArtilleryHull
    ? "-artillery-hull-v1"
    : `-${alternateArtilleryHullRequest}`
  : "";
const output = resolve(outputDirectory, `tank-v2-candidate-sheet${suffix}.png`);
mkdirSync(outputDirectory, { recursive: true });
const chassis = ["scout", "assault", "bulwark", "artillery"];
const directions = ["se", "s", "sw", "w", "e", "nw", "n", "ne"];
const selection = JSON.parse(readFileSync(resolve(root, "art/source/sprite-fusion/tank-selection-v2.json"), "utf8"));
if (alternateArtilleryHullRequest) {
  selection.chassis.artillery.hullRequest = alternateArtilleryHullRequest;
  // A candidate source has no measured mounts until its own registration is
  // declared; never apply the selected source's anchors to another request.
  delete selection.chassis.artillery.mountRegistration;
}
const sourceIndex = directions.map((direction) => selection.sourceDirectionOrder.indexOf(direction));
if (sourceIndex.some((index) => index < 0)) throw new Error("tank source selection lacks a compass direction");
const cell = archivedArtilleryHull ? 192 : 160;
const width = directions.length * cell;
const height = chassis.length * cell;
const pixels = Buffer.alloc(width * height * 4);
const report = {
  schemaVersion: 1,
  owner: "tools/preview-tank-v2.mjs",
  candidate: suffix || "selected",
  directions,
  chassis: [],
};

function pixel(x, y, rgba) {
  const offset = (y * width + x) * 4;
  pixels[offset] = rgba[0];
  pixels[offset + 1] = rgba[1];
  pixels[offset + 2] = rgba[2];
  pixels[offset + 3] = rgba[3];
}

function readSource(name, index) {
  const manifest = JSON.parse(readFileSync(resolve(root, `art/source/sprite-fusion/requests/${name}.json`), "utf8"));
  const entry = manifest.outputs?.find((candidate) => candidate.index === index);
  if (!entry) throw new Error(`${name} lacks direction ${index}`);
  const bytes = readFileSync(resolve(root, entry.path));
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== entry.sha256) throw new Error(`${name} source changed at direction ${index}`);
  const image = decodeRgbaPng(bytes);
  if (image.width > 96 || image.height > 96) throw new Error(`${name} exceeds the 96px preview stage`);
  const bounds = alphaBounds(image);
  const edgeContact = bounds[0] < 1 || bounds[1] < 1 || bounds[2] > image.width - 2 || bounds[3] > image.height - 2;
  return { image, bounds, edgeContact, sha256: digest, assetId: entry.assetId };
}

function opaqueCenter(bounds) {
  return [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2];
}

function layerOrigin(image, selected, layerName, direction, originX, originY, stage) {
  const scale = layerName === "turret" ? selected.turretScale : 1;
  const width = Math.ceil(image.width * 2 * scale);
  const height = Math.ceil(image.height * 2 * scale);
  const placement = tankLayerPlacement(selected, layerName, direction, image.width, image.height);
  const centeredX = Math.floor((128 - placement.width) / 2);
  const centeredY = Math.floor((128 - placement.height) / 2);
  return {
    left: originX + Math.floor((stage - width) / 2) + 2 * (placement.x - centeredX),
    top: originY + Math.floor((stage - height) / 2) + 2 * (placement.y - centeredY),
    width,
    height,
  };
}

// Three rows per chassis: hull, turret, and their same-facing composite.
// The crosshair marks canvas centre; declared mounting coordinates, when
// present, are projected by the same placement helper as production art.
function writeRegistrationSheet(kind, selected) {
  const stage = cell;
  const sheetWidth = directions.length * stage;
  const sheetHeight = 3 * stage;
  const sheet = Buffer.alloc(sheetWidth * sheetHeight * 4);
  const put = (x, y, rgba) => {
    const offset = (y * sheetWidth + x) * 4;
    sheet[offset] = rgba[0];
    sheet[offset + 1] = rgba[1];
    sheet[offset + 2] = rgba[2];
    sheet[offset + 3] = rgba[3];
  };
  const layer = (source, originX, originY, scale, layerName, direction, putPixel = put) => {
    const { left, top, width, height } = layerOrigin(
      source.image,
      selected,
      layerName,
      direction,
      originX,
      originY,
      stage,
    );
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const sourceX = Math.min(source.image.width - 1, Math.floor(x / (2 * scale)));
        const sourceY = Math.min(source.image.height - 1, Math.floor(y / (2 * scale)));
        const offset = (sourceY * source.image.width + sourceX) * 4;
        const alpha = source.image.pixels[offset + 3];
        if (alpha < 32) continue;
        putPixel(
          left + x,
          top + y,
          paintTankArmor(
            source.image.pixels[offset],
            source.image.pixels[offset + 1],
            source.image.pixels[offset + 2],
            alpha,
            selected.livery,
            layerName,
            { x: sourceX, y: sourceY, width: source.image.width, height: source.image.height, direction },
          ),
        );
      }
    }
  };
  for (let column = 0; column < directions.length; column += 1) {
    const direction = directions[column];
    const hull = readSource(selected.hullRequest, sourceIndex[column]);
    const turret = readSource(selected.turretRequest, sourceIndex[column]);
    for (let row = 0; row < 3; row += 1) {
      const x = column * stage;
      const y = row * stage;
      for (let sy = 0; sy < stage; sy += 1) {
        for (let sx = 0; sx < stage; sx += 1) {
          put(x + sx, y + sy, (Math.floor(sx / 16) + Math.floor(sy / 16)) % 2 ? [29, 45, 39, 255] : [34, 51, 44, 255]);
        }
      }
      for (let guide = 0; guide < stage; guide += 1) {
        put(x + stage / 2, y + guide, [99, 45, 75, 255]);
        put(x + guide, y + stage / 2, [99, 45, 75, 255]);
      }
      if (row !== 1) layer(hull, x, y, 1, "hull", direction);
      if (row !== 0) layer(turret, x, y, selected.turretScale, "turret", direction);
      // Guides are a diagnostic overlay, never part of generated runtime art.
      for (let delta = -4; delta <= 4; delta += 1) {
        put(x + stage / 2 + delta, y + stage / 2, [255, 65, 182, 255]);
        put(x + stage / 2, y + stage / 2 + delta, [255, 65, 182, 255]);
      }
    }
  }
  const path = resolve(outputDirectory, "tank-v2-registration-" + kind + suffix + ".png");
  writeFileSync(path, encodeRgbaPng(sheetWidth, sheetHeight, sheet));
  const mixedSize = directions.length * stage;
  const mixed = Buffer.alloc(mixedSize * mixedSize * 4);
  const mixedPut = (x, y, rgba) => {
    const offset = (y * mixedSize + x) * 4;
    mixed[offset] = rgba[0];
    mixed[offset + 1] = rgba[1];
    mixed[offset + 2] = rgba[2];
    mixed[offset + 3] = rgba[3];
  };
  for (let hullIndex = 0; hullIndex < directions.length; hullIndex += 1) {
    const hull = readSource(selected.hullRequest, sourceIndex[hullIndex]);
    for (let turretIndex = 0; turretIndex < directions.length; turretIndex += 1) {
      const turret = readSource(selected.turretRequest, sourceIndex[turretIndex]);
      const x = turretIndex * stage;
      const y = hullIndex * stage;
      for (let sy = 0; sy < stage; sy += 1) {
        for (let sx = 0; sx < stage; sx += 1) {
          mixedPut(
            x + sx,
            y + sy,
            (Math.floor(sx / 16) + Math.floor(sy / 16)) % 2 ? [29, 45, 39, 255] : [34, 51, 44, 255],
          );
        }
      }
      layer(hull, x, y, 1, "hull", directions[hullIndex], mixedPut);
      layer(turret, x, y, selected.turretScale, "turret", directions[turretIndex], mixedPut);
    }
  }
  writeFileSync(
    resolve(outputDirectory, "tank-v2-mixed-aim-" + kind + suffix + ".png"),
    encodeRgbaPng(mixedSize, mixedSize, mixed),
  );
  return path;
}

function drawLayer(image, originX, originY, selected, layer, direction) {
  const scale = layer === "turret" ? selected.turretScale : 1;
  const {
    left,
    top,
    width: displayWidth,
    height: displayHeight,
  } = layerOrigin(image, selected, layer, direction, originX, originY, cell);
  for (let y = 0; y < displayHeight; y += 1) {
    for (let x = 0; x < displayWidth; x += 1) {
      const sourceX = Math.min(image.width - 1, Math.floor(x / (2 * scale)));
      const sourceY = Math.min(image.height - 1, Math.floor(y / (2 * scale)));
      const offset = (sourceY * image.width + sourceX) * 4;
      const alpha = image.pixels[offset + 3];
      if (alpha < 32) continue;
      const rgba = paintTankArmor(
        image.pixels[offset],
        image.pixels[offset + 1],
        image.pixels[offset + 2],
        alpha,
        selected.livery,
        layer,
        { x: sourceX, y: sourceY, width: image.width, height: image.height, direction },
      );
      pixel(left + x, top + y, rgba);
    }
  }
}

for (let row = 0; row < chassis.length; row += 1) {
  const kind = chassis[row];
  const selected = selection.chassis[kind];
  if (!selected) throw new Error(`tank source selection lacks ${kind}`);
  const hullName = selected.hullRequest;
  const turretName = selected.turretRequest;
  const entries = [];
  for (let column = 0; column < directions.length; column += 1) {
    const originX = column * cell;
    const originY = row * cell;
    for (let y = 0; y < cell; y += 1) {
      for (let x = 0; x < cell; x += 1) {
        pixel(originX + x, originY + y, (x + y) % 32 < 16 ? [43, 68, 43, 255] : [47, 72, 47, 255]);
      }
    }
    const hull = readSource(hullName, sourceIndex[column]);
    const turret = readSource(turretName, sourceIndex[column]);
    drawLayer(hull.image, originX, originY, selected, "hull", directions[column]);
    drawLayer(turret.image, originX, originY, selected, "turret", directions[column]);
    entries.push({
      direction: directions[column],
      sourceIndex: sourceIndex[column],
      hull: {
        dimensions: [hull.image.width, hull.image.height],
        bounds: hull.bounds,
        opaqueCenter: opaqueCenter(hull.bounds),
        canvasCenter: [hull.image.width / 2, hull.image.height / 2],
        edgeContact: hull.edgeContact,
        sha256: hull.sha256,
        assetId: hull.assetId,
      },
      turret: {
        dimensions: [turret.image.width, turret.image.height],
        bounds: turret.bounds,
        opaqueCenter: opaqueCenter(turret.bounds),
        canvasCenter: [turret.image.width / 2, turret.image.height / 2],
        edgeContact: turret.edgeContact,
        sha256: turret.sha256,
        assetId: turret.assetId,
      },
    });
  }
  report.chassis.push({
    id: kind,
    hullRequest: hullName,
    turretRequest: turretName,
    turretScale: selected.turretScale,
    registration: selected.mountRegistration ? "declared-source-mount" : "unverified-canvas-centred",
    ...(selected.mountRegistration ? { mountRegistration: selected.mountRegistration } : {}),
    entries,
  });
  writeRegistrationSheet(kind, selected);
}

writeFileSync(output, encodeRgbaPng(width, height, pixels));
writeFileSync(
  resolve(outputDirectory, `tank-v2-candidate-sheet${suffix}.json`),
  `${JSON.stringify(report, null, 2)}\n`,
);
console.log(`tank-v2-preview:${output}`);
