#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  cp,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { parse as parseYaml } from "yaml";

import { stableBindingId } from "./lib/binding-identity.mjs";
import { LIFECYCLE_TABLES } from "./lib/script-lifecycle-callbacks.mjs";
import {
  generatedScriptArtifacts,
  scriptGenerationSteps,
  scriptGeneratorSources,
  scriptPinnedInputs
} from "./lib/script-generator-pipeline.mjs";

const execFileAsync = promisify(execFile);
const defaultRepositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export { generatedScriptArtifacts };

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function parseLock(text) {
  return Object.fromEntries(text.split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    return match ? [[match[1], match[2]]] : [];
  }));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function confinedRelativePath(value, label) {
  assert(typeof value === "string" && value.length > 0, `${label} must be a non-empty path`);
  assert(!path.isAbsolute(value), `${label} must be repository-relative`);
  const normalized = value.replaceAll("\\", "/");
  assert(!normalized.split("/").includes(".."), `${label} must not escape the repository`);
  return normalized;
}

async function copyRelative(sourceRoot, targetRoot, relativePath) {
  const safePath = confinedRelativePath(relativePath, "copy path");
  const source = path.join(sourceRoot, safePath);
  const target = path.join(targetRoot, safePath);
  await mkdir(path.dirname(target), { recursive: true });
  await copyFile(source, target);
}

async function sourceEvidencePaths(repositoryRoot) {
  const result = new Set();
  for (const inputPath of scriptPinnedInputs.filter((entry) => entry.startsWith("packages/bindings/overrides/"))) {
    const value = JSON.parse(await readFile(path.join(repositoryRoot, inputPath), "utf8"));
    if (inputPath.endsWith("script-api-semantic-overrides.json")) {
      for (const override of value.overrides ?? []) {
        result.add(`upstream/defold/${confinedRelativePath(override.evidence?.source, `${override.id}.evidence.source`)}`);
      }
      continue;
    }
    if (inputPath.endsWith("defold-value-layouts.json")) {
      for (const source of Object.values(value.sources ?? {})) {
        const relative = confinedRelativePath(source, `${inputPath}.sources`);
        assert(relative.startsWith("upstream/defold/"),
          `${inputPath}.sources must address the pinned Defold checkout`);
        result.add(relative);
      }
      continue;
    }
    if (inputPath.endsWith("script-borrowed-handle-classification.json")) {
      for (const evidence of value.sourceEvidence ?? []) {
        result.add(`upstream/defold/${confinedRelativePath(evidence.source, `${inputPath}.sourceEvidence.source`)}`);
      }
      continue;
    }
    if (inputPath.endsWith("script-callback-lifecycle-policies.json")) {
      for (const evidence of value.sourceEvidence ?? []) {
        result.add(`upstream/defold/${confinedRelativePath(evidence.path, `${inputPath}.sourceEvidence.path`)}`);
      }
      continue;
    }
    if (inputPath.endsWith("script-fixed-tuple-registrations.json")) {
      for (const evidence of value.sources ?? []) {
        result.add(`upstream/defold/${confinedRelativePath(evidence.path, `${inputPath}.sources.path`)}`);
      }
      continue;
    }
    if (inputPath.endsWith("script-dynamic-value-bindings.json")) {
      for (const evidence of value.sources ?? []) {
        result.add(`upstream/defold/${confinedRelativePath(evidence.path, `${inputPath}.sources.path`)}`);
      }
      continue;
    }
    if (inputPath.endsWith("script-defold-value-tail-bindings.json")) {
      for (const evidence of value.sources ?? []) {
        result.add(`upstream/defold/${confinedRelativePath(evidence.path, `${inputPath}.sources.path`)}`);
      }
      continue;
    }
    if (inputPath.endsWith("script-overload-dispatch.json")) {
      for (const evidence of value.sources ?? []) {
        result.add(`upstream/defold/${confinedRelativePath(evidence.path, `${inputPath}.sources.path`)}`);
      }
      continue;
    }
    if (inputPath.endsWith("script-table-record-bindings.json")) {
      for (const evidence of value.sources ?? []) {
        result.add(`upstream/defold/${confinedRelativePath(evidence.path, `${inputPath}.sources.path`)}`);
      }
      continue;
    }
    if (inputPath.endsWith("script-copied-value-record-blockers.json")) {
      for (const evidence of value.sources ?? []) {
        result.add(`upstream/defold/${confinedRelativePath(evidence.path, `${inputPath}.sources.path`)}`);
      }
      continue;
    }
    if (inputPath.endsWith("script-opaque-record-blockers.json")) {
      for (const evidence of value.sources ?? []) {
        result.add(`upstream/defold/${confinedRelativePath(evidence.path, `${inputPath}.sources.path`)}`);
      }
      continue;
    }
    if (inputPath.endsWith("script-url-address-classification.json")) {
      for (const evidence of value.sourceEvidence ?? []) {
        result.add(`upstream/defold/${confinedRelativePath(evidence.source, `${inputPath}.sourceEvidence.source`)}`);
      }
      continue;
    }
    if (inputPath.endsWith("script-route-availability-profiles.json")) {
      for (const evidence of value.buildEvidence ?? []) {
        result.add(confinedRelativePath(evidence.path, `${inputPath}.buildEvidence.path`));
      }
      for (const evidence of Object.values(value.manifests ?? {})) {
        result.add(confinedRelativePath(evidence.path, `${inputPath}.manifests.path`));
      }
      for (const evidence of value.registrations ?? []) {
        result.add(confinedRelativePath(evidence.path, `${inputPath}.registrations.path`));
      }
      for (const evidence of value.documentedButUnregistered ?? []) {
        result.add(confinedRelativePath(evidence.source, `${inputPath}.documentedButUnregistered.source`));
      }
      continue;
    }
    if (!value.source) continue;
    result.add(`upstream/defold/${confinedRelativePath(value.source, `${inputPath}.source`)}`);
    for (const evidence of value.additionalSourceEvidence ?? []) {
      result.add(`upstream/defold/${confinedRelativePath(evidence.source, `${inputPath}.additionalSourceEvidence.source`)}`);
    }
  }
  // The engine tables that define each script type's lifecycle callbacks. They
  // are evidence like any override's cited source - they decide which documented
  // globals are callbacks rather than callable API - but they are named by a
  // module rather than by an overrides file, so they join the set here.
  for (const table of LIFECYCLE_TABLES) {
    result.add(`upstream/defold/${confinedRelativePath(table.source, `${table.proxyKind}.lifecycle.source`)}`);
  }

  const matrix = JSON.parse(await readFile(
    path.join(repositoryRoot, "packages/bindings/probes/defold-script-real-engine-matrix.json"),
    "utf8"
  ));
  for (const observation of matrix.observations ?? []) {
    const artifactPath = confinedRelativePath(observation.artifact?.path, `${observation.id}.artifact.path`);
    assert(!generatedScriptArtifacts.includes(artifactPath),
      `${observation.id}.artifact.path cannot use a generated output as evidence`);
    result.add(artifactPath);
  }
  return [...result].sort();
}

async function validatePinnedGroundTruth(repositoryRoot, evidencePaths) {
  const lockText = await readFile(path.join(repositoryRoot, "upstream.lock"), "utf8");
  const lock = parseLock(lockText);
  assert(/^[0-9a-f]{40}$/.test(lock.DEFOLD_REV ?? ""), "upstream.lock has no exact DEFOLD_REV");
  assert(/^[0-9a-f]{64}$/.test(lock.DEFOLD_REF_DOC_SHA256 ?? ""),
    "upstream.lock has no DEFOLD_REF_DOC_SHA256");
  const archive = await readFile(path.join(repositoryRoot, "upstream/ref-doc.zip"));
  assert(sha256(archive) === lock.DEFOLD_REF_DOC_SHA256,
    "upstream/ref-doc.zip does not match the SHA-256 pinned in upstream.lock");
  const defoldRoot = path.join(repositoryRoot, "upstream/defold");
  const { stdout: headOutput } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: defoldRoot });
  const head = headOutput.trim();
  assert(head === lock.DEFOLD_REV,
    `Defold evidence checkout ${head} does not match pinned revision ${lock.DEFOLD_REV}`);
  const relativeEvidence = [...new Set([...evidencePaths, ...scriptPinnedInputs])]
    .filter((entry) => entry.startsWith("upstream/defold/"))
    .map((entry) => entry.slice("upstream/defold/".length));
  if (relativeEvidence.length) {
    await execFileAsync("git", ["ls-files", "--error-unmatch", "--", ...relativeEvidence], { cwd: defoldRoot });
    try {
      await execFileAsync("git", ["diff", "--quiet", "HEAD", "--", ...relativeEvidence], { cwd: defoldRoot });
    } catch (error) {
      if (error.code === 1) throw new Error("Pinned Defold source-evidence files have local modifications");
      throw error;
    }
  }
  return { defoldRevision: lock.DEFOLD_REV, refDocSha256: lock.DEFOLD_REF_DOC_SHA256 };
}

async function walkFiles(root, relative = "") {
  const directory = path.join(root, relative);
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, "en"))) {
    const child = path.posix.join(relative.replaceAll(path.sep, "/"), entry.name);
    if (entry.isDirectory()) files.push(...await walkFiles(root, child));
    else if (entry.isFile()) files.push(child);
  }
  return files;
}

export async function discoverGeneratedScriptArtifacts(repositoryRoot = defaultRepositoryRoot) {
  const candidates = new Set();
  for (const file of await walkFiles(path.join(repositoryRoot, "packages/bindings/generated"))) {
    // `defold-script-resource-namespaces.json` carries the `defold-script-`
    // prefix but belongs to `resourceNamespaceGenerator`, whose evidence is a
    // source tree rather than an enumerable input list, so this clean room
    // cannot regenerate it and must not claim to own it.
    if (file === "defold-script-resource-namespaces.json") continue;
    if (/^(?:defold-script-|defold-component-proxy-contract|defold-static-hermes-|defold-typed-native-|defold-value-layouts|war-battles-script-)/.test(file)) {
      candidates.add(`packages/bindings/generated/${file}`);
    }
  }
  for (const file of await walkFiles(path.join(repositoryRoot, "packages/sdk/src/generated/script"))) {
    candidates.add(`packages/sdk/src/generated/script/${file}`);
  }
  for (const file of await walkFiles(path.join(repositoryRoot, "defold/defold_hermes/include/defold_hermes"))) {
    if (/^generated_(?:script_|scalar_lua_|static_hermes_|defold_value_)/.test(file)) {
      candidates.add(`defold/defold_hermes/include/defold_hermes/${file}`);
    }
  }
  for (const file of await walkFiles(path.join(repositoryRoot, "defold/defold_hermes/src"))) {
    if (/^generated_(?:script_|scalar_lua_|static_hermes_)/.test(file)) {
      candidates.add(`defold/defold_hermes/src/${file}`);
    }
  }
  for (const file of await walkFiles(path.join(repositoryRoot, "examples/runtime-smoke/src/generated"))) {
    if (file.endsWith("real-engine-probes.ts")) candidates.add(`examples/runtime-smoke/src/generated/${file}`);
  }
  for (const file of await walkFiles(path.join(repositoryRoot, "packages/static-hermes/src/generated"))) {
    if (file === "script-vmath.ts" || file === "script-universal-value.ts" ||
        file === "script-typed-native-bridge.ts") {
      candidates.add(`packages/static-hermes/src/generated/${file}`);
    }
  }
  for (const file of await walkFiles(path.join(repositoryRoot, "defold/defold_hermes/lib/web"))) {
    if (file === "generated_script_universal_value.js") {
      candidates.add(`defold/defold_hermes/lib/web/${file}`);
    }
  }
  // The generated recording engine is a harness fixture rather than shipped
  // extension source, so it is discovered by its own generator-owned prefix.
  for (const file of await walkFiles(path.join(repositoryRoot, "tests/fixtures"))) {
    if (/^generated_script_recording_/.test(file)) candidates.add(`tests/fixtures/${file}`);
  }
  for (const documentation of [
    ".agents/docs/research/script-api-coverage.md",
    ".agents/docs/research/script-table-tuple-schema-classification.md"
  ]) {
    try {
      if ((await lstat(path.join(repositoryRoot, documentation))).isFile()) candidates.add(documentation);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return [...candidates].sort();
}

export function assertGeneratedArtifactInventory(actual, expected = generatedScriptArtifacts) {
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  const missing = [...expectedSet].filter((entry) => !actualSet.has(entry)).sort();
  const unexpected = [...actualSet].filter((entry) => !expectedSet.has(entry)).sort();
  if (missing.length || unexpected.length) {
    throw new Error([
      "Generated script artifact inventory is not generator-owned.",
      missing.length ? `Missing: ${missing.join(", ")}` : "",
      unexpected.length ? `Unexpected (possibly hand-authored): ${unexpected.join(", ")}` : ""
    ].filter(Boolean).join("\n"));
  }
}

export async function compareGeneratedArtifacts(cleanRoot, repositoryRoot, artifacts = generatedScriptArtifacts) {
  const hashes = {};
  for (const relativePath of artifacts) {
    const [generated, committed] = await Promise.all([
      readFile(path.join(cleanRoot, relativePath)),
      readFile(path.join(repositoryRoot, relativePath))
    ]);
    if (!generated.equals(committed)) {
      throw new Error(`${relativePath} is not byte-identical to clean-room generation`);
    }
    hashes[relativePath] = sha256(generated);
  }
  return hashes;
}

function ids(rows, label) {
  assert(Array.isArray(rows), `${label} must be an array`);
  const values = rows.map((row) => row.id);
  assert(values.every((id) => typeof id === "string" && id.startsWith("script:")), `${label} contains an invalid route id`);
  assert(new Set(values).size === values.length, `${label} contains duplicate route ids`);
  return new Set(values);
}

async function validateRouteProvenance(cleanRoot) {
  const load = async (relativePath) => JSON.parse(await readFile(path.join(cleanRoot, relativePath), "utf8"));
  const [inventory, ir, accounting, scalar, value, tuple, url, valueTail, overload, universal, constantLowering,
    profiles, projection, typedNative, loweringPlan] = await Promise.all([
    load("packages/bindings/generated/defold-script-api-inventory.json"),
    load("packages/bindings/generated/defold-script-api-ir.json"),
    load("packages/bindings/generated/defold-script-api-accounting.json"),
    load("packages/bindings/generated/defold-script-scalar-dispatch.json"),
    load("packages/bindings/generated/defold-script-value-bindings.json"),
    load("packages/bindings/generated/defold-script-fixed-tuples.json"),
    load("packages/bindings/generated/defold-script-url-address-classification.json"),
    load("packages/bindings/generated/defold-script-value-tail-bindings.json"),
    load("packages/bindings/generated/defold-script-overload-dispatch.json"),
    load("packages/bindings/generated/defold-script-universal-value-bindings.json"),
    load("packages/bindings/generated/defold-script-constant-lowering.json"),
    load("packages/bindings/generated/defold-script-route-availability-profiles.json"),
    load("packages/bindings/generated/defold-script-projection-ir.json"),
    load("packages/bindings/generated/defold-typed-native-bridge.json"),
    load("packages/bindings/generated/defold-binding-lowering-plan.json")
  ]);
  const inventoryFunctions = inventory.declarations.filter(({ kind }) => kind === "function");
  const irIds = ids(ir.functions, "script IR");
  const accountingIds = ids(accounting.rows, "script accounting");
  const projectionIds = ids(projection.rows, "script projection");
  const routeCount = irIds.size;
  assert(inventory.countsByKind?.function === inventoryFunctions.length && inventoryFunctions.length === routeCount,
    `Pinned inventory function census ${inventoryFunctions.length} does not match the IR route census ${routeCount}`);
  assert(ir.counts?.functions === routeCount, `Clean IR function count metadata is stale: ${ir.counts?.functions} versus ${routeCount}`);
  assert(accounting.functionCount === routeCount && accountingIds.size === routeCount,
    `Clean accounting function census does not match the IR route census ${routeCount}`);
  assert(projection.routeCount === routeCount && projection.generationCounts?.projected === routeCount && projectionIds.size === routeCount,
    `Clean projection IR does not project the current ${routeCount} script routes`);
  assert(projection.defoldRevision === ir.defoldRevision && profiles.defoldRevision === ir.defoldRevision,
    "Script projection/profile revision differs from the imported IR");
  const inventoryNames = new Set(inventoryFunctions.map(({ name }) => name));
  const irRawNames = new Set(ir.functions.map(({ rawName }) => rawName));
  assert(inventoryNames.size === inventoryFunctions.length && irRawNames.size === routeCount,
    "Pinned inventory and IR must each contain unique raw function names");
  for (const name of inventoryNames) assert(irRawNames.has(name), `Script IR is missing pinned function ${name}`);
  for (const id of irIds) assert(accountingIds.has(id), `Accounting is missing generated route ${id}`);
  for (const id of irIds) assert(projectionIds.has(id), `Projection IR is missing generated route ${id}`);
  for (const [profileName, profile] of Object.entries(profiles.profiles ?? {})) {
    assert(profile.documentedRouteCount === (profile.documentedRoutes ?? []).length,
      `${profileName} documented route count is stale`);
    assert(profile.availableRouteCount === (profile.availableRoutes ?? []).length,
      `${profileName} available route count is stale`);
  }
  const executableIds = [
    ...ids(scalar.bindings, "scalar routes"),
    ...ids(value.bindings, "value routes"),
    ...ids(tuple.bindings, "fixed tuple routes"),
    ...ids(url.rows, "URL routes"),
    ...ids(valueTail.bindings.filter(({ disposition }) => disposition === "candidate"), "value-tail routes"),
    ...ids(overload.bindings.filter(({ generatedFamilyExecutableCandidate }) => generatedFamilyExecutableCandidate), "overload routes")
  ];
  assert(new Set(executableIds).size === executableIds.length, "Executable route generators overlap");
  for (const id of executableIds) assert(irIds.has(id), `Generated executable route is absent from pinned IR: ${id}`);
  const universalCallableIds = ids(
    universal.bindings.filter(({ loweringFamily }) => loweringFamily !== "script-constant"),
    "universal callable fallback routes");
  const universalConstantIds = ids(
    universal.bindings.filter(({ loweringFamily }) => loweringFamily === "script-constant"),
    "universal constant routes");
  assert(universalCallableIds.size + universalConstantIds.size === universal.bindings.length,
    "Universal fallback route partitions do not cover the current catalog");
  for (const id of universalCallableIds) assert(irIds.has(id), `Universal fallback route is absent from pinned IR: ${id}`);
  const constantEntries = constantLowering.entries;
  assert(constantLowering.counts?.total === constantEntries.length,
    "Constant lowering policy count metadata is stale");
  const runtimeConstantIds = new Set(constantEntries
    .filter(({ state }) => state !== "inlined")
    .map(({ name }) => `script:constant.${name}`));
  assert(runtimeConstantIds.size === universalConstantIds.size &&
    JSON.stringify([...runtimeConstantIds].sort()) === JSON.stringify([...universalConstantIds].sort()),
  "Every non-inlined constant must have exactly one generated universal route");
  assert(constantEntries.every((entry) => Number.isInteger(entry.stableId) && entry.stableId > 0 &&
    Array.isArray(entry.profiles) && entry.profiles.length === constantLowering.targets.length &&
    entry.profiles.every((profile) => typeof profile.id === "string" && typeof profile.registered === "boolean")),
  "Every documented constant must retain generated stable identity and profile metadata");
  assert(constantEntries.filter(({ state }) => state === "inlined").every(({ value, profiles: rows }) =>
    value !== undefined && rows.every((profile) => profile.registered && profile.value === value)),
  "Every inlined constant must retain one source-derived value across selected profiles");
  const plannedTypedNative = loweringPlan.units.filter((unit) =>
    unit.identity.surface === "script" &&
    unit.backends?.staticHermesCAbi?.selection === "emit")
    .map((unit) => `${unit.identity.stableId}:${unit.identity.id}`).sort();
  const generatedTypedNative = typedNative.claimedRoutes
    .map((route) => `${route.stableId}:${route.id}`).sort();
  const typedNativeFunctionRouteCount = typedNative.claimedRoutes
    .filter(({ id }) => !id.startsWith("script:constant.")).length;
  const typedNativeConstantRouteCount = typedNative.claimedRoutes
    .filter(({ id }) => id.startsWith("script:constant.")).length;
  assert(typedNative.planTypedNativeEmit === plannedTypedNative.length,
    "Typed-native report does not carry the canonical script plan count");
  assert(typedNative.claimedRouteCount === plannedTypedNative.length && typedNative.declinedRouteCount === 0,
    "Typed-native bridge must realize every canonical script selection without a second decline list");
  assert(JSON.stringify(generatedTypedNative) === JSON.stringify(plannedTypedNative),
    "Typed-native bridge route identities differ from the canonical script plan");
  const modulesSource = await readFile(path.join(cleanRoot, "packages/sdk/src/generated/script/modules.ts"), "utf8");
  const emittedStableIds = [...modulesSource.matchAll(/callScriptApi\((0x[0-9a-f]{8}), args\)/g)]
    .map((match) => match[1]);
  assert(emittedStableIds.length === routeCount,
    `Generated TypeScript SDK emits ${emittedStableIds.length} calls, expected ${routeCount}`);
  assert(new Set(emittedStableIds).size === routeCount, "Generated TypeScript SDK contains duplicate stable-ID calls");
  const emittedSet = new Set(emittedStableIds);
  for (const id of irIds) {
    const expectedStableId = `0x${stableBindingId(id).toString(16).padStart(8, "0")}`;
    assert(emittedSet.has(expectedStableId), `Generated TypeScript SDK is missing ${id} (${expectedStableId})`);
  }
  return {
    routeCount: irIds.size,
    accountedRouteCount: accountingIds.size,
    executableRouteCount: executableIds.length,
    universalRouteCount: universalCallableIds.size,
    universalConstantRouteCount: universalConstantIds.size,
    constantPolicyCount: constantEntries.length,
    scalarRouteCount: scalar.bindingCount,
    valueRouteCount: value.bindingCount,
    fixedTupleRouteCount: tuple.bindingCount,
    urlRouteCount: url.routeCount,
    valueTailRouteCount: valueTail.candidateCount,
    overloadRouteCount: overload.generatedFamilyCandidateCount,
    typedNativeRouteCount: typedNative.claimedRouteCount,
    typedNativeFunctionRouteCount,
    typedNativeConstantRouteCount,
    projectedRouteCount: projection.routeCount,
    defaultProfileRouteCount: profiles.profiles[profiles.engineProfileSelection.defaultProfileId].availableRouteCount,
    defoldRevision: ir.defoldRevision
  };
}

async function inputFingerprint(cleanRoot, inputs) {
  const hash = createHash("sha256");
  for (const relativePath of [...inputs].sort()) {
    const contents = await readFile(path.join(cleanRoot, relativePath));
    hash.update(relativePath).update("\0").update(contents).update("\0");
  }
  return hash.digest("hex");
}

export async function runScriptCleanRoomRegeneration(options = {}) {
  const repositoryRoot = path.resolve(options.repositoryRoot ?? defaultRepositoryRoot);
  const cleanRoot = await mkdtemp(path.join(tmpdir(), "deherm-script-clean-room-"));
  const keep = options.keep ?? process.env.DEHERM_KEEP_CLEAN_ROOM === "1";
  try {
    const evidencePaths = await sourceEvidencePaths(repositoryRoot);
    const pinnedGroundTruth = await validatePinnedGroundTruth(repositoryRoot, evidencePaths);
    const cleanInputs = [...new Set([...scriptGeneratorSources, ...scriptPinnedInputs, ...evidencePaths])];
    for (const relativePath of cleanInputs) await copyRelative(repositoryRoot, cleanRoot, relativePath);
    const locked = parseYaml(await readFile(path.join(repositoryRoot, "pnpm-lock.yaml"), "utf8"));
    const installedFflate = JSON.parse(await readFile(path.join(repositoryRoot, "node_modules/fflate/package.json"), "utf8"));
    const lockedFflate = locked.importers?.["."]?.dependencies?.fflate?.version;
    assert(installedFflate.version === lockedFflate,
      `Installed fflate ${installedFflate.version} does not match pnpm lockfile ${lockedFflate}`);
    await mkdir(path.join(cleanRoot, "node_modules"), { recursive: true });
    await cp(path.join(repositoryRoot, "node_modules/fflate"), path.join(cleanRoot, "node_modules/fflate"), { recursive: true });
    for (const relativePath of generatedScriptArtifacts) {
      await mkdir(path.dirname(path.join(cleanRoot, relativePath)), { recursive: true });
    }
    for (const step of scriptGenerationSteps) {
      const command = step.runtime === "node" ? process.execPath : step.runtime;
      await execFileAsync(command, [step.script], { cwd: cleanRoot, maxBuffer: 16 * 1024 * 1024 });
    }
    assertGeneratedArtifactInventory(await discoverGeneratedScriptArtifacts(cleanRoot));
    assertGeneratedArtifactInventory(await discoverGeneratedScriptArtifacts(repositoryRoot));
    const routeProvenance = await validateRouteProvenance(cleanRoot);
    const artifactSha256 = await compareGeneratedArtifacts(cleanRoot, repositoryRoot);
    return {
      ...routeProvenance,
      pinnedGroundTruth,
      artifactCount: generatedScriptArtifacts.length,
      inputCount: cleanInputs.length,
      aggregateInputSha256: await inputFingerprint(cleanRoot, cleanInputs),
      artifactSha256,
      cleanRoot: keep ? cleanRoot : undefined
    };
  } finally {
    if (!keep) await rm(cleanRoot, { recursive: true, force: true });
  }
}

async function main() {
  const unknown = process.argv.slice(2).filter((argument) => argument !== "--keep");
  if (unknown.length) throw new Error(`Unknown argument: ${unknown[0]}`);
  const report = await runScriptCleanRoomRegeneration({ keep: process.argv.includes("--keep") });
  console.log(`Clean-room regeneration verified ${report.routeCount} script routes across ${report.artifactCount} byte-identical artifacts.`);
  console.log(`Universal callable fallback: ${report.universalRouteCount}; optimized generated routes: ${report.executableRouteCount} (${report.scalarRouteCount} scalar, ${report.valueRouteCount} value, ${report.fixedTupleRouteCount} fixed tuple, ${report.urlRouteCount} URL/address, ${report.valueTailRouteCount} value-tail, ${report.overloadRouteCount} overload).`);
  console.log(`Pinned input fingerprint: ${report.aggregateInputSha256}`);
  if (report.cleanRoot) console.log(`Clean room retained at ${report.cleanRoot}`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    console.error(error.stack ?? error.message);
    process.exitCode = 1;
  });
}
