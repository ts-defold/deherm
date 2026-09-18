import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { generateScriptTableTupleSchemas } from "../scripts/generate-script-table-tuple-schemas.mjs";

const paths = {
  ir: new URL("../packages/bindings/generated/defold-script-api-ir.json", import.meta.url),
  patterns: new URL("../packages/bindings/generated/defold-script-binding-patterns.json", import.meta.url),
  accounting: new URL("../packages/bindings/generated/defold-script-api-accounting.json", import.meta.url),
  overrides: new URL("../packages/bindings/overrides/script-table-tuple-schema-overrides.json", import.meta.url)
};

async function inputs() {
  return Object.fromEntries(await Promise.all(Object.entries(paths).map(async ([name, url]) =>
    [name, await readFile(url, "utf8")]
  )));
}

function mutateJson(text, mutate) {
  const value = JSON.parse(text);
  mutate(value);
  return `${JSON.stringify(value, null, 2)}\n`;
}

test("classifies all 185 pending table and tuple routes exactly once", async () => {
  const report = generateScriptTableTupleSchemas(await inputs());
  assert.equal(report.routeCount, 185);
  assert.deepEqual(report.familyCounts, { "lua-table": 148, "multi-result": 37 });
  assert.equal(new Set(report.rows.map(({ id }) => id)).size, 185);
  assert.equal(new Set(report.rows.map(({ stableId }) => stableId)).size, 185);
  assert.equal(report.mechanicalIrRouteCount, 81);
  assert.equal(report.explicitPolicyRouteCount, 104);
  assert.equal(report.reviewedOverrideCount, 12);
  assert.deepEqual(report.tupleArities, { 2: 29, 3: 5, 4: 3 });
  assert.match(report.evidencePolicy, /does not claim compilation, linkage, packaged-engine execution, or runtime behavior/);
});

test("rejects missing and duplicate accounting classifications", async () => {
  const source = await inputs();
  const missing = {
    ...source,
    accounting: mutateJson(source.accounting, (value) => {
      value.rows = value.rows.filter(({ id }) => id !== "script:b2d.body.compute_aabb");
    })
  };
  assert.throws(() => generateScriptTableTupleSchemas(missing), /lua-table expected count drifted/);

  const duplicate = {
    ...source,
    accounting: mutateJson(source.accounting, (value) => {
      value.rows.push(value.rows.find(({ id }) => id === "script:b2d.body.compute_aabb"));
    })
  };
  assert.throws(() => generateScriptTableTupleSchemas(duplicate), /Duplicate accounting route/);
});

test("rejects structural and reviewed semantic drift", async () => {
  const source = await inputs();
  const structural = {
    ...source,
    ir: mutateJson(source.ir, (value) => {
      const type = value.types.find(({ name }) => name === "b2d.mass_data");
      type.fields.find(({ rawName }) => rawName === "center").rawType = "vector3[]";
    })
  };
  assert.throws(() => generateScriptTableTupleSchemas(structural), /flat-record: expected 57 routes, classified 54/);

  const semantic = {
    ...source,
    overrides: mutateJson(source.overrides, (value) => {
      value.overrides.find(({ id }) => id === "script:resource.set_buffer").parameters[1] = "string";
    })
  };
  assert.throws(() => generateScriptTableTupleSchemas(semantic), /reviewed signature drifted/);
});

test("checked-in schema and documentation artifacts are deterministic", () => {
  execFileSync(process.execPath, ["scripts/generate-script-table-tuple-schemas.mjs", "--check"], {
    cwd: new URL("..", import.meta.url),
    stdio: "pipe"
  });
});
