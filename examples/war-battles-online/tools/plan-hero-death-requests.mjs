#!/usr/bin/env node
// Plan provider-owned, per-facing collapsed poses from the selected idle
// assets. The paid responses remain separate pinned Sprite Fusion manifests.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const check = process.argv.includes("--check");
const characters = process.argv.slice(2).filter((argument) => argument !== "--check");
if (characters.length === 0 || characters.some((character) => !["spark", "mud"].includes(character))) {
  throw new Error("Usage: node tools/plan-hero-death-requests.mjs spark|mud [spark|mud] [--check]");
}
const directions = ["se", "s", "sw", "w", "e", "nw", "n", "ne"];
const perspective = {
  se: "from the same southeast three-quarter angle",
  s: "straight south toward the viewer",
  sw: "from the same southwest three-quarter angle",
  w: "in the exact same side-on west-facing view",
  e: "in the exact same side-on east-facing view",
  nw: "from behind at the same northwest three-quarter angle",
  n: "strictly from behind facing north",
  ne: "from behind at the same northeast three-quarter angle",
};
const identity = {
  spark: "lean build, spiky dark hair, orange goggles, teal scarf, olive sleeves, dark uniform, and small backpack",
  mud: "rugged build, tan helmet, orange goggles, dark face covering, red scarf, and olive jacket",
};

for (const character of characters) {
  const manifest = JSON.parse(
    readFileSync(resolve(root, `art/source/sprite-fusion/requests/${character}-infantry-directions-v1.json`), "utf8"),
  );
  assert.equal(manifest.operation, "direction-set");
  assert.equal(manifest.outputs.length, directions.length);
  for (const [index, direction] of directions.entries()) {
    const source = manifest.outputs.find((output) => output.index === index);
    assert.ok(source?.assetId, `missing ${character} ${direction} provider asset`);
    const name = `${character}-infantry-death-pose-${direction}-v1`;
    const prompt =
      `Keep ${character} viewed ${perspective[direction]}. ` +
      "Change the body into a clearly defeated collapsed pose: one knee on the ground, " +
      "torso and head bowed low forward, one hand braced on the ground, sidearm lowered, " +
      "silhouette much shorter and wider than standing. " +
      `Preserve the same ${identity[character]}, boots and knee on one ground line, ` +
      "colors, dark outlines, identity, and original perspective. " +
      "Do not turn toward another direction. No blood, injury detail, explosion, " +
      "extra prop, scenery, platform, text, or second person.";
    const contents = `${JSON.stringify({ name, operation: "edit", inputs: [`asset:${source.assetId}`], prompt }, null, 2)}\n`;
    const path = resolve(root, `art/source/sprite-fusion/specs/${name}.json`);
    if (check) assert.equal(readFileSync(path, "utf8"), contents, `stale ${name} request spec`);
    else writeFileSync(path, contents);
  }
}
console.log(`war-battles-hero-death-specs:${check ? "fresh" : "generated"}:${characters.join(",")}`);
