import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const json = async (relative) => JSON.parse(await readFile(new URL(relative, root), "utf8"));

test("verification status never suppresses Lua API emission machinery", async () => {
  const [ir, accounting, verification, universal, compatibility] = await Promise.all([
    json("packages/bindings/generated/defold-script-api-ir.json"),
    json("packages/bindings/generated/defold-script-api-accounting.json"),
    json("packages/bindings/generated/defold-route-verification.json"),
    json("packages/bindings/generated/defold-script-universal-value-bindings.json"),
    json("packages/bindings/lua-compat.json")
  ]);

  const universalIds = new Set(universal.bindings.map(({ id }) => id));
  const compilerIds = new Set(accounting.rows
    .filter(({ category }) => category === "component-property-compiler")
    .map(({ id }) => id));
  const compatibilityNames = new Set(compatibility.modules.flatMap(({ luaModule, functions }) =>
    functions.map(({ luaFunction }) => `${luaModule}.${luaFunction}`)));
  const separateIds = new Set(ir.functions
    .filter(({ id, rawName }) => accounting.rows.some((row) => row.id === id && row.category === "separate-module")
      && compatibilityNames.has(rawName))
    .map(({ id }) => id));

  const machinery = new Map();
  for (const id of universalIds) machinery.set(id, "universal-runtime-dispatch");
  for (const id of compilerIds) machinery.set(id, "component-property-compiler");
  for (const id of separateIds) machinery.set(id, "specialized-lua-bridge");

  assert.equal(machinery.size, ir.functions.length,
    "every documented Lua route must retain generated machinery regardless of evidence status");
  assert.deepEqual(ir.functions.filter(({ id }) => !machinery.has(id)).map(({ id }) => id), []);
  assert.deepEqual(verification.routes
    .filter(({ status }) => status === "verified")
    .filter(({ id }) => !machinery.has(id))
    .map(({ id }) => id), [], "verification status never grants or removes emission");
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
