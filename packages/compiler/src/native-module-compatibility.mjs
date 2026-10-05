import assert from "node:assert/strict";

export const NATIVE_MODULE_COMPATIBILITY_SCHEMA_VERSION = 1;

const CURRENT_FRONTENDS = new Set(["defold-script-api", "defold-c-header", "deherm-native-provider"]);

const ADAPTER_FRONTENDS = new Set(["expo-module", "turbo-module-spec", "nitro-module-spec", "plain-jsi"]);

function unique(values) {
  return [...new Set(values)].sort();
}

function targetRows(targetMatrix) {
  assert.equal(targetMatrix?.schemaVersion, 1, "target matrix schemaVersion must be 1");
  assert.ok(Array.isArray(targetMatrix.targets), "target matrix must contain targets");
  return targetMatrix.targets.filter(({ kind }) => kind === "bundle");
}

function catalogEvidence(catalogEntry, target) {
  return catalogEntry?.evidence?.find((entry) => entry.target === target) ?? null;
}

function packageEvidence(module, { target, group }) {
  return (module.platformEvidence ?? []).filter(
    (fact) =>
      fact.targets?.includes(target) ||
      fact.groups?.includes(group) ||
      (fact.portability === "native-cpp" && group !== "web") ||
      (fact.portability === "wasm-candidate" && group === "web"),
  );
}

function ecosystemEvidence(module, { target, group }) {
  return (module.ecosystemEvidence ?? []).filter(
    (fact) => fact.targets?.includes(target) || fact.groups?.includes(group),
  );
}

/**
 * Pure compatibility projection shared by the CLI, the checked-in catalog,
 * and future Turbo/Nitro spec importers. It intentionally reports generation,
 * compile, and runtime evidence as separate stages.
 */
export function analyzeNativeModuleCompatibility(module, targetMatrix, catalogEntry = null) {
  assert.equal(module?.schemaVersion, 1, "module analysis input schemaVersion must be 1");
  assert.equal(typeof module.name, "string");
  const frontends = unique(module.frontends ?? []);
  const activeFrontends = frontends.filter((frontend) => CURRENT_FRONTENDS.has(frontend));
  const adapterFrontends = frontends.filter((frontend) => ADAPTER_FRONTENDS.has(frontend));
  const blockers = [...(module.blockers ?? [])];
  const platformExclusions = unique(module.platformExclusions ?? []);
  const hasCurrentRoute = activeFrontends.length > 0;
  const onlyNeedsAdapter = !hasCurrentRoute && adapterFrontends.length > 0;

  if (!hasCurrentRoute && !onlyNeedsAdapter && blockers.length === 0) {
    blockers.push({
      code: "no-ingestible-module-surface",
      detail:
        "No Defold script API, public C/C++ header, deherm provider, TurboModule, Nitro, or JSI surface was found",
    });
  }

  const platforms = targetRows(targetMatrix).map(({ target, group, architecture }) => {
    const evidence = catalogEvidence(catalogEntry, target);
    const packageFacts = packageEvidence(module, { target, group });
    const ecosystemFacts = ecosystemEvidence(module, { target, group });
    let status;
    let route;
    if (platformExclusions.includes(group)) {
      status = "platform-declared-unsupported";
      route = null;
    } else if (evidence?.stage === "runtime") {
      status = "runtime-verified";
      route = evidence.route;
    } else if (evidence?.stage === "compile") {
      status = "compile-verified";
      route = evidence.route;
    } else if (hasCurrentRoute) {
      status = "generation-supported";
      route = activeFrontends.includes("deherm-native-provider")
        ? "deherm-native-provider"
        : activeFrontends.includes("defold-c-header")
          ? "generated-native-adapter"
          : "lua-compatibility";
    } else if (onlyNeedsAdapter) {
      status = packageFacts.length ? "adapter-required" : "platform-unproven";
      route = adapterFrontends[0];
    } else {
      status = "blocked";
      route = null;
    }
    return {
      target,
      group,
      architecture,
      status,
      route,
      evidence: evidence
        ? { stage: evidence.stage, source: evidence.source, detail: evidence.detail }
        : {
            stage: hasCurrentRoute ? "generation" : "inspection",
            source: "module-compatibility-analyzer",
            ...(packageFacts.length ? { packageFacts } : {}),
            ...(ecosystemFacts.length ? { ecosystemFacts } : {}),
          },
      ...(blockers.length && status === "blocked" ? { blockers } : {}),
    };
  });

  return {
    schemaVersion: NATIVE_MODULE_COMPATIBILITY_SCHEMA_VERSION,
    analyzerVersion: 1,
    module: {
      name: module.name,
      ...(module.version ? { version: module.version } : {}),
      sourceKind: module.sourceKind,
      sourceDigest: module.sourceDigest,
    },
    frontends,
    moduleKind: module.moduleKind ?? "unknown",
    declaredPlatformContexts: unique(module.declaredPlatformContexts ?? []),
    capabilities: {
      scriptApiModules: module.capabilities?.scriptApiModules ?? 0,
      publicHeaders: module.capabilities?.publicHeaders ?? 0,
      nativeProviders: module.capabilities?.nativeProviders ?? 0,
      nativeMethods: module.capabilities?.nativeMethods ?? 0,
    },
    frameworkDependencies: unique(module.frameworkDependencies ?? []),
    platformEvidence: module.platformEvidence ?? [],
    ecosystemEvidence: module.ecosystemEvidence ?? [],
    platformExclusions,
    blockers,
    platforms,
    summary: Object.fromEntries(
      unique(platforms.map(({ status }) => status)).map((status) => [
        status,
        platforms.filter((row) => row.status === status).length,
      ]),
    ),
  };
}

export function assertNativeModuleCatalog(catalog, targetMatrix) {
  assert.equal(catalog?.schemaVersion, 1, "native module catalog schemaVersion must be 1");
  assert.ok(Array.isArray(catalog.modules), "native module catalog must contain modules");
  const targets = new Set(targetRows(targetMatrix).map(({ target }) => target));
  const ids = new Set();
  for (const entry of catalog.modules) {
    assert.match(entry.id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/u);
    assert.ok(!ids.has(entry.id), `duplicate native module catalog id: ${entry.id}`);
    ids.add(entry.id);
    assert.equal(typeof entry.name, "string");
    assert.equal(typeof entry.source, "string");
    if (entry.evidence?.length) assert.match(entry.sourceDigest, /^[0-9a-f]{64}$/u);
    assert.ok(["headless", "mixed", "ui", "unknown"].includes(entry.moduleKind ?? "unknown"));
    assert.ok(Array.isArray(entry.frontends));
    if (entry.moduleNames !== undefined) assert.ok(Array.isArray(entry.moduleNames));
    if (entry.packageNames !== undefined) assert.ok(Array.isArray(entry.packageNames));
    for (const evidence of entry.evidence ?? []) {
      assert.ok(targets.has(evidence.target), `unknown catalog target: ${evidence.target}`);
      assert.ok(["compile", "runtime"].includes(evidence.stage));
      assert.equal(typeof evidence.route, "string");
      assert.equal(typeof evidence.source, "string");
    }
  }
  return catalog;
}
