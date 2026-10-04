import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  createDmSdkUniversalRecipeFacts,
  emitDmSdkUniversalReport,
} from "../packages/compiler/src/dmsdk-universal-recipe-facts.mjs";
import {
  generateDmSdkUniversalBrowserLibrary,
  generateDmSdkUniversalHeader,
  generateDmSdkUniversalJsiHeader,
  generateDmSdkUniversalRuntimeSource,
} from "../packages/compiler/src/dmsdk-universal-output-emitter.mjs";

const reportSource = await readFile("packages/bindings/generated/defold-dmsdk-universal-bindings.json", "utf8");
const report = JSON.parse(reportSource);

test("dmSDK universal recipe facts losslessly reconstruct the source-derived catalog", () => {
  const facts = createDmSdkUniversalRecipeFacts(report);
  const emitted = `${JSON.stringify(emitDmSdkUniversalReport(facts), null, 2)}\n`;
  assert.equal(emitted, reportSource);
  assert.ok(
    Buffer.byteLength(JSON.stringify(facts)) < Buffer.byteLength(JSON.stringify(report)) * 0.35,
    "interned recipe facts must remain below 35% of the canonical report object",
  );
});

test("package-side dmSDK universal output emitters match the source pipeline", async () => {
  const [header, jsiHeader, runtime, browser] = await Promise.all([
    readFile("defold/defold_hermes/include/defold_hermes/generated_dmsdk_universal.h", "utf8"),
    readFile("defold/defold_hermes/include/defold_hermes/generated_dmsdk_universal_jsi.hpp", "utf8"),
    readFile("defold/defold_hermes/src/generated_dmsdk_universal.cpp", "utf8"),
    readFile("defold/defold_hermes/lib/web/generated_dmsdk_universal.js", "utf8"),
  ]);
  assert.equal(generateDmSdkUniversalHeader(report), header);
  assert.equal(generateDmSdkUniversalJsiHeader(report), jsiHeader);
  assert.equal(generateDmSdkUniversalRuntimeSource(report), runtime);
  assert.equal(generateDmSdkUniversalBrowserLibrary(report), browser);
});

test("dmSDK universal recipe decoder rejects malformed dictionaries", () => {
  const facts = createDmSdkUniversalRecipeFacts(report);
  facts.root[0] = 100_000;
  assert.throws(() => emitDmSdkUniversalReport(facts), /shape is invalid/u);
});
