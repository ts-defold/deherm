import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { renderDmSdkCStringValueOutputs } from "../packages/compiler/src/dmsdk-cstring-value-output-emitter.mjs";
import { renderDmSdkEnumValueOutputs } from "../packages/compiler/src/dmsdk-enum-value-output-emitter.mjs";
import { renderDmSdkNamedScalarOutputs } from "../packages/compiler/src/dmsdk-named-scalar-output-emitter.mjs";
import { renderDmSdkScalarOutputs } from "../packages/compiler/src/dmsdk-scalar-output-emitter.mjs";

const root = new URL("../", import.meta.url);
const loadJson = async (relative) => JSON.parse(await readFile(new URL(relative, root), "utf8"));
const digest = (source) => createHash("sha256").update(source).digest("hex");

async function assertOldPipelineBytes(outputs) {
  const fixture = await loadJson("tests/fixtures/policy-surface-old-pipeline/manifest.json");
  for (const [relative, source] of Object.entries(outputs)) {
    const canonical = await readFile(new URL(relative, root), "utf8");
    assert.equal(source, canonical, `${relative}: compiler emitter changed canonical bytes`);
    assert.equal(
      Buffer.byteLength(source),
      fixture.outputs[relative].bytes,
      `${relative}: old-pipeline byte count changed`,
    );
    assert.equal(digest(source), fixture.outputs[relative].sha256, `${relative}: old-pipeline bytes changed`);
  }
}

async function assertOldPipelineSdkBytes(outputs) {
  const fixture = await loadJson("tests/fixtures/policy-surface-old-pipeline/manifest.json");
  for (const [relative, source] of Object.entries(outputs)) {
    const repositoryPath = `packages/sdk/src/generated/${relative}`;
    const canonical = await readFile(new URL(repositoryPath, root), "utf8");
    assert.equal(source, canonical, `${repositoryPath}: compiler emitter changed canonical bytes`);
    assert.equal(
      Buffer.byteLength(source),
      fixture.files[relative].bytes,
      `${relative}: old-pipeline byte count changed`,
    );
    assert.equal(digest(source), fixture.files[relative].sha256, `${relative}: old-pipeline bytes changed`);
  }
}

test("dmSDK scalar compiler emitter reproduces all revision outputs", async () => {
  const output = renderDmSdkScalarOutputs(
    await loadJson("packages/bindings/generated/defold-dmsdk-scalar-recipe-facts.json"),
  );
  await assertOldPipelineBytes({
    "defold/defold_hermes/include/defold_hermes/generated_dmsdk_scalar.h": output.header,
    "defold/defold_hermes/src/generated_dmsdk_scalar_bindings.cpp": output.source,
    "defold/defold_hermes/include/defold_hermes/generated_dmsdk_scalar_runtime.h": output.runtimeHeader,
    "defold/defold_hermes/src/generated_dmsdk_scalar_runtime.cpp": output.runtime,
    "defold/defold_hermes/src/generated_dmsdk_scalar_jsi.cpp": output.jsi,
    "defold/defold_hermes/lib/web/generated_dmsdk_scalar.js": output.browser,
  });
  await assertOldPipelineSdkBytes({ "dmsdk/scalar.ts": output.typescript });
});

test("dmSDK named-scalar compiler emitter reproduces recipe-dependent revision outputs", async () => {
  const output = renderDmSdkNamedScalarOutputs(
    await loadJson("packages/bindings/generated/defold-dmsdk-named-scalar-recipe-facts.json"),
  );
  await assertOldPipelineBytes({
    "defold/defold_hermes/include/defold_hermes/generated_dmsdk_named_scalar.h": output.header,
    "defold/defold_hermes/src/generated_dmsdk_named_scalar_runtime.cpp": output.runtime,
  });
});

test("dmSDK enum-value compiler emitter reproduces all recipe-dependent revision outputs", async () => {
  const output = renderDmSdkEnumValueOutputs(
    await loadJson("packages/bindings/generated/defold-dmsdk-enum-value-recipe-facts.json"),
  );
  const outputs = {
    "defold/defold_hermes/include/defold_hermes/generated_dmsdk_enum_value.h": output.header,
    "defold/defold_hermes/include/defold_hermes/generated_dmsdk_enum_value_runtime.h": output.runtimeHeader,
    "defold/defold_hermes/src/generated_dmsdk_enum_value_runtime.cpp": output.runtime,
    "defold/defold_hermes/src/generated_dmsdk_enum_value_jsi.cpp": output.jsi,
  };
  for (const [group, source] of Object.entries(output.sources)) {
    outputs[`defold/defold_hermes/src/generated_dmsdk_enum_value_${group}.cpp`] = source;
  }
  await assertOldPipelineBytes(outputs);
  await assertOldPipelineSdkBytes({ "dmsdk/enum-value.ts": output.typescript });
});

test("dmSDK C-string/value compiler emitter reproduces all recipe-dependent revision outputs", async () => {
  const output = renderDmSdkCStringValueOutputs(
    await loadJson("packages/bindings/generated/defold-dmsdk-cstring-value-recipe-facts.json"),
  );
  await assertOldPipelineBytes({
    "defold/defold_hermes/include/defold_hermes/generated_dmsdk_cstring_value.h": output.header,
    "defold/defold_hermes/src/generated_dmsdk_cstring_value_runtime.cpp": output.runtime,
    "defold/defold_hermes/src/generated_dmsdk_cstring_value.cpp": output.native,
    "defold/defold_hermes/src/generated_dmsdk_cstring_value_jsi.cpp": output.jsi,
    "defold/defold_hermes/lib/web/generated_dmsdk_cstring_value.js": output.browser,
  });
  await assertOldPipelineSdkBytes({ "dmsdk/cstring-value.ts": output.typescript });
});
