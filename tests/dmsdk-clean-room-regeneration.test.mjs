import assert from "node:assert/strict";
import test from "node:test";

import {
  assertGeneratedDmSdkArtifactInventory,
  assertDmSdkSourceCensus,
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

test("dmSDK clean-room census follows synthetic source add/remove drift", () => {
  const source = {
    patterns: { bindings: [{ id: "dmsdk:a" }], coverage: { runtimePendingCount: 1, classifiedCount: 1 } },
    shapes: { rows: [{ id: "dmsdk:a" }], coverage: { runtimePending: 1, shaped: 1 } },
    projection: { rows: [{ id: "dmsdk:a" }], coverage: { classifiedDeclarations: 1, projectedDeclarations: 1, mechanicallyProjected: 1, unprojectedDeclarations: 0, projectionGaps: 0, silentUnknowns: 0 } },
    universal: { recipes: [{ declarationId: "dmsdk:a" }], coverage: { declarations: 1, recipes: 1, cAbiDispatchable: 1, dynamicHermesMetadata: 1, staticHermesDeclarations: 1, browserDirectMemoryMetadata: 1, typescriptStableIds: 1, silentlyOmitted: 0 } }
  };
  assert.equal(assertDmSdkSourceCensus(source), 1);

  const added = structuredClone(source);
  for (const rows of [added.patterns.bindings, added.shapes.rows, added.projection.rows]) rows.push({ id: "dmsdk:b" });
  added.universal.recipes.push({ declarationId: "dmsdk:b" });
  for (const key of ["runtimePendingCount", "classifiedCount"]) added.patterns.coverage[key] += 1;
  for (const key of ["runtimePending", "shaped"]) added.shapes.coverage[key] += 1;
  for (const key of ["classifiedDeclarations", "projectedDeclarations", "mechanicallyProjected"]) added.projection.coverage[key] += 1;
  for (const key of ["declarations", "recipes", "cAbiDispatchable", "dynamicHermesMetadata", "staticHermesDeclarations", "browserDirectMemoryMetadata", "typescriptStableIds"]) added.universal.coverage[key] += 1;
  assert.equal(assertDmSdkSourceCensus(added), 2);

  const removed = structuredClone(added);
  for (const report of [removed.patterns, removed.shapes, removed.projection]) report.bindings ? report.bindings.pop() : report.rows.pop();
  removed.universal.recipes.pop();
  for (const key of ["runtimePendingCount", "classifiedCount"]) removed.patterns.coverage[key] -= 1;
  for (const key of ["runtimePending", "shaped"]) removed.shapes.coverage[key] -= 1;
  for (const key of ["classifiedDeclarations", "projectedDeclarations", "mechanicallyProjected"]) removed.projection.coverage[key] -= 1;
  for (const key of ["declarations", "recipes", "cAbiDispatchable", "dynamicHermesMetadata", "staticHermesDeclarations", "browserDirectMemoryMetadata", "typescriptStableIds"]) removed.universal.coverage[key] -= 1;
  assert.equal(assertDmSdkSourceCensus(removed), 1);
});

test("all generated dmSDK runtime artifacts regenerate byte-for-byte from pinned inputs", async () => {
  const report = await runDmSdkCleanRoomRegeneration();
  assert.ok(report.runtimePendingCount > 0);
  assert.equal(report.scalarGeneratedCount, 26);
  assert.equal(report.enumGeneratedCount, 7);
  assert.equal(report.fixedDigestGeneratedCount, 4);
  assert.equal(report.base64SpanGeneratedCount, 2);
  assert.equal(report.astcProbeGeneratedCount, 2);
  assert.equal(report.xteaSpanGeneratedCount, 2);
  assert.equal(report.hashSpanGeneratedCount, 2);
  assert.equal(report.hashStateGeneratedCount, 10);
  assert.equal(report.arenaSpanCensusCount, 79);
  assert.equal(report.arenaSpanPriorWaveCount, 14);
  assert.equal(report.arenaSpanBlockedCount, 60);
  assert.equal(report.arenaSpanExecutableCount, 5);
  assert.equal(report.namedScalarReviewedCount, 21);
  assert.equal(report.namedScalarGeneratedCount, 20);
  assert.equal(report.namedScalarBlockedCount, 1);
  assert.equal(report.remainingWithoutGeneratedAdapters, 721);
  assert.equal(report.universalRecipeCount, report.runtimePendingCount);
  assert.equal(report.universalReadyExactVectorCount, 566);
  assert.equal(report.uniqueShapeCount, 888);
  assert.equal(report.trancheCount, 15);
  assert.equal(report.artifactCount, generatedDmSdkArtifacts.length);
  assert.equal(Object.keys(report.artifactSha256).length, generatedDmSdkArtifacts.length);
  assert.match(report.aggregateInputSha256, /^[0-9a-f]{64}$/);
  assert.equal(report.groundTruth.defoldRevision, report.defoldRevision);
});
