import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { generateScriptBindingDescriptors } from "../scripts/generate-script-binding-descriptors.mjs";

const root = new URL("../", import.meta.url);
const ir = JSON.parse(await readFile(new URL("bindings/generated/defold-script-api-ir.json", root), "utf8"));
const patterns = JSON.parse(await readFile(new URL("bindings/generated/defold-script-binding-patterns.json", root), "utf8"));
const checkedJsonText = await readFile(new URL("bindings/generated/defold-script-binding-descriptors.json", root), "utf8");
const checkedHeader = await readFile(new URL("defold/defold_hermes/include/defold_hermes/generated_script_binding_descriptors.hpp", root), "utf8");
const checked = JSON.parse(checkedJsonText);
const generated = generateScriptBindingDescriptors(ir, patterns);

function pendingIds(sourceIr) {
  return sourceIr.functions
    .filter((entry) => entry.runtimeStatus === "requires-universal-lua-bridge")
    .map((entry) => entry.id)
    .sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
}

test("assigns every pending function one dense deterministic numeric ID", () => {
  const expected = pendingIds(ir);
  assert.equal(expected.length, 923);
  assert.equal(checked.bindingCount, 923);
  assert.deepEqual(checked.cold.stableKeys, expected);
  assert.equal(new Set(checked.cold.stableKeys).size, checked.bindingCount);
  for (let numericId = 0; numericId < checked.bindingCount; numericId += 1) {
    assert.equal(checked.cold.stableKeys[numericId], expected[numericId]);
  }
  assert.match(checked.idPolicy.compatibility, /stable IDs persist/);
  assert.equal(checked.coverageClaim, "descriptor generation only; no executable binding coverage is claimed");
});

test("keeps all hot SoA ranges compact, contiguous, and in bounds", () => {
  const perBindingArrays = [
    "stableId", "family", "parameterBegin", "parameterCount", "returnBegin", "returnCount",
    "minimumArity", "maximumArity", "traitMask", "parameterCodecUnion", "returnCodecUnion"
  ];
  for (const name of perBindingArrays) assert.equal(checked.hot[name].length, checked.bindingCount, name);
  assert.equal(checked.hot.parameterCodecMask.length, checked.parameterSlotCount);
  assert.equal(checked.hot.parameterFlags.length, checked.parameterSlotCount);
  assert.equal(checked.hot.returnCodecMask.length, checked.returnSlotCount);

  let nextParameter = 0;
  let nextReturn = 0;
  for (let id = 0; id < checked.bindingCount; id += 1) {
    assert.equal(checked.hot.parameterBegin[id], nextParameter);
    assert.equal(checked.hot.returnBegin[id], nextReturn);
    nextParameter += checked.hot.parameterCount[id];
    nextReturn += checked.hot.returnCount[id];
    assert.ok(checked.hot.minimumArity[id] <= checked.hot.maximumArity[id]);
    assert.ok(Object.values(checked.families).includes(checked.hot.family[id]));
  }
  assert.equal(nextParameter, checked.parameterSlotCount);
  assert.equal(nextReturn, checked.returnSlotCount);
  assert.ok(checked.hot.parameterCodecMask.every((mask) => mask > 0 && mask <= 0xffff));
  assert.ok(checked.hot.returnCodecMask.every((mask) => mask > 0 && mask <= 0xffff));
  assert.ok(checked.hot.parameterFlags.every((flags) => flags >= 0 && flags <= 0xff));
  assert.ok(checked.hot.parameterBegin.every((offset) => offset <= 0xffff));
  assert.ok(checked.hot.returnBegin.every((offset) => offset <= 0xffff));
});

test("uses one persistent stable-ID scheme across full and scalar descriptors", async () => {
  const scalar = JSON.parse(await readFile(new URL(
    "bindings/generated/defold-script-scalar-dispatch.json", root), "utf8"));
  const denseByKey = new Map(checked.cold.stableKeys.map((key, index) => [key, index]));
  for (const binding of scalar.bindings) {
    const denseIndex = denseByKey.get(binding.id);
    assert.notEqual(denseIndex, undefined, binding.id);
    assert.equal(checked.hot.stableId[denseIndex], binding.stableId, binding.id);
  }
});

test("separates cold names and provenance from the hot descriptor tables", () => {
  const perBindingArrays = [
    "stableKeys", "rawNames", "jsNames", "members", "sourceFileIndex", "sourceLines", "modulePathIndex"
  ];
  for (const name of perBindingArrays) assert.equal(checked.cold[name].length, checked.bindingCount, name);
  assert.ok(checked.cold.sourceFileIndex.every((index) => index < checked.cold.sourceFiles.length));
  assert.ok(checked.cold.modulePathIndex.every((index) => index < checked.cold.modulePaths.length));
  assert.ok(checked.cold.sourceLines.every((line) => Number.isInteger(line) && line > 0 && line <= 0xffff));
  assert.equal("stableKeys" in checked.hot, false);
  assert.equal("sourceLines" in checked.hot, false);
});

test("encodes pattern families, codecs, and arity without losing rows", () => {
  const patternById = new Map(patterns.bindings.map((entry) => [entry.id, entry]));
  const familyCounts = new Map(Object.keys(checked.families).map((name) => [name, 0]));
  for (let id = 0; id < checked.bindingCount; id += 1) {
    const key = checked.cold.stableKeys[id];
    const pattern = patternById.get(key);
    assert.ok(pattern, key);
    assert.equal(checked.hot.family[id], checked.families[pattern.loweringFamily]);
    familyCounts.set(pattern.loweringFamily, familyCounts.get(pattern.loweringFamily) + 1);
    const variadic = pattern.traits.includes("variable-arguments");
    assert.equal(checked.hot.maximumArity[id], variadic ? 255 : pattern.parameterCodecs.length);
  }
  assert.deepEqual(
    Object.fromEntries(familyCounts),
    Object.fromEntries(patterns.families.map(({ name, count }) => [name, count]))
  );
});

test("is invariant to input array order and exactly matches checked-in outputs", () => {
  const reorderedIr = structuredClone(ir);
  const reorderedPatterns = structuredClone(patterns);
  reorderedIr.functions.reverse();
  reorderedIr.types.reverse();
  reorderedPatterns.bindings.reverse();
  reorderedPatterns.families.reverse();
  reorderedPatterns.ambiguityEvidence.reverse();
  const reordered = generateScriptBindingDescriptors(reorderedIr, reorderedPatterns);
  assert.deepEqual(reordered.artifact, generated.artifact);
  assert.equal(reordered.header, generated.header);
  assert.deepEqual(checked, generated.artifact);
  assert.equal(checkedHeader, generated.header);
});

test("rejects stale or structurally dishonest pattern inputs", () => {
  const missing = structuredClone(patterns);
  missing.bindings.pop();
  assert.throws(() => generateScriptBindingDescriptors(ir, missing), /classified count|exactly once/);

  const duplicate = structuredClone(patterns);
  duplicate.bindings[1] = structuredClone(duplicate.bindings[0]);
  assert.throws(() => generateScriptBindingDescriptors(ir, duplicate), /duplicate stable keys/);

  const staleType = structuredClone(patterns);
  staleType.bindings[0].parameterCodecs[0].rawType = "number";
  assert.throws(() => generateScriptBindingDescriptors(ir, staleType), /Parameter type mismatch/);

  const overclaim = structuredClone(patterns);
  overclaim.bindings[0].runtimeStatus = "implemented";
  assert.throws(() => generateScriptBindingDescriptors(ir, overclaim), /Unexpected runtime claim/);
});

test("check mode accepts both generated artifacts", () => {
  execFileSync(process.execPath, ["scripts/generate-script-binding-descriptors.mjs", "--check"], {
    cwd: root,
    stdio: "pipe"
  });
});

test("generated descriptor header compiles as strict C++17 constexpr data", () => {
  const candidates = [process.env.CXX, "clang++", "c++"].filter(Boolean);
  const compiler = candidates.find((candidate) => spawnSync(candidate, ["--version"], { stdio: "ignore" }).status === 0);
  assert.ok(compiler, "a C++17 compiler is required to validate the generated descriptor header");
  const dynamicId = checked.cold.stableKeys.indexOf("script:bit.band");
  const dynamicCodecId = checked.cold.stableKeys.indexOf("script:json.decode");
  const scalarId = checked.cold.stableKeys.indexOf("script:bit.bnot");
  const source = `
#include <defold_hermes/generated_script_binding_descriptors.hpp>
using namespace defold_hermes::script_descriptors;
static_assert(kBindingCount == 923);
static_assert(kParameterSlotCount == 1577);
static_assert(kReturnSlotCount == 624);
static_assert(cold::kStableKeys[${dynamicId}] == "script:bit.band");
static_assert(hot::kFamily[${dynamicId}] == Family::DynamicValues);
static_assert(hasTrait(${dynamicId}, TraitVariableArguments));
static_assert(hasCodec(hot::kReturnCodecUnion[${dynamicCodecId}], CodecDynamic));
static_assert(hot::kFamily[${scalarId}] == Family::Scalar);
static_assert(isValidDenseIndex(922));
static_assert(!isValidDenseIndex(923));
int main() { return 0; }
`;
  execFileSync(compiler, [
    "-std=c++17", "-Wall", "-Wextra", "-Werror", "-pedantic", "-fsyntax-only",
    "-Idefold/defold_hermes/include", "-x", "c++", "-"
  ], { cwd: root, input: source, stdio: ["pipe", "pipe", "pipe"] });
});
