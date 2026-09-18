#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const root = new URL("../", import.meta.url);
const inputUrls = {
  manifest: new URL("packages/bindings/probes/defold-script-real-engine-matrix.json", root),
  scalarRoutes: new URL("packages/bindings/generated/defold-script-scalar-dispatch.json", root),
  valueRoutes: new URL("packages/bindings/generated/defold-script-value-bindings.json", root),
  tupleRoutes: new URL("packages/bindings/generated/defold-script-fixed-tuples.json", root),
  urlRoutes: new URL("packages/bindings/generated/defold-script-url-address-classification.json", root),
  valueTailRoutes: new URL("packages/bindings/generated/defold-script-value-tail-bindings.json", root),
  overloadRoutes: new URL("packages/bindings/generated/defold-script-overload-dispatch.json", root),
  scalarProbes: new URL("packages/bindings/generated/defold-script-real-engine-probes.json", root),
  valueProbes: new URL("packages/bindings/generated/defold-script-value-real-engine-probes.json", root),
  tupleProbes: new URL("packages/bindings/generated/defold-script-fixed-tuple-probes.json", root)
};
const reportUrl = new URL("packages/bindings/generated/defold-script-real-engine-matrix.json", root);
const stages = ["compile", "link", "runtime"];
const setupContextKinds = new Set(["global", "script-instance", "gui-script", "render-script", "extension"]);
const propertyTypes = new Set(["number", "integer", "boolean", "string", "hash", "url", "vector3", "vector4", "quaternion"]);

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function evidenceLines(text) {
  return text.replaceAll("\r", "").split("\n");
}

function assertRecord(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
}

function assertNonEmpty(value, label) {
  if (typeof value !== "string" || !value) throw new Error(`${label} must be a non-empty string`);
}

function validatePropertyValue(property, label) {
  if (!propertyTypes.has(property.type)) throw new Error(`${label}.type is unsupported: ${property.type}`);
  const value = property.value;
  if (property.type === "number" && (typeof value !== "number" || !Number.isFinite(value))) throw new Error(`${label}.value must be finite`);
  if (property.type === "integer" && !Number.isSafeInteger(value)) throw new Error(`${label}.value must be a safe integer`);
  if (property.type === "boolean" && typeof value !== "boolean") throw new Error(`${label}.value must be boolean`);
  if (["string", "hash", "url"].includes(property.type) && typeof value !== "string") throw new Error(`${label}.value must be a string`);
  const widths = { vector3: 3, vector4: 4, quaternion: 4 };
  const width = widths[property.type];
  if (width && (!Array.isArray(value) || value.length !== width || value.some((component) => typeof component !== "number" || !Number.isFinite(component)))) {
    throw new Error(`${label}.value must contain ${width} finite components`);
  }
}

function validateSetups(manifest) {
  if (!Array.isArray(manifest.setups) || manifest.setups.length === 0) throw new Error("At least one setup is required");
  const setups = new Map();
  for (const setup of manifest.setups) {
    assertRecord(setup, "setup");
    assertNonEmpty(setup.id, "setup.id");
    if (setups.has(setup.id)) throw new Error(`Duplicate setup: ${setup.id}`);
    assertRecord(setup.context, `${setup.id}.context`);
    if (!setupContextKinds.has(setup.context.kind)) throw new Error(`${setup.id}.context.kind is unsupported`);
    if (setup.context.kind === "script-instance") {
      assertNonEmpty(setup.context.collection, `${setup.id}.context.collection`);
      assertNonEmpty(setup.context.gameObject, `${setup.id}.context.gameObject`);
      assertNonEmpty(setup.context.component, `${setup.id}.context.component`);
    }
    if (setup.projectConfig !== undefined) {
      assertRecord(setup.projectConfig, `${setup.id}.projectConfig`);
      for (const [key, value] of Object.entries(setup.projectConfig)) {
        assertNonEmpty(key, `${setup.id}.projectConfig key`);
        if (typeof value !== "string") throw new Error(`${setup.id}.projectConfig.${key} must be a string`);
      }
    }
    if (setup.properties !== undefined) {
      if (setup.context.kind !== "script-instance") throw new Error(`${setup.id}: properties require script-instance context`);
      if (!Array.isArray(setup.properties)) throw new Error(`${setup.id}.properties must be an array`);
      const names = new Set();
      setup.properties.forEach((property, index) => {
        assertRecord(property, `${setup.id}.properties[${index}]`);
        assertNonEmpty(property.name, `${setup.id}.properties[${index}].name`);
        if (names.has(property.name)) throw new Error(`${setup.id}: duplicate property ${property.name}`);
        names.add(property.name);
        validatePropertyValue(property, `${setup.id}.properties[${index}]`);
      });
    }
    setups.set(setup.id, setup);
  }
  return setups;
}

function routeRows(scalarRoutes, valueRoutes, tupleRoutes, urlRoutes, valueTailRoutes, overloadRoutes) {
  const rows = [
    ...scalarRoutes.bindings.map((binding) => ({
      id: binding.id,
      stableId: binding.stableId,
      rawName: binding.rawName,
      routeKind: "scalar",
      source: binding.source,
      line: binding.line
    })),
    ...valueRoutes.bindings.map((binding) => ({
      id: binding.id,
      stableId: binding.stableId,
      rawName: binding.rawName,
      routeKind: binding.id === "script:hash" ? "handle" : "value",
      source: binding.source,
      line: binding.line
    })),
    ...tupleRoutes.bindings.map((binding) => ({
      id: binding.id,
      stableId: typeof binding.stableId === "string" ? Number.parseInt(binding.stableId) : binding.stableId,
      rawName: binding.id.slice("script:".length),
      routeKind: "fixed-tuple",
      source: binding.sourceEvidence.path,
      line: 0,
      publicTypeScriptFixture: binding.targetSupport.publicTypeScriptFixture
    })),
    ...urlRoutes.rows.map((binding) => ({
      id: binding.id,
      stableId: binding.stableId,
      rawName: binding.rawName,
      routeKind: "url-address",
      source: binding.source,
      line: binding.line
    })),
    ...valueTailRoutes.bindings.filter(({ disposition }) => disposition === "candidate").map((binding) => ({
      id: binding.id,
      stableId: binding.stableId,
      rawName: binding.id.slice("script:".length),
      routeKind: "captured-lua-value-tail",
      source: binding.sourcePath,
      line: 0
    })),
    ...overloadRoutes.bindings.filter(({ generatedFamilyExecutableCandidate }) => generatedFamilyExecutableCandidate).map((binding) => ({
      id: binding.id,
      stableId: binding.stableId,
      rawName: binding.id.slice("script:".length),
      routeKind: "captured-lua-overload",
      source: binding.sourceEvidence.path,
      line: 0
    }))
  ].sort((left, right) => compareText(left.id, right.id));
  const ids = new Set();
  const stableIds = new Set();
  for (const route of rows) {
    if (ids.has(route.id)) throw new Error(`Executable route appears more than once: ${route.id}`);
    if (stableIds.has(route.stableId)) throw new Error(`Executable stable ID appears more than once: ${route.stableId}`);
    ids.add(route.id);
    stableIds.add(route.stableId);
  }
  return rows;
}

function importedScenarios(manifest, setups, scalarProbes, valueProbes, routeById) {
  if (!Array.isArray(manifest.probeImports)) throw new Error("probeImports must be an array");
  const reports = new Map([["scalar", scalarProbes], ["value", valueProbes]]);
  const seenSources = new Set();
  const scenarios = [];
  for (const probeImport of manifest.probeImports) {
    assertRecord(probeImport, "probe import");
    if (!reports.has(probeImport.source) || seenSources.has(probeImport.source)) throw new Error(`Invalid or duplicate probe import: ${probeImport.source}`);
    seenSources.add(probeImport.source);
    if (!setups.has(probeImport.defaultSetupId)) throw new Error(`${probeImport.source}: unknown default setup ${probeImport.defaultSetupId}`);
    assertRecord(probeImport.setupByProbeKey, `${probeImport.source}.setupByProbeKey`);
    const report = reports.get(probeImport.source);
    const knownProbeKeys = new Set(report.probes.map(({ key }) => key));
    for (const [key, setupId] of Object.entries(probeImport.setupByProbeKey)) {
      if (!knownProbeKeys.has(key)) throw new Error(`${probeImport.source}: setup assigned to unknown probe ${key}`);
      if (!setups.has(setupId)) throw new Error(`${probeImport.source}:${key}: unknown setup ${setupId}`);
    }
    for (const probe of report.probes) {
      if (!routeById.has(probe.id)) throw new Error(`${probeImport.source}:${probe.key}: probe route is not executable: ${probe.id}`);
      const state = probe.state ?? "instrumented";
      if (!["instrumented", "planned"].includes(state)) throw new Error(`${probeImport.source}:${probe.key}: invalid probe state`);
      if (state === "planned") assertNonEmpty(probe.reason, `${probeImport.source}:${probe.key}.reason`);
      const markerKind = probe.expectedMarker ? "exact-line" : "line-prefix";
      const expectedMarker = probe.expectedMarker ?? probe.expectedMarkerPrefix;
      assertNonEmpty(expectedMarker, `${probeImport.source}:${probe.key}.expectedMarker`);
      scenarios.push({
        key: `${probeImport.source}:${probe.key}`,
        routeId: probe.id,
        state,
        setupId: probeImport.setupByProbeKey[probe.key] ?? probeImport.defaultSetupId,
        probeSource: probeImport.source,
        probeKey: probe.key,
        probeSetInputMarker: report.expectedInputMarker,
        markerKind,
        expectedMarker,
        expectation: probe.expectation,
        ...(state === "planned" ? { reason: probe.reason } : {})
      });
    }
  }
  if (seenSources.size !== reports.size) throw new Error("Both scalar and value probe reports must be imported exactly once");
  return scenarios;
}

function applyOverrides(manifest, setups, routeById, scenarios) {
  if (!Array.isArray(manifest.scenarioOverrides)) throw new Error("scenarioOverrides must be an array");
  const keys = new Set(scenarios.map(({ key }) => key));
  for (const override of manifest.scenarioOverrides) {
    assertRecord(override, "scenario override");
    assertNonEmpty(override.key, "scenario override key");
    assertNonEmpty(override.routeId, `${override.key}.routeId`);
    assertNonEmpty(override.setupId, `${override.key}.setupId`);
    assertNonEmpty(override.reason, `${override.key}.reason`);
    if (keys.has(override.key)) throw new Error(`Duplicate scenario key: ${override.key}`);
    if (!routeById.has(override.routeId)) throw new Error(`${override.key}: route is not executable: ${override.routeId}`);
    if (!setups.has(override.setupId)) throw new Error(`${override.key}: unknown setup ${override.setupId}`);
    if ("evidence" in override || "status" in override || "verified" in override) {
      throw new Error(`${override.key}: scenario overrides cannot claim evidence`);
    }
    keys.add(override.key);
    scenarios.push({ key: override.key, routeId: override.routeId, state: "planned", setupId: override.setupId, reason: override.reason });
  }
}

async function validateObservations(manifest, scenarios, routeById, loadEvidence) {
  if (!Array.isArray(manifest.observations)) throw new Error("observations must be an array");
  const scenarioByKey = new Map(scenarios.map((scenario) => [scenario.key, scenario]));
  const seen = new Set();
  const observations = [];
  for (const observation of manifest.observations) {
    assertRecord(observation, "observation");
    assertNonEmpty(observation.id, "observation.id");
    if (seen.has(observation.id)) throw new Error(`Duplicate observation: ${observation.id}`);
    seen.add(observation.id);
    if (!stages.includes(observation.stage)) throw new Error(`${observation.id}: invalid evidence stage`);
    if (observation.target !== manifest.target) throw new Error(`${observation.id}: observation target does not match matrix target`);
    if (observation.result !== "passed") throw new Error(`${observation.id}: only explicitly passed observations are evidence`);
    assertNonEmpty(observation.command, `${observation.id}.command`);
    assertNonEmpty(observation.observedAt, `${observation.id}.observedAt`);
    if (!Array.isArray(observation.routeIds) || observation.routeIds.length === 0) throw new Error(`${observation.id}.routeIds must not be empty`);
    const routeIds = [...new Set(observation.routeIds)].sort(compareText);
    for (const routeId of routeIds) if (!routeById.has(routeId)) throw new Error(`${observation.id}: unknown route ${routeId}`);
    const scenarioKeys = [...new Set(observation.scenarioKeys ?? [])].sort(compareText);
    for (const key of scenarioKeys) if (!scenarioByKey.has(key)) throw new Error(`${observation.id}: unknown scenario ${key}`);
    assertRecord(observation.artifact, `${observation.id}.artifact`);
    assertNonEmpty(observation.artifact.path, `${observation.id}.artifact.path`);
    const artifactPath = observation.artifact.path;
    if (artifactPath.startsWith("/") || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(artifactPath) ||
        artifactPath.split(/[\\/]/).includes("..")) {
      throw new Error(`${observation.id}: evidence artifact path must stay within the repository`);
    }
    if (!/^[0-9a-f]{64}$/.test(observation.artifact.sha256)) throw new Error(`${observation.id}: artifact SHA-256 is invalid`);
    const evidence = await loadEvidence(observation.artifact.path);
    const bytes = Buffer.isBuffer(evidence) ? evidence : Buffer.from(evidence);
    const actualSha256 = createHash("sha256").update(bytes).digest("hex");
    if (actualSha256 !== observation.artifact.sha256) throw new Error(`${observation.id}: evidence artifact SHA-256 mismatch`);
    const evidenceText = bytes.toString("utf8");
    const lines = evidenceLines(evidenceText);
    const requiredMarkers = [...new Set(observation.requiredMarkers ?? [])].sort(compareText);
    if (observation.stage !== "runtime" && requiredMarkers.length === 0) {
      throw new Error(`${observation.id}: compile/link evidence requires at least one content marker`);
    }
    for (const marker of requiredMarkers) {
      assertNonEmpty(marker, `${observation.id}.requiredMarkers`);
      if (!evidenceText.includes(marker)) throw new Error(`${observation.id}: evidence artifact is missing marker ${marker}`);
    }
    if (observation.stage === "runtime") {
      if (scenarioKeys.length === 0) throw new Error(`${observation.id}: runtime evidence must name instrumented scenarios`);
      const runtimeRoutes = new Set();
      const requiredProbeSetMarkers = new Set();
      for (const key of scenarioKeys) {
        const scenario = scenarioByKey.get(key);
        if (scenario.state !== "instrumented") throw new Error(`${observation.id}: planned scenario cannot be promoted to runtime evidence`);
        if (!routeIds.includes(scenario.routeId)) throw new Error(`${observation.id}: runtime scenario route is not covered by routeIds`);
        const markerObserved = scenario.markerKind === "exact-line"
          ? lines.includes(scenario.expectedMarker)
          : lines.some((line) => line.startsWith(scenario.expectedMarker));
        if (!markerObserved) throw new Error(`${observation.id}: evidence artifact is missing ${scenario.markerKind} scenario marker ${scenario.expectedMarker}`);
        requiredProbeSetMarkers.add(scenario.probeSetInputMarker);
        runtimeRoutes.add(scenario.routeId);
      }
      for (const marker of requiredProbeSetMarkers) {
        if (!lines.includes(marker)) throw new Error(`${observation.id}: evidence artifact is missing current probe-set marker ${marker}`);
      }
      const routesWithoutScenarios = routeIds.filter((routeId) => !runtimeRoutes.has(routeId));
      if (routesWithoutScenarios.length) throw new Error(`${observation.id}: runtime route lacks an observed scenario: ${routesWithoutScenarios.join(", ")}`);
    }
    observations.push({
      id: observation.id,
      stage: observation.stage,
      target: observation.target,
      result: observation.result,
      command: observation.command,
      observedAt: observation.observedAt,
      routeIds,
      scenarioKeys,
      artifact: observation.artifact,
      requiredMarkers
    });
  }
  return observations;
}

export async function generateScriptRealEngineMatrix(texts, options = {}) {
  const manifest = JSON.parse(texts.manifest);
  const scalarRoutes = JSON.parse(texts.scalarRoutes);
  const valueRoutes = JSON.parse(texts.valueRoutes);
  const tupleRoutes = JSON.parse(texts.tupleRoutes);
  const urlRoutes = JSON.parse(texts.urlRoutes);
  const valueTailRoutes = JSON.parse(texts.valueTailRoutes);
  const overloadRoutes = JSON.parse(texts.overloadRoutes);
  const scalarProbes = JSON.parse(texts.scalarProbes);
  const valueProbes = JSON.parse(texts.valueProbes);
  const tupleProbes = JSON.parse(texts.tupleProbes);
  if (manifest.schemaVersion !== 1) throw new Error(`Unsupported matrix schema ${manifest.schemaVersion}`);
  assertNonEmpty(manifest.target, "target");
  assertRecord(manifest.policy, "policy");
  assertNonEmpty(manifest.policy.defaultPlannedReason, "policy.defaultPlannedReason");
  assertNonEmpty(manifest.policy.defaultSetupId, "policy.defaultSetupId");
  if (JSON.stringify(manifest.policy.requiredEvidenceStages) !== JSON.stringify(stages)) throw new Error("requiredEvidenceStages must be compile, link, runtime");
  if (manifest.policy.runtimeRequiresExactScenarioMarker !== true) throw new Error("runtimeRequiresExactScenarioMarker must be true");
  if (scalarRoutes.defoldRevision !== valueRoutes.defoldRevision ||
      scalarRoutes.defoldRevision !== tupleRoutes.defoldRevision ||
      scalarRoutes.defoldRevision !== urlRoutes.defoldRevision ||
      scalarRoutes.defoldRevision !== valueTailRoutes.defoldRevision ||
      scalarRoutes.defoldRevision !== overloadRoutes.defoldRevision ||
      scalarRoutes.defoldRevision !== scalarProbes.defoldRevision ||
      scalarRoutes.defoldRevision !== valueProbes.defoldRevision) {
    throw new Error("All matrix inputs must use the same Defold revision");
  }
  const setups = validateSetups(manifest);
  if (!setups.has(manifest.policy.defaultSetupId)) throw new Error(`Unknown default setup ${manifest.policy.defaultSetupId}`);
  const routes = routeRows(scalarRoutes, valueRoutes, tupleRoutes, urlRoutes, valueTailRoutes, overloadRoutes);
  const routeById = new Map(routes.map((route) => [route.id, route]));
  const scenarios = importedScenarios(manifest, setups, scalarProbes, valueProbes, routeById);
  applyOverrides(manifest, setups, routeById, scenarios);
  for (const probe of tupleProbes.scenarios) {
    if (!routeById.has(probe.routeId)) throw new Error(`${probe.id}: fixed tuple probe route is not executable`);
    const setupId = probe.requirements.includes("active-context:GuiScriptInstance")
      ? "generated-gui-script-instance"
      : probe.requirements.includes("active-context:ScriptInstance")
        ? "bootstrap-script-instance" : "global-runtime";
    scenarios.push({
      key: `tuple:${probe.id}`,
      routeId: probe.routeId,
      state: "planned",
      setupId,
      reason: probe.publicTypeScriptFixture === "blocked-missing-handle-producer"
        ? "Generated tuple lowering awaits its public TypeScript borrowed-handle producer."
        : "Generated tuple lowering has no observed packaged-engine marker yet."
    });
  }
  const routesWithScenarios = new Set(scenarios.map(({ routeId }) => routeId));
  for (const route of routes) {
    if (!routesWithScenarios.has(route.id)) {
      scenarios.push({
        key: `planned:${route.id}`,
        routeId: route.id,
        state: "planned",
        setupId: manifest.policy.defaultSetupId,
        reason: manifest.policy.defaultPlannedReason
      });
    }
  }
  scenarios.sort((left, right) => compareText(left.routeId, right.routeId) || compareText(left.key, right.key));
  const loadEvidence = options.loadEvidence ?? (async (path) => readFile(new URL(path, root)));
  const observations = await validateObservations(manifest, scenarios, routeById, loadEvidence);
  const observationsByRouteStage = new Map();
  for (const observation of observations) {
    for (const routeId of observation.routeIds) {
      const key = `${routeId}\0${observation.stage}`;
      const entries = observationsByRouteStage.get(key) ?? [];
      entries.push(observation.id);
      observationsByRouteStage.set(key, entries);
    }
  }
  const routeReports = routes.map((route) => {
    const routeScenarios = scenarios.filter(({ routeId }) => routeId === route.id);
    if (routeScenarios.length === 0) throw new Error(`${route.id}: every executable route requires a scenario`);
    return {
      ...route,
      scenarios: routeScenarios.map((scenario) => scenario.key),
      scenarioState: routeScenarios.some(({ state }) => state === "instrumented") ? "instrumented" : "planned",
      evidence: Object.fromEntries(stages.map((stage) => {
        const observationIds = observationsByRouteStage.get(`${route.id}\0${stage}`) ?? [];
        return [stage, { status: observationIds.length ? "verified" : "unverified", observationIds }];
      }))
    };
  });
  const stageSummary = Object.fromEntries(stages.map((stage) => [stage, {
    verifiedRouteCount: routeReports.filter((route) => route.evidence[stage].status === "verified").length,
    unverifiedRouteCount: routeReports.filter((route) => route.evidence[stage].status === "unverified").length
  }]));
  const inputSha256 = createHash("sha256")
    .update(texts.manifest).update("\0").update(texts.scalarRoutes).update("\0").update(texts.valueRoutes)
    .update("\0").update(texts.tupleRoutes).update("\0").update(texts.urlRoutes)
    .update("\0").update(texts.valueTailRoutes).update("\0").update(texts.overloadRoutes)
    .update("\0").update(texts.scalarProbes)
    .update("\0").update(texts.valueProbes).update("\0").update(texts.tupleProbes).digest("hex");
  return {
    schemaVersion: 1,
    defoldRevision: scalarRoutes.defoldRevision,
    target: manifest.target,
    inputSha256,
    evidencePolicy: "Scenario state records planning/instrumentation only. A route stage is verified exclusively by an explicit, passed, target-matched observation whose repository-confined evidence artifact matches its declared SHA-256. Runtime requires the current probe-set fingerprint and an exact line or explicitly declared line prefix for every scenario.",
    coverageClaim: `All ${routes.length} generated executable script routes have at least one deterministic scenario. No compile, link, or runtime behavior is claimed without a verified observation.`,
    routeCount: routes.length,
    scenarioCount: scenarios.length,
    instrumentedScenarioCount: scenarios.filter(({ state }) => state === "instrumented").length,
    plannedScenarioCount: scenarios.filter(({ state }) => state === "planned").length,
    instrumentedRouteCount: routeReports.filter(({ scenarioState }) => scenarioState === "instrumented").length,
    plannedOnlyRouteCount: routeReports.filter(({ scenarioState }) => scenarioState === "planned").length,
    setupCount: setups.size,
    observationCount: observations.length,
    stageSummary,
    setups: [...setups.values()],
    scenarios,
    observations,
    routes: routeReports
  };
}

async function main(argv = process.argv.slice(2)) {
  const unknown = argv.filter((argument) => argument !== "--check");
  if (unknown.length) throw new Error(`Unknown argument: ${unknown[0]}`);
  const check = argv.includes("--check");
  const entries = await Promise.all(Object.entries(inputUrls).map(async ([key, url]) => [key, await readFile(url, "utf8")]));
  const report = `${JSON.stringify(await generateScriptRealEngineMatrix(Object.fromEntries(entries)), null, 2)}\n`;
  if (check) {
    if (await readFile(reportUrl, "utf8") !== report) throw new Error(`${reportUrl.pathname} is stale`);
  } else {
    await writeFile(reportUrl, report);
  }
  const parsed = JSON.parse(report);
  console.log(`${check ? "Verified" : "Generated"} ${parsed.routeCount} route scenarios; ${parsed.instrumentedRouteCount} instrumented, ${parsed.plannedOnlyRouteCount} planned-only, ${parsed.stageSummary.runtime.verifiedRouteCount} runtime-verified.`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await main();
