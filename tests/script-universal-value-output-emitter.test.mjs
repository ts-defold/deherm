import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { renderUniversalValueArtifacts } from "../packages/compiler/src/script-universal-value-output-emitter.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "..");

const outputs = Object.freeze({
  header: "defold/defold_hermes/include/defold_hermes/generated_script_universal_value_bindings.hpp",
  source: "defold/defold_hermes/src/generated_script_universal_value_bindings.cpp",
  cHeader: "defold/defold_hermes/include/defold_hermes/generated_script_universal_value_capi.h",
  cSource: "defold/defold_hermes/src/generated_script_universal_value_capi.cpp",
  staticFrameHeader: "defold/defold_hermes/include/defold_hermes/generated_script_universal_static_frame.h",
  staticFrameSource: "defold/defold_hermes/src/generated_script_universal_static_frame.cpp",
  staticHermes: "packages/static-hermes/src/generated/script-universal-value.ts",
  browser: "defold/defold_hermes/lib/web/generated_script_universal_value.js",
});

test("compiler universal-value renderer reproduces its eight authenticated repository outputs", async () => {
  const [report, layouts] = await Promise.all([
    readJson("packages/bindings/generated/defold-script-universal-value-bindings.json"),
    readJson("packages/bindings/generated/defold-value-layouts.json"),
  ]);
  const rendered = renderUniversalValueArtifacts(report, layouts);
  for (const [key, relative] of Object.entries(outputs)) {
    assert.equal(rendered[key], await readText(relative), `${relative} changed under compiler realization`);
  }
});

async function readJson(relative) {
  return JSON.parse(await readText(relative));
}

async function readText(relative) {
  return readFile(path.join(repositoryRoot, relative), "utf8");
}
