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

test("release planning takes its Defold reachability from the checker", async () => {
  const [usage, emission, lowering, scriptProjection, projection] = await Promise.all([
    json("../dist/defold-app.defold-api-usage.json"),
    json("../build/profiles/release/defold-binding-emission-plan.json"),
    json("../packages/bindings/generated/defold-binding-lowering-plan.json"),
    json("../packages/bindings/generated/defold-script-projection-ir.json"),
    json("../build/profiles/release/defold-build-projection.json")
  ]);
  assert.equal(emission.sourcePlanSha256, lowering.planSha256);
  assert.equal(emission.sourceAuthorities.scriptProjectionSha256, lowering.inputHashes.scriptProjection);

  // The checker resolves the reachable set; the module graph only confirms it.
  assert.equal(usage.dynamicAccess, false);
  assert.equal(usage.derivation.authority, "ttsc-checker-symbol-resolution");
  assert.equal(usage.derivation.crossCheck.status, "agree");
  assert.ok(usage.symbols.length > 0, "a program that calls the Defold API resolves routes");
  assert.deepEqual(usage.symbols, [...usage.symbols].sort());
  assert.equal(emission.usage.authority, "ttsc-checker-symbol-resolution");
  assert.equal(emission.usage.crossCheck, "agree");
  assert.equal(emission.treeShaking.selectedForEmissionUnits, usage.symbols.length);

  // Module granularity retains every route of every namespace it keeps, which
  // is why it can only ever be the cross-check.
  const crossCheck = usage.derivation.crossCheck;
  assert.ok(crossCheck.bundleRoutes > crossCheck.checkerRoutes);
  assert.deepEqual(crossCheck.bundleNamespaces, crossCheck.checkerNamespaces);

  // The pruned set is a small fraction of the emittable surface.
  const profileAvailable = lowering.units.filter((unit) => {
    if (unit.backends.dynamicHermesJsi.selection !== "emit") return false;
    if (unit.identity.surface !== "script") return true;
    const availability = scriptProjection.rows[unit.sourceRef.row].availability;
    return availability.token === "core" || availability.token === "html5-host" ||
      availability.runtimeProfiles?.includes(emission.profileId) === true;
  }).length;
  assert.ok(emission.treeShaking.selectedForEmissionUnits * 10 < profileAvailable,
    "a real program must reach far less than the complete Defold surface");
  assert.equal(emission.evidenceBoundary.generation, "planned-not-emitted");
  assert.equal(emission.evidenceBoundary.runtime, "not-claimed");

  // Every layer is pruned from the one set.
  const reachability = projection.canonicalDefoldApi.reachability;
  assert.deepEqual(reachability.reachableRouteIds, usage.symbols);
  assert.equal(reachability.crossCheck, "agree");
  assert.equal(projection.typedNativeLane.status, "reachable-subset-emitted");
});
