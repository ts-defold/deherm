import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { decodeRgbaPng } from "../tools/generate-world-art.mjs";
import { paintTankArmor } from "../tools/tank-livery.mjs";
import { TANK_DIRECTIONS, tankLayerPlacement } from "../tools/tank-registration.mjs";

const root = resolve(import.meta.dirname, "..");
const selection = JSON.parse(readFileSync(resolve(root, "art/source/sprite-fusion/tank-selection-v2.json"), "utf8"));

test("every class has a distinct, visible marking in all eight source directions", () => {
  const signatures = new Set();
  for (const [kind, selected] of Object.entries(selection.chassis)) {
    assert.ok(!signatures.has(selected.livery.signature), `${kind} shares a class marking`);
    signatures.add(selected.livery.signature);
    for (const direction of selection.sourceDirectionOrder) {
      let changed = 0;
      for (const layer of ["hull", "turret"]) {
        const request = layer === "hull" ? selected.hullRequest : selected.turretRequest;
        const manifest = JSON.parse(
          readFileSync(resolve(root, `art/source/sprite-fusion/requests/${request}.json`), "utf8"),
        );
        const index = selection.sourceDirectionOrder.indexOf(direction);
        const source = manifest.outputs.find((output) => output.index === index);
        assert.ok(source, `${kind} ${layer} ${direction} source missing`);
        const image = decodeRgbaPng(readFileSync(resolve(root, source.path)));
        for (let y = 0; y < image.height; y += 1) {
          for (let x = 0; x < image.width; x += 1) {
            const offset = (y * image.width + x) * 4;
            const rgba = image.pixels.subarray(offset, offset + 4);
            const plain = paintTankArmor(...rgba, selected.livery, layer);
            const marked = paintTankArmor(...rgba, selected.livery, layer, {
              x,
              y,
              width: image.width,
              height: image.height,
              direction,
            });
            if (plain.some((channel, channelIndex) => channel !== marked[channelIndex])) changed += 1;
            assert.equal(marked[3], rgba[3], `${kind} ${layer} ${direction} changed alpha`);
          }
        }
      }
      assert.ok(changed >= 100, `${kind} ${direction} marking is not legible at source scale: ${changed} pixels`);
    }
  }
  assert.equal(signatures.size, 4);
});

test("class markings preserve transparent pixels and reject invalid directions", () => {
  const livery = selection.chassis.scout.livery;
  assert.deepEqual(
    paintTankArmor(90, 90, 90, 0, livery, "hull", { x: 1, y: 1, width: 64, height: 64, direction: "n" }),
    [90, 90, 90, 0],
  );
  assert.throws(
    () => paintTankArmor(90, 90, 90, 255, livery, "hull", { x: 1, y: 1, width: 64, height: 64, direction: "up" }),
    /bounded directional source pixel/,
  );
});

test("tank source QA materializes every facing and independent-aim combination", () => {
  const outputDirectory = mkdtempSync(join(tmpdir(), "war-battles-tank-qa-"));
  try {
    execFileSync(process.execPath, [resolve(root, "tools/preview-tank-v2.mjs"), "--output-dir", outputDirectory], {
      cwd: root,
      encoding: "utf8",
    });
    const report = JSON.parse(readFileSync(resolve(outputDirectory, "tank-v2-candidate-sheet.json"), "utf8"));
    assert.equal(report.chassis.length, 4);
    for (const chassis of report.chassis) {
      assert.equal(chassis.registration, "declared-source-mount");
      assert.equal(chassis.entries.length, 8);
      assert.deepEqual(
        chassis.entries.map(({ direction }) => direction),
        ["se", "s", "sw", "w", "e", "nw", "n", "ne"],
      );
      const matrix = decodeRgbaPng(readFileSync(resolve(outputDirectory, `tank-v2-mixed-aim-${chassis.id}.png`)));
      assert.deepEqual([matrix.width, matrix.height], [1280, 1280]);
      const guide = decodeRgbaPng(readFileSync(resolve(outputDirectory, `tank-v2-registration-${chassis.id}.png`)));
      assert.deepEqual([guide.width, guide.height], [1280, 480]);
    }
  } finally {
    rmSync(outputDirectory, { recursive: true, force: true });
  }
});

test("every chassis shares one declared mount across eight hull and turret facings", () => {
  for (const [kind, selected] of Object.entries(selection.chassis)) {
    const target = selected.mountRegistration.targetCellPixel;
    for (const direction of TANK_DIRECTIONS) {
      for (const layer of ["hull", "turret"]) {
        const request = layer === "hull" ? selected.hullRequest : selected.turretRequest;
        const manifest = JSON.parse(
          readFileSync(resolve(root, `art/source/sprite-fusion/requests/${request}.json`), "utf8"),
        );
        const sourceIndex = selection.sourceDirectionOrder.indexOf(direction);
        const source = manifest.outputs.find((output) => output.index === sourceIndex);
        assert.ok(source, `${kind}.${layer}.${direction} source missing`);
        const placement = tankLayerPlacement(selected, layer, direction, source.width, source.height);
        const anchor = selected.mountRegistration[`${layer}MountByDirection`][direction];
        const scale = layer === "turret" ? selected.turretScale : 1;
        assert.equal(placement.registered, true);
        assert.deepEqual(
          [placement.x + Math.floor(anchor[0] * scale), placement.y + Math.floor(anchor[1] * scale)],
          target,
          `${kind}.${layer}.${direction} misses the shared mount`,
        );
      }
    }
  }
  const selected = selection.chassis.artillery;
  assert.throws(
    () => tankLayerPlacement({ ...selected, hullRequest: "unmeasured-hull" }, "hull", "se", 64, 64),
    /does not match selected source requests/,
  );
  assert.throws(
    () =>
      tankLayerPlacement(
        { ...selected, mountRegistration: { ...selected.mountRegistration, turretMountByDirection: {} } },
        "turret",
        "se",
        64,
        64,
      ),
    /incomplete tank turret mount registration/,
  );
});

test("tank source QA can compare an archived hull without changing the selected runtime source", () => {
  const outputDirectory = mkdtempSync(join(tmpdir(), "war-battles-tank-alternate-"));
  const selectionPath = resolve(root, "art/source/sprite-fusion/tank-selection-v2.json");
  const selectedBefore = readFileSync(selectionPath);
  try {
    execFileSync(
      process.execPath,
      [
        resolve(root, "tools/preview-tank-v2.mjs"),
        "--artillery-hull-request",
        "artillery-hull-directions-v2",
        "--output-dir",
        outputDirectory,
      ],
      { cwd: root, encoding: "utf8" },
    );
    const report = JSON.parse(
      readFileSync(resolve(outputDirectory, "tank-v2-candidate-sheet-artillery-hull-directions-v2.json"), "utf8"),
    );
    assert.equal(
      report.chassis.find((chassis) => chassis.id === "artillery").hullRequest,
      "artillery-hull-directions-v2",
    );
    assert.equal(
      report.chassis.find((chassis) => chassis.id === "artillery").registration,
      "unverified-canvas-centred",
    );
    assert.deepEqual(readFileSync(selectionPath), selectedBefore);
  } finally {
    rmSync(outputDirectory, { recursive: true, force: true });
  }
});
