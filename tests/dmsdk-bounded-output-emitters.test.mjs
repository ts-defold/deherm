import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  DMSDK_BOUNDED_OUTPUTS,
  renderDmSdkBoundedOutputs,
} from "../packages/compiler/src/dmsdk-bounded-output-emitter.mjs";
import {
  DMSDK_HASH_STATE_OUTPUTS,
  renderDmSdkHashStateOutputs,
} from "../packages/compiler/src/dmsdk-hash-state-output-emitter.mjs";
import {
  DMSDK_ARENA_CSTRING_OUTPUTS,
  renderDmSdkArenaCStringOutputs,
} from "../packages/compiler/src/dmsdk-arena-cstring-output-emitter.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => readFile(path.join(root, relative), "utf8");

for (const family of ["fixed-digest", "base64-span", "astc-probe", "xtea-span", "hash-span"]) {
  test(`${family} compiler emitter reproduces the frozen old-pipeline bytes`, async () => {
    const text = await read(`packages/bindings/generated/defold-dmsdk-${family}-recipe-facts.json`);
    const facts = JSON.parse(text);
    assert.equal(facts.family, family);
    assert.ok(text.length < 4096, `${family} recipe facts must stay compact`);
    assert.doesNotMatch(text, /(?:evidence|description|sourceFacts|implementationObservations|tokens)/u);
    const outputs = renderDmSdkBoundedOutputs(facts);
    assert.deepEqual([...outputs.keys()], [...DMSDK_BOUNDED_OUTPUTS[family]]);
    for (const [relative, content] of outputs) assert.equal(content, await read(relative), relative);
  });
}

test("hash-state compiler emitter reproduces the frozen old-pipeline bytes", async () => {
  const text = await read("packages/bindings/generated/defold-dmsdk-hash-state-recipe-facts.json");
  const facts = JSON.parse(text);
  assert.ok(text.length < 4096, "hash-state recipe facts must stay compact");
  assert.doesNotMatch(text, /(?:evidence|description|sourceFacts|implementationObservations|tokens)/u);
  const outputs = renderDmSdkHashStateOutputs(facts);
  assert.deepEqual([...outputs.keys()], Object.values(DMSDK_HASH_STATE_OUTPUTS));
  for (const [relative, content] of outputs) assert.equal(content, await read(relative), relative);
});

test("arena-cstring compiler emitter reproduces the frozen old-pipeline bytes", async () => {
  const text = await read("packages/bindings/generated/defold-dmsdk-arena-cstring-recipe-facts.json");
  const facts = JSON.parse(text);
  assert.ok(text.length < 8192, "arena-cstring recipe facts must stay compact");
  assert.doesNotMatch(text, /(?:evidence|description|sourceFacts|implementationObservations|tokens)/u);
  const outputs = renderDmSdkArenaCStringOutputs(facts);
  assert.deepEqual([...outputs.keys()], Object.values(DMSDK_ARENA_CSTRING_OUTPUTS));
  for (const [relative, content] of outputs) assert.equal(content, await read(relative), relative);
});
