import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { classifyScriptBindings } from "../scripts/classify-script-bindings.mjs";

const root = new URL("../", import.meta.url);
const irSource = await readFile(new URL("bindings/generated/defold-script-api-ir.json", root), "utf8");
const ir = JSON.parse(irSource);
const checkedIn = JSON.parse(await readFile(new URL("bindings/generated/defold-script-binding-patterns.json", root), "utf8"));
const generated = classifyScriptBindings(ir, irSource);

test("classifies every pending script function exactly once", () => {
  const pendingIds = ir.functions
    .filter((entry) => entry.runtimeStatus === "requires-universal-lua-bridge")
    .map((entry) => entry.id)
    .sort((left, right) => left.localeCompare(right));
  const classifiedIds = generated.bindings.map((entry) => entry.id);
  assert.equal(pendingIds.length, 923);
  assert.deepEqual(classifiedIds, pendingIds);
  assert.equal(new Set(classifiedIds).size, classifiedIds.length);
  assert.equal(generated.families.reduce((sum, family) => sum + family.count, 0), pendingIds.length);
  assert.deepEqual(
    Object.fromEntries(generated.families.map(({ name, count }) => [name, count])),
    {
      "dynamic-values": 14,
      "callback-lifecycle": 25,
      "overload-dispatch": 23,
      "multi-result": 37,
      "lua-table": 151,
      "borrowed-handle": 456,
      "defold-value": 127,
      scalar: 90
    }
  );
});

test("keeps the generated classification deterministic", () => {
  assert.deepEqual(checkedIn, generated);
  assert.equal(generated.coverageClaim, "classification only; no executable binding coverage is claimed");
});

test("check mode accepts the current checked-in artifact", () => {
  execFileSync(process.execPath, ["scripts/classify-script-bindings.mjs", "--check"], {
    cwd: new URL("../", import.meta.url),
    stdio: "pipe"
  });
});

test("recognizes representative lowering families", () => {
  const byId = new Map(generated.bindings.map((entry) => [entry.id, entry]));
  assert.equal(byId.get("script:bit.band").loweringFamily, "dynamic-values");
  assert.equal(byId.get("script:collectionfactory.load").loweringFamily, "callback-lifecycle");
  assert.equal(byId.get("script:vmath.lerp").loweringFamily, "overload-dispatch");
  assert.equal(byId.get("script:window.get_size").loweringFamily, "multi-result");
  assert.equal(byId.get("script:json.decode").loweringFamily, "dynamic-values");
  assert.equal(byId.get("script:b2d.body.get_position").loweringFamily, "borrowed-handle");
  assert.equal(byId.get("script:vmath.cross").loweringFamily, "defold-value");
  assert.equal(byId.get("script:bit.bnot").loweringFamily, "scalar");
});

test("surfaces unresolved and policy-sensitive evidence", () => {
  for (const evidence of generated.ambiguityEvidence) {
    assert.ok(evidence.source);
    assert.ok(Number.isInteger(evidence.line));
    assert.ok(evidence.traits.length > 0 || evidence.unresolvedTypes.length > 0);
  }
  const unresolvedFromBindings = [...new Set(generated.bindings.flatMap((entry) => entry.unresolvedTypes))].sort();
  assert.deepEqual(generated.unresolvedTypes, unresolvedFromBindings);
  assert.equal(generated.unresolvedTypeCount, 0);
  assert.equal(generated.ambiguousBindingCount, 262);
});
