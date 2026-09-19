import { readFile } from "node:fs/promises";
import path from "node:path";

// What a release build would retain, reported from a development session.
//
// Development links the complete Defold surface on purpose: the expensive step
// is the native link through Bob and Extender, and a linked surface that
// tracked what the game currently calls would turn the first use of a new API
// into a native rebuild in the middle of iteration. So reachability never
// prunes here. It is still computed on every compile, because knowing which 40
// of 913 routes a release would keep is worth having long before anyone
// produces one — and because a surprise in that number is usually a surprise in
// the program.

const usageRelativePath = path.join(".deherm", "generated", "defold-api-usage.json");

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

/**
 * Summarize the checker's reachability manifest for a console.
 *
 * Returns null when the project has not produced one; a session that predates
 * the reachability pass simply shows nothing rather than failing.
 */
export async function readReleaseReachability(projectRoot) {
  const manifest = await readJson(path.join(projectRoot, usageRelativePath));
  if (!manifest || manifest.schemaVersion !== 1) return null;
  const namespaces = [...new Set((manifest.routes ?? []).map(({ namespace }) => namespace))].sort();
  return {
    // The development link is unaffected by every number below it.
    developmentLinkedSurface: "complete",
    profile: manifest.profile ?? "development",
    surfaceRouteCount: manifest.surfaceRouteCount ?? 0,
    reachableRouteCount: manifest.dynamicAccess === true
      ? (manifest.surfaceRouteCount ?? 0)
      : manifest.routeCount ?? 0,
    resolvedRouteCount: manifest.routeCount ?? 0,
    namespaces,
    dynamicAccess: manifest.dynamicAccess === true,
    declaredDynamicAccess: manifest.declaredDynamicAccess === true,
    dynamicSites: manifest.dynamicSites ?? [],
    routes: (manifest.routes ?? []).map(({ id, member, namespace }) => ({ id, member, namespace }))
  };
}

/** One line a console can render without knowing the manifest's layout. */
export function describeReleaseReachability(reachability) {
  if (!reachability) return "release reachability: not yet computed";
  if (reachability.dynamicAccess && !reachability.declaredDynamicAccess) {
    return `release reachability: undeclared dynamic access at ${reachability.dynamicSites.length} site(s); ` +
      "a release build would refuse until it is declared";
  }
  if (reachability.dynamicAccess) {
    return `release reachability: dynamic access declared; all ${reachability.surfaceRouteCount} routes retained`;
  }
  return `release would retain ${reachability.reachableRouteCount}/${reachability.surfaceRouteCount} Defold routes ` +
    `across ${reachability.namespaces.length} namespace(s); development links all of them`;
}
