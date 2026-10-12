#!/usr/bin/env node
// Deterministically materialize each selected eight-view driver family from
// pinned Sprite Fusion outputs. Every runtime PNG shares one foot baseline.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

import { alphaBounds, decodeRgbaPng, encodeRgbaPng } from "./generate-world-art.mjs";

const root = resolve(import.meta.dirname, "..");
const check = process.argv.includes("--check");
if (process.argv.slice(2).some((argument) => argument !== "--check")) {
  throw new Error("Usage: node tools/generate-hero-art.mjs [--check]");
}
const selection = JSON.parse(readFileSync(resolve(root, "art/source/hero-source-selection.json"), "utf8"));
const directions = ["se", "s", "sw", "w", "e", "nw", "n", "ne"];
assert.equal(selection.schemaVersion, 4);
assert.deepEqual(selection.directions, directions);
assert.ok(Array.isArray(selection.families) && selection.families.length > 0);
for (const [index, family] of selection.families.entries()) {
  assert.equal(family.variant, index, "hero variants must be contiguous and start at zero");
  assert.match(family.character, /^[a-z]+$/u);
  assert.match(family.idleRequest, /^[a-z0-9]+(?:-[a-z0-9]+)*$/u);
  if (family.fireRequest !== undefined) assert.match(family.fireRequest, /^[a-z0-9]+(?:-[a-z0-9]+)*$/u);
  if (family.hitRequest !== undefined) assert.match(family.hitRequest, /^[a-z0-9]+(?:-[a-z0-9]+)*$/u);
  if (family.deathSources !== undefined) {
    assert.deepEqual(
      Object.keys(family.deathSources).sort(),
      [...directions].sort(),
      `${family.character} death views must be explicit`,
    );
    for (const source of Object.values(family.deathSources)) {
      assert.match(source.request, /^[a-z0-9]+(?:-[a-z0-9]+)*$/u);
      assert.ok(Number.isInteger(source.outputIndex) && source.outputIndex >= 0);
    }
  }
  assert.ok(typeof family.walkRequestPrefix === "string" && typeof family.walkRequestSuffix === "string");
  assert.ok(Number.isInteger(family.walkOutputIndex) && family.walkOutputIndex >= 0);
  if (family.walkOverrides !== undefined) {
    assert.ok(family.walkOverrides && typeof family.walkOverrides === "object" && !Array.isArray(family.walkOverrides));
    for (const [direction, source] of Object.entries(family.walkOverrides)) {
      assert.ok(directions.includes(direction), `unknown ${family.character} walk override direction ${direction}`);
      assert.match(source.request, /^[a-z0-9]+(?:-[a-z0-9]+)*$/u);
      assert.ok(Number.isInteger(source.outputIndex) && source.outputIndex >= 0);
    }
  }
  assert.ok(Array.isArray(family.flipHorizontal));
  assert.ok(family.flipHorizontal.every((direction) => directions.includes(direction)));
  assert.equal(new Set(family.flipHorizontal).size, family.flipHorizontal.length);
}
assert.equal(new Set(selection.families.map((family) => family.character)).size, selection.families.length);
assert.deepEqual(selection.canvas, [40, 40]);
assert.equal(selection.subjectHeight, 32);
assert.equal(selection.deathHeight, 24);
assert.equal(selection.footBaseline, 36);
assert.equal(selection.spriteOffsetY, 16);
assert.equal(selection.spriteOffsetY + selection.canvas[1] / 2 - selection.footBaseline, 0);

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const manifests = new Map();
const sourceEdgeRecords = [];
function recordSourceEdges(image, label, source) {
  const bounds = alphaBounds(image);
  assert.ok(bounds, `empty hero source: ${label}`);
  const [left, top, right, bottom] = bounds;
  sourceEdgeRecords.push({
    label,
    source,
    canvas: [image.width, image.height],
    opaqueBounds: bounds,
    edgeContacts: {
      left: left === 0,
      top: top === 0,
      right: right === image.width - 1,
      bottom: bottom === image.height - 1,
    },
  });
}
function request(name, operation) {
  assert.match(name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/u);
  if (!manifests.has(name)) {
    const manifest = JSON.parse(readFileSync(resolve(root, `art/source/sprite-fusion/requests/${name}.json`), "utf8"));
    assert.equal(manifest.operation, operation);
    assert.ok(manifest.spec?.path && manifest.spec?.sha256);
    assert.equal(
      sha256(readFileSync(resolve(root, manifest.spec.path))),
      manifest.spec.sha256,
      `stale source recipe: ${name}`,
    );
    manifests.set(name, manifest);
  }
  return manifests.get(name);
}

function readPinned(output, label) {
  assert.ok(output?.path && output?.sha256);
  const bytes = readFileSync(resolve(root, output.path));
  assert.equal(sha256(bytes), output.sha256, `source art differs from pinned request: ${output.path}`);
  const image = decodeRgbaPng(bytes);
  recordSourceEdges(image, label, output.path);
  return image;
}

function walkFrames(family, direction) {
  const override = family.walkOverrides?.[direction];
  const name = override?.request ?? `${family.walkRequestPrefix}${direction}${family.walkRequestSuffix}`;
  const manifest = request(name, "animate");
  const output = manifest.outputs.find(
    (candidate) => candidate.index === (override?.outputIndex ?? family.walkOutputIndex),
  );
  assert.ok(output?.spritesheet?.path && output?.spritesheet?.sha256, `missing walk spritesheet: ${name}`);
  assert.equal(output.frameCount, 4, `expected four walk frames: ${name}`);
  const bytes = readFileSync(resolve(root, output.spritesheet.path));
  assert.equal(sha256(bytes), output.spritesheet.sha256, `walk sheet differs from pinned request: ${name}`);
  const sheet = decodeRgbaPng(bytes);
  assert.equal(sheet.width % output.frameCount, 0, `walk sheet width is not divisible by frame count: ${name}`);
  const frameWidth = sheet.width / output.frameCount;
  assert.equal(frameWidth, output.width, `walk sheet frame width changed: ${name}`);
  assert.equal(sheet.height, output.height, `walk sheet frame height changed: ${name}`);
  return Array.from({ length: output.frameCount }, (_, frame) => {
    const pixels = Buffer.alloc(frameWidth * sheet.height * 4);
    for (let y = 0; y < sheet.height; y += 1) {
      sheet.pixels.copy(
        pixels,
        y * frameWidth * 4,
        (y * sheet.width + frame * frameWidth) * 4,
        (y * sheet.width + (frame + 1) * frameWidth) * 4,
      );
    }
    const image = { width: frameWidth, height: sheet.height, pixels };
    recordSourceEdges(image, `${family.character}/${direction}/walk-${frame + 1}`, output.spritesheet.path);
    return image;
  });
}

function register(image, label, flipHorizontal, targetHeight = selection.subjectHeight) {
  const bounds = alphaBounds(image);
  assert.ok(bounds, `empty hero frame: ${label}`);
  const [left, top, right, bottom] = bounds;
  const sourceWidth = right - left + 1;
  const sourceHeight = bottom - top + 1;
  assert.ok(targetHeight > 0 && targetHeight <= selection.subjectHeight, `invalid hero state height: ${label}`);
  const targetWidth = Math.max(1, Math.round((sourceWidth * targetHeight) / sourceHeight));
  const [canvasWidth, canvasHeight] = selection.canvas;
  const originX = Math.floor((canvasWidth - targetWidth) / 2);
  const originY = selection.footBaseline - targetHeight;
  assert.ok(originX >= 2 && originX + targetWidth <= canvasWidth - 2, `hero has no horizontal gutter: ${label}`);
  assert.ok(originY >= 2 && selection.footBaseline <= canvasHeight - 2, `hero has no vertical gutter: ${label}`);
  const pixels = Buffer.alloc(canvasWidth * canvasHeight * 4);
  for (let y = 0; y < targetHeight; y += 1) {
    const sourceY = top + Math.floor((y * sourceHeight) / targetHeight);
    for (let x = 0; x < targetWidth; x += 1) {
      const sampledX = Math.floor((x * sourceWidth) / targetWidth);
      const sourceX = flipHorizontal ? right - sampledX : left + sampledX;
      const from = (sourceY * image.width + sourceX) * 4;
      const to = ((originY + y) * canvasWidth + originX + x) * 4;
      if (image.pixels[from + 3] !== 0) image.pixels.copy(pixels, to, from, from + 4);
    }
  }
  const normalized = { width: canvasWidth, height: canvasHeight, pixels };
  const normalizedBounds = alphaBounds(normalized);
  assert.ok(
    normalizedBounds && normalizedBounds[3] === selection.footBaseline - 1,
    `hero foot baseline drifted: ${label}`,
  );
  assert.ok(normalizedBounds[0] > 0 && normalizedBounds[1] > 0 && normalizedBounds[2] < canvasWidth - 1);
  return encodeRgbaPng(canvasWidth, canvasHeight, pixels);
}

async function output(relativePath, contents) {
  const path = resolve(root, relativePath);
  if (check) {
    assert.deepEqual(readFileSync(path), contents, `stale generated hero art: ${relativePath}`);
    return;
  }
  await mkdir(resolve(path, ".."), { recursive: true });
  writeFileSync(path, contents);
}

const families = [];
for (const family of selection.families) {
  const idleManifest = request(family.idleRequest, "direction-set");
  assert.equal(idleManifest.outputs.length, directions.length);
  const fireManifest = family.fireRequest === undefined ? undefined : request(family.fireRequest, "direction-set");
  if (fireManifest !== undefined) assert.equal(fireManifest.outputs.length, directions.length);
  const hitManifest = family.hitRequest === undefined ? undefined : request(family.hitRequest, "direction-set");
  if (hitManifest !== undefined) assert.equal(hitManifest.outputs.length, directions.length);
  const imagePaths = new Map();
  const imageRoot = `defold/assets/units/infantry-${family.character}/`;
  for (const [index, direction] of directions.entries()) {
    const idleOutput = idleManifest.outputs.find((candidate) => candidate.index === index);
    assert.ok(idleOutput, `missing ${family.character} idle direction ${direction}`);
    const idlePath = `${imageRoot}${direction}/idle.png`;
    const flipHorizontal = family.flipHorizontal.includes(direction);
    await output(
      idlePath,
      register(
        readPinned(idleOutput, `${family.character}/${direction}/idle`),
        `${family.character}/${direction}/idle`,
        flipHorizontal,
      ),
    );
    let firePath;
    if (fireManifest !== undefined) {
      const fireOutput = fireManifest.outputs.find((candidate) => candidate.index === index);
      assert.ok(fireOutput, `missing ${family.character} fire direction ${direction}`);
      firePath = `${imageRoot}${direction}/fire.png`;
      await output(
        firePath,
        register(
          readPinned(fireOutput, `${family.character}/${direction}/fire`),
          `${family.character}/${direction}/fire`,
          flipHorizontal,
        ),
      );
    }
    let hitPath;
    if (hitManifest !== undefined) {
      const hitOutput = hitManifest.outputs.find((candidate) => candidate.index === index);
      assert.ok(hitOutput, `missing ${family.character} hit direction ${direction}`);
      hitPath = `${imageRoot}${direction}/hit.png`;
      await output(
        hitPath,
        register(
          readPinned(hitOutput, `${family.character}/${direction}/hit`),
          `${family.character}/${direction}/hit`,
          flipHorizontal,
        ),
      );
    }
    let deathPath;
    if (family.deathSources !== undefined) {
      const source = family.deathSources[direction];
      const deathManifest = request(source.request, "edit");
      const deathOutput = deathManifest.outputs.find((candidate) => candidate.index === source.outputIndex);
      assert.ok(deathOutput, `missing ${family.character} death direction ${direction}`);
      deathPath = `${imageRoot}${direction}/death.png`;
      await output(
        deathPath,
        register(
          readPinned(deathOutput, `${family.character}/${direction}/death`),
          `${family.character}/${direction}/death`,
          flipHorizontal,
          selection.deathHeight,
        ),
      );
    }
    const walks = walkFrames(family, direction);
    const walkPaths = [];
    for (const [frame, image] of walks.entries()) {
      const path = `${imageRoot}${direction}/walk-${frame + 1}.png`;
      await output(path, register(image, `${family.character}/${direction}/walk-${frame + 1}`, flipHorizontal));
      walkPaths.push(path);
    }
    imagePaths.set(direction, { idlePath, walkPaths, firePath, hitPath, deathPath });
  }
  const anchors = Object.fromEntries(
    directions.flatMap((direction) => {
      const paths = imagePaths.get(direction);
      return [
        paths.idlePath,
        ...paths.walkPaths,
        ...(paths.firePath === undefined ? [] : [paths.firePath]),
        ...(paths.hitPath === undefined ? [] : [paths.hitPath]),
        ...(paths.deathPath === undefined ? [] : [paths.deathPath]),
      ].map((path) => [path.slice(imageRoot.length), [selection.canvas[0] / 2, selection.footBaseline]]);
    }),
  );
  const suffix = family.variant === 0 ? "" : `-${family.character}`;
  const anchorEntries = Object.entries(anchors);
  const anchorJson = [
    "{",
    ...anchorEntries.map(
      ([path, [x, y]], index) =>
        `  ${JSON.stringify(path)}: [${x}, ${y}]${index + 1 === anchorEntries.length ? "" : ","}`,
    ),
    "}",
    "",
  ].join("\n");
  await output(`art/derived/hero-anchors${suffix}.json`, Buffer.from(anchorJson));
  await output(
    `art/derived/hero-frame-inventory${suffix}.json`,
    Buffer.from(`${JSON.stringify(Object.keys(anchors), null, 2)}\n`),
  );
  families.push({ family, imagePaths });
}

function animation(record, direction, state) {
  const paths = record.imagePaths.get(direction);
  const variant = record.family.variant;
  const id = `hero-${variant === 0 ? "" : `${variant}-`}${direction}-${state}`;
  const images =
    state === "walk"
      ? paths.walkPaths
      : state === "fire"
        ? [paths.idlePath, paths.firePath, paths.firePath]
        : state === "hit"
          ? [paths.hitPath, paths.hitPath, paths.idlePath]
          : state === "death"
            ? [
                paths.idlePath,
                ...(paths.hitPath === undefined ? [] : [paths.hitPath]),
                paths.deathPath,
                paths.deathPath,
              ]
            : [paths.idlePath];
  return [
    "animations {",
    `  id: "${id}"`,
    ...images.map((path) => `  images {\n    image: "/${path.slice("defold/".length)}"\n  }`),
    state === "walk"
      ? "  playback: PLAYBACK_LOOP_FORWARD"
      : state !== "idle"
        ? "  playback: PLAYBACK_ONCE_FORWARD"
        : "  playback: PLAYBACK_NONE",
    `  fps: ${state === "walk" ? 8 : state === "death" || state === "hit" ? 12 : state === "idle" ? 1 : 18}`,
    "}",
  ].join("\n");
}
const atlas = [
  ...families.flatMap((record) =>
    directions.flatMap((direction) => [
      animation(record, direction, "idle"),
      animation(record, direction, "walk"),
      ...(record.imagePaths.get(direction).firePath === undefined ? [] : [animation(record, direction, "fire")]),
      ...(record.imagePaths.get(direction).hitPath === undefined ? [] : [animation(record, direction, "hit")]),
      ...(record.imagePaths.get(direction).deathPath === undefined ? [] : [animation(record, direction, "death")]),
    ]),
  ),
  "extrude_borders: 2",
  "",
].join("\n");
const typescript = [
  "// Generated by tools/generate-hero-art.mjs from pinned eight-view driver sources.",
  'import { hashLiteral, type DefoldHash } from "@deherm/project";',
  "",
  `export const HERO_DIRECTION_IDS = [${directions.map((direction) => JSON.stringify(direction)).join(", ")}] as const;`,
  `export const HERO_FAMILY_COUNT = ${families.length};`,
  "const IDLE = [",
  ...families.flatMap(({ family }) => [
    "  [",
    ...directions.map(
      (direction) => `    hashLiteral("#hero-${family.variant === 0 ? "" : `${family.variant}-`}${direction}-idle"),`,
    ),
    "  ],",
  ]),
  "] as const;",
  "const WALK = [",
  ...families.flatMap(({ family }) => [
    "  [",
    ...directions.map(
      (direction) => `    hashLiteral("#hero-${family.variant === 0 ? "" : `${family.variant}-`}${direction}-walk"),`,
    ),
    "  ],",
  ]),
  "] as const;",
  "const FIRE = [",
  ...families.flatMap(({ family, imagePaths }) => [
    "  [",
    ...directions.map((direction) => {
      const state = imagePaths.get(direction).firePath === undefined ? "idle" : "fire";
      return `    hashLiteral("#hero-${family.variant === 0 ? "" : `${family.variant}-`}${direction}-${state}"),`;
    }),
    "  ],",
  ]),
  "] as const;",
  "const HIT = [",
  ...families.flatMap(({ family, imagePaths }) => [
    "  [",
    ...directions.map((direction) => {
      const state = imagePaths.get(direction).hitPath === undefined ? "idle" : "hit";
      return `    hashLiteral("#hero-${family.variant === 0 ? "" : `${family.variant}-`}${direction}-${state}"),`;
    }),
    "  ],",
  ]),
  "] as const;",
  "const DEATH = [",
  ...families.flatMap(({ family, imagePaths }) => [
    "  [",
    ...directions.map((direction) => {
      const state = imagePaths.get(direction).deathPath === undefined ? "idle" : "death";
      return `    hashLiteral("#hero-${family.variant === 0 ? "" : `${family.variant}-`}${direction}-${state}"),`;
    }),
    "  ],",
  ]),
  "] as const;",
  "",
  "export function heroAnimation(direction: number, moving: boolean, variant = 0): DefoldHash {",
  "  const index = Math.trunc(direction);",
  "  const family = Math.trunc(variant) === variant && variant >= 0 && variant < IDLE.length ? variant : 0;",
  "  if (index < 0 || index >= HERO_DIRECTION_IDS.length) return IDLE[family]![1];",
  "  return moving ? WALK[family]![index]! : IDLE[family]![index]!;",
  "}",
  "export function heroFireAnimation(direction: number, variant = 0): DefoldHash {",
  "  const index = Math.trunc(direction);",
  "  const family = Math.trunc(variant) === variant && variant >= 0 && variant < FIRE.length ? variant : 0;",
  "  return FIRE[family]![index >= 0 && index < HERO_DIRECTION_IDS.length ? index : 1]!;",
  "}",
  "export function heroHitAnimation(direction: number, variant = 0): DefoldHash {",
  "  const index = Math.trunc(direction);",
  "  const family = Math.trunc(variant) === variant && variant >= 0 && variant < HIT.length ? variant : 0;",
  "  return HIT[family]![index >= 0 && index < HERO_DIRECTION_IDS.length ? index : 1]!;",
  "}",
  "export function heroDeathAnimation(direction: number, variant = 0): DefoldHash {",
  "  const index = Math.trunc(direction);",
  "  const family = Math.trunc(variant) === variant && variant >= 0 && variant < DEATH.length ? variant : 0;",
  "  return DEATH[family]![index >= 0 && index < HERO_DIRECTION_IDS.length ? index : 1]!;",
  "}",
  "",
].join("\n");
await output("defold/main/hero-sprites.atlas", Buffer.from(atlas));
await output("defold/src/generated-hero-art.ts", Buffer.from(typescript));
const sourceEdgeContacts = sourceEdgeRecords.filter((record) =>
  Object.values(record.edgeContacts).some(Boolean),
).length;
const walkSourceFrames = sourceEdgeRecords.filter((record) => /\/walk-[1-4]$/u.test(record.label));
const walkHorizontalEdgeContacts = walkSourceFrames.filter(
  (record) => record.edgeContacts.left || record.edgeContacts.right,
).length;
const audit = {
  schemaVersion: 1,
  meaning:
    "Source-cell edge contact is a clipping risk, not proof that pixels are missing; runtime canvas gutters cannot repair a clipped source.",
  selectedSourceFrames: sourceEdgeRecords.length,
  edgeContactFrames: sourceEdgeContacts,
  walkSourceFrames: walkSourceFrames.length,
  walkHorizontalEdgeContactFrames: walkHorizontalEdgeContacts,
  frames: sourceEdgeRecords,
};
// Match the repository JSON formatter's compact numeric arrays without
// making a generator depend on a formatter subprocess at build time.
const auditJson = JSON.stringify(audit, null, 2).replace(
  /"(canvas|opaqueBounds)": \[\n((?:\s*\d+,?\n)+)\s*\]/gu,
  (_match, key, numbers) => `"${key}": [${numbers.match(/\d+/gu).join(", ")}]`,
);
await output("art/derived/hero-source-edge-audit.json", Buffer.from(`${auditJson}\n`));
console.log(
  `war-battles-hero-art:${check ? "fresh" : "generated"}:${families.length}-families:8-authored-directions:4-walk-frames:${walkHorizontalEdgeContacts}-walk-horizontal-edge-contacts:${sourceEdgeContacts}-all-source-edge-contacts`,
);
