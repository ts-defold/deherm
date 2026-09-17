import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  computeLayouts,
  filterSchemaForUsage,
  generateArtifacts,
  validateSchema
} from "../scripts/generate-bindings.mjs";

const schema = JSON.parse(
  await readFile(new URL("../bindings/modules.json", import.meta.url), "utf8")
);

test("the binding IR computes deterministic, C-compatible layouts", () => {
  const [vec3] = computeLayouts(validateSchema(structuredClone(schema)));
  assert.equal(vec3.size, 12);
  assert.equal(vec3.align, 4);
  assert.deepEqual(vec3.fields.map(({ name, offset }) => [name, offset]), [
    ["x", 0],
    ["y", 4],
    ["z", 8]
  ]);
});

test("one IR emits every runtime binding surface", () => {
  const artifacts = generateArtifacts(schema);
  assert.deepEqual([...artifacts.keys()], [
    "packages/sdk/src/generated/modules.ts",
    "packages/abi/src/generated/layouts.ts",
    "defold/defold_hermes/include/defold_hermes/generated_modules.h",
    "defold/defold_hermes/include/defold_hermes/generated_jsi.hpp",
    "defold/defold_hermes/src/generated_jsi.cpp",
    "defold/defold_hermes/lib/web/generated_modules.js",
    "packages/static-hermes/src/generated/ffi.js",
    "bindings/generated/symbol-map.json",
    "packages/sdk/src/generated/modules/ExampleMath.ts",
    "packages/sdk/src/generated/functions/ExampleMath/add.ts",
    "packages/sdk/src/generated/functions/ExampleMath/multiply.ts",
    "packages/sdk/src/generated/modules/Timer.ts",
    "packages/sdk/src/generated/functions/Timer/delay.ts",
    "packages/sdk/src/generated/functions/Timer/cancel.ts",
    "packages/sdk/src/generated/functions/Timer/trigger.ts"
  ]);
  assert.match(artifacts.get("defold/defold_hermes/src/generated_jsi.cpp"), /createFromHostFunction/);
  assert.match(artifacts.get("packages/static-hermes/src/generated/ffi.js"), /\$SHBuiltin\.extern_c/);
  assert.match(artifacts.get("packages/abi/src/generated/layouts.ts"), /memory\.f32/);
  assert.match(artifacts.get("defold/defold_hermes/lib/web/generated_modules.js"), /_defold_hermes_example_math_add/);
});

test("a usage manifest filters every generated runtime projection", () => {
  const selected = filterSchemaForUsage(schema, {
    schemaVersion: 1,
    dynamicAccess: false,
    symbols: [{ id: "ExampleMath.add" }]
  });
  const artifacts = generateArtifacts(selected);
  assert.match(artifacts.get("defold/defold_hermes/include/defold_hermes/generated_modules.h"), /example_math_add/);
  assert.doesNotMatch(artifacts.get("defold/defold_hermes/include/defold_hermes/generated_modules.h"), /example_math_multiply/);
  assert.ok(artifacts.has("packages/sdk/src/generated/functions/ExampleMath/add.ts"));
  assert.ok(!artifacts.has("packages/sdk/src/generated/functions/ExampleMath/multiply.ts"));
});

test("the compiler rejects ambiguous and unsupported ABI types", () => {
  const invalid = structuredClone(schema);
  invalid.modules[0].functions[0].parameters[0].type = "number";
  assert.throws(() => validateSchema(invalid), /unsupported parameter type "number"/);
});

test("multi-callback acquisition rolls back earlier rooted callbacks", () => {
  const multipleCallbacks = {
    schemaVersion: 1,
    abiVersion: 1,
    types: [],
    modules: [{
      name: "Events",
      functions: [{
        name: "subscribePair",
        parameters: [
          { name: "first", type: "callback" },
          { name: "second", type: "callback" }
        ],
        returns: "u32",
        callbackFailureValue: 4294967295
      }]
    }]
  };

  const artifacts = generateArtifacts(multipleCallbacks);
  const jsi = artifacts.get("defold/defold_hermes/src/generated_jsi.cpp");
  const web = artifacts.get("defold/defold_hermes/lib/web/generated_modules.js");
  assert.match(jsi, /if \(!second_handle\) \{\n          callbacks\.release\(first_handle\);/);
  assert.match(web, /catch \(error\) \{\n              DEFOLD_HERMES_WEB_CALLBACKS\.release\(firstHandle\);/);
});

test("large binding surfaces generate quickly", () => {
  const synthetic = {
    schemaVersion: 1,
    abiVersion: 1,
    types: Array.from({ length: 100 }, (_, index) => ({
      kind: "struct",
      name: `Record${index}`,
      fields: Array.from({ length: 12 }, (__, field) => ({ name: `field${field}`, type: "f32" }))
    })),
    modules: Array.from({ length: 100 }, (_, module) => ({
      name: `Module${module}`,
      functions: Array.from({ length: 20 }, (__, fn) => ({
        name: `method${fn}`,
        parameters: [{ name: "value", type: "f64" }],
        returns: "f64"
      }))
    }))
  };

  generateArtifacts(synthetic);
  const start = performance.now();
  for (let iteration = 0; iteration < 10; iteration += 1) generateArtifacts(synthetic);
  const elapsed = performance.now() - start;
  assert.ok(elapsed < 2_000, `10 large codegen passes took ${elapsed.toFixed(1)}ms`);
});
