import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  assertTypedNativeBridgeProvenance,
  assertWarBattlesStaticHermesProjection,
  buildWarBattlesStaticHermesProjection,
  reconstructReleaseUsage,
  outputPath,
  PROJECTION_ID,
} from "../scripts/generate-war-battles-static-hermes-projection.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const root = path.resolve(import.meta.dirname, "..");

test("War Battles Static Hermes projection records closed release reachability", async () => {
  const checkedIn = JSON.parse(await readFile(outputPath, "utf8"));
  assertWarBattlesStaticHermesProjection(checkedIn);
  assert.equal(checkedIn.projection.id, PROJECTION_ID);
  assert.equal(checkedIn.reachability.profile, "release");
  assert.equal(checkedIn.reachability.dynamicAccess, false);
  assert.equal(checkedIn.reachability.reachableRouteCount, 27);
  assert.equal(
    checkedIn.reachability.staticReachableRouteCount,
    checkedIn.reachability.reachableRouteCount,
    "every reachable War Battles route must remain selected for Static Hermes"
  );
  assert.equal(checkedIn.reachability.blockedReachableRouteCount, 0);
  assert.ok(checkedIn.source.authoredFiles.length > 0);
  assert.match(checkedIn.source.authoredSourceTreeSha256, /^[0-9a-f]{64}$/u);
  assert.ok(checkedIn.adapter.observedTypedNativeRouteCount > 0);
  assert.ok(checkedIn.adapter.unobservedStaticReachableRouteIds.length > 0);
  assert.match(checkedIn.source.adapterEvidenceSha256, /^[0-9a-f]{64}$/u);
  assert.equal(checkedIn.source.usageSha256, undefined,
    "Static Hermes projection must not couple to mutable generated usage bytes");
  assert.match(checkedIn.evidenceBoundary.runtime, /not-claimed/);
});

test("Static Hermes projection reconstructs release reachability outside mutable usage output", async () => {
  const usage = await reconstructReleaseUsage();
  assert.equal(usage.profile, "release");
  assert.equal(usage.dynamicAccess, false);
  assert.equal(usage.routeCount, usage.routes.length);
  const reconstructed = await buildWarBattlesStaticHermesProjection();
  assert.deepEqual(reconstructed.reachability.reachableRouteIds,
    usage.routes.map(({ id }) => id).sort());
  assert.equal(reconstructed.source.releaseConfig,
    "examples/war-battles-online/defold/tsconfig.deherm.release.json");
});

test("Static Hermes projection rejects accidental promotion or route drift", async () => {
  const checkedIn = JSON.parse(await readFile(outputPath, "utf8"));
  const runtimeClaim = structuredClone(checkedIn);
  runtimeClaim.evidenceBoundary.runtime = "observed";
  assert.throws(() => assertWarBattlesStaticHermesProjection(runtimeClaim), /Expected values to be strictly equal/);

  const routeDrift = structuredClone(checkedIn);
  routeDrift.reachability.staticReachableRouteIds.pop();
  assert.throws(() => assertWarBattlesStaticHermesProjection(routeDrift), /Expected values to be strictly equal/);
});

test("Static Hermes projection rejects a self-consistent bridge from another lowering plan", async () => {
  const bridge = JSON.parse(await readFile(
    path.join(root, "packages/bindings/generated/defold-typed-native-bridge.json"), "utf8"));
  const loweringPlanSha256 = sha256(await readFile(
    path.join(root, "packages/bindings/generated/defold-binding-lowering-plan.json")));
  const typedNativeSourceSha256 = sha256(await readFile(path.join(
    root, "examples/war-battles-online/defold/.deherm/static-hermes/generated/script-typed-native-bridge.ts")));
  const stale = structuredClone(bridge);
  stale.inputHashes["packages/bindings/generated/defold-binding-lowering-plan.json"] = "0".repeat(64);
  const { reportSha256: _discarded, ...body } = stale;
  stale.reportSha256 = sha256(JSON.stringify(body));
  assert.throws(() => assertTypedNativeBridgeProvenance(stale, {
    engineRevision: bridge.defoldRevision,
    loweringPlanSha256,
    typedNativeSourceSha256
  }), /different lowering plan/u);
});
