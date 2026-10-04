import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  createScriptValueBindingRecipeFacts,
  renderScriptValueBindingOutputs,
  validateScriptValueBindingRecipeFacts,
} from "../packages/compiler/src/script-value-binding-output-emitter.mjs";
import { generate, loadGenerationInputs } from "../scripts/generate-script-value-bindings.mjs";

test("script value binding emitter preserves every checked-in artifact byte for byte", async () => {
  const { irText, scalarDispatchText, patternsText, inputs } = await loadGenerationInputs();
  const outputs = generate(irText, scalarDispatchText, patternsText, inputs);
  const facts = createScriptValueBindingRecipeFacts(JSON.parse(outputs.report));
  assert.equal(validateScriptValueBindingRecipeFacts(facts), facts);
  assert.deepEqual(renderScriptValueBindingOutputs(facts), {
    header: outputs.header,
    source: outputs.source,
    targetSupportSource: outputs.targetSupportSource,
  });
  const duplicateOperationFacts = structuredClone(facts);
  duplicateOperationFacts.operations.push(duplicateOperationFacts.operations[0]);
  assert.throws(
    () => validateScriptValueBindingRecipeFacts(duplicateOperationFacts),
    /intern table contains duplicates/u,
  );
  const expected = [
    ["packages/bindings/generated/defold-script-value-bindings.json", outputs.report],
    ["defold/defold_hermes/include/defold_hermes/generated_script_value_bindings.hpp", outputs.header],
    ["defold/defold_hermes/src/generated_script_value_bindings.cpp", outputs.source],
    ["packages/sdk/src/generated/script/value-target-support.ts", outputs.targetSupportSource],
  ];

  for (const [path, generated] of expected) {
    assert.equal(await readFile(new URL(`../${path}`, import.meta.url), "utf8"), generated, `${path} changed`);
  }
});
