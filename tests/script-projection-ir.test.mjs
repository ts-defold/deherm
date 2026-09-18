import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  generateScriptProjectionIr,
  inputPaths,
  loadScriptProjectionInputs,
  parseValueShape
} from "../scripts/generate-script-projection-ir.mjs";

const root = new URL("../", import.meta.url);
const inputs = await loadScriptProjectionInputs();
const generated = generateScriptProjectionIr(inputs);
const checked = JSON.parse(await readFile(new URL("packages/bindings/generated/defold-script-projection-ir.json", root), "utf8"));

function replaceJson(text, mutate) {
  const value = JSON.parse(text);
  mutate(value);
  return `${JSON.stringify(value, null, 2)}\n`;
}

test("projects all 926 script APIs exactly once independently of evidence state", () => {
  assert.equal(generated.routeCount, 926);
  assert.deepEqual(generated.generationCounts, { projected: 926 });
  assert.equal(new Set(generated.rows.map(({ id }) => id)).size, 926);
  assert.deepEqual(generated.accountingCounts, {
    "component-property-compiler": 8,
    "executable-stable-id": 915,
    "separate-module": 3
  });
  assert.ok(generated.rows.every(({ generation, evidence }) =>
    generation.state === "projected" && typeof evidence.accountingCategory === "string"));
  assert.deepEqual(checked, generated);
});

test("normalizes the value algebra structurally instead of route-specific hand coding", () => {
  assert.deepEqual(parseValueShape("number|nil"), {
    kind: "optional",
    value: { kind: "scalar", name: "number" }
  });
  assert.deepEqual(parseValueShape("table<hash, vector3[]>"), {
    kind: "map",
    key: { kind: "defold-value", name: "hash" },
    value: { kind: "sequence", element: { kind: "defold-value", name: "vector3" } }
  });
  assert.deepEqual(parseValueShape("{ index?:integer, enabled:boolean }"), {
    kind: "record",
    fields: [
      { name: "index", optional: true, value: { kind: "scalar", name: "integer" } },
      { name: "enabled", optional: false, value: { kind: "scalar", name: "boolean" } }
    ]
  });
  assert.deepEqual(parseValueShape("b2Body", ["handle"]), { kind: "handle", name: "b2Body" });
  assert.deepEqual(parseValueShape("fun(self:script_instance)|nil"), {
    kind: "optional",
    value: {
      kind: "callback",
      parameters: [{ name: "self", optional: false, variadic: false, value: { kind: "named", name: "script_instance" } }],
      returns: []
    }
  });
});

test("carries normalized effects, profiles, targets, and explicit semantic holes", () => {
  const destroy = generated.rows.find(({ id }) => id === "script:b2d.joint.destroy");
  assert.equal(destroy.availability.token, "source-derived-profile-catalog");
  assert.ok(destroy.availability.runtimeProfiles.includes("default-legacy-bullet"));
  assert.ok(destroy.availability.runtimeProfiles.includes("v3-bullet"));
  assert.equal(destroy.effects.ownership.token, "generation-checked-host-handle");
  assert.equal(destroy.context.source, "borrowed-handle-ledger");

  const documentedOnly = generated.rows.find(({ id }) => id === "script:b2d.body.get_user_data");
  assert.deepEqual(documentedOnly.availability.documentedFeatures, ["box2d-v3"]);
  assert.deepEqual(documentedOnly.availability.runtimeFeatures, []);
  assert.equal(documentedOnly.availability.runtimeAvailable, false);

  const v3Only = generated.rows.find(({ id }) => id === "script:b2d.body.create_shape");
  assert.deepEqual(v3Only.availability.runtimeFeatures, ["box2d-v3"]);
  assert.equal(v3Only.effects.ownership.token, "handle-ownership-policy-unresolved");
  assert.equal(v3Only.effects.lifetime.token, "handle-lifetime-policy-unresolved");
  assert.ok(v3Only.generation.semanticHoles.includes("handle-ownership-lifetime-policy"));

  const guiTuple = generated.rows.find(({ id }) => id === "script:gui.get_type");
  assert.equal(guiTuple.context.token, "gui-script-instance");

  const request = generated.rows.find(({ id }) => id === "script:http.request");
  assert.equal(request.effects.callback.token, "retained-lua-closure");
  assert.notEqual(request.effects.callback.lifetime, undefined);

  const unresolved = generated.rows.filter(({ context }) => context.token === "context-policy-unresolved");
  assert.ok(unresolved.length > 0);
  assert.ok(unresolved.every(({ generation }) => generation.semanticHoles.includes("context-policy")));
  assert.ok(generated.semanticHoleCounts["context-policy"] > 0);
});

test("rejects omitted, duplicated, foreign, and stale route inputs", () => {
  const omitted = structuredClone(inputs);
  omitted.patterns = replaceJson(omitted.patterns, (value) => {
    value.bindings.pop();
    value.classifiedFunctionCount -= 1;
  });
  assert.throws(() => generateScriptProjectionIr(omitted), /census is stale|omits/);

  const duplicate = structuredClone(inputs);
  duplicate.accounting = replaceJson(duplicate.accounting, (value) => value.rows.push(value.rows[0]));
  assert.throws(() => generateScriptProjectionIr(duplicate), /duplicate id/);

  const foreign = structuredClone(inputs);
  foreign.callbacks = replaceJson(foreign.callbacks, (value) => value.routes.push({
    ...value.routes[0],
    id: "script:not.real"
  }));
  assert.throws(() => generateScriptProjectionIr(foreign), /absent from script IR/);

  const stale = structuredClone(inputs);
  stale.ir = replaceJson(stale.ir, (value) => value.functions.pop());
  assert.throws(() => generateScriptProjectionIr(stale), /function census drifted/);
});

test("pins every machine-readable input and checks deterministic regeneration", () => {
  assert.deepEqual(Object.keys(generated.inputHashes), Object.keys(inputPaths));
  assert.ok(Object.values(generated.inputHashes).every((hash) => /^[0-9a-f]{64}$/.test(hash)));
  assert.equal(new Set(generated.rows.map(({ stableId }) => stableId)).size, 926);
  execFileSync(process.execPath, ["scripts/generate-script-projection-ir.mjs", "--check"], {
    cwd: root,
    stdio: "pipe"
  });
});
