import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function json(path) {
  return JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));
}

test("a statically imported binding emits an exact usage manifest", async () => {
  const usage = await json("../dist/sample.usage.json");
  assert.equal(usage.dynamicAccess, false);
  assert.deepEqual(usage.symbols.map(({ id }) => id), ["ExampleMath.add"]);
});

test("the dynamic registry conservatively retains the complete surface", async () => {
  const usage = await json("../dist/binding-benchmark.usage.json");
  assert.equal(usage.dynamicAccess, true);
  assert.deepEqual(usage.symbols.map(({ id }) => id), [
    "ExampleMath.add",
    "ExampleMath.multiply",
    "Timer.delay",
    "Timer.cancel",
    "Timer.trigger"
  ]);
});

test("release binding generation contains only reachable symbols", async () => {
  const root = "../build/profiles/release/";
  const paths = [
    "defold/defold_hermes/include/defold_hermes/generated_modules.h",
    "defold/defold_hermes/src/generated_jsi.cpp",
    "defold/defold_hermes/lib/web/generated_modules.js",
    "packages/static-hermes/src/generated/ffi.js",
    "packages/sdk/src/generated/modules.ts",
    "packages/abi/src/generated/layouts.ts",
    "packages/bindings/generated/symbol-map.json"
  ];
  const [header, jsi, web, staticHermes, sdk, layouts, symbolMap] = await Promise.all(
    paths.map((path) => readFile(new URL(`${root}${path}`, import.meta.url), "utf8"))
  );
  assert.match(header, /defold_hermes_example_math_add/);
  assert.doesNotMatch(header, /defold_hermes_example_math_multiply/);
  assert.doesNotMatch(header, /DefoldHermesVec3/);
  assert.match(jsi, /ExampleMath\.add/);
  assert.doesNotMatch(jsi, /ExampleMath\.multiply/);
  assert.match(web, /defold_hermes_example_math_add/);
  assert.doesNotMatch(web, /defold_hermes_example_math_multiply/);
  assert.match(staticHermes, /defold_hermes_example_math_add/);
  assert.doesNotMatch(staticHermes, /defold_hermes_example_math_multiply/);
  assert.match(sdk, /add\(/);
  assert.doesNotMatch(sdk, /multiply\(/);
  assert.doesNotMatch(layouts, /Vec3Layout/);
  assert.deepEqual(JSON.parse(symbolMap).symbols.map(({ id }) => id), ["ExampleMath.add"]);
});

test("release planning joins the canonical API plan to bundler reachability", async () => {
  const [usage, emission, lowering, scriptProjection] = await Promise.all([
    json("../dist/defold-app.defold-api-usage.json"),
    json("../build/profiles/release/defold-binding-emission-plan.json"),
    json("../packages/bindings/generated/defold-binding-lowering-plan.json"),
    json("../packages/bindings/generated/defold-script-projection-ir.json")
  ]);
  assert.equal(usage.dynamicAccess, true);
  assert.deepEqual(usage.symbols, []);
  assert.equal(emission.sourcePlanSha256, lowering.planSha256);
  assert.equal(emission.sourceAuthorities.scriptProjectionSha256, lowering.inputHashes.scriptProjection);
  const sourceRows = new Map(scriptProjection.rows.map((row, index) => [index, row]));
  const profileSelected = lowering.units.filter((unit) => {
    if (unit.backends.dynamicHermesJsi.selection !== "emit") return false;
    if (unit.identity.surface !== "script") return true;
    const availability = sourceRows.get(unit.sourceRef.row).availability;
    return availability.token === "core" || availability.token === "html5-host" ||
      availability.runtimeProfiles?.includes(emission.profileId) === true;
  }).length;
  assert.equal(emission.treeShaking.selectedForEmissionUnits, profileSelected);
  assert.equal(emission.evidenceBoundary.generation, "planned-not-emitted");
  assert.equal(emission.evidenceBoundary.runtime, "not-claimed");
});
