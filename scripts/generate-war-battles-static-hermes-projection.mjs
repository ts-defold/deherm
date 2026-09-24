#!/usr/bin/env node
// Materialise the strongest honest Static Hermes projection currently
// available for the War Battles project.
//
// This is deliberately a generator, not a second runtime gate.  The project
// release usage manifest and canonical lowering plan establish the reachable
// set and the Static Hermes selection.  The packaged typed-native census is
// kept as a separate adapter observation: it proves that some of the same
// routes crossed the generated adapter in a real Hermes engine, but it does
// not promote that observation into Static Hermes gameplay evidence.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { projectionEnvelope } from "../examples/war-battles-online/integration/projections.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const projectRoot = path.join(repositoryRoot, "examples/war-battles-online/defold");
const inputPaths = Object.freeze({
  usage: path.join(projectRoot, ".deherm/generated/defold-api-usage.json"),
  loweringPlan: path.join(repositoryRoot, "packages/bindings/generated/defold-binding-lowering-plan.json"),
  bridge: path.join(repositoryRoot, "packages/bindings/generated/defold-typed-native-bridge.json"),
  typedNativeSource: path.join(projectRoot, ".deherm/static-hermes/generated/script-typed-native-bridge.ts"),
  transportEvidence: path.join(repositoryRoot, "examples/war-battles-online/evidence/packaged-typed-native-transport-arm64-macos.json"),
  upstreamLock: path.join(repositoryRoot, "upstream.lock")
});
export const outputPath = path.join(repositoryRoot, "examples/war-battles-online/evidence/static-hermes-reachable-arm64-macos.json");
export const PROJECTION_ID = "native-arm64-macos-static-hermes-reachable";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const canonical = (value) => JSON.stringify(value);

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

function routeUnits(plan) {
  return new Map(plan.units
    .filter((unit) => unit.identity?.surface === "script")
    .map((unit) => [unit.identity.id, unit]));
}

function blockerNames(plan, unit) {
  const index = unit.backends?.staticHermesCAbi?.blockerSet;
  const blockers = plan.tables?.blockerSets?.[index];
  assert.ok(Array.isArray(blockers), `${unit.identity.id}: missing Static Hermes blocker set ${index}`);
  return [...blockers];
}

export function assertTypedNativeBridgeProvenance(bridge, expected) {
  assert.equal(bridge.schemaVersion, 1, "unsupported typed-native bridge report schema");
  assert.equal(bridge.transport, "typed-native", "unexpected typed-native bridge transport");
  const { reportSha256, ...bridgeBody } = bridge;
  assert.equal(reportSha256, sha256(canonical(bridgeBody)), "typed-native bridge report digest is stale");
  assert.equal(bridge.defoldRevision, expected.engineRevision,
    "typed-native bridge targets a different Defold revision");
  assert.equal(
    bridge.inputHashes?.["packages/bindings/generated/defold-binding-lowering-plan.json"],
    expected.loweringPlanSha256,
    "typed-native bridge was generated from a different lowering plan"
  );
  assert.equal(bridge.generatedSha256?.typescript, expected.typedNativeSourceSha256,
    "project Static Hermes bridge is stale; run deherm generate first");
  const claimedRoutes = new Map((bridge.claimedRoutes ?? []).map(({ id, stableId }) => [id, stableId]));
  assert.equal(claimedRoutes.size, bridge.claimedRouteCount,
    "typed-native bridge claimed-route count is inconsistent");
  return claimedRoutes;
}

/** Build a projection from generator-owned inputs without writing anything. */
export async function buildWarBattlesStaticHermesProjection() {
  const [usage, plan, bridge, typedNativeSource, transportEvidence, upstreamLock] = await Promise.all([
    readJson(inputPaths.usage),
    readJson(inputPaths.loweringPlan),
    readJson(inputPaths.bridge),
    readFile(inputPaths.typedNativeSource, "utf8"),
    readJson(inputPaths.transportEvidence),
    readFile(inputPaths.upstreamLock, "utf8")
  ]);
  assert.equal(usage.profile, "release", "War Battles Static Hermes projection requires release reachability");
  assert.equal(usage.dynamicAccess, false, "War Battles Static Hermes projection refuses dynamic API access");
  assert.ok(Array.isArray(usage.routes) && usage.routes.length > 0, "release usage has no reachable routes");
  assert.equal(usage.routeCount, usage.routes.length, "release usage route count is inconsistent");
  const loweringPlanSha256 = sha256(await readFile(inputPaths.loweringPlan));
  const engineRevision = /^DEFOLD_REV=([0-9a-f]{40})$/m.exec(upstreamLock)?.[1];
  assert.ok(engineRevision, "upstream.lock does not pin a Defold revision");
  const claimedRoutes = assertTypedNativeBridgeProvenance(bridge, {
    engineRevision,
    loweringPlanSha256,
    typedNativeSourceSha256: sha256(typedNativeSource)
  });
  assert.equal(usage.defoldRevision, engineRevision, "release usage targets a different Defold revision");
  assert.equal(plan.defoldRevision, engineRevision, "lowering plan targets a different Defold revision");
  assert.equal(transportEvidence.engineRevision, engineRevision, "adapter evidence targets a different Defold revision");
  assert.equal(transportEvidence.projection?.id, "native-arm64-macos-typed-native-transport",
    "typed-native adapter evidence is not the expected packaged projection");

  const units = routeUnits(plan);
  const reachable = [...usage.routes]
    .map(({ id, stableId }) => ({ id, stableId }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const staticReachable = [];
  const blocked = [];
  for (const route of reachable) {
    const unit = units.get(route.id);
    assert.ok(unit, `${route.id}: release usage route is absent from the lowering plan`);
    assert.equal(route.stableId, unit.identity.stableId, `${route.id}: release usage stable id disagrees with the lowering plan`);
    const selection = unit.backends?.staticHermesCAbi?.selection;
    if (selection === "emit") {
      assert.equal(claimedRoutes.get(route.id), route.stableId,
        `${route.id}: Static Hermes selection is absent or has a different stable id in the typed-native bridge`);
      staticReachable.push(route);
    } else {
      blocked.push({
        ...route,
        selection,
        blockers: blockerNames(plan, unit)
      });
    }
  }

  const typedNativeRows = Object.values(transportEvidence.runs?.withAssembledTypedNativeExtension?.rows ?? [])
    .filter((row) => row.transport === "typed-native")
    .map(({ routeId, stableId, calls, failures }) => ({ routeId, stableId, calls, failures }))
    .sort((left, right) => (left.routeId ?? "").localeCompare(right.routeId ?? ""));
  const reachableIds = new Set(reachable.map(({ id }) => id));
  const staticIds = new Set(staticReachable.map(({ id }) => id));
  const reachableStableIds = new Map(reachable.map(({ id, stableId }) => [id, stableId]));
  assert.ok(typedNativeRows.every(({ routeId }) => reachableIds.has(routeId)),
    "adapter evidence contains a route outside the release reachable set");
  assert.ok(typedNativeRows.every(({ routeId, stableId }) => reachableStableIds.get(routeId) === stableId),
    "adapter evidence contains a stable id that disagrees with release reachability");
  assert.ok(typedNativeRows.every(({ routeId, stableId }) => claimedRoutes.get(routeId) === stableId),
    "adapter evidence contains a route absent from the authenticated typed-native bridge");
  assert.ok(typedNativeRows.every(({ calls }) => Number.isSafeInteger(calls) && calls > 0),
    "adapter evidence contains a route without an observed call");
  assert.ok(typedNativeRows.every(({ failures }) => failures === 0),
    "adapter evidence contains a failed typed-native route");

  const body = {
    schemaVersion: 1,
    generator: "scripts/generate-war-battles-static-hermes-projection.mjs",
    projection: projectionEnvelope(PROJECTION_ID),
    target: "arm64-macos",
    engineRevision,
    source: {
      usage: "examples/war-battles-online/defold/.deherm/generated/defold-api-usage.json",
      usageSha256: sha256(await readFile(inputPaths.usage)),
      loweringPlan: "packages/bindings/generated/defold-binding-lowering-plan.json",
      loweringPlanSha256,
      typedNativeBridge: "packages/bindings/generated/defold-typed-native-bridge.json",
      typedNativeBridgeSha256: sha256(await readFile(inputPaths.bridge)),
      typedNativeSource: "examples/war-battles-online/defold/.deherm/static-hermes/generated/script-typed-native-bridge.ts",
      typedNativeSourceSha256: sha256(typedNativeSource),
      adapterEvidence: "examples/war-battles-online/evidence/packaged-typed-native-transport-arm64-macos.json",
      adapterEvidenceSha256: sha256(await readFile(inputPaths.transportEvidence))
    },
    reachability: {
      profile: usage.profile,
      dynamicAccess: usage.dynamicAccess,
      reachableRouteCount: reachable.length,
      reachableRouteIds: reachable.map(({ id }) => id),
      staticReachableRouteCount: staticReachable.length,
      staticReachableRouteIds: staticReachable.map(({ id }) => id),
      blockedReachableRouteCount: blocked.length,
      blockedReachableRoutes: blocked
    },
    adapter: {
      observedTypedNativeRouteCount: typedNativeRows.length,
      observedTypedNativeRoutes: typedNativeRows,
      observedStaticReachableRouteCount: typedNativeRows.filter(({ routeId }) => staticIds.has(routeId)).length,
      unobservedStaticReachableRouteIds: staticReachable
        .map(({ id }) => id)
        .filter((id) => !typedNativeRows.some((row) => row.routeId === id))
    },
    evidenceBoundary: {
      generation: "release usage and canonical lowering plan select the reachable Static Hermes subset",
      adapter: "packaged DEHERM_PROFILE census proves only the listed typed-native crossings in Dynamic Hermes",
      compilation: "not-claimed by this projection; run the pinned shermes/Extender build gate separately",
      linkage: "not-claimed",
      runtime: "not-claimed; the full War Battles game has not executed as a Static Hermes application",
      gameplay: "not-claimed; packaged gameplay belongs to the native Dynamic Hermes projection",
      blockers: "blocked reachable routes remain explicit and fail closed"
    }
  };
  return {
    ...body,
    recordSha256: sha256(canonical(body))
  };
}

export function assertWarBattlesStaticHermesProjection(document) {
  assert.deepEqual(document?.projection, projectionEnvelope(PROJECTION_ID),
    "Static Hermes War Battles evidence carries a stale projection envelope");
  assert.equal(document?.reachability?.profile, "release");
  assert.equal(document?.reachability?.dynamicAccess, false);
  assert.equal(document?.reachability?.reachableRouteCount,
    document?.reachability?.reachableRouteIds?.length);
  assert.equal(document?.reachability?.staticReachableRouteCount,
    document?.reachability?.staticReachableRouteIds?.length);
  assert.equal(document?.reachability?.blockedReachableRouteCount,
    document?.reachability?.blockedReachableRoutes?.length);
  assert.equal(document?.adapter?.observedTypedNativeRouteCount,
    document?.adapter?.observedTypedNativeRoutes?.length);
  assert.equal(document?.evidenceBoundary?.runtime, "not-claimed; the full War Battles game has not executed as a Static Hermes application");
  const { recordSha256, ...body } = document ?? {};
  assert.equal(recordSha256, sha256(canonical(body)), "Static Hermes War Battles evidence digest is stale");
  return document;
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  const check = process.argv.includes("--check");
  try {
    const generated = await buildWarBattlesStaticHermesProjection();
    if (check) {
      const existing = await readFile(outputPath, "utf8");
      assert.equal(existing, `${JSON.stringify(generated, null, 2)}\n`, `${path.relative(repositoryRoot, outputPath)} is stale`);
      assertWarBattlesStaticHermesProjection(generated);
      console.log(`war-battles-static-hermes-projection:current:${path.relative(repositoryRoot, outputPath)}`);
    } else {
      await writeFile(outputPath, `${JSON.stringify(generated, null, 2)}\n`);
      console.log(`war-battles-static-hermes-projection:generated:${path.relative(repositoryRoot, outputPath)}`);
    }
  } catch (error) {
    console.error(error.stack ?? String(error));
    process.exitCode = 1;
  }
}
