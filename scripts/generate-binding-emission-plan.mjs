import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "..");

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function compareCodeUnits(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function parseArguments(argv) {
  const options = {
    plan: resolve(repositoryRoot, "bindings/generated/defold-binding-lowering-plan.json"),
    sentinel: resolve(repositoryRoot, "bindings/generated/defold-binding-lowering-plan.sentinel.json"),
    scriptProjection: resolve(repositoryRoot, "bindings/generated/defold-script-projection-ir.json"),
    profiles: resolve(repositoryRoot, "bindings/generated/defold-script-route-availability-profiles.json"),
    usage: null,
    output: resolve(repositoryRoot, "build/profiles/release/defold-binding-emission-plan.json"),
    target: "dynamicHermesJsi",
    profile: "default-legacy-bullet",
    check: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--check") options.check = true;
    else if (argument === "--plan") options.plan = resolve(argv[++index]);
    else if (argument === "--sentinel") options.sentinel = resolve(argv[++index]);
    else if (argument === "--script-projection") options.scriptProjection = resolve(argv[++index]);
    else if (argument === "--profiles") options.profiles = resolve(argv[++index]);
    else if (argument === "--usage") options.usage = resolve(argv[++index]);
    else if (argument === "--output") options.output = resolve(argv[++index]);
    else if (argument === "--target") options.target = argv[++index];
    else if (argument === "--profile") options.profile = argv[++index];
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!options.usage) throw new Error("--usage is required");
  return options;
}

function usageIds(usage, known) {
  if (usage.schemaVersion !== 1 || !Array.isArray(usage.symbols)) {
    throw new Error("Usage must be a version 1 manifest with a symbols array");
  }
  const ids = usage.symbols.map((value) => typeof value === "string" ? value : value?.id);
  if (ids.some((id) => typeof id !== "string")) throw new Error("Every usage symbol needs a string id");
  if (new Set(ids).size !== ids.length) throw new Error("Usage manifest contains duplicate symbols");
  for (const id of ids) if (!known.has(id)) throw new Error(`Usage names unknown binding '${id}'`);
  return ids.sort();
}

function validatePlanIdentity(plan) {
  if (plan?.schemaVersion !== 2) {
    throw new Error(`Binding emission requires canonical lowering-plan schema v2, got ${plan?.schemaVersion ?? "missing"}`);
  }
  if (!plan || typeof plan !== "object" || typeof plan.planSha256 !== "string") {
    throw new Error("Lowering plan has no internal identity");
  }
  const { planSha256, ...body } = plan;
  if (sha256(JSON.stringify(body)) !== planSha256) throw new Error("Lowering plan internal digest is invalid");
}

function validateProfileAuthority(scriptProjection, profileCatalog) {
  const projectionCatalogs = new Set(scriptProjection.rows
    .map((row) => row.availability?.catalogSha256)
    .filter(Boolean));
  if (projectionCatalogs.size !== 1 || !projectionCatalogs.has(profileCatalog.catalogSha256)) {
    throw new Error("Script projection and profile catalog authorities differ");
  }
  const catalogMaterial = {
    defoldRevision: profileCatalog.defoldRevision,
    profiles: Object.fromEntries(Object.entries(profileCatalog.profiles ?? {}).map(([profileId, profile]) => [profileId, {
      features: profile.features,
      capabilityBits: profile.runtimeHandshake?.capabilityBits,
      routeSetSha256: profile.runtimeHandshake?.routeSetSha256
    }]))
  };
  if (sha256(JSON.stringify(catalogMaterial)) !== profileCatalog.catalogSha256) {
    throw new Error("Defold profile catalog internal digest is invalid");
  }
  for (const [profileId, profile] of Object.entries(profileCatalog.profiles ?? {})) {
    if (profile.runtimeHandshake?.catalogSha256 !== profileCatalog.catalogSha256 ||
        profile.runtimeHandshake?.profileId !== profileId) {
      throw new Error(`Defold profile '${profileId}' has an invalid runtime authority`);
    }
  }
}

function scriptAvailableInProfile(sourceRow, profileId) {
  if (sourceRow.availability.token === "core" || sourceRow.availability.token === "html5-host") return true;
  return sourceRow.availability.runtimeProfiles?.includes(profileId) === true;
}

function internSelected(sourceValues, indices) {
  const selected = [...indices].sort((left, right) => left - right);
  const remap = new Map(selected.map((sourceIndex, index) => [sourceIndex, index]));
  return {
    values: selected.map((sourceIndex) => sourceValues[sourceIndex]),
    sourceIndices: selected,
    remap
  };
}

export function generateBindingEmissionPlan(plan, scriptProjection, profileCatalog, usage, options = {}) {
  const target = options.target ?? "dynamicHermesJsi";
  const profileId = options.profile ?? "default-legacy-bullet";
  validatePlanIdentity(plan);
  if (plan.inputCanonicalHashes?.scriptProjection !== sha256(JSON.stringify(scriptProjection))) {
    throw new Error("Script projection does not match the lowering plan authority");
  }
  if (plan.defoldRevision !== scriptProjection.defoldRevision || plan.defoldRevision !== profileCatalog.defoldRevision) {
    throw new Error("Lowering plan, script projection, and profile catalog revisions differ");
  }
  validateProfileAuthority(scriptProjection, profileCatalog);
  if (!plan.targetOrder.includes(target)) throw new Error(`Unknown lowering target '${target}'`);
  if (!plan.targetCapabilities[target].runtime) throw new Error(`Target '${target}' is not a runtime emission target`);
  if (!profileCatalog.profiles[profileId]) throw new Error(`Unknown Defold runtime profile '${profileId}'`);
  const byId = new Map(plan.units.map((unit, unitIndex) => [unit.identity.id, { unit, unitIndex }]));
  if (byId.size !== plan.coverage.units) throw new Error("Lowering plan contains duplicate public IDs");
  const explicitIds = usageIds(usage, byId);
  const candidates = usage.dynamicAccess === true ? [...byId.keys()].sort() : explicitIds;
  const normalizedUsage = {
    schemaVersion: 1,
    dynamicAccess: usage.dynamicAccess === true,
    symbols: usage.dynamicAccess === true ? [] : explicitIds
  };
  const sourceScriptRows = new Map(scriptProjection.rows.map((row, index) => [index, row]));
  const selected = [];
  const diagnostics = [];
  for (const id of candidates) {
    const { unit, unitIndex } = byId.get(id);
    const backend = unit.backends[target];
    if (unit.identity.surface === "script") {
      const row = sourceScriptRows.get(unit.sourceRef.row);
      if (!row || row.id !== id) throw new Error(`${id}: script projection reference drifted`);
      if (!scriptAvailableInProfile(row, profileId)) {
        if (usage.dynamicAccess === true) continue;
        throw new Error(`${id} is unavailable in Defold profile '${profileId}'`);
      }
    }
    if (backend.selection !== "emit") {
      diagnostics.push({ id, selection: backend.selection, blockers: plan.tables.blockerSets[backend.blockerSet] });
      if (usage.dynamicAccess !== true) {
        throw new Error(`${id} cannot emit for ${target}: ${backend.selection} (${plan.tables.blockerSets[backend.blockerSet].join(", ")})`);
      }
      continue;
    }
    selected.push({ id, unit, unitIndex, backend });
  }

  const programIndices = new Set(selected.map(({ backend }) => backend.marshallingProgram));
  const blockerIndices = new Set(selected.map(({ backend }) => backend.blockerSet));
  const resolvedIndices = new Set(selected.map(({ backend }) => backend.resolvedTokenSet));
  const unresolvedIndices = new Set(selected.map(({ backend }) => backend.unresolvedTokenSet));
  const programs = internSelected(plan.tables.marshallingPrograms, programIndices);
  const blockers = internSelected(plan.tables.blockerSets, blockerIndices);
  const resolved = internSelected(plan.tables.resolvedTokenSets, resolvedIndices);
  const unresolved = internSelected(plan.tables.unresolvedTokenSets, unresolvedIndices);
  const units = selected.map(({ id, unit, unitIndex, backend }) => ({
    id,
    sourceUnit: unitIndex,
    surface: unit.identity.surface,
    abiEntry: unit.abi.symbol ?? unit.abi.plannedSymbol,
    loweringFamily: unit.sourceState.loweringFamily,
    marshallingProgram: programs.remap.get(backend.marshallingProgram),
    blockerSet: blockers.remap.get(backend.blockerSet),
    resolvedTokenSet: resolved.remap.get(backend.resolvedTokenSet),
    unresolvedTokenSet: unresolved.remap.get(backend.unresolvedTokenSet)
  }));
  const familyCounts = {};
  for (const unit of units) familyCounts[unit.loweringFamily] = (familyCounts[unit.loweringFamily] ?? 0) + 1;
  const body = {
    schemaVersion: 1,
    defoldRevision: plan.defoldRevision,
    sourcePlanSha256: plan.planSha256,
    sourceAuthorities: {
      planFileSha256: options.planFileSha256 ?? sha256(JSON.stringify(plan)),
      scriptProjectionSha256: options.scriptProjectionSha256 ?? sha256(JSON.stringify(scriptProjection)),
      profileCatalogSha256: options.profileCatalogSha256 ?? sha256(JSON.stringify(profileCatalog)),
      profileCatalogIdentity: profileCatalog.catalogSha256
    },
    target,
    profileId,
    usage: {
      dynamicAccess: usage.dynamicAccess === true,
      requestedCount: candidates.length,
      usageSha256: sha256(JSON.stringify(normalizedUsage))
    },
    evidenceBoundary: {
      selection: "Bindings are selected for a later emitter; this file does not contain emitted source.",
      generation: "planned-not-emitted",
      compilation: "not-claimed",
      linkage: "not-claimed",
      runtime: "not-claimed",
      allocation: "not-claimed",
      conformance: "not-claimed"
    },
    treeShaking: {
      totalPlanUnits: plan.coverage.units,
      selectedForEmissionUnits: units.length,
      notSelectedUnits: plan.coverage.units - units.length,
      retainedMarshallingPrograms: programs.values.length,
      totalMarshallingPrograms: plan.tables.marshallingPrograms.length,
      policy: "Only explicitly reachable, profile-available units with an emit disposition are retained. Shared tables are compacted to referenced entries."
    },
    familyCounts: Object.fromEntries(Object.entries(familyCounts).sort(([left], [right]) => compareCodeUnits(left, right))),
    diagnostics,
    tables: {
      marshallingPrograms: programs.values,
      blockerSets: blockers.values,
      resolvedTokenSets: resolved.values,
      unresolvedTokenSets: unresolved.values
    },
    units
  };
  return { ...body, emissionPlanSha256: sha256(JSON.stringify(body)) };
}

export async function run(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  const [planText, sentinelText, loweringGeneratorText, scriptText, profilesText, usageText] = await Promise.all([
    readFile(options.plan, "utf8"),
    readFile(options.sentinel, "utf8"),
    readFile(resolve(repositoryRoot, "packages/compiler/src/generate-binding-lowering-plan.mjs"), "utf8"),
    readFile(options.scriptProjection, "utf8"),
    readFile(options.profiles, "utf8"),
    readFile(options.usage, "utf8")
  ]);
  const plan = JSON.parse(planText);
  const sentinel = JSON.parse(sentinelText);
  if (sentinel.schemaVersion !== 1 || sentinel.generator !== "packages/compiler/src/generate-binding-lowering-plan.mjs" ||
      sentinel.generatorSha256 !== sha256(loweringGeneratorText) || sentinel.outputSha256 !== sha256(planText) ||
      sentinel.outputBytes !== Buffer.byteLength(planText) || sentinel.planSha256 !== plan.planSha256 ||
      JSON.stringify(sentinel.inputHashes) !== JSON.stringify(plan.inputHashes)) {
    throw new Error("Canonical lowering-plan sentinel is stale or does not authenticate the selected plan");
  }
  if (plan.inputHashes?.scriptProjection !== sha256(scriptText)) {
    throw new Error("Script projection bytes do not match the lowering plan authority");
  }
  const report = generateBindingEmissionPlan(
    plan,
    JSON.parse(scriptText),
    JSON.parse(profilesText),
    JSON.parse(usageText),
    {
      ...options,
      planFileSha256: sha256(planText),
      scriptProjectionSha256: sha256(scriptText),
      profileCatalogSha256: sha256(profilesText)
    }
  );
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (options.check) {
    if (await readFile(options.output, "utf8") !== serialized) throw new Error(`${options.output} is stale; regenerate binding emission plan`);
  } else {
    await mkdir(dirname(options.output), { recursive: true });
    await writeFile(options.output, serialized);
  }
  process.stdout.write(`${options.check ? "Verified" : "Generated"} ${report.treeShaking.selectedForEmissionUnits}/${report.treeShaking.totalPlanUnits} units selected for ${report.target}/${report.profileId}.\n`);
  return report;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await run();
