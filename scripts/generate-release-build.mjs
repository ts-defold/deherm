import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { filterSchemaForUsage, generateArtifacts } from "./generate-bindings.mjs";
import { generateBindingEmissionPlan } from "./generate-binding-emission-plan.mjs";
import { generateCanonicalFamilyArtifacts } from "./generate-canonical-family-sources.mjs";
import { generateTypedNativeProjection } from "./generate-typed-native-projection.mjs";
import { ensureBindingLoweringPlan } from "./ensure-binding-lowering-plan.mjs";
import { verifyGeneratedProject } from "../packages/cli/src/generate.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = resolve(dirname(scriptPath), "..");

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function compareCodeUnits(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function parseArguments(argv) {
  const options = {
    moduleUsage: resolve(repositoryRoot, "dist/sample.usage.json"),
    defoldUsage: resolve(repositoryRoot, "dist/defold-app.defold-api-usage.json"),
    componentUsage: null,
    outputRoot: resolve(repositoryRoot, "build/profiles/release"),
    target: null,
    profile: null,
    project: null,
    platform: null,
    check: false,
    force: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--check") options.check = true;
    else if (argument === "--force") options.force = true;
    else if (argument === "--module-usage") options.moduleUsage = resolve(argv[++index]);
    else if (argument === "--defold-usage") options.defoldUsage = resolve(argv[++index]);
    else if (argument === "--component-usage") options.componentUsage = resolve(argv[++index]);
    else if (argument === "--output-root") options.outputRoot = resolve(argv[++index]);
    else if (argument === "--target") options.target = argv[++index];
    else if (argument === "--profile") options.profile = argv[++index];
    else if (argument === "--project") options.project = resolve(argv[++index]);
    else if (argument === "--platform") options.platform = argv[++index];
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (options.check && options.force) throw new Error("--check and --force are mutually exclusive");
  if (options.outputRoot === repositoryRoot || relative(repositoryRoot, options.outputRoot) === "") {
    throw new Error("Release output root must not be the repository root");
  }
  return options;
}

export function resolveReleaseSelection(engineProfiles, options = {}) {
  const platformProfile = options.platform ? engineProfiles?.platforms?.[options.platform] : null;
  if (options.platform && !platformProfile) {
    throw new Error(`Generated project has no API profile for platform '${options.platform}'`);
  }
  return {
    profile: options.profile ?? platformProfile ?? engineProfiles?.defaultProfileId ?? "default-legacy-bullet",
    target: options.target ?? (options.platform?.endsWith("-web") ? "browserWasmHost" : "dynamicHermesJsi")
  };
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function statFile(path) {
  try {
    const information = await lstat(path);
    return information.isFile() && !information.isSymbolicLink() ? information : null;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export function selectedTargetArtifacts(target) {
  const common = [
    "packages/bindings/generated/symbol-map.json",
    "packages/sdk/src/generated/modules.ts",
    "packages/abi/src/generated/layouts.ts"
  ];
  const targetFiles = {
    dynamicHermesJsi: [
      "defold/defold_hermes/include/defold_hermes/generated_modules.h",
      "defold/defold_hermes/include/defold_hermes/generated_jsi.hpp",
      "defold/defold_hermes/src/generated_jsi.cpp"
    ],
    staticHermesCAbi: [
      "defold/defold_hermes/include/defold_hermes/generated_modules.h",
      "packages/static-hermes/src/generated/ffi.js"
    ],
    browserWasmHost: [
      "defold/defold_hermes/include/defold_hermes/generated_modules.h",
      "defold/defold_hermes/lib/web/generated_modules.js"
    ],
    luaStack: ["defold/defold_hermes/include/defold_hermes/generated_modules.h"]
  };
  return [...common, ...(targetFiles[target] ?? [])].sort(compareCodeUnits);
}

function defoldApiReachability(defoldUsage, emissionPlan, canonical) {
  const derivation = defoldUsage.derivation ?? {};
  const emittableSurface = emissionPlan.treeShaking.totalPlanUnits;
  return {
    // The checker is the authority. The module graph is the cross-check, and a
    // build that reached this point has already had them agree.
    authority: derivation.authority ?? "unattributed",
    crossCheck: derivation.crossCheck?.status ?? "not-performed",
    dynamicAccess: defoldUsage.dynamicAccess === true,
    declaredDynamicAccess: derivation.declaredDynamicAccess === true,
    dynamicSites: derivation.dynamicSites ?? [],
    routeIndexSha256: derivation.routeIndexSha256 ?? null,
    surfaceRouteCount: derivation.surfaceRouteCount ?? null,
    resolvedRouteCount: Array.isArray(defoldUsage.symbols) ? defoldUsage.symbols.length : 0,
    emittedRouteCount: canonical.manifest.routeCount,
    canonicalPlanUnits: emittableSurface,
    reachableRouteIds: canonical.manifest.groups.flatMap(({ routeIds }) => routeIds).sort(compareCodeUnits),
    evidence: defoldUsage.dynamicAccess === true
      ? "Dynamic access was declared, so the complete profile-available surface is retained by design."
      : "Every emitted route was resolved to a call site by the ttsc checker and confirmed present in the bundler's module graph."
  };
}

function releaseProjection({ cacheKey, target, profile, moduleUsage, defoldUsage, componentUsage, emissionPlan, artifacts, canonical, typedNative }) {
  const symbolIds = moduleUsage.dynamicAccess === true
    ? artifacts.symbols.map(({ id }) => id)
    : moduleUsage.symbols.map((symbol) => typeof symbol === "string" ? symbol : symbol.id).sort(compareCodeUnits);
  const selectedArtifacts = selectedTargetArtifacts(target);
  return {
    schemaVersion: 1,
    cacheKey,
    target,
    profileId: profile,
    generatedModules: {
      status: "source-content-pruned",
      reachableSymbols: symbolIds,
      selectedArtifacts,
      evidence: "The listed generated source files were emitted from the reachability-filtered module schema in this release directory.",
      compilation: "not-run-by-this-step",
      linkage: "consumer-build-required"
    },
    canonicalDefoldApi: {
      status: canonical.manifest.routeCount > 0 ? "family-source-emitted" : canonical.requirements.status,
      selectedUnits: emissionPlan.treeShaking.selectedForEmissionUnits,
      totalUnits: emissionPlan.treeShaking.totalPlanUnits,
      emissionPlan: "defold-binding-emission-plan.json",
      familyManifest: `canonical/${target}/manifest.json`,
      requirements: `canonical/${target}/requirements.json`,
      generatedGroups: canonical.manifest.groupCount,
      generatedRoutes: canonical.manifest.routeCount,
      evidence: canonical.manifest.routeCount > 0
        ? "Canonical script families were projected into generated C++ route tables and a release reachability gate."
        : canonical.requirements.status === "blocked-by-canonical-plan"
          ? "The canonical plan authorizes no emitted routes for this target; the generated registry rejects every route and requirements.json records the exact blocker authority."
          : "Usage selected no canonical routes; the generated registry rejects every route.",
      reachability: defoldApiReachability(defoldUsage, emissionPlan, canonical)
    },
    typedNativeLane: {
      status: typedNative.manifest.retainedSymbols.length > 0 ? "reachable-subset-emitted" : "no-reachable-typed-native-route",
      manifest: `canonical/${target}/typed-native/manifest.json`,
      source: `canonical/${target}/typed-native/script-vmath.ts`,
      surfaceRoutes: typedNative.manifest.surfaceRouteCount,
      retainedRoutes: typedNative.manifest.retainedRouteIds.length,
      retainedSymbols: typedNative.manifest.retainedSymbols,
      prunedSymbols: typedNative.manifest.prunedSymbols,
      evidence: "The typed-native lane handed to `shermes -emit-c` was re-rendered from its own generated report over the reachable route set; pruned symbols have no declaration to emit.",
      cEmission: "requires-shermes-emit-c-consumer"
    },
    components: componentUsage ? {
      status: target === "dynamicHermesJsi"
        ? "compiler-registry-bundle-reachable"
        : "bundle-generated-runtime-provider-unimplemented",
      registry: componentUsage.registry,
      componentOnlyBootstrap: componentUsage.componentOnlyBootstrap === true,
      reachableComponentIds: componentUsage.components.map(({ componentId }) => componentId).sort(compareCodeUnits),
      usage: "component-reachability.json",
      evidence: target === "dynamicHermesJsi"
        ? "Every discovered Defold component proxy has one mechanically imported registry entry; no per-component native wrapper is emitted."
        : "The component registry bundle is target-neutral JavaScript, but this target has no verified component provider/bootstrap."
    } : {
      status: "no-component-usage-input",
      reachableComponentIds: []
    },
    evidenceBoundary: {
      generatedModuleSourcePruning: "proven-by-filtered-generation",
      generatedModuleCompilation: "not-claimed",
      generatedModuleLinkage: "not-claimed",
      canonicalSourcePruning: canonical.manifest.routeCount > 0 ? "registration-dispatch-glue-proven" : "fail-closed-empty-registry",
      canonicalLinkPruning: canonical.manifest.routeCount > 0 ? "generated-glue-cmake-consumer-available" : "no-authorized-routes-to-link",
      canonicalImplementationObjectPruning: "not-claimed-existing-family-objects-remain-coarse-grained",
      runtime: "not-claimed"
    }
  };
}

async function currentSentinel(options, cacheKey) {
  const sentinelPath = resolve(options.outputRoot, "release-build.sentinel.json");
  try {
    const sentinel = await readJson(sentinelPath);
    if (sentinel.schemaVersion !== 1 || sentinel.cacheKey !== cacheKey) return null;
    for (const [relativePath, size] of Object.entries(sentinel.outputSizes ?? {})) {
      const information = await statFile(resolve(options.outputRoot, relativePath));
      if (!information || information.size !== size) return null;
    }
    return sentinel;
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

function checkedOutputPath(outputRoot, relativePath) {
  const output = resolve(outputRoot, relativePath);
  const fromRoot = relative(outputRoot, output);
  if (fromRoot === "" || fromRoot === ".." || fromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
    throw new Error(`Release sentinel contains an unsafe output path '${relativePath}'`);
  }
  return output;
}

async function verifySentinelOutputs(options, sentinel) {
  const sizes = sentinel.outputSizes ?? {};
  const hashes = sentinel.outputSha256 ?? {};
  if (JSON.stringify(Object.keys(sizes).sort(compareCodeUnits)) !== JSON.stringify(Object.keys(hashes).sort(compareCodeUnits))) {
    throw new Error("Release sentinel has no exact output hash inventory; regenerate it");
  }
  for (const relativePath of Object.keys(sizes).sort(compareCodeUnits)) {
    const source = await readFile(checkedOutputPath(options.outputRoot, relativePath));
    if (source.byteLength !== sizes[relativePath] || sha256(source) !== hashes[relativePath]) {
      throw new Error(`Release output '${relativePath}' does not match its sentinel`);
    }
  }
}

async function replaceDirectory(staging, output) {
  const backup = `${output}.previous-${process.pid}`;
  let hadOutput = false;
  try {
    const information = await lstat(output);
    if (!information.isDirectory() || information.isSymbolicLink()) throw new Error("Release output root must be a regular directory");
    await rename(output, backup);
    hadOutput = true;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  try {
    await rename(staging, output);
  } catch (error) {
    if (hadOutput) await rename(backup, output);
    throw error;
  }
  if (hadOutput) await rm(backup, { recursive: true, force: true });
}

export async function generateReleaseBuild(argv = []) {
  const options = parseArguments(argv);
  await ensureBindingLoweringPlan({ root: repositoryRoot, deepCheck: true });
  let projectManifestSource = null;
  let engineProfiles = null;
  if (options.project) {
    await verifyGeneratedProject(options.project);
    projectManifestSource = await readFile(resolve(options.project, ".deherm/manifest.json"));
    engineProfiles = JSON.parse(projectManifestSource).engineProfiles;
  }
  const selection = resolveReleaseSelection(engineProfiles, options);
  options.target = selection.target;
  options.profile = selection.profile;
  const paths = {
    schema: resolve(repositoryRoot, "packages/bindings/modules.json"),
    plan: resolve(repositoryRoot, "packages/bindings/generated/defold-binding-lowering-plan.json"),
    planSentinel: resolve(repositoryRoot, "packages/bindings/generated/defold-binding-lowering-plan.sentinel.json"),
    scriptProjection: resolve(repositoryRoot, "packages/bindings/generated/defold-script-projection-ir.json"),
    profiles: resolve(repositoryRoot, "packages/bindings/generated/defold-script-route-availability-profiles.json"),
    bindingsGenerator: resolve(repositoryRoot, "scripts/generate-bindings.mjs"),
    emissionGenerator: resolve(repositoryRoot, "scripts/generate-binding-emission-plan.mjs"),
    canonicalFamilyGenerator: resolve(repositoryRoot, "scripts/generate-canonical-family-sources.mjs"),
    typedNativeLane: resolve(repositoryRoot, "packages/bindings/generated/defold-static-hermes-vmath.json")
  };
  const [generatorSource, schemaSource, planSource, planSentinelSource, projectionSource, profilesSource, moduleUsageSource, defoldUsageSource, componentUsageSource, bindingsGeneratorSource, emissionGeneratorSource, canonicalFamilyGeneratorSource, typedNativeLaneSource] = await Promise.all([
    readFile(scriptPath),
    readFile(paths.schema),
    readFile(paths.plan),
    readFile(paths.planSentinel),
    readFile(paths.scriptProjection),
    readFile(paths.profiles),
    readFile(options.moduleUsage),
    readFile(options.defoldUsage),
    options.componentUsage ? readFile(options.componentUsage) : null,
    readFile(paths.bindingsGenerator),
    readFile(paths.emissionGenerator),
    readFile(paths.canonicalFamilyGenerator),
    readFile(paths.typedNativeLane)
  ]);
  const plan = JSON.parse(planSource);
  const planSentinel = JSON.parse(planSentinelSource);
  if (plan.schemaVersion !== 2 || planSentinel.outputSha256 !== sha256(planSource) || planSentinel.planSha256 !== plan.planSha256) {
    throw new Error("Release build requires an authenticated canonical lowering-plan schema v2");
  }
  const keyInputs = {
    generator: sha256(generatorSource),
    bindingsGenerator: sha256(bindingsGeneratorSource),
    emissionGenerator: sha256(emissionGeneratorSource),
    canonicalFamilyGenerator: sha256(canonicalFamilyGeneratorSource),
    typedNativeLane: sha256(typedNativeLaneSource),
    schema: sha256(schemaSource),
    planSentinel: sha256(planSentinelSource),
    scriptProjection: sha256(projectionSource),
    profiles: sha256(profilesSource),
    moduleUsage: sha256(moduleUsageSource),
    defoldUsage: sha256(defoldUsageSource),
    componentUsage: componentUsageSource ? sha256(componentUsageSource) : null,
    projectManifest: projectManifestSource ? sha256(projectManifestSource) : null,
    platform: options.platform,
    target: options.target,
    profile: options.profile
  };
  const cacheKey = sha256(JSON.stringify(keyInputs));
  const current = options.force ? null : await currentSentinel(options, cacheKey);
  if (current) {
    if (options.check) await verifySentinelOutputs(options, current);
    return { action: "current", outputRoot: options.outputRoot, cacheKey, projection: await readJson(resolve(options.outputRoot, "defold-build-projection.json")) };
  }
  if (options.check) throw new Error(`Release build projection is stale or missing for key ${cacheKey}`);

  const schema = JSON.parse(schemaSource);
  const moduleUsage = JSON.parse(moduleUsageSource);
  const componentUsage = componentUsageSource ? JSON.parse(componentUsageSource) : null;
  if (componentUsage && (componentUsage.schemaVersion !== 1 || componentUsage.registry !== "__defoldComponentsV1" ||
      !Array.isArray(componentUsage.components) || componentUsage.components.some(({ componentId, source, contextKind, schemaFingerprint }) =>
        typeof componentId !== "string" || typeof source !== "string" || typeof contextKind !== "string" ||
        typeof schemaFingerprint !== "string"))) {
    throw new Error("Release component usage is missing the authenticated compiler-registry shape");
  }
  const selectedSchema = filterSchemaForUsage(schema, moduleUsage);
  const generatedArtifacts = generateArtifacts(selectedSchema);
  const defoldUsage = JSON.parse(defoldUsageSource);
  const emissionPlan = generateBindingEmissionPlan(
    plan,
    JSON.parse(projectionSource),
    JSON.parse(profilesSource),
    defoldUsage,
    {
      target: options.target,
      profile: options.profile,
      planFileSha256: sha256(planSource),
      scriptProjectionSha256: sha256(projectionSource),
      profileCatalogSha256: sha256(profilesSource)
    }
  );
  const canonical = generateCanonicalFamilyArtifacts(plan, emissionPlan);
  // One reachable set drives every layer, including the tier-2 lane whose
  // emitted C would otherwise carry a symbol for every route in the surface.
  const typedNative = generateTypedNativeProjection({
    vmathReport: JSON.parse(typedNativeLaneSource),
    reachableRouteIds: canonical.manifest.groups.flatMap(({ routeIds }) => routeIds),
    dynamicAccess: defoldUsage.dynamicAccess === true,
    target: options.target
  });
  const symbolMap = JSON.parse(generatedArtifacts.get("packages/bindings/generated/symbol-map.json"));
  const projection = releaseProjection({
    cacheKey,
    target: options.target,
    profile: options.profile,
    moduleUsage,
    defoldUsage,
    componentUsage,
    emissionPlan,
    artifacts: symbolMap,
    canonical,
    typedNative
  });
  const staging = `${options.outputRoot}.staging-${process.pid}`;
  await rm(staging, { recursive: true, force: true });
  for (const [artifactPath, contents] of generatedArtifacts) {
    const output = resolve(staging, artifactPath);
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, contents);
  }
  for (const [artifactPath, contents] of typedNative.artifacts) {
    const output = resolve(staging, artifactPath);
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, contents);
  }
  for (const [artifactPath, contents] of canonical.artifacts) {
    const output = resolve(staging, artifactPath);
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, contents);
  }
  const serializedEmission = `${JSON.stringify(emissionPlan, null, 2)}\n`;
  const serializedProjection = `${JSON.stringify(projection, null, 2)}\n`;
  await mkdir(staging, { recursive: true });
  await writeFile(resolve(staging, "defold-binding-emission-plan.json"), serializedEmission);
  await writeFile(resolve(staging, "defold-build-projection.json"), serializedProjection);
  const serializedComponentUsage = componentUsage ? `${JSON.stringify(componentUsage, null, 2)}\n` : null;
  if (serializedComponentUsage) {
    await writeFile(resolve(staging, "component-reachability.json"), serializedComponentUsage);
  }
  const sentinelContents = {
    "packages/bindings/generated/symbol-map.json": generatedArtifacts.get("packages/bindings/generated/symbol-map.json"),
    "defold-binding-emission-plan.json": serializedEmission,
    "defold-build-projection.json": serializedProjection,
    ...(serializedComponentUsage ? { "component-reachability.json": serializedComponentUsage } : {}),
    ...Object.fromEntries(canonical.artifacts),
    ...Object.fromEntries(typedNative.artifacts),
    ...Object.fromEntries(selectedTargetArtifacts(options.target).filter((item) => item !== "packages/bindings/generated/symbol-map.json").map((item) => [item, generatedArtifacts.get(item)]))
  };
  const sentinelOutputs = Object.fromEntries(Object.entries(sentinelContents).map(([item, contents]) => [item, Buffer.byteLength(contents)]));
  const sentinelHashes = Object.fromEntries(Object.entries(sentinelContents).map(([item, contents]) => [item, sha256(contents)]));
  const sentinel = {
    schemaVersion: 1,
    cacheKey,
    keyInputs,
    outputSizes: Object.fromEntries(Object.entries(sentinelOutputs).sort(([left], [right]) => compareCodeUnits(left, right))),
    outputSha256: Object.fromEntries(Object.entries(sentinelHashes).sort(([left], [right]) => compareCodeUnits(left, right)))
  };
  await writeFile(resolve(staging, "release-build.sentinel.json"), `${JSON.stringify(sentinel, null, 2)}\n`);
  await mkdir(dirname(options.outputRoot), { recursive: true });
  await replaceDirectory(staging, options.outputRoot);
  return { action: "generated", outputRoot: options.outputRoot, cacheKey, projection };
}

export async function run(argv = process.argv.slice(2)) {
  const result = await generateReleaseBuild(argv);
  process.stdout.write(`${result.action === "current" ? "Current" : "Generated"} release build projection ${result.cacheKey} at ${result.outputRoot}.\n`);
  return result;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await run();
