import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { generate, loadInputs } from "../scripts/generate-dmsdk-arena-span-blockers.mjs";

const root = new URL("../", import.meta.url);

function withJson(text, mutate) {
  const value = JSON.parse(text);
  mutate(value);
  return `${JSON.stringify(value, null, 2)}\n`;
}

test("arena-span blocker ledger is deterministic, complete, and metadata-only", async () => {
  execFileSync(process.execPath, ["scripts/generate-dmsdk-arena-span-blockers.mjs", "--check"], {
    cwd: root,
    stdio: "pipe"
  });
  const report = JSON.parse(await readFile(
    new URL("bindings/generated/defold-dmsdk-arena-span-blockers.json", root),
    "utf8"
  ));
  assert.deepEqual(report.coverage, {
    arenaSpanCensus: 79,
    coveredByPriorWaves: 10,
    blocked: 69,
    executableAdaptersEmitted: 0,
    overlap: 0,
    unaccounted: 0
  });
  assert.deepEqual(report.partitionSummary, {
    "cstring-termination-or-capacity-policy": 5,
    "handle-provenance-or-engine-context": 33,
    "hash-buffer-runtime-and-allocation-evidence": 2,
    "opaque-byte-pointee-unit-or-lifetime": 4,
    "record-layout-or-borrowed-record-lifetime": 19,
    "template-element-layout-or-specialization": 6
  });
  const priorIds = new Set(report.coveredByPriorWaves.map(({ id }) => id));
  const blockedIds = new Set(report.declarations.map(({ id }) => id));
  assert.equal(priorIds.size, 10);
  assert.equal(blockedIds.size, 69);
  assert.equal([...priorIds].some((id) => blockedIds.has(id)), false);
  assert.equal(Object.values(report.partitionSummary).reduce((sum, count) => sum + count, 0), 69);
  for (const declaration of report.declarations) {
    assert.equal(declaration.disposition, "blocked");
    assert.equal(declaration.stages.generated, "not-applicable");
    assert.equal(declaration.stages.runtime, "not-claimed");
    assert.equal(declaration.stages.allocation, "not-claimed");
  }
});

test("arena-span blocker generator rejects schema, revision, provenance, and duplicate drift", async () => {
  const inputs = await loadInputs();
  assert.throws(() => generate({
    ...inputs,
    policyText: withJson(inputs.policyText, (policy) => { policy.schemaVersion = 2; })
  }), /schemaVersion must be 1/);
  assert.throws(() => generate({
    ...inputs,
    policyText: withJson(inputs.policyText, (policy) => { policy.defoldRevision = "0".repeat(40); })
  }), /different Defold revisions/);
  assert.throws(() => generate({
    ...inputs,
    shapesText: withJson(inputs.shapesText, (shapes) => { shapes.sourceHashes.ir = "0".repeat(64); })
  }), /IR hash does not match ABI-shape census provenance/);
  assert.throws(() => generate({
    ...inputs,
    shapesText: withJson(inputs.shapesText, (shapes) => { shapes.rows.push(structuredClone(shapes.rows[0])); })
  }), /contains duplicate/);
});

test("arena-span blocker policy must exactly name generated prior-wave symbols", async () => {
  const inputs = await loadInputs();
  assert.throws(() => generate({
    ...inputs,
    policyText: withJson(inputs.policyText, (policy) => { policy.coveredByPriorWaves.pop(); })
  }), /does not exactly match generated prior-wave symbols/);
  const priorWaveTexts = new Map(inputs.priorWaveTexts);
  const [path, text] = priorWaveTexts.entries().next().value;
  priorWaveTexts.set(path, withJson(text, (report) => { report.sourceHashes.shapes = "0".repeat(64); }));
  assert.throws(() => generate({ ...inputs, priorWaveTexts }), /ABI-shape provenance drifted/);
});
