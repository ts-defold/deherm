import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { renderDmSdkUniversalJsiSource } from "../packages/compiler/src/dmsdk-universal-jsi-source-emitter.mjs";

const report = JSON.parse(
  await readFile(
    new URL("../packages/bindings/generated/defold-dmsdk-universal-bindings.json", import.meta.url),
    "utf8",
  ),
);
const facts = { catalogSha256: report.sourceHashes.catalog };
const oldPipeline = JSON.parse(
  await readFile(new URL("./fixtures/policy-surface-old-pipeline/manifest.json", import.meta.url), "utf8"),
);

test("dmSDK universal JSI source renders exactly from the policy catalog identity", async () => {
  const rendered = renderDmSdkUniversalJsiSource(facts);
  const expected = await readFile(
    new URL("../defold/defold_hermes/src/generated_dmsdk_universal_jsi.cpp", import.meta.url),
    "utf8",
  );
  assert.equal(expected, rendered);
  const frozen = oldPipeline.outputs["defold/defold_hermes/src/generated_dmsdk_universal_jsi.cpp"];
  assert.equal(Buffer.byteLength(rendered), frozen.bytes);
  assert.equal(createHash("sha256").update(rendered).digest("hex"), frozen.sha256);
});

test("dmSDK universal JSI source rejects an invalid catalog identity", () => {
  assert.throws(() => renderDmSdkUniversalJsiSource({ catalogSha256: "stale" }), /catalog SHA-256/u);
});
