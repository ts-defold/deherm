import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const json = async (relative) => JSON.parse(await readFile(new URL(relative, root), "utf8"));

test("verification status never suppresses Lua API emission machinery", async () => {
  const [ir, accounting, verification, universal, constantLowering, compatibility, specialCalls] = await Promise.all([
    json("packages/bindings/generated/defold-script-api-ir.json"),
    json("packages/bindings/generated/defold-script-api-accounting.json"),
    json("packages/bindings/generated/defold-route-verification.json"),
    json("packages/bindings/generated/defold-script-universal-value-bindings.json"),
    json("packages/bindings/generated/defold-script-constant-lowering.json"),
    json("packages/bindings/lua-compat.json"),
    json("packages/bindings/generated/defold-script-special-call-verification.json")
  ]);

  const universalFunctionIds = new Set(universal.bindings
    .filter(({ loweringFamily }) => loweringFamily !== "script-constant")
    .map(({ id }) => id));
  const universalConstantIds = new Set(universal.bindings
    .filter(({ loweringFamily }) => loweringFamily === "script-constant")
    .map(({ id }) => id));
  const compilerIds = new Set(accounting.rows
    .filter(({ category }) => category === "component-property-compiler")
    .map(({ id }) => id));
  const compatibilityNames = new Set(compatibility.modules.flatMap(({ luaModule, functions }) =>
    functions.map(({ luaFunction }) => `${luaModule}.${luaFunction}`)));
  const separateIds = new Set(ir.functions
    .filter(({ id, rawName }) => accounting.rows.some((row) => row.id === id && row.category === "separate-module")
      && compatibilityNames.has(rawName))
    .map(({ id }) => id));
  assert.deepEqual(
    specialCalls.compilerIntrinsics.map(({ id }) => id).sort(),
    [...compilerIds].sort(),
    "every compiler intrinsic must have an exact generated declaration vector"
  );
  assert.deepEqual(
    specialCalls.separateModules.map(({ id }) => id).sort(),
    [...separateIds].sort(),
    "every separate module must have generated specialized-bridge inventory"
  );

  const machinery = new Map();
  for (const id of universalFunctionIds) machinery.set(id, "universal-runtime-dispatch");
  for (const id of compilerIds) machinery.set(id, "component-property-compiler");
  for (const id of separateIds) machinery.set(id, "specialized-lua-bridge");

  assert.equal(machinery.size, ir.functions.length,
    "every documented Lua function must retain generated machinery regardless of evidence status");
  assert.deepEqual(ir.functions.filter(({ id }) => !machinery.has(id)).map(({ id }) => id), []);
  assert.deepEqual(verification.routes
    .filter(({ status }) => status === "verified")
    .filter(({ id }) => !machinery.has(id))
    .map(({ id }) => id), [], "verification status never grants or removes emission");

  const constantEntries = constantLowering.entries;
  const constantStates = new Set(["inlined", "runtime-backed", "profile-unavailable"]);
  assert.equal(constantEntries.length, 483, "the generated constant policy must cover every documented constant");
  assert.equal(new Set(constantEntries.map(({ name }) => name)).size, constantEntries.length,
    "constant policy names must be unique");
  assert.deepEqual(constantLowering.counts, {
    total: constantEntries.length,
    inlined: constantEntries.filter(({ state }) => state === "inlined").length,
    runtimeBacked: constantEntries.filter(({ state }) => state === "runtime-backed").length,
    profileUnavailable: constantEntries.filter(({ state }) => state === "profile-unavailable").length,
    impossible: constantEntries.filter(({ state }) => state === "impossible").length
  });
  assert.ok(constantEntries.every(({ state }) => constantStates.has(state)),
    "constant policy must not silently suppress or invent an unclassified state");
  assert.ok(constantEntries.every((entry) => Number.isInteger(entry.stableId) && entry.stableId > 0 &&
    Array.isArray(entry.profiles) && entry.profiles.length === constantLowering.targets.length &&
    entry.profiles.every((profile) => typeof profile.id === "string" &&
      typeof profile.registered === "boolean")),
  "every constant must retain stable identity and selected-profile metadata");
  const runtimeConstantEntries = constantEntries.filter(({ state }) => state !== "inlined");
  assert.deepEqual(
    new Set(runtimeConstantEntries.map(({ name }) => `script:constant.${name}`)),
    universalConstantIds,
    "every non-inlined constant must retain generated universal machinery, and no extra constant route may exist"
  );
  assert.ok(constantEntries.filter(({ state }) => state === "inlined").every(({ value, profiles }) =>
    value !== undefined && profiles.every((profile) => profile.registered && profile.value === value)),
  "inlined constants must carry the same value in every selected profile");
  assert.ok(constantEntries.filter(({ state }) => state === "profile-unavailable").every(({ blocker }) =>
    blocker?.code === "constant-not-registered"),
  "profile-unavailable constants must retain a machine-readable blocker");
});

test("every runtime dmSDK declaration has a materializable generated recipe", async () => {
  const [projection, universal] = await Promise.all([
    json("packages/bindings/generated/defold-dmsdk-projection-ir.json"),
    json("packages/bindings/generated/defold-dmsdk-universal-bindings.json")
  ]);
  const projected = new Set(projection.rows.map(({ id }) => id));
  const recipes = new Map(universal.recipes.map((recipe) => [recipe.declarationId, recipe]));

  assert.equal(projected.size, projection.coverage.classifiedDeclarations);
  assert.equal(recipes.size, projected.size,
    "every projected runtime dmSDK declaration must have generated materialization machinery");
  assert.deepEqual([...projected].filter((id) => !recipes.has(id)), []);
  assert.ok([...recipes.values()].every(({ fallback }) =>
    fallback.state === "materializable" && fallback.silentOmissionAllowed === false));
});
