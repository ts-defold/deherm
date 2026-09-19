// The tier-2 projection of one reachable set.
//
// Tiers are chosen per route inside a single binary: a route the checker
// resolved is lowered as far as its contract allows, and a route nothing calls
// is not lowered at all. The typed-native lane is where that becomes visible in
// emitted C — `shermes -emit-c` turns each `$SHBuiltin.extern_c` declaration
// into a real symbol, so an unreachable route left in the input becomes a
// symbol in the final artifact.
//
// Pruning therefore happens to the *input* of the C emitter, which is why this
// re-renders the lane from its own generated report rather than filtering text:
// the report round-trips the checked-in source byte for byte, so a pruned
// render differs from it only by the routes that were removed.

import { createHash } from "node:crypto";

import { renderTypescript } from "./generate-static-hermes-vmath.mjs";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function compareCodeUnits(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Project the typed-native lane onto a reachable route set.
 *
 * `reachableRouteIds` is the canonical route identity set; `dynamicAccess`
 * declares that the program reaches the surface by a name the checker cannot
 * resolve, in which case the lane keeps everything it had.
 */
export function generateTypedNativeProjection({ vmathReport, reachableRouteIds, dynamicAccess = false, target }) {
  if (vmathReport?.schemaVersion !== 1 || !Array.isArray(vmathReport.included)) {
    throw new Error("Typed-native projection requires a version 1 Static Hermes vmath report");
  }
  const reachable = new Set(reachableRouteIds);
  const retained = dynamicAccess
    ? vmathReport.included
    : vmathReport.included.filter(({ id }) => reachable.has(id));
  const pruned = vmathReport.included.filter((binding) => !retained.includes(binding));
  const symbolsOf = (bindings) => bindings
    .flatMap(({ shapes }) => shapes.map(({ cFunction }) => cFunction))
    .sort(compareCodeUnits);
  const source = renderTypescript(retained);
  const body = {
    schemaVersion: 1,
    generator: "scripts/generate-typed-native-projection.mjs",
    target,
    transport: "typed-native",
    dynamicAccess,
    laneReportSha256: vmathReport.generatedSha256?.typescript ?? null,
    surfaceRouteCount: vmathReport.included.length,
    surfaceSymbolCount: symbolsOf(vmathReport.included).length,
    retainedRouteIds: retained.map(({ id }) => id).sort(compareCodeUnits),
    retainedSymbols: symbolsOf(retained),
    prunedRouteIds: pruned.map(({ id }) => id).sort(compareCodeUnits),
    // The dead-symbol retention gate reads this list: none of these may appear
    // in the emitted C, the final native artifact, or the Wasm artifact.
    prunedSymbols: symbolsOf(pruned),
    source: "script-vmath.ts",
    sourceSha256: sha256(source),
    evidenceBoundary: {
      sourcePruning: "proven-by-regeneration-from-the-lane-report",
      cEmission: "requires-shermes-emit-c-consumer",
      compilation: "not-claimed",
      linkage: "not-claimed",
      runtime: "not-claimed"
    }
  };
  const manifest = { ...body, manifestSha256: sha256(JSON.stringify(body)) };
  const artifacts = new Map();
  const prefix = `canonical/${target}/typed-native`;
  artifacts.set(`${prefix}/script-vmath.ts`, source);
  artifacts.set(`${prefix}/manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`);
  return { artifacts, manifest };
}
