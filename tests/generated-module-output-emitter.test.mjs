import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  projectGeneratedModuleFacts,
  renderGeneratedModuleOutputs,
} from "../packages/compiler/src/generated-module-output-emitter.mjs";
import {
  generateAbiLayouts,
  generateCHeader,
  generateEmscriptenModules,
  generateJsiHeader,
  generateJsiSource,
  generateStaticHermes,
} from "../scripts/generate-bindings.mjs";

const schema = JSON.parse(await readFile(new URL("../packages/bindings/modules.json", import.meta.url), "utf8"));
const facts = projectGeneratedModuleFacts(schema);
const oldPipeline = new Map([
  ["packages/abi/src/generated/layouts.ts", generateAbiLayouts(schema)],
  ["defold/defold_hermes/include/defold_hermes/generated_modules.h", generateCHeader(schema)],
  ["defold/defold_hermes/include/defold_hermes/generated_jsi.hpp", generateJsiHeader()],
  ["defold/defold_hermes/src/generated_jsi.cpp", generateJsiSource(schema)],
  ["defold/defold_hermes/lib/web/generated_modules.js", generateEmscriptenModules(schema)],
  ["packages/static-hermes/src/generated/ffi.js", generateStaticHermes(schema)],
]);

test("generated module recipe facts keep only ABI-relevant declarations", () => {
  const originalBytes = Buffer.byteLength(JSON.stringify(schema));
  const factBytes = Buffer.byteLength(JSON.stringify(facts));

  assert.ok(factBytes < originalBytes);
  assert.ok(factBytes > 0);
  assert.ok(facts.modules.some((module) => module.functions.some((fn) => fn.callbackFailureValue !== undefined)));
  assert.equal("description" in facts.modules[0], false);
  assert.equal("verification" in facts.modules.find(({ name }) => name === "Timer"), false);
});

test("package emitters preserve exact old-pipeline bytes", async () => {
  const rendered = renderGeneratedModuleOutputs(facts);
  assert.equal(rendered.size, 6);

  for (const [path, contents] of rendered) {
    assert.equal(oldPipeline.get(path), contents, `${path} differs from the old pipeline`);
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
