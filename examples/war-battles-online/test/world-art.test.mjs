import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, readFile as readBytes, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { alphaBounds, buildWorldArt, decodeRgbaPng } from "../tools/generate-world-art.mjs";
import { buildTitleBackground } from "../tools/generate-title-art.mjs";

const exampleRoot = path.resolve(import.meta.dirname, "..");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

test("large blast expands into a bounded ground shockwave without clipping its atlas cell", async () => {
  const first = decodeRgbaPng(
    await readBytes(path.join(exampleRoot, "defold/assets/derived/arena/explosion-big-1.png")),
  );
  const peak = decodeRgbaPng(
    await readBytes(path.join(exampleRoot, "defold/assets/derived/arena/explosion-big-5.png")),
  );
  assert.deepEqual([first.width, first.height, peak.width, peak.height], [64, 64, 64, 64]);
  const firstBounds = alphaBounds(first);
  const peakBounds = alphaBounds(peak);
  assert.ok(peakBounds[2] - peakBounds[0] >= 46, "the big blast needs a legible expanding shockwave");
  assert.ok(peakBounds[2] - peakBounds[0] > firstBounds[2] - firstBounds[0] + 30);
  assert.ok(
    peakBounds.every((edge) => edge >= 2 && edge <= 61),
    "the shockwave needs an atlas gutter",
  );
});

test("selected Sprite Fusion sandbags retain source provenance and grounded runtime gutters", async () => {
  const selectionBytes = await readBytes(path.join(exampleRoot, "art/source/sprite-fusion/sandbag-selection-v1.json"));
  const selection = JSON.parse(selectionBytes);
  const manifest = JSON.parse(
    await readFile(path.join(exampleRoot, `art/source/sprite-fusion/requests/${selection.request}.json`), "utf8"),
  );
  const arenaArt = JSON.parse(
    await readFile(path.join(exampleRoot, "defold/assets/derived/arena/arena-art.json"), "utf8"),
  );
  assert.equal(arenaArt.source.worldSandbagSprites.provider, "Sprite Fusion");
  assert.equal(arenaArt.source.worldSandbagSprites.selectionSha256, sha256(selectionBytes));
  assert.equal(arenaArt.source.worldSandbagSprites.requestId, manifest.requestId);
  assert.deepEqual(selection.outputCell, [36, 32]);
  assert.deepEqual(selection.scale, [5, 8]);
  assert.deepEqual(
    selection.variants.map(({ id }) => id),
    ["cover-sandbag-a", "cover-sandbag-b"],
  );
  const runtimeImages = [];
  for (const variant of selection.variants) {
    const source = manifest.outputs.find(({ index }) => index === variant.index);
    assert.equal(source.assetId, variant.assetId);
    const sourceBytes = await readBytes(path.join(exampleRoot, source.path));
    assert.equal(sha256(sourceBytes), source.sha256);
    const sourceBounds = alphaBounds(decodeRgbaPng(sourceBytes));
    assert.ok(sourceBounds[0] >= 2 && sourceBounds[1] >= 2 && sourceBounds[2] <= 61 && sourceBounds[3] <= 61);
    const runtimeBytes = await readBytes(path.join(exampleRoot, `defold/assets/derived/arena/${variant.id}.png`));
    const runtime = decodeRgbaPng(runtimeBytes);
    assert.deepEqual([runtime.width, runtime.height], selection.outputCell);
    const bounds = alphaBounds(runtime);
    assert.ok(bounds[0] >= 2 && bounds[2] <= 33, `${variant.id} needs horizontal atlas gutter`);
    assert.equal(bounds[3], selection.groundLine, `${variant.id} lost the ground-contact line`);
    runtimeImages.push(runtimeBytes);
  }
  assert.notDeepEqual(runtimeImages[0], runtimeImages[1], "two sandbag variants must remain visually distinct");
  assert.deepEqual(Object.keys(arenaArt.source.worldCoverSprites.sprites), ["cover-crate"]);
});

test("the selected SNK hex title source deterministically fills the Defold title backdrop", async () => {
  const generated = buildTitleBackground();
  const installed = await readBytes(path.join(exampleRoot, "defold/assets/ui/title-screen/background.png"));
  assert.deepEqual(installed, generated);
  const background = decodeRgbaPng(generated);
  assert.deepEqual([background.width, background.height], [1280, 720]);
  assert.match(
    await readFile(path.join(exampleRoot, "defold/main/tutorial-presentation.atlas"), "utf8"),
    /id: "battlefield-background"\s+images \{\s+image: "\/assets\/ui\/title-screen\/background\.png"/,
  );
});

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
  assert.equal(result.metadata.rendering.method, "hand-authored 16px motifs");
  for (let cell = 0; cell < result.metadata.roles.length; cell += 1) {
    let opaque = 0;
    for (let y = 0; y < 16; y += 1) {
      for (let x = 0; x < 16; x += 1) {
        if (atlas.pixels[(y * atlas.width + cell * 16 + x) * 4 + 3] > 0) opaque += 1;
      }
    }
    assert.ok(
      opaque >= 64 && opaque <= 128,
      `${result.metadata.roles[cell].role} has a legible native-scale silhouette`,
    );
  }
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
