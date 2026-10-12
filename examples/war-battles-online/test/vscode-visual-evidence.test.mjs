import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  EXPECTED_LIVE_PROPERTIES,
  EXPECTED_PROPERTY_DEFAULTS,
  VISUAL_EVIDENCE_SOURCE_PATHS,
  requireInlineValueRows,
  verifyVisualEvidence,
} from "../integration/vscode-visual-evidence.mjs";

const exampleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.resolve(exampleRoot, "../..");

test("recorded VS Code evidence shows genuine live arena values", async () => {
  const document = JSON.parse(await readFile(path.join(exampleRoot, "evidence/vscode-live-values.json"), "utf8"));
  await verifyVisualEvidence(document, repositoryRoot);
  assert.deepEqual(document.observation.properties, EXPECTED_LIVE_PROPERTIES);
  assert.deepEqual(
    document.observation.inlineValueTexts,
    Object.values(EXPECTED_PROPERTY_DEFAULTS).map((value) => `= ${value}`),
  );
  assert.equal(document.observation.targetId, "local-engine");
  assert.equal(document.observation.instanceId.slot, 0);
  assert.equal(document.observation.instanceId.generation, 1);
  assert.equal(document.observation.omittedInstanceCount, 0);
  assert.ok(document.observation.projectedInstanceCount > 0);
  assert.deepEqual(
    document.sourceInputs.map((input) => input.path),
    VISUAL_EVIDENCE_SOURCE_PATHS,
  );
});

test("inline default evidence must share each visible property declaration row", () => {
  const rows = Object.entries(EXPECTED_PROPERTY_DEFAULTS)
    .map(([name, value]) => `${name}: property.number(${value}), = ${value}`)
    .join("\n");
  assert.deepEqual(
    requireInlineValueRows(rows),
    Object.values(EXPECTED_PROPERTY_DEFAULTS).map((value) => `= ${value}`),
  );
  assert.throws(
    () =>
      requireInlineValueRows(rows.replace("players: property.number(16), = 16", "players: property.number(16), = 8")),
    /inline players value on its declaration/u,
  );
});
