import assert from "node:assert/strict";
import test from "node:test";

import {
  assertGeneratedDmSdkArtifactInventory,
  runDmSdkCleanRoomRegeneration
} from "../scripts/check-dmsdk-clean-room-regeneration.mjs";
import { generatedDmSdkArtifacts } from "../scripts/lib/dmsdk-generator-pipeline.mjs";

test("dmSDK artifact ownership rejects hand-authored generated output", () => {
  assert.throws(
    () => assertGeneratedDmSdkArtifactInventory([
      ...generatedDmSdkArtifacts,
      "packages/bindings/generated/defold-dmsdk-hand-authored-binding.json"
    ]),
    /Unexpected \(possibly hand-authored\): packages\/bindings\/generated\/defold-dmsdk-hand-authored-binding\.json/
  );
});

test("all generated dmSDK runtime artifacts regenerate byte-for-byte from pinned inputs", async () => {
  const report = await runDmSdkCleanRoomRegeneration();
  assert.equal(report.runtimePendingCount, 1361);
  assert.equal(report.scalarGeneratedCount, 26);
  assert.equal(report.enumGeneratedCount, 7);
  assert.equal(report.fixedDigestGeneratedCount, 4);
  assert.equal(report.base64SpanGeneratedCount, 2);
  assert.equal(report.astcProbeGeneratedCount, 2);
  assert.equal(report.xteaSpanGeneratedCount, 2);
  assert.equal(report.hashSpanGeneratedCount, 2);
  assert.equal(report.arenaSpanCensusCount, 79);
  assert.equal(report.arenaSpanPriorWaveCount, 12);
  assert.equal(report.arenaSpanBlockedCount, 67);
  assert.equal(report.arenaSpanExecutableCount, 0);
  assert.equal(report.namedScalarReviewedCount, 21);
  assert.equal(report.namedScalarGeneratedCount, 0);
  assert.equal(report.namedScalarBlockedCount, 21);
  assert.equal(report.remainingWithoutGeneratedAdapters, 1316);
  assert.equal(report.universalRecipeCount, 1361);
  assert.equal(report.uniqueShapeCount, 888);
  assert.equal(report.trancheCount, 15);
  assert.equal(report.artifactCount, generatedDmSdkArtifacts.length);
  assert.equal(Object.keys(report.artifactSha256).length, generatedDmSdkArtifacts.length);
  assert.match(report.aggregateInputSha256, /^[0-9a-f]{64}$/);
  assert.equal(report.groundTruth.defoldRevision, report.defoldRevision);
});
