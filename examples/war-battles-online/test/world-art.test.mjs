import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, readFile as readBytes, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { buildWorldArt, decodeRgbaPng } from "../tools/generate-world-art.mjs";

const exampleRoot = path.resolve(import.meta.dirname, "..");

async function fixtureRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), "war-battles-world-art-"));
  await cp(path.join(exampleRoot, "art"), path.join(root, "art"), { recursive: true });
  return root;
}

async function readSelection(root) {
  const selectionPath = path.join(root, "art/source/sprite-fusion/selection.json");
  return { path: selectionPath, value: JSON.parse(await readFile(selectionPath, "utf8")) };
}

test("world-art derivation rejects a stale selected source hash", async () => {
  const root = await fixtureRoot();
  const sourcePath = path.join(root, "art/source/sprite-fusion/outputs/refinery-pickup-pedestal-v1/00.png");
  const bytes = Buffer.from(await readBytes(sourcePath));
  bytes[bytes.length - 1] ^= 0x01;
  await writeFile(sourcePath, bytes);
  await assert.rejects(() => buildWorldArt({ exampleRoot: root }), /source hash does not match/);
});

test("world-art derivation rejects a selection asset-id mismatch", async () => {
  const root = await fixtureRoot();
  const selection = await readSelection(root);
  selection.value.world.pickupPedestal.assetId = "stale-asset-id";
  await writeFile(selection.path, `${JSON.stringify(selection.value, null, 2)}\n`);
  await assert.rejects(() => buildWorldArt({ exampleRoot: root }), /asset id disagrees/);
});

test("world-art atlas preserves transparency and reports bounded 16px cells", async () => {
  const root = await fixtureRoot();
  const result = await buildWorldArt({ exampleRoot: root });
  assert.deepEqual(result.metadata.cellSize, [16, 16]);
  assert.equal(result.metadata.roles.length, 6);
  assert.deepEqual(
    result.metadata.roles.map((entry) => entry.role),
    ["pickup-pedestal", "thermal-vent", "lava-fissure", "floor-vent", "pipe-junction", "pipe-run"],
  );
  for (const entry of result.metadata.roles) {
    assert.deepEqual(entry.cell.slice(2), [16, 16]);
    assert.ok(entry.normalizedBounds.every((coordinate) => coordinate >= 0 && coordinate < 16));
  }
  const atlas = decodeRgbaPng(result.atlasBytes);
  assert.deepEqual([atlas.width, atlas.height], [96, 16]);
  assert.ok(
    atlas.pixels.some((value, index) => index % 4 === 3 && value === 0),
    "atlas must retain transparent pixels",
  );
});

test("world-art output is byte-for-byte deterministic and --check is zero-write", async () => {
  const root = await fixtureRoot();
  const first = await buildWorldArt({ exampleRoot: root });
  const outputPath = path.join(root, "defold/assets/derived/world/refinery-props.png");
  const metadataPath = path.join(root, "defold/assets/derived/world/refinery-props.json");
  const firstOutput = await readBytes(outputPath);
  const firstMetadata = await readBytes(metadataPath);
  const beforeOutput = await stat(outputPath);
  const beforeMetadata = await stat(metadataPath);
  await buildWorldArt({ exampleRoot: root, check: true });
  assert.equal((await stat(outputPath)).mtimeMs, beforeOutput.mtimeMs);
  assert.equal((await stat(metadataPath)).mtimeMs, beforeMetadata.mtimeMs);
  const second = await buildWorldArt({ exampleRoot: root });
  assert.deepEqual(second.atlasBytes, first.atlasBytes);
  assert.deepEqual(second.metadataBytes, first.metadataBytes);
  assert.deepEqual(await readBytes(outputPath), firstOutput);
  assert.deepEqual(await readBytes(metadataPath), firstMetadata);
  assert.equal(first.metadata.atlas.sha256, second.metadata.atlas.sha256);
});

test("world-art freshness ignores unrelated portrait selection changes", async () => {
  const root = await fixtureRoot();
  const first = await buildWorldArt({ exampleRoot: root });
  const selection = await readSelection(root);
  selection.value.portrait.reason = "Unrelated portrait editorial change";
  await writeFile(selection.path, `${JSON.stringify(selection.value, null, 2)}\n`);
  const checked = await buildWorldArt({ exampleRoot: root, check: true });
  assert.deepEqual(checked.atlasBytes, first.atlasBytes);
  assert.deepEqual(checked.metadataBytes, first.metadataBytes);
  assert.deepEqual(first.metadata.sources.selection.keys, ["world"]);
});
