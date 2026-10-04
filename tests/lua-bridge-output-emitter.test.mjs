import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { projectLuaBridgeFacts, renderLuaBridgeOutputs } from "../packages/compiler/src/lua-bridge-output-emitter.mjs";

const schema = JSON.parse(await readFile(new URL("../packages/bindings/lua-compat.json", import.meta.url), "utf8"));
const oldPipeline = JSON.parse(
  await readFile(new URL("./fixtures/policy-surface-old-pipeline/manifest.json", import.meta.url), "utf8"),
);
const facts = projectLuaBridgeFacts(schema);

function assertFrozenOutput(path, contents) {
  const expected = oldPipeline.outputs[path];
  assert.ok(expected, `${path} is absent from the frozen old-pipeline fixture`);
  assert.equal(Buffer.byteLength(contents), expected.bytes, `${path} old-pipeline byte count changed`);
  assert.equal(createHash("sha256").update(contents).digest("hex"), expected.sha256, `${path} bytes changed`);
}

test("Lua bridge projection retains the complete compact ABI and Lua call schema", () => {
  assert.equal(facts.modules.length, schema.modules.length);
  assert.ok(facts.modules.some((module) => module.functions.some(({ timerOperation }) => timerOperation === "delay")));
  assert.ok(
    facts.modules
      .flatMap(({ functions }) => functions)
      .some(({ parameters }) => parameters.some(({ type }) => type === "callback")),
  );
});

test("Lua bridge emitters preserve frozen old-pipeline bytes and checked-in outputs", async () => {
  const rendered = renderLuaBridgeOutputs(facts);
  assert.equal(rendered.size, 2);
  for (const [path, contents] of rendered) {
    assertFrozenOutput(path, contents);
    assert.equal(await readFile(new URL(`../${path}`, import.meta.url), "utf8"), contents, `${path} is stale`);
  }
});

test("Lua bridge facts reject unsupported argument and return domains", () => {
  const invalidParameter = structuredClone(facts);
  invalidParameter.modules[0].functions[0].parameters[0].type = "userdata";
  assert.throws(() => renderLuaBridgeOutputs(invalidParameter), /invalid parameter fact/u);

  const invalidReturn = structuredClone(facts);
  invalidReturn.modules[0].functions[0].returns = "userdata";
  assert.throws(() => renderLuaBridgeOutputs(invalidReturn), /invalid signature facts/u);
});
