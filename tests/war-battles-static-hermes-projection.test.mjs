import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  assertTypedNativeBridgeProvenance,
  assertWarBattlesStaticHermesProjection,
  buildWarBattlesStaticHermesProjection,
  outputPath,
  PROJECTION_ID,
} from "../scripts/generate-war-battles-static-hermes-projection.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const root = path.resolve(import.meta.dirname, "..");

test("War Battles Static Hermes projection is generated from release reachability", async () => {
  const generated = await buildWarBattlesStaticHermesProjection();
  const checkedIn = JSON.parse(await readFile(outputPath, "utf8"));
  assert.deepEqual(checkedIn, generated);
  assertWarBattlesStaticHermesProjection(checkedIn);
  assert.equal(checkedIn.projection.id, PROJECTION_ID);
  assert.equal(checkedIn.reachability.profile, "release");
  assert.equal(checkedIn.reachability.dynamicAccess, false);
  assert.ok(checkedIn.reachability.staticReachableRouteCount > 0);
  assert.ok(checkedIn.reachability.blockedReachableRouteCount > 0);
  assert.ok(checkedIn.adapter.observedTypedNativeRouteCount > 0);
  assert.ok(checkedIn.adapter.unobservedStaticReachableRouteIds.length > 0);
  assert.match(checkedIn.source.adapterEvidenceSha256, /^[0-9a-f]{64}$/u);
  assert.match(checkedIn.evidenceBoundary.runtime, /not-claimed/);
});

test("Static Hermes projection rejects accidental promotion or route drift", async () => {
  const generated = await buildWarBattlesStaticHermesProjection();
  const runtimeClaim = structuredClone(generated);
  runtimeClaim.evidenceBoundary.runtime = "observed";
  assert.throws(() => assertWarBattlesStaticHermesProjection(runtimeClaim), /Expected values to be strictly equal/);

  const routeDrift = structuredClone(generated);
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
