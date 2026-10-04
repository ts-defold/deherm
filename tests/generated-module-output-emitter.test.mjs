import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  projectGeneratedModuleFacts,
  renderGeneratedModuleOutputs,
} from "../packages/compiler/src/generated-module-output-emitter.mjs";
const schema = JSON.parse(await readFile(new URL("../packages/bindings/modules.json", import.meta.url), "utf8"));
const facts = projectGeneratedModuleFacts(schema);
const oldPipeline = JSON.parse(
  await readFile(new URL("./fixtures/policy-surface-old-pipeline/manifest.json", import.meta.url), "utf8"),
);

function assertFrozenOutput(path, contents) {
  const expected = oldPipeline.outputs[path];
  assert.ok(expected, `${path} is absent from the frozen old-pipeline fixture`);
  assert.equal(Buffer.byteLength(contents), expected.bytes, `${path} old-pipeline byte count changed`);
  assert.equal(
    createHash("sha256").update(contents).digest("hex"),
    expected.sha256,
    `${path} old-pipeline bytes changed`,
  );
}

test("generated module recipe facts keep only ABI-relevant declarations", () => {
  const originalBytes = Buffer.byteLength(JSON.stringify(schema));
  const factBytes = Buffer.byteLength(JSON.stringify(facts));

  assert.ok(factBytes < originalBytes);
  assert.ok(factBytes > 0);
  assert.ok(facts.modules.some((module) => module.functions.some((fn) => fn.callbackFailureValue !== undefined)));
  assert.equal("description" in facts.modules[0], false);
  assert.equal("verification" in facts.modules.find(({ name }) => name === "Timer"), false);
});

test("package emitters preserve frozen old-pipeline bytes and checked-in outputs", async () => {
  const rendered = renderGeneratedModuleOutputs(facts);
  assert.equal(rendered.size, 6);

  for (const [path, contents] of rendered) {
    assertFrozenOutput(path, contents);
    assert.equal(await readFile(new URL(`../${path}`, import.meta.url), "utf8"), contents, `${path} is stale`);
  }
});

test("generated module facts fail closed on invalid C ABI names and types", () => {
  const invalidSymbol = structuredClone(facts);
  invalidSymbol.modules[0].functions[0].symbol = "not-valid-symbol";
  assert.throws(() => renderGeneratedModuleOutputs(invalidSymbol), /symbol.*identifier/u);

  const invalidType = structuredClone(facts);
  invalidType.modules[0].functions[0].parameters[0].type = "pointer";
  assert.throws(() => renderGeneratedModuleOutputs(invalidType), /invalid or duplicate parameter/u);
});
