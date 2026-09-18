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

import { stableBindingId } from "./lib/binding-identity.mjs";

const execFileAsync = promisify(execFile);
const defaultRepositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const generatorSources = [
  "scripts/import-defold-script-api.py",
  "scripts/generate-script-sdk.mjs",
  "scripts/classify-script-bindings.mjs",
  "scripts/generate-script-binding-descriptors.mjs",
  "scripts/generate-scalar-lua-dispatch.mjs",
  "scripts/generate-script-value-bindings.mjs",
  "scripts/generate-script-fixed-tuples.mjs",
  "scripts/generate-script-real-engine-probes.mjs",
  "scripts/generate-script-value-real-engine-probes.mjs",
  "scripts/generate-script-api-accounting.mjs",
  "scripts/generate-borrowed-handle-classification.mjs",
  "scripts/generate-script-table-tuple-schemas.mjs",
  "scripts/generate-script-url-address-classification.mjs",
  "scripts/generate-script-real-engine-matrix.mjs",
  "scripts/generate-war-battles-real-engine-probes.mjs",
  "scripts/lib/binding-identity.mjs",
  "scripts/lib/script-semantic-overrides.mjs",
  "packages/cli/src/names.mjs"
];

const pinnedInputs = [
  "package.json",
  "package-lock.json",
  "upstream.lock",
  "upstream/ref-doc.zip",
  "bindings/lua-compat.json",
  "bindings/overrides/script-api-semantic-overrides.json",
  "bindings/overrides/script-borrowed-handle-classification.json",
  "bindings/overrides/script-defold-handle-bindings.json",
  "bindings/overrides/script-defold-value-bindings.json",
  "bindings/overrides/script-fixed-tuple-registrations.json",
  "bindings/overrides/script-factory-structured-bindings.json",
  "bindings/overrides/script-go-current-instance-bindings.json",
  "bindings/overrides/script-gui-structured-bindings.json",
  "bindings/overrides/script-msg-structured-bindings.json",
  "bindings/overrides/script-table-tuple-schema-overrides.json",
  "bindings/overrides/script-url-address-classification.json",
  "bindings/probes/defold-script-real-engine-matrix.json",
  "bindings/probes/defold-script-real-engine-probes.json",
  "bindings/probes/defold-script-value-real-engine-probes.json",
  "bindings/probes/war-battles-script-real-engine-probes.json"
];

export const generatedScriptArtifacts = Object.freeze([
  "bindings/generated/defold-script-api-inventory.json",
  "knowledge/research/script-api-coverage.md",
  "bindings/generated/defold-script-api-ir.json",
  "packages/sdk/src/generated/script/types.ts",
  "packages/sdk/src/generated/script/modules.ts",
  "packages/sdk/src/generated/script/runtime.ts",
  "packages/sdk/src/generated/script/index.ts",
  "bindings/generated/defold-script-binding-patterns.json",
  "bindings/generated/defold-script-binding-descriptors.json",
  "defold/defold_hermes/include/defold_hermes/generated_script_binding_descriptors.hpp",
  "bindings/generated/defold-script-scalar-dispatch.json",
  "defold/defold_hermes/include/defold_hermes/generated_scalar_lua_ids.hpp",
  "defold/defold_hermes/src/generated_scalar_lua_descriptors.cpp",
  "bindings/generated/defold-script-value-bindings.json",
  "defold/defold_hermes/include/defold_hermes/generated_script_value_bindings.hpp",
  "defold/defold_hermes/src/generated_script_value_bindings.cpp",
  "packages/sdk/src/generated/script/value-target-support.ts",
  "bindings/generated/defold-script-fixed-tuples.json",
  "bindings/generated/defold-script-fixed-tuple-probes.json",
  "defold/defold_hermes/include/defold_hermes/generated_script_fixed_tuples.hpp",
  "defold/defold_hermes/src/generated_script_fixed_tuples.cpp",
  "packages/sdk/src/generated/script/fixed-tuple-target-support.ts",
  "bindings/generated/defold-script-real-engine-probes.json",
  "sample/src/generated/script-real-engine-probes.ts",
  "bindings/generated/defold-script-value-real-engine-probes.json",
  "sample/src/generated/script-value-real-engine-probes.ts",
  "bindings/generated/defold-script-api-accounting.json",
  "bindings/generated/defold-script-borrowed-handle-classification.json",
  "bindings/generated/defold-script-table-tuple-schemas.json",
  "knowledge/research/script-table-tuple-schema-classification.md",
  "bindings/generated/defold-script-url-address-classification.json",
  "bindings/generated/defold-script-real-engine-matrix.json",
  "bindings/generated/war-battles-script-real-engine-probes.json",
  "sample/src/generated/war-battles-script-real-engine-probes.ts"
]);

const generationSteps = [
  ["python3", ["scripts/import-defold-script-api.py"]],
  [process.execPath, ["scripts/generate-script-sdk.mjs"]],
  [process.execPath, ["scripts/classify-script-bindings.mjs"]],
  [process.execPath, ["scripts/generate-script-binding-descriptors.mjs"]],
  [process.execPath, ["scripts/generate-scalar-lua-dispatch.mjs"]],
  [process.execPath, ["scripts/generate-script-value-bindings.mjs"]],
  [process.execPath, ["scripts/generate-script-fixed-tuples.mjs"]],
  [process.execPath, ["scripts/generate-script-real-engine-probes.mjs"]],
  [process.execPath, ["scripts/generate-script-value-real-engine-probes.mjs"]],
  [process.execPath, ["scripts/generate-script-api-accounting.mjs"]],
  [process.execPath, ["scripts/generate-borrowed-handle-classification.mjs"]],
  [process.execPath, ["scripts/generate-script-table-tuple-schemas.mjs"]],
  [process.execPath, ["scripts/generate-script-url-address-classification.mjs"]],
  [process.execPath, ["scripts/generate-script-real-engine-matrix.mjs"]],
  [process.execPath, ["scripts/generate-war-battles-real-engine-probes.mjs"]]
];

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
  for (const inputPath of pinnedInputs.filter((entry) => entry.startsWith("bindings/overrides/"))) {
    const value = JSON.parse(await readFile(path.join(repositoryRoot, inputPath), "utf8"));
    if (inputPath.endsWith("script-api-semantic-overrides.json")) {
      for (const override of value.overrides ?? []) {
        result.add(`upstream/defold/${confinedRelativePath(override.evidence?.source, `${override.id}.evidence.source`)}`);
      }
      continue;
    }
    if (inputPath.endsWith("script-borrowed-handle-classification.json")) {
      for (const evidence of value.sourceEvidence ?? []) {
        result.add(`upstream/defold/${confinedRelativePath(evidence.source, `${inputPath}.sourceEvidence.source`)}`);
      }
      continue;
    }
    if (inputPath.endsWith("script-fixed-tuple-registrations.json")) {
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
    if (!value.source) continue;
    result.add(`upstream/defold/${confinedRelativePath(value.source, `${inputPath}.source`)}`);
    for (const evidence of value.additionalSourceEvidence ?? []) {
      result.add(`upstream/defold/${confinedRelativePath(evidence.source, `${inputPath}.additionalSourceEvidence.source`)}`);
    }
  }
  const matrix = JSON.parse(await readFile(
    path.join(repositoryRoot, "bindings/probes/defold-script-real-engine-matrix.json"),
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
  const relativeEvidence = evidencePaths
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
  for (const file of await walkFiles(path.join(repositoryRoot, "bindings/generated"))) {
    if (/^(?:defold-script-|war-battles-script-)/.test(file)) candidates.add(`bindings/generated/${file}`);
  }
  for (const file of await walkFiles(path.join(repositoryRoot, "packages/sdk/src/generated/script"))) {
    candidates.add(`packages/sdk/src/generated/script/${file}`);
  }
  for (const file of await walkFiles(path.join(repositoryRoot, "defold/defold_hermes/include/defold_hermes"))) {
    if (/^generated_(?:script_|scalar_lua_)/.test(file)) {
      candidates.add(`defold/defold_hermes/include/defold_hermes/${file}`);
    }
  }
  for (const file of await walkFiles(path.join(repositoryRoot, "defold/defold_hermes/src"))) {
    if (/^generated_(?:script_|scalar_lua_)/.test(file)) {
      candidates.add(`defold/defold_hermes/src/${file}`);
    }
  }
  for (const file of await walkFiles(path.join(repositoryRoot, "sample/src/generated"))) {
    if (file.endsWith("real-engine-probes.ts")) candidates.add(`sample/src/generated/${file}`);
  }
  for (const documentation of [
    "knowledge/research/script-api-coverage.md",
    "knowledge/research/script-table-tuple-schema-classification.md"
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
  const [inventory, ir, accounting, scalar, value, tuple] = await Promise.all([
    load("bindings/generated/defold-script-api-inventory.json"),
    load("bindings/generated/defold-script-api-ir.json"),
    load("bindings/generated/defold-script-api-accounting.json"),
    load("bindings/generated/defold-script-scalar-dispatch.json"),
    load("bindings/generated/defold-script-value-bindings.json"),
    load("bindings/generated/defold-script-fixed-tuples.json")
  ]);
  assert(inventory.countsByKind?.function === 926, `Pinned inventory contains ${inventory.countsByKind?.function} functions, expected 926`);
  assert(ir.counts?.functions === 926, `Clean IR contains ${ir.counts?.functions} functions, expected 926`);
  assert(accounting.functionCount === 926, `Clean accounting contains ${accounting.functionCount} functions, expected 926`);
  const inventoryNames = new Set(inventory.declarations
    .filter(({ kind }) => kind === "function")
    .map(({ name }) => name));
  const irIds = ids(ir.functions, "script IR");
  const accountingIds = ids(accounting.rows, "script accounting");
  const irRawNames = new Set(ir.functions.map(({ rawName }) => rawName));
  assert(inventoryNames.size === 926 && irRawNames.size === 926, "Pinned inventory and IR must each contain 926 unique raw function names");
  for (const name of inventoryNames) assert(irRawNames.has(name), `Script IR is missing pinned function ${name}`);
  assert(irIds.size === 926 && accountingIds.size === 926, "Full script route ledger must contain exactly 926 unique IDs");
  for (const id of irIds) assert(accountingIds.has(id), `Accounting is missing generated route ${id}`);
  const executableIds = [...ids(scalar.bindings, "scalar routes"), ...ids(value.bindings, "value routes"), ...ids(tuple.bindings, "fixed tuple routes")];
  assert(new Set(executableIds).size === executableIds.length, "Executable route generators overlap");
  for (const id of executableIds) assert(irIds.has(id), `Generated executable route is absent from pinned IR: ${id}`);
  const modulesSource = await readFile(path.join(cleanRoot, "packages/sdk/src/generated/script/modules.ts"), "utf8");
  const emittedStableIds = [...modulesSource.matchAll(/callScriptApi\((0x[0-9a-f]{8}), args\)/g)]
    .map((match) => match[1]);
  assert(emittedStableIds.length === 926,
    `Generated TypeScript SDK emits ${emittedStableIds.length} calls, expected 926`);
  assert(new Set(emittedStableIds).size === 926, "Generated TypeScript SDK contains duplicate stable-ID calls");
  const emittedSet = new Set(emittedStableIds);
  for (const id of irIds) {
    const expectedStableId = `0x${stableBindingId(id).toString(16).padStart(8, "0")}`;
    assert(emittedSet.has(expectedStableId), `Generated TypeScript SDK is missing ${id} (${expectedStableId})`);
  }
  return {
    routeCount: irIds.size,
    accountedRouteCount: accountingIds.size,
    executableRouteCount: executableIds.length,
    scalarRouteCount: scalar.bindingCount,
    valueRouteCount: value.bindingCount,
    fixedTupleRouteCount: tuple.bindingCount,
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
    const cleanInputs = [...generatorSources, ...pinnedInputs, ...evidencePaths];
    for (const relativePath of cleanInputs) await copyRelative(repositoryRoot, cleanRoot, relativePath);
    const locked = JSON.parse(await readFile(path.join(repositoryRoot, "package-lock.json"), "utf8"));
    const installedFflate = JSON.parse(await readFile(path.join(repositoryRoot, "node_modules/fflate/package.json"), "utf8"));
    const lockedFflate = locked.packages?.["node_modules/fflate"]?.version;
    assert(installedFflate.version === lockedFflate,
      `Installed fflate ${installedFflate.version} does not match package-lock ${lockedFflate}`);
    await mkdir(path.join(cleanRoot, "node_modules"), { recursive: true });
    await cp(path.join(repositoryRoot, "node_modules/fflate"), path.join(cleanRoot, "node_modules/fflate"), { recursive: true });
    for (const relativePath of generatedScriptArtifacts) {
      await mkdir(path.dirname(path.join(cleanRoot, relativePath)), { recursive: true });
    }
    for (const [command, args] of generationSteps) {
      await execFileAsync(command, args, { cwd: cleanRoot, maxBuffer: 16 * 1024 * 1024 });
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
  console.log(`Executable generated routes: ${report.executableRouteCount} (${report.scalarRouteCount} scalar, ${report.valueRouteCount} value, ${report.fixedTupleRouteCount} fixed tuple).`);
  console.log(`Pinned input fingerprint: ${report.aggregateInputSha256}`);
  if (report.cleanRoot) console.log(`Clean room retained at ${report.cleanRoot}`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    console.error(error.stack ?? error.message);
    process.exitCode = 1;
  });
}
