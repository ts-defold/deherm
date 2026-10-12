import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import { decodeRgbaPng } from "../tools/generate-world-art.mjs";

const exampleRoot = path.resolve(import.meta.dirname, "..");

async function guiNode(id) {
  const source = await readFile(path.join(exampleRoot, "defold/main/ui.gui"), "utf8");
  const block = source.split("nodes {").find((entry) => entry.includes(`id: "${id}"`));
  assert.ok(block, `GUI node ${id} exists`);
  const position = block.match(/position \{ x: ([\d.]+) y: ([\d.]+)/);
  const size = block.match(/size \{ x: ([\d.]+) y: ([\d.]+)/);
  assert.ok(position && size, `GUI node ${id} has position and size`);
  return {
    x: Number(position[1]),
    y: Number(position[2]),
    width: Number(size[1]),
    height: Number(size[2]),
  };
}

test("title and gameplay UI describe the 16-player target", async () => {
  const [gui, script] = await Promise.all([
    readFile(path.join(exampleRoot, "defold/main/ui.gui"), "utf8"),
    readFile(path.join(exampleRoot, "defold/main/ui.gui.ts"), "utf8"),
  ]);
  assert.match(gui, /16 PLAYER MATCH/);
  assert.match(script, /16 PLAYERS/);
  assert.doesNotMatch(`${gui}\n${script}`, /32 DRIVERS|32 TANKS/);
});

test("vital meter fills remain inset within their metal tracks", async () => {
  for (const [trackId, fillId] of [
    ["health_back", "health_fill"],
    ["armor_back", "armor_fill"],
  ]) {
    const track = await guiNode(trackId);
    const fill = await guiNode(fillId);
    assert.ok(fill.x >= track.x);
    assert.ok(fill.x + fill.width <= track.x + track.width);
    assert.ok(fill.height < track.height);
    assert.ok(fill.height >= 12);
  }
});

test("leaderboard header stays on one line within its panel", async () => {
  const [script, background, rows] = await Promise.all([
    readFile(path.join(exampleRoot, "defold/main/ui.gui.ts"), "utf8"),
    guiNode("leaderboard_back"),
    guiNode("frags"),
  ]);
  const header = script.match(/let text = "([^"]+)";/)?.[1];
  assert.equal(header, "TOP 5          K D\\n");
  assert.ok(rows.width < background.width);
  assert.ok(rows.x >= background.x);
});

test("persistent objective ribbon sits under the score at the upper-left edge", async () => {
  const [score, panel, text] = await Promise.all([
    guiNode("score_back"),
    guiNode("objective_back"),
    guiNode("objective"),
  ]);
  assert.equal(panel.x, score.x);
  assert.equal(panel.y + panel.height, score.y);
  assert.equal(text.x, panel.x + panel.width / 2);
  assert.ok(text.width <= panel.width);
});

test("short combat notices use a centered compact nine-slice rather than a full-width blackout", async () => {
  const [gui, script, background] = await Promise.all([
    readFile(path.join(exampleRoot, "defold/main/ui.gui"), "utf8"),
    readFile(path.join(exampleRoot, "defold/main/ui.gui.ts"), "utf8"),
    guiNode("announcement_back"),
  ]);
  const block = gui.split("nodes {").find((entry) => entry.includes('id: "announcement_back"'));
  assert.match(block, /pivot: PIVOT_N/u);
  assert.equal(background.x, 640);
  assert.equal(background.y, 632);
  assert.match(script, /Math\.min\(520, Math\.max\(144, text\.length \* 11 \+ 44\)\)/u);
  assert.match(script, /gui\.setSize\(self\.announcementBack, vmath\.vector3\(width, 42, 0\)\)/u);
});

test("HUD chrome nine-slice corners fit the generated source cells", async () => {
  const metadata = JSON.parse(
    await readFile(path.join(exampleRoot, "defold/assets/derived/ui/driver-portrait.json"), "utf8"),
  );
  for (const [id, asset] of Object.entries(metadata.chrome)) {
    const [width, height] = asset.nativeSize;
    assert.ok(asset.slice * 2 < width, `${id} has horizontal center pixels`);
    assert.ok(asset.slice * 2 < height, `${id} has vertical center pixels`);
  }
});

test("nine-sliced HUD panels use readable slate interiors rather than near-black fill", async () => {
  for (const id of ["hud-shell", "hud-card", "hud-strip"]) {
    const image = decodeRgbaPng(await readFile(path.join(exampleRoot, `defold/assets/derived/ui/chrome/${id}.png`)));
    const center = (Math.floor(image.height / 2) * image.width + Math.floor(image.width / 2)) * 4;
    const luminance =
      image.pixels[center] * 0.2126 + image.pixels[center + 1] * 0.7152 + image.pixels[center + 2] * 0.0722;
    assert.ok(luminance >= 60, `${id} center is too dark for the combat HUD`);
    assert.equal(image.pixels[center + 3], 255, `${id} center must remain opaque behind text`);
  }
});
