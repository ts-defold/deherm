import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";

import { alphaBounds, decodeRgbaPng } from "../tools/generate-world-art.mjs";

const root = resolve(import.meta.dirname, "..");
const directions = ["se", "s", "sw", "w", "e", "nw", "n", "ne"];
const source = ["down-d", "down", "down-d", "side", "side", "up-d", "up", "up-d"];

test("Rook atlas has eight grounded idle, walk, fire, hit, and lower death facings", () => {
  const atlas = readFileSync(resolve(root, "defold/main/hero-sprites.atlas"), "utf8");
  const anchors = JSON.parse(readFileSync(resolve(root, "art/derived/hero-anchors.json"), "utf8"));
  const inventory = JSON.parse(readFileSync(resolve(root, "art/derived/hero-frame-inventory.json"), "utf8"));
  const animations = [
    ...atlas.matchAll(/animations \{\n  id: "(hero-[a-z]+-(?:idle|walk|fire|hit|death))"([\s\S]*?)\n\}/gu),
  ];
  assert.equal(animations.length, 40);
  const seen = new Set();
  const idleImages = new Set();
  for (let index = 0; index < directions.length; index += 1) {
    const direction = directions[index];
    for (const moving of [false, true]) {
      const id = `hero-${direction}-${moving ? "walk" : "idle"}`;
      const block = animations.find((match) => match[1] === id)?.[2];
      assert.ok(block, `missing ${id}`);
      assert.equal((block.match(/image:/gu) ?? []).length, moving ? 4 : 1);
      assert.match(
        block,
        new RegExp(`/assets/units/infantry-rook/${direction}/${moving ? "walk-1" : "idle"}\\.png`, "u"),
      );
      assert.ok(
        !block.includes("flip_horizontal: 1"),
        `${id} should use authored perspective, not mirror another facing`,
      );
      for (const filename of moving ? ["walk-1", "walk-2", "walk-3", "walk-4"] : ["idle"]) {
        const relative = `defold/assets/units/infantry-rook/${direction}/${filename}.png`;
        assert.ok(!seen.has(relative));
        seen.add(relative);
        const bytes = readFileSync(resolve(root, relative));
        if (filename === "idle") idleImages.add(bytes.toString("base64"));
        const image = decodeRgbaPng(bytes);
        assert.deepEqual([image.width, image.height], [40, 40]);
        const bounds = alphaBounds(image);
        assert.ok(bounds && bounds[0] > 0 && bounds[1] > 0 && bounds[2] < 39, `${relative} touches canvas edge`);
        assert.equal(bounds[3], 35, `${relative} foot baseline drifted`);
        assert.deepEqual(anchors[`${direction}/${filename}.png`], [20, 36], `${relative} QA anchor drifted`);
      }
    }
    for (const [state, frames, height] of [
      ["fire", 3, 32],
      ["hit", 3, 32],
      ["death", 4, 24],
    ]) {
      const id = `hero-${direction}-${state}`;
      const block = animations.find((match) => match[1] === id)?.[2];
      assert.ok(block, `missing ${id}`);
      assert.equal((block.match(/image:/gu) ?? []).length, frames);
      assert.match(block, /playback: PLAYBACK_ONCE_FORWARD/u);
      if (state === "hit") {
        assert.match(
          block,
          new RegExp(`images \\{\\n    image: "/assets/units/infantry-rook/${direction}/hit\\.png"`, "u"),
        );
        assert.match(block, /fps: 12/u);
      }
      assert.ok(block.includes(`/assets/units/infantry-rook/${direction}/${state}.png`));
      const relative = `defold/assets/units/infantry-rook/${direction}/${state}.png`;
      seen.add(relative);
      const image = decodeRgbaPng(readFileSync(resolve(root, relative)));
      const bounds = alphaBounds(image);
      assert.deepEqual([image.width, image.height], [40, 40]);
      assert.ok(bounds && bounds[0] > 0 && bounds[1] > 0 && bounds[2] < 39);
      assert.equal(bounds[3], 35, `${relative} foot baseline drifted`);
      assert.equal(bounds[3] - bounds[1] + 1, height, `${relative} action silhouette height drifted`);
      assert.deepEqual(anchors[`${direction}/${state}.png`], [20, 36]);
    }
  }
  assert.equal(seen.size, 64);
  assert.equal(Object.keys(anchors).length, 64, "QA anchors must cover only the shipped hero frames");
  assert.deepEqual(new Set(inventory), new Set(Object.keys(anchors)), "planned hero frames and QA anchors must agree");
  assert.deepEqual(
    new Set(inventory),
    new Set([...seen].map((path) => path.slice("defold/assets/units/infantry-rook/".length))),
  );
  assert.equal(idleImages.size, 8, "every facing must emit distinct pixels, not duplicate another direction");
});

test("all non-default driver families have complete, grounded eight-view atlases", () => {
  const atlas = readFileSync(resolve(root, "defold/main/hero-sprites.atlas"), "utf8");
  const selection = JSON.parse(readFileSync(resolve(root, "art/source/hero-source-selection.json"), "utf8"));
  assert.deepEqual(
    selection.families.map(({ character }) => character),
    ["rook", "brass", "spark", "mud"],
  );
  for (const family of selection.families.slice(1)) {
    const anchors = JSON.parse(
      readFileSync(resolve(root, `art/derived/hero-anchors-${family.character}.json`), "utf8"),
    );
    const inventory = JSON.parse(
      readFileSync(resolve(root, `art/derived/hero-frame-inventory-${family.character}.json`), "utf8"),
    );
    assert.deepEqual(family.flipHorizontal, ["w", "e"]);
    const actionStates = [
      "fire",
      ...(family.hitRequest === undefined ? [] : ["hit"]),
      ...(family.deathSources === undefined ? [] : ["death"]),
    ];
    assert.equal(inventory.length, 40 + actionStates.length * directions.length);
    assert.deepEqual(new Set(inventory), new Set(Object.keys(anchors)));
    const idleImages = new Set();
    for (const direction of directions) {
      for (const moving of [false, true]) {
        const id = `hero-${family.variant}-${direction}-${moving ? "walk" : "idle"}`;
        const block = atlas.match(new RegExp(`animations \\{\\n  id: "${id}"([\\s\\S]*?)\\n\\}`, "u"))?.[1];
        assert.ok(block, `missing ${id}`);
        assert.equal((block.match(/image:/gu) ?? []).length, moving ? 4 : 1);
        for (const filename of moving ? ["walk-1", "walk-2", "walk-3", "walk-4"] : ["idle"]) {
          const relative = `${direction}/${filename}.png`;
          assert.ok(inventory.includes(relative), `missing ${family.character} frame ${relative}`);
          assert.ok(
            block.includes(`/assets/units/infantry-${family.character}/${relative}`),
            `${id} does not reference ${relative}`,
          );
          const bytes = readFileSync(resolve(root, `defold/assets/units/infantry-${family.character}/${relative}`));
          if (!moving) idleImages.add(bytes.toString("base64"));
          const image = decodeRgbaPng(bytes);
          assert.deepEqual([image.width, image.height], [40, 40]);
          const bounds = alphaBounds(image);
          assert.ok(bounds && bounds[0] > 0 && bounds[1] > 0 && bounds[2] < 39, `${relative} touches canvas edge`);
          assert.equal(bounds[3], 35, `${relative} foot baseline drifted`);
          assert.deepEqual(anchors[relative], [20, 36]);
        }
      }
      for (const state of actionStates) {
        const id = `hero-${family.variant}-${direction}-${state}`;
        const block = atlas.match(new RegExp(`animations \\{\\n  id: "${id}"([\\s\\S]*?)\\n\\}`, "u"))?.[1];
        assert.ok(block, `missing ${id}`);
        assert.equal((block.match(/image:/gu) ?? []).length, state === "death" ? 4 : 3);
        assert.match(block, /playback: PLAYBACK_ONCE_FORWARD/u);
        const relative = `${direction}/${state}.png`;
        assert.ok(inventory.includes(relative), `missing ${family.character} frame ${relative}`);
        assert.ok(block.includes(`/assets/units/infantry-${family.character}/${relative}`));
        const image = decodeRgbaPng(
          readFileSync(resolve(root, `defold/assets/units/infantry-${family.character}/${relative}`)),
        );
        assert.deepEqual([image.width, image.height], [40, 40]);
        const bounds = alphaBounds(image);
        assert.ok(bounds && bounds[0] > 0 && bounds[1] > 0 && bounds[2] < 39);
        assert.equal(bounds[3], 35, `${relative} foot baseline drifted`);
        assert.equal(bounds[3] - bounds[1] + 1, state === "death" ? 24 : 32);
        assert.deepEqual(anchors[relative], [20, 36]);
      }
    }
    assert.equal(idleImages.size, 8, `${family.character} repeats a source facing`);
  }
});

test("selected hero source-cell edge risks are accounted for separately from runtime padding", () => {
  const selection = JSON.parse(readFileSync(resolve(root, "art/source/hero-source-selection.json"), "utf8"));
  const audit = JSON.parse(readFileSync(resolve(root, "art/derived/hero-source-edge-audit.json"), "utf8"));
  const expected = selection.families.flatMap((family) =>
    directions.flatMap((direction) => [
      `${family.character}/${direction}/idle`,
      ...(family.fireRequest === undefined ? [] : [`${family.character}/${direction}/fire`]),
      ...(family.hitRequest === undefined ? [] : [`${family.character}/${direction}/hit`]),
      ...(family.deathSources === undefined ? [] : [`${family.character}/${direction}/death`]),
      ...[1, 2, 3, 4].map((frame) => `${family.character}/${direction}/walk-${frame}`),
    ]),
  );
  assert.equal(audit.selectedSourceFrames, expected.length);
  assert.deepEqual(new Set(audit.frames.map((frame) => frame.label)), new Set(expected));
  assert.equal(
    audit.edgeContactFrames,
    audit.frames.filter((frame) => Object.values(frame.edgeContacts).some(Boolean)).length,
  );
  const walks = audit.frames.filter((frame) => /\/walk-[1-4]$/u.test(frame.label));
  assert.equal(audit.walkSourceFrames, walks.length);
  assert.equal(
    audit.walkHorizontalEdgeContactFrames,
    walks.filter((frame) => frame.edgeContacts.left || frame.edgeContacts.right).length,
  );
  for (const frame of audit.frames) {
    const [left, top, right, bottom] = frame.opaqueBounds;
    assert.deepEqual(frame.edgeContacts, {
      left: left === 0,
      top: top === 0,
      right: right === frame.canvas[0] - 1,
      bottom: bottom === frame.canvas[1] - 1,
    });
  }
});

test("provider animation review sheets preserve a visible gutter without claiming source repair", () => {
  const request = "rook-infantry-walk-n-v1";
  const result = spawnSync(process.execPath, ["tools/inspect-sprite-fusion-animation.mjs", request], {
    cwd: root,
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(
    readFileSync(resolve(root, `build/evidence/sprite-fusion-animation/${request}/inspection.json`), "utf8"),
  );
  assert.equal(report.paddingOnly, true);
  assert.equal(report.reviewGutterPixels, 8);
  assert.equal(report.frames.length, 4);
  assert.ok(report.frames.some(({ edgeContacts }) => Object.values(edgeContacts).some(Boolean)));
  assert.deepEqual(report.sourceEdgeContactFrames, [0, 1, 2, 3]);
  for (const { registeredBounds } of report.frames) {
    assert.ok(registeredBounds[0] >= 8 && registeredBounds[1] >= 8);
    assert.ok(registeredBounds[2] < report.reviewCellPixels - 8);
    assert.ok(registeredBounds[3] < report.reviewCellPixels - 8);
  }
  const image = decodeRgbaPng(readFileSync(report.presentationPath));
  assert.deepEqual([image.width, image.height], [4 * report.reviewCellPixels * 4, report.reviewCellPixels * 4]);
  assert.deepEqual([...image.pixels.subarray(0, 4)], [53, 105, 60, 255]);
  const first = report.frames[0];
  const sourceLeft = Math.floor((report.reviewCellPixels - first.canvas[0]) / 2);
  const sourceTop = first.registeredBounds[1] - first.opaqueBounds[1];
  const markerX = (sourceLeft - 2) * 4;
  const markerY = (sourceTop + Math.floor(first.canvas[1] / 2)) * 4;
  const marker = (markerY * image.width + markerX) * 4;
  assert.deepEqual([...image.pixels.subarray(marker, marker + 4)], report.sourceEdgeMarker);
});

test("archived tutorial driver frames retain their original baseline", () => {
  const anchors = JSON.parse(readFileSync(resolve(root, "art/source/hero-anchors.json"), "utf8"));
  assert.equal(Object.keys(anchors).length, 20);
  for (const sourceDirection of new Set(source)) {
    for (let frame = 1; frame <= 4; frame += 1) {
      const key = `${sourceDirection}/${frame}.png`;
      const image = decodeRgbaPng(readFileSync(resolve(root, `defold/assets/units/infantry/${key}`)));
      assert.equal(image.width, 22);
      assert.equal(image.height, 22);
      const bounds = alphaBounds(image);
      assert.ok(bounds[0] >= 1 && bounds[1] >= 1 && bounds[2] <= 20);
      assert.deepEqual(anchors[key], [11, 20], `${key} source anchor changed`);
      assert.equal(bounds[3] + 1, anchors[key][1], `${key} foot baseline drifted`);
    }
  }
});

test("an existing Sprite Fusion request fails before another paid API call", () => {
  const result = spawnSync(
    process.execPath,
    ["tools/sprite-fusion.mjs", "--spec", "art/source/sprite-fusion/specs/rook-infantry-walk-se-v1.json"],
    {
      cwd: root,
      encoding: "utf8",
      timeout: 5_000,
      env: { ...process.env, SPRITE_FUSION_API_KEY: "unusable-test-key" },
    },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /SpriteFusion request already exists/u);
  assert.doesNotMatch(result.stderr, /fetch failed|request failed|unusable-test-key/u);
});

const selectedHeroSources = JSON.parse(readFileSync(resolve(root, "art/source/hero-source-selection.json"), "utf8"));
for (const family of selectedHeroSources.families) {
  for (const [direction, override] of Object.entries(family.walkOverrides ?? {})) {
    test(`${family.character} ${direction} selected animation retains source and returned-frame gutters`, () => {
      const character = family.character;
      const request = override.request;
      const manifest = JSON.parse(
        readFileSync(resolve(root, `art/source/sprite-fusion/requests/${request}.json`), "utf8"),
      );
      const inputPath = manifest.inputs[0]?.path;
      assert.match(inputPath, /^art\/source\/sprite-fusion\/inputs\/.+\.png$/u);
      const input = JSON.parse(readFileSync(resolve(root, inputPath.replace(/\.png$/u, ".json")), "utf8"));
      const { sourceRequest: poseRequest, outputIndex: poseIndex, canvas } = input;
      const check = spawnSync(
        process.execPath,
        ["tools/prepare-hero-animation-input.mjs", poseRequest, String(poseIndex), "--check"],
        { cwd: root, encoding: "utf8", timeout: 5_000 },
      );
      assert.equal(check.status, 0, check.stderr);
      assert.equal(manifest.inputs[0].sha256, input.sha256, "paid request must consume this exact padded source");
      const output = manifest.outputs[0];
      assert.equal(output.frameCount, 4);
      const sheet = decodeRgbaPng(readFileSync(resolve(root, output.spritesheet.path)));
      assert.deepEqual([sheet.width, sheet.height], [canvas * 4, canvas]);
      for (let frame = 0; frame < output.frameCount; frame += 1) {
        const pixels = Buffer.alloc(canvas * canvas * 4);
        for (let y = 0; y < canvas; y += 1) {
          sheet.pixels.copy(
            pixels,
            y * canvas * 4,
            (y * sheet.width + frame * canvas) * 4,
            (y * sheet.width + (frame + 1) * canvas) * 4,
          );
        }
        const bounds = alphaBounds({ width: canvas, height: canvas, pixels });
        assert.ok(bounds, `${character} ${direction} walk frame ${frame + 1} is empty`);
        assert.ok(
          bounds[0] >= 6 && bounds[1] >= 6 && bounds[2] < canvas - 6 && bounds[3] < canvas - 6,
          `${character} ${direction} walk frame ${frame + 1} approaches the canvas edge`,
        );
      }
    });
  }
}
