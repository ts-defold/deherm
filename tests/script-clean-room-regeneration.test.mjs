import assert from "node:assert/strict";
import test from "node:test";

import {
  assertGeneratedArtifactInventory,
  generatedScriptArtifacts,
  runScriptCleanRoomRegeneration
} from "../scripts/check-script-clean-room-regeneration.mjs";

test("generated artifact inventory rejects per-route hand-authored output", () => {
  assert.throws(
    () => assertGeneratedArtifactInventory([
      ...generatedScriptArtifacts,
      "packages/bindings/generated/defold-script-hand-authored-route.json"
    ]),
    /Unexpected \(possibly hand-authored\): packages\/bindings\/generated\/defold-script-hand-authored-route\.json/
  );
});

test("all 926 script routes regenerate byte-for-byte from pinned inputs", async () => {
  const report = await runScriptCleanRoomRegeneration();
  assert.equal(report.routeCount, 926);
  assert.equal(report.accountedRouteCount, 926);
  assert.equal(report.artifactCount, generatedScriptArtifacts.length);
  assert.equal(Object.keys(report.artifactSha256).length, generatedScriptArtifacts.length);
  assert.match(report.aggregateInputSha256, /^[0-9a-f]{64}$/);
  assert.equal(report.pinnedGroundTruth.defoldRevision, report.defoldRevision);
  assert.match(report.pinnedGroundTruth.refDocSha256, /^[0-9a-f]{64}$/);
  assert.equal(
    report.executableRouteCount,
    report.scalarRouteCount + report.valueRouteCount + report.fixedTupleRouteCount + report.urlRouteCount +
      report.valueTailRouteCount + report.overloadRouteCount
  );
  assert.equal(report.executableRouteCount, 286);
  assert.equal(report.universalRouteCount, 915);
});
