import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { EXPECTED_PROPERTIES, verifyVisualEvidence } from "../integration/vscode-visual-evidence.mjs";

const exampleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.resolve(exampleRoot, "../..");

test("recorded VS Code evidence shows genuine live arena values", async () => {
  const document = JSON.parse(await readFile(path.join(exampleRoot, "evidence/vscode-live-values.json"), "utf8"));
  await verifyVisualEvidence(document, repositoryRoot);
  assert.deepEqual(document.observation.properties, EXPECTED_PROPERTIES);
  assert.equal(document.observation.targetId, "local-engine");
  assert.equal(document.observation.instanceId.slot, 0);
  assert.equal(document.observation.instanceId.generation, 1);
  assert.equal(document.observation.omittedInstanceCount, 0);
  assert.ok(document.observation.projectedInstanceCount > 0);
});
