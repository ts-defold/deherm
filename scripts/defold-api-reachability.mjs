// Joining the two independent derivations of what a build reaches.
//
// The checker resolves call sites to canonical route IDs; the bundler decides
// which generated modules survive tree shaking and emits each surviving route's
// stable ID verbatim into the output. Neither is a view of the other: one comes
// from TypeScript's symbol resolution, the other from esbuild's module graph and
// the bytes it wrote. They therefore constitute a check on each other, and a
// disagreement means one of them is wrong — which is exactly the situation in
// which a release build must not silently pick a winner.
//
// The checker is the authority for *what to retain*. The bundler is the
// authority for *what could possibly execute*. Those two facts have a fixed
// relationship:
//
//   * every route the checker resolved must be present in the emitted bundle,
//     or the checker named something the program cannot reach;
//   * every namespace the bundle retained must be claimed by at least one
//     resolved route, or something reaches the surface the checker never saw.
//
// The second direction is the one that catches the failure this module exists
// for: dynamic indexing, a re-export the checker walked past, a generator edge
// nobody classified. It fails closed rather than quietly shipping a pruned
// artifact that the program can step outside of.

function compareCodeUnits(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Stable route IDs the bundler actually emitted into one output.
 *
 * The generated script SDK dispatches every route through
 * `callScriptApi(<stableId>, args)`, so the emitted integers are a direct,
 * post-tree-shaking census of the routes the output can reach. esbuild
 * normalises the generated hexadecimal literal to decimal, so both spellings
 * are read.
 */
export function bundleReachableStableIds(source) {
  const ids = new Set();
  for (const match of source.matchAll(/callScriptApi\(\s*(0[xX][0-9a-fA-F]+|\d+)/g)) {
    ids.add(Number(match[1]));
  }
  return ids;
}

function namespacesOf(routeIds, routeIndex) {
  const byId = new Map(Object.values(routeIndex.members).map((member) => [member.id, member.namespace]));
  return new Set(routeIds.map((id) => byId.get(id)).filter(Boolean));
}

function namespacesOfStableIds(stableIds, routeIndex) {
  const byStableId = new Map(Object.values(routeIndex.members).map((member) => [member.stableId, member.namespace]));
  return new Set([...stableIds].map((stableId) => byStableId.get(stableId)).filter(Boolean));
}

/**
 * Project the checker's whole-program manifest onto one bundler entrypoint.
 *
 * ttsc sees a program, not an entrypoint. The bundler's retained-input set is
 * what narrows the program to this artifact, so the reachable route set for an
 * output is the union of the routes the checker resolved in the files that
 * contributed bytes to it.
 */
export function checkerReachableRoutes(manifest, retainedInputs) {
  const reached = new Set();
  for (const input of retainedInputs) {
    for (const id of manifest.files[input] ?? []) reached.add(id);
  }
  return [...reached].sort(compareCodeUnits);
}

/**
 * Cross-check the checker's symbol set against the bundler's module graph.
 *
 * Returns the verdict rather than throwing so the caller can decide: a
 * development build reports it, a release build refuses to proceed without it.
 */
export function crossCheckReachability({
  entryPoint,
  output,
  manifest,
  routeIndex,
  checkerRouteIds,
  bundleStableIds
}) {
  const byId = new Map(Object.values(routeIndex.members).map((member) => [member.id, member]));
  const checkerNamespaces = namespacesOf(checkerRouteIds, routeIndex);
  const bundleNamespaces = namespacesOfStableIds(bundleStableIds, routeIndex);
  const resolvedButNotEmitted = checkerRouteIds
    .filter((id) => !bundleStableIds.has(byId.get(id)?.stableId))
    .sort(compareCodeUnits);
  const emittedButUnclaimed = [...bundleNamespaces]
    .filter((namespace) => !checkerNamespaces.has(namespace))
    .sort(compareCodeUnits);
  const disagreements = [];
  for (const id of resolvedButNotEmitted) {
    disagreements.push(
      `the checker resolved ${id} but the bundler emitted no dispatch for it in ${output}`
    );
  }
  if (!manifest.dynamicAccess) {
    for (const namespace of emittedButUnclaimed) {
      disagreements.push(
        `the bundler retained the '${namespace}' Defold namespace in ${output} but the checker resolved no route in it`
      );
    }
  }
  return {
    source: "esbuild-module-graph-and-emitted-stable-ids",
    status: disagreements.length === 0 ? "agree" : "disagree",
    entryPoint,
    output,
    checkerRoutes: checkerRouteIds.length,
    bundleRoutes: bundleStableIds.size,
    checkerNamespaces: [...checkerNamespaces].sort(compareCodeUnits),
    bundleNamespaces: [...bundleNamespaces].sort(compareCodeUnits),
    resolvedButNotEmitted,
    emittedNamespacesWithoutResolvedRoute: emittedButUnclaimed,
    disagreements
  };
}

/** The per-entrypoint Defold API usage document the release planner consumes. */
export function defoldApiUsageDocument({ entryPoint, output, manifest, routeIndex, checkerRouteIds, crossCheck }) {
  const byId = new Map(Object.entries(routeIndex.members)
    .map(([path, member]) => [member.id, { ...member, member: path }]));
  return {
    schemaVersion: 1,
    entryPoint,
    output,
    // Dynamic access is a declaration, never an inference. An undeclared
    // computed access is a compile diagnostic in the release profile; a
    // declared one lands here and conservatively retains the whole surface.
    dynamicAccess: manifest.dynamicAccess === true,
    symbols: manifest.dynamicAccess === true ? [] : checkerRouteIds,
    derivation: {
      authority: "ttsc-checker-symbol-resolution",
      generator: manifest.generator,
      profile: manifest.profile,
      defoldRevision: manifest.defoldRevision,
      routeIndexSha256: manifest.routeIndexSha256,
      loweringPlanSha256: manifest.loweringPlanSha256,
      surfaceRouteCount: manifest.surfaceRouteCount,
      declaredDynamicAccess: manifest.declaredDynamicAccess === true,
      dynamicSites: manifest.dynamicSites ?? [],
      resolvedRoutes: checkerRouteIds.map((id) => ({
        id,
        stableId: byId.get(id)?.stableId ?? null,
        member: byId.get(id)?.member ?? null
      })),
      crossCheck
    }
  };
}
