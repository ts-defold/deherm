#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { copyFile, cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import {
  dmSdkGenerationSteps,
  dmSdkGeneratorSources,
  dmSdkPinnedInputs,
  generatedDmSdkArtifacts
} from "./lib/dmsdk-generator-pipeline.mjs";

const execFileAsync = promisify(execFile);
const repositoryRootDefault = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const scalarImplementationEvidence = Object.freeze([
  "upstream/defold/engine/dlib/src/dlib/log.cpp",
  "upstream/defold/engine/dlib/src/dlib/profile/profile.cpp",
  "upstream/defold/engine/dlib/src/dlib/profile/profile_null.cpp",
  "upstream/defold/engine/dlib/src/dlib/time_apple.cpp",
  "upstream/defold/engine/dlib/src/dlib/time_posix.cpp",
  "upstream/defold/engine/dlib/src/dlib/time_win32.cpp",
  "upstream/defold/engine/dlib/src/dlib/trig_lookup.cpp",
  "upstream/defold/engine/dlib/src/dmsdk/dlib/crypt.h",
  "upstream/defold/engine/dlib/src/dlib/crypt.cpp",
  "upstream/defold/engine/dlib/src/dmsdk/dlib/image.h",
  "upstream/defold/engine/dlib/src/dlib/image.cpp",
  "upstream/defold/engine/dlib/src/dlib/hash.cpp",
  "upstream/defold/engine/graphics/src/graphics.cpp"
]);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function parseLock(text) {
  return Object.fromEntries(text.split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    return match ? [[match[1], match[2]]] : [];
  }));
}

function confined(relativePath, label) {
  assert(typeof relativePath === "string" && relativePath.length > 0, `${label} must be a non-empty path`);
  assert(!path.isAbsolute(relativePath), `${label} must be repository-relative`);
  const normalized = relativePath.replaceAll("\\", "/");
  assert(!normalized.split("/").includes(".."), `${label} must not escape the repository`);
  return normalized;
}

async function copyRelative(sourceRoot, targetRoot, relativePath) {
  const safe = confined(relativePath, "copy path");
  const target = path.join(targetRoot, safe);
  await mkdir(path.dirname(target), { recursive: true });
  await copyFile(path.join(sourceRoot, safe), target);
}

export function assertDeclaredYamlDependency({ rootPackage, lockfile, installedPackage }) {
  const declared = rootPackage?.dependencies?.yaml;
  assert(/^\d+\.\d+\.\d+$/u.test(declared ?? ""),
    "the clean-room YAML parser must be declared at one exact package version");
  assert(installedPackage?.name === "yaml" && installedPackage.version === declared,
    `installed yaml ${installedPackage?.version ?? "missing"} does not match package.json ${declared}`);
  const escaped = declared.replaceAll(".", "\\.");
  assert(new RegExp(`^  yaml@${escaped}:$`, "mu").test(lockfile),
    `pnpm-lock.yaml does not pin yaml@${declared}`);
  return declared;
}

async function copyDeclaredGeneratorDependencies(sourceRoot, targetRoot) {
  // The target-conditional and symbol-evidence generators parse Defold's own
  // YAML manifests. An installed npm package has this declared dependency;
  // the synthetic clean room must provision the same pinned package instead
  // of accidentally succeeding only because a parent checkout has node_modules.
  const yamlSource = await realpath(path.join(sourceRoot, "node_modules/yaml"));
  const [rootPackage, lockfile, installedPackage] = await Promise.all([
    readFile(path.join(sourceRoot, "package.json"), "utf8").then(JSON.parse),
    readFile(path.join(sourceRoot, "pnpm-lock.yaml"), "utf8"),
    readFile(path.join(yamlSource, "package.json"), "utf8").then(JSON.parse)
  ]);
  assertDeclaredYamlDependency({ rootPackage, lockfile, installedPackage });
  await cp(yamlSource, path.join(targetRoot, "node_modules/yaml"), {
    recursive: true,
    dereference: true
  });
}

async function evidencePaths(repositoryRoot, defoldRevision) {
  const ir = JSON.parse(await readFile(path.join(repositoryRoot, "packages/bindings/generated/defold-sdk-ir.json"), "utf8"));
  const inventory = JSON.parse(await readFile(
    path.join(repositoryRoot, "packages/bindings/generated/defold-sdk-inventory.json"),
    "utf8"
  ));
  assert(ir.defoldRevision === defoldRevision,
    `dmSDK IR revision ${ir.defoldRevision} does not match upstream.lock ${defoldRevision}`);
  assert(inventory.defoldRevision === defoldRevision,
    `dmSDK inventory revision ${inventory.defoldRevision} does not match upstream.lock ${defoldRevision}`);
  const result = new Set(scalarImplementationEvidence);
  for (const header of await walk(repositoryRoot, "upstream/defold/engine")) {
    if (header.split("/").includes("dmsdk") && /\.(?:h|hpp)$/u.test(header)) result.add(header);
  }
  for (const declaration of [...(inventory.declarations ?? []), ...(inventory.typeSupportDeclarations ?? [])]) {
    if (declaration.header?.startsWith("upstream/defold/engine/")) {
      result.add(confined(declaration.header, `${declaration.id ?? declaration.name}.header`));
    }
  }
  for (const declaration of ir.declarations) {
    if (declaration.disposition === "generated-raw-call") result.add(confined(declaration.header, `${declaration.id}.header`));
  }
  const sdkRoot = `upstream/extender/server/app/sdk/${defoldRevision}/defoldsdk`;
  result.add(`${sdkRoot}/sdk/include/dmsdk/graphics/graphics.h`);
  result.add(`${sdkRoot}/include/graphics/graphics_ddf.h`);
  const namedScalarPolicy = JSON.parse(await readFile(
    path.join(repositoryRoot, "packages/bindings/overrides/dmsdk-named-scalar-policies.json"),
    "utf8"
  ));
  for (const rule of namedScalarPolicy.rules ?? []) {
    for (const [evidencePath] of rule.evidence ?? []) {
      result.add(confined(evidencePath, `${rule.id}.evidence.path`));
    }
  }
  const cstringPolicy = JSON.parse(await readFile(
    path.join(repositoryRoot, "packages/bindings/overrides/dmsdk-cstring-value-bindings.json"),
    "utf8"
  ));
  for (const evidence of [...(cstringPolicy.sourceEvidence ?? []), ...(cstringPolicy.blockerSourceEvidence ?? [])]) {
    result.add(confined(evidence.path, `${evidence.id}.evidence.path`));
  }
  return [...result].sort();
}

async function validateGroundTruth(repositoryRoot, sources) {
  const lock = parseLock(await readFile(path.join(repositoryRoot, "upstream.lock"), "utf8"));
  assert(/^[0-9a-f]{40}$/.test(lock.DEFOLD_REV ?? ""), "upstream.lock has no exact DEFOLD_REV");
  const defoldRoot = path.join(repositoryRoot, "upstream/defold");
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: defoldRoot });
  assert(stdout.trim() === lock.DEFOLD_REV,
    `Defold checkout ${stdout.trim()} does not match upstream.lock ${lock.DEFOLD_REV}`);
  const tracked = sources.filter((entry) => entry.startsWith("upstream/defold/"))
    .map((entry) => entry.slice("upstream/defold/".length));
  await execFileAsync("git", ["ls-files", "--error-unmatch", "--", ...tracked], { cwd: defoldRoot });
  try {
    await execFileAsync("git", ["diff", "--quiet", "HEAD", "--", ...tracked], { cwd: defoldRoot });
  } catch (error) {
    if (error.code === 1) throw new Error("Pinned dmSDK header/source evidence has local modifications");
    throw error;
  }
  return { defoldRevision: lock.DEFOLD_REV };
}

async function walk(root, relative = "") {
  let entries;
  try {
    entries = await readdir(path.join(root, relative), { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, "en"))) {
    const child = path.posix.join(relative.replaceAll(path.sep, "/"), entry.name);
    if (entry.isDirectory()) files.push(...await walk(root, child));
    else if (entry.isFile()) files.push(child);
  }
  return files;
}

export async function discoverGeneratedDmSdkArtifacts(repositoryRoot = repositoryRootDefault) {
  const result = new Set();
  for (const file of await walk(path.join(repositoryRoot, "packages/bindings/generated"))) {
    if (/^defold-dmsdk-(?:target-conditionals|binding-patterns|scalar-thunks|abi-shapes|enum-value-bindings|named-scalar-bindings|fixed-digest-bindings|base64-span-bindings|astc-probe-bindings|xtea-span-bindings|hash-span-bindings|hash-state-bindings|arena-span-blockers|projection-ir|borrowed-handle-bindings|scratch-scalar-out-bindings|cstring-value-bindings|universal-bindings|universal-ready-exact-plan|generated-adapter-exact-plan)\.json$/.test(file)) {
      result.add(`packages/bindings/generated/${file}`);
    }
  }
  for (const file of await walk(path.join(repositoryRoot, "defold/defold_hermes/include/defold_hermes"))) {
    if (/^generated_dmsdk_(?:scalar|enum_value|named_scalar|fixed_digest|base64_span|astc_probe|xtea_span|hash_span|hash_state|arena_cstring|borrowed_handle|scratch_scalar_out|cstring_value|universal)/.test(file)) {
      result.add(`defold/defold_hermes/include/defold_hermes/${file}`);
    }
  }
  for (const file of await walk(path.join(repositoryRoot, "defold/defold_hermes/src"))) {
    if (/^generated_dmsdk_(?:scalar|enum_value|named_scalar|fixed_digest|base64_span|astc_probe|xtea_span|hash_span|hash_state|arena_cstring|borrowed_handle|scratch_scalar_out|cstring_value|universal)/.test(file)) {
      result.add(`defold/defold_hermes/src/${file}`);
    }
  }
  for (const browser of ["defold/defold_hermes/lib/web/generated_dmsdk_scalar.js", "defold/defold_hermes/lib/web/generated_dmsdk_borrowed_handle.js", "defold/defold_hermes/lib/web/generated_dmsdk_scratch_scalar_out.js", "defold/defold_hermes/lib/web/generated_dmsdk_cstring_value.js", "defold/defold_hermes/lib/web/generated_dmsdk_universal.js"]) {
    try {
      if ((await lstat(path.join(repositoryRoot, browser))).isFile()) result.add(browser);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  for (const file of ["scalar.ts", "enum-value.ts", "named-scalar.ts", "borrowed-handle.ts", "scratch-scalar-out.ts", "cstring-value.ts", "browser-arena.ts", "universal.ts"]) {
    const relative = `packages/sdk/src/generated/dmsdk/${file}`;
    try {
      if ((await lstat(path.join(repositoryRoot, relative))).isFile()) result.add(relative);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  for (const relative of [
    "packages/static-hermes/src/generated/dmsdk-borrowed-handle.ts",
    "packages/static-hermes/src/generated/dmsdk-scratch-scalar-out.ts",
    "packages/static-hermes/src/generated/dmsdk-cstring-value.ts",
    "packages/static-hermes/src/generated/dmsdk-universal.ts",
    "packages/compiler/src/generated/dmsdk-universal-recipes.mjs",
    "native/generated_dmsdk_borrowed_handle_exact_call.cpp",
    "native/generated_dmsdk_borrowed_handle_header_audit.cpp",
    "native/generated_dmsdk_scratch_scalar_out_header_audit.cpp",
    "tests/fixtures/generated_dmsdk_arena_cstring_exact.cpp",
    "tests/fixtures/generated_dmsdk_named_scalar_exact_verification.cpp",
    "tests/fixtures/generated_dmsdk_hash_state_exact.cpp",
    "tests/fixtures/generated_dmsdk_universal_test_provider.cpp",
    "tests/fixtures/generated_dmsdk_universal_test_ids.h",
    "tests/fixtures/generated_dmsdk_universal_ready_provider.cpp",
    "tests/fixtures/generated_dmsdk_universal_ready_verification.cpp",
    "tests/fixtures/generated_dmsdk_adapter_exact_verification.cpp",
    "tests/fixtures/generated_dmsdk_adapter_jsi_exact_verification.cpp"
  ]) {
    try {
      if ((await lstat(path.join(repositoryRoot, relative))).isFile()) result.add(relative);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return [...result].sort();
}

export function assertGeneratedDmSdkArtifactInventory(actual, expected = generatedDmSdkArtifacts) {
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  const missing = [...expectedSet].filter((entry) => !actualSet.has(entry)).sort();
  const unexpected = [...actualSet].filter((entry) => !expectedSet.has(entry)).sort();
  if (missing.length || unexpected.length) {
    throw new Error([
      "Generated dmSDK artifact inventory is not generator-owned.",
      missing.length ? `Missing: ${missing.join(", ")}` : "",
      unexpected.length ? `Unexpected (possibly hand-authored): ${unexpected.join(", ")}` : ""
    ].filter(Boolean).join("\n"));
  }
}

async function compareArtifacts(cleanRoot, repositoryRoot) {
  const hashes = {};
  for (const relative of generatedDmSdkArtifacts) {
    const [generated, committed] = await Promise.all([
      readFile(path.join(cleanRoot, relative)),
      readFile(path.join(repositoryRoot, relative))
    ]);
    if (!generated.equals(committed)) throw new Error(`${relative} is not byte-identical to clean-room generation`);
    hashes[relative] = sha256(generated);
  }
  return hashes;
}

function censusIds(rows, key, label) {
  assert(Array.isArray(rows), `${label} must be an array`);
  const values = rows.map((row) => row?.[key]);
  assert(values.every((id) => typeof id === "string" && id.length > 0), `${label} contains an invalid declaration id`);
  assert(new Set(values).size === values.length, `${label} contains duplicate declaration ids`);
  return new Set(values);
}

function equalCensus(left, right, label) {
  assert(left.size === right.size && [...left].every((id) => right.has(id)), `${label} does not match the source declaration census`);
}

export function assertDmSdkSourceCensus({ patterns, shapes, projection, universal }) {
  const patternIds = censusIds(patterns.bindings, "id", "dmSDK binding patterns");
  const shapeIds = censusIds(shapes.rows, "id", "dmSDK ABI shapes");
  const projectionIds = censusIds(projection.rows, "id", "dmSDK projection");
  const universalIds = censusIds(universal.recipes, "declarationId", "dmSDK universal recipes");
  const runtimePendingCount = patternIds.size;
  assert(patterns.coverage?.runtimePendingCount === runtimePendingCount && patterns.coverage?.classifiedCount === runtimePendingCount,
    "dmSDK classifier coverage metadata is stale against its source rows");
  assert(shapes.coverage?.runtimePending === runtimePendingCount && shapes.coverage?.shaped === runtimePendingCount,
    "ABI-shape census is stale against the classifier source rows");
  assert(projection.coverage?.classifiedDeclarations === runtimePendingCount &&
    projection.coverage?.projectedDeclarations === runtimePendingCount &&
    projection.coverage?.mechanicallyProjected === runtimePendingCount &&
    projection.coverage?.unprojectedDeclarations === 0 &&
    projection.coverage?.projectionGaps === 0 &&
    projection.coverage?.silentUnknowns === 0,
  "dmSDK projection census is stale against the classifier source rows");
  assert(universal.coverage?.declarations === runtimePendingCount &&
    universal.coverage?.recipes === runtimePendingCount &&
    universal.coverage?.cAbiDispatchable === runtimePendingCount &&
    universal.coverage?.dynamicHermesMetadata === runtimePendingCount &&
    universal.coverage?.staticHermesDeclarations === runtimePendingCount &&
    universal.coverage?.browserDirectMemoryMetadata === runtimePendingCount &&
    universal.coverage?.typescriptStableIds === runtimePendingCount &&
    universal.coverage?.silentlyOmitted === 0,
  "universal dmSDK coverage is stale against the classifier source rows");
  equalCensus(shapeIds, patternIds, "ABI-shape declaration IDs");
  equalCensus(projectionIds, patternIds, "projection declaration IDs");
  equalCensus(universalIds, patternIds, "universal declaration IDs");
  return runtimePendingCount;
}

async function validateReports(root) {
  const load = async (relative) => JSON.parse(await readFile(path.join(root, relative), "utf8"));
  const [patterns, scalar, shapes, enumValue, namedScalar, fixedDigest, base64Span, astcProbe, xteaSpan, hashSpan, hashState, arenaSpan, projection, borrowedHandle, scratchScalarOut, cstringValue, universal, readyExact, generatedExact] = await Promise.all([
    load("packages/bindings/generated/defold-dmsdk-binding-patterns.json"),
    load("packages/bindings/generated/defold-dmsdk-scalar-thunks.json"),
    load("packages/bindings/generated/defold-dmsdk-abi-shapes.json"),
    load("packages/bindings/generated/defold-dmsdk-enum-value-bindings.json"),
    load("packages/bindings/generated/defold-dmsdk-named-scalar-bindings.json"),
    load("packages/bindings/generated/defold-dmsdk-fixed-digest-bindings.json"),
    load("packages/bindings/generated/defold-dmsdk-base64-span-bindings.json"),
    load("packages/bindings/generated/defold-dmsdk-astc-probe-bindings.json"),
    load("packages/bindings/generated/defold-dmsdk-xtea-span-bindings.json"),
    load("packages/bindings/generated/defold-dmsdk-hash-span-bindings.json"),
    load("packages/bindings/generated/defold-dmsdk-hash-state-bindings.json"),
    load("packages/bindings/generated/defold-dmsdk-arena-span-blockers.json"),
    load("packages/bindings/generated/defold-dmsdk-projection-ir.json"),
    load("packages/bindings/generated/defold-dmsdk-borrowed-handle-bindings.json"),
    load("packages/bindings/generated/defold-dmsdk-scratch-scalar-out-bindings.json"),
    load("packages/bindings/generated/defold-dmsdk-cstring-value-bindings.json"),
    load("packages/bindings/generated/defold-dmsdk-universal-bindings.json"),
    load("packages/bindings/generated/defold-dmsdk-universal-ready-exact-plan.json"),
    load("packages/bindings/generated/defold-dmsdk-generated-adapter-exact-plan.json")
  ]);
  const runtimePendingCount = assertDmSdkSourceCensus({ patterns, shapes, projection, universal });
  assert(projection.coverage?.generatedAdapters === 45 &&
    projection.coverage?.policyBlocked === 69 &&
    projection.coverage?.projectionGaps === 0 &&
      projection.coverage?.loweringPending === 1247,
  "dmSDK projection IR does not retain its fail-closed policy partition");
  assert(scalar.coverage.reviewed === 31 && scalar.coverage.generated === 26 && scalar.coverage.blocked === 5,
    "scalar report does not have the pinned 26/31 disposition");
  // The exact SDK support headers preserve nested enums and platform-native
  // handle aliases that a missing-include Clang recovery had collapsed to int.
  // See
  // `.agents/docs/decisions/target-directed-dmsdk-parse.md`.
  assert(shapes.coverage.uniqueShapes === new Set(shapes.rows.map(({ shape }) => shape)).size &&
    shapes.coverage.tranches === new Set(shapes.rows.map(({ tranche }) => tranche)).size,
  "ABI-shape report does not retain source-derived shape and tranche counts");
  assert(enumValue.coverage.baselineRuntimePending === runtimePendingCount &&
    enumValue.coverage.previouslyEmittedScalar === scalar.coverage.generated &&
    enumValue.coverage.discovered === 10 && enumValue.coverage.emitted === 7 &&
    enumValue.coverage.blocked === enumValue.coverage.discovered - enumValue.coverage.emitted &&
    enumValue.coverage.remainingWithoutGeneratedAdapters === runtimePendingCount - scalar.coverage.generated - enumValue.coverage.emitted,
  "enum-value report does not have the pinned 7/10 disposition or 1,328 remainder");
  assert(namedScalar.coverage.reviewed === 21 && namedScalar.coverage.generated === 20 &&
    namedScalar.coverage.policyBlocked === 1 && namedScalar.coverage.exactCallCovered === 20,
  "named-scalar report does not have the pinned 20 generated / 1 symbol-blocked disposition");
  assert(fixedDigest.coverage.baselineRuntimePending === runtimePendingCount &&
    fixedDigest.coverage.discovered === 4 && fixedDigest.coverage.emitted === 4 &&
    fixedDigest.coverage.policyBlocked === fixedDigest.coverage.discovered - fixedDigest.coverage.emitted &&
    fixedDigest.coverage.remainingWithoutGeneratedAdapters === runtimePendingCount - scalar.coverage.generated - enumValue.coverage.emitted - fixedDigest.coverage.emitted,
  "fixed-digest report does not have the pinned 4/4 disposition or 1,324 remainder");
  assert(base64Span.coverage.baselineRuntimePending === runtimePendingCount &&
    base64Span.coverage.discovered === 2 && base64Span.coverage.emitted === 2 &&
    base64Span.coverage.policyBlocked === base64Span.coverage.discovered - base64Span.coverage.emitted &&
    base64Span.coverage.remainingWithoutGeneratedAdapters === fixedDigest.coverage.remainingWithoutGeneratedAdapters - base64Span.coverage.emitted,
  "base64-span report does not have the pinned 2/2 disposition or 1,322 remainder");
  assert(astcProbe.coverage.baselineRuntimePending === runtimePendingCount &&
    astcProbe.coverage.discovered === 2 && astcProbe.coverage.emitted === 2 &&
    astcProbe.coverage.policyBlocked === astcProbe.coverage.discovered - astcProbe.coverage.emitted &&
    astcProbe.coverage.remainingWithoutGeneratedAdapters === base64Span.coverage.remainingWithoutGeneratedAdapters - astcProbe.coverage.emitted,
  "ASTC-probe report does not have the pinned 2/2 disposition or 1,320 remainder");
  assert(xteaSpan.coverage.baselineRuntimePending === runtimePendingCount &&
    xteaSpan.coverage.discovered === 2 && xteaSpan.coverage.emitted === 2 &&
    xteaSpan.coverage.policyBlocked === xteaSpan.coverage.discovered - xteaSpan.coverage.emitted &&
    xteaSpan.coverage.remainingWithoutGeneratedAdapters === astcProbe.coverage.remainingWithoutGeneratedAdapters - xteaSpan.coverage.emitted,
  "XTEA-span report does not have the pinned 2/2 disposition or 1,318 remainder");
  assert(hashSpan.coverage.baselineRuntimePending === runtimePendingCount &&
    hashSpan.coverage.discovered === 2 && hashSpan.coverage.emitted === 2 &&
    hashSpan.coverage.policyBlocked === hashSpan.coverage.discovered - hashSpan.coverage.emitted &&
    hashSpan.coverage.remainingWithoutGeneratedAdapters === xteaSpan.coverage.remainingWithoutGeneratedAdapters - hashSpan.coverage.emitted,
  "hash-span report does not have the pinned 2/2 disposition or 1,316 remainder");
  assert(hashState.coverage.discovered === 10 && hashState.coverage.generated === 10 &&
    hashState.coverage.exactFixtureCount === 10,
  "hash-state report does not have the pinned 10/10 lifecycle disposition");
  assert(generatedExact.generatedAdapterCount === 74 &&
    generatedExact.specializationRequiredCount === runtimePendingCount - generatedExact.generatedAdapterCount - readyExact.universalReadyCount,
  "generated-adapter exact plan does not have the current 74/721 partition");
  assert(arenaSpan.coverage.arenaSpanCensus === 79 && arenaSpan.coverage.coveredByPriorWaves === 14 &&
    arenaSpan.coverage.generatedCStringArena === 5 && arenaSpan.coverage.blocked === 60 &&
    arenaSpan.coverage.executableAdaptersEmitted === 5 && arenaSpan.coverage.exactCallTwinsEmitted === 5 &&
    arenaSpan.coverage.overlap === 0 && arenaSpan.coverage.unaccounted === 0,
  "arena-span blocker report does not have the pinned complete 14 prior + 5 arena + 60 blocked partition");
  // Exact nested-enum support facts move GetConstantType and
  // GetMaterialVertexSpace into the enum family. No declaration disappeared;
  // the structural selector now correctly rejects those two as non-scalars.
  assert(borrowedHandle.coverage.candidates === 348 && borrowedHandle.coverage.generated === 158 &&
    borrowedHandle.coverage.blocked === 190 && borrowedHandle.coverage.cAbiGenerated === 158 &&
    borrowedHandle.coverage.dynamicHermesJsiGenerated === 158 &&
    borrowedHandle.coverage.staticHermesGenerated === 158 &&
    borrowedHandle.coverage.browserDirectMemoryGenerated === 158 &&
    borrowedHandle.coverage.typescriptGenerated === 158 &&
    borrowedHandle.coverage.pinnedHeaderSignatureCompiled === 158 &&
    borrowedHandle.coverage.exactCallTwinsGenerated === 158 &&
    borrowedHandle.coverage.fakeProviderHostRuntimeTested === 158 &&
    borrowedHandle.coverage.packagedEngineRuntimeVerified === 0 &&
    borrowedHandle.coverage.warmedDispatchObservedCppAllocations === 0,
  "borrowed-handle report does not preserve its pinned 158 generated + 190 blocked provider boundary");
  assert(scratchScalarOut.coverage.candidates === 79 && scratchScalarOut.coverage.generated === 7 &&
    scratchScalarOut.coverage.blocked === 72 && scratchScalarOut.coverage.cAbiGenerated === 7 &&
    scratchScalarOut.coverage.dynamicHermesJsiGenerated === 7 &&
    scratchScalarOut.coverage.staticHermesGenerated === 7 &&
    scratchScalarOut.coverage.browserDirectMemoryGenerated === 7 &&
    scratchScalarOut.coverage.typescriptGenerated === 7 &&
    scratchScalarOut.coverage.pinnedHeaderSignatureCompiled === 7 &&
    scratchScalarOut.coverage.fakeProviderHostRuntimeTested === 7 &&
    scratchScalarOut.coverage.packagedEngineRuntimeVerified === 0 &&
    scratchScalarOut.coverage.warmedDispatchObservedCppAllocations === 0,
  "scratch scalar-out report does not preserve its pinned 7 generated + 72 blocked provider boundary");
  assert(cstringValue.coverage.candidates === 20 && cstringValue.coverage.generated === 14 &&
    cstringValue.coverage.blocked === 6 && cstringValue.coverage.headerObjectCompiled === 0 &&
    cstringValue.coverage.stubAbiLinkedAndRuntimeTested === 0 &&
    cstringValue.coverage.pinnedEngineLinked === 0 && cstringValue.coverage.allTargetConformant === 0,
  "C-string/value report does not preserve its pinned 14 generated + 6 blocked truth boundary");
  assert(universal.coverage.universalReadyExactVectors === readyExact.universalReadyCount &&
    universal.coverage.universalReadyExactVectors === readyExact.verification.vectorCount &&
    universal.coverage.universalReadyExactVectors === readyExact.production.manifest.length &&
    readyExact.catalogSha256 === universal.sourceHashes.catalog &&
    readyExact.verification.catalogSha256 === universal.sourceHashes.catalog &&
    /^[0-9a-f]{64}$/.test(readyExact.symbolIndexSha256) &&
    /^[0-9a-f]{64}$/.test(readyExact.corpusSha256),
  "universal-ready exact corpus does not preserve its authenticated source-derived plan");
  const scalarIds = new Set(scalar.declarations.filter(({ emitted }) => emitted).map(({ id }) => id));
  const enumIds = new Set(enumValue.declarations.filter(({ emitted }) => emitted).map(({ id }) => id));
  const fixedDigestIds = new Set(fixedDigest.declarations.map(({ id }) => id));
  const base64SpanIds = new Set(base64Span.declarations.map(({ id }) => id));
  const astcProbeIds = new Set(astcProbe.declarations.map(({ id }) => id));
  const xteaSpanIds = new Set(xteaSpan.declarations.map(({ id }) => id));
  const hashSpanIds = new Set(hashSpan.declarations.map(({ id }) => id));
  const hashStateIds = new Set(hashState.declarations.map(({ id }) => id));
  const borrowedHandleIds = new Set(borrowedHandle.declarations
    .filter(({ disposition }) => disposition === "generated-provider-boundary")
    .map(({ id }) => id));
  const scratchScalarOutIds = new Set(scratchScalarOut.declarations
    .filter(({ disposition }) => disposition === "generated-provider-boundary")
    .map(({ id }) => id));
  assert(scalarIds.size === 26 && enumIds.size === 7 && fixedDigestIds.size === 4 && base64SpanIds.size === 2 && astcProbeIds.size === 2 && xteaSpanIds.size === 2 && hashSpanIds.size === 2,
    "generated dmSDK IDs are not unique within a family");
  assert(hashStateIds.size === 10, "hash-state family contains duplicate generated IDs");
  assert(borrowedHandleIds.size === 158, "borrowed-handle family contains duplicate generated IDs");
  assert(scratchScalarOutIds.size === 7, "scratch scalar-out family contains duplicate generated IDs");
  const priorGeneratedIds = new Set([
    ...scalarIds,
    ...enumIds,
    ...fixedDigestIds,
    ...base64SpanIds,
    ...astcProbeIds,
    ...xteaSpanIds,
    ...hashSpanIds,
    ...hashStateIds,
    ...borrowedHandleIds
  ]);
  for (const id of scratchScalarOutIds) {
    assert(!priorGeneratedIds.has(id), `scratch scalar-out family overlaps a prior generated family at ${id}`);
  }
  for (const id of enumIds) assert(!scalarIds.has(id), `dmSDK generator families overlap at ${id}`);
  for (const id of fixedDigestIds) {
    assert(!scalarIds.has(id), `dmSDK generator families overlap at ${id}`);
    assert(!enumIds.has(id), `dmSDK generator families overlap at ${id}`);
  }
  for (const id of base64SpanIds) {
    assert(!scalarIds.has(id), `dmSDK generator families overlap at ${id}`);
    assert(!enumIds.has(id), `dmSDK generator families overlap at ${id}`);
    assert(!fixedDigestIds.has(id), `dmSDK generator families overlap at ${id}`);
  }
  for (const id of astcProbeIds) {
    assert(!scalarIds.has(id), `dmSDK generator families overlap at ${id}`);
    assert(!enumIds.has(id), `dmSDK generator families overlap at ${id}`);
    assert(!fixedDigestIds.has(id), `dmSDK generator families overlap at ${id}`);
    assert(!base64SpanIds.has(id), `dmSDK generator families overlap at ${id}`);
  }
  for (const id of xteaSpanIds) {
    assert(!scalarIds.has(id), `dmSDK generator families overlap at ${id}`);
    assert(!enumIds.has(id), `dmSDK generator families overlap at ${id}`);
    assert(!fixedDigestIds.has(id), `dmSDK generator families overlap at ${id}`);
    assert(!base64SpanIds.has(id), `dmSDK generator families overlap at ${id}`);
    assert(!astcProbeIds.has(id), `dmSDK generator families overlap at ${id}`);
  }
  for (const id of hashSpanIds) {
    assert(!scalarIds.has(id), `dmSDK generator families overlap at ${id}`);
    assert(!enumIds.has(id), `dmSDK generator families overlap at ${id}`);
    assert(!fixedDigestIds.has(id), `dmSDK generator families overlap at ${id}`);
    assert(!base64SpanIds.has(id), `dmSDK generator families overlap at ${id}`);
    assert(!astcProbeIds.has(id), `dmSDK generator families overlap at ${id}`);
    assert(!xteaSpanIds.has(id), `dmSDK generator families overlap at ${id}`);
  }
  const arenaHashStateIds = new Set(hashState.declarations.filter(({ tranche }) => tranche === "arena-backed-spans").map(({ id }) => id));
  const priorArenaIds = new Set([...fixedDigestIds, ...base64SpanIds, ...astcProbeIds, ...xteaSpanIds, ...hashSpanIds, ...arenaHashStateIds]);
  const reportedPriorArenaIds = new Set(arenaSpan.coveredByPriorWaves.map(({ id }) => id));
  const generatedArenaIds = new Set(arenaSpan.generatedDeclarations.map(({ id }) => id));
  const blockedArenaIds = new Set(arenaSpan.declarations.map(({ id }) => id));
  const censusArenaIds = new Set(shapes.rows.filter(({ tranche }) => tranche === "arena-backed-spans").map(({ id }) => id));
  assert(priorArenaIds.size === 14 && reportedPriorArenaIds.size === 14 && generatedArenaIds.size === 5 && blockedArenaIds.size === 60,
    "arena-span partition contains duplicate IDs");
  assert([...priorArenaIds].every((id) => reportedPriorArenaIds.has(id)),
    "arena-span prior-wave ledger does not exactly match generated families");
  assert([...priorArenaIds].every((id) => !blockedArenaIds.has(id)),
    "arena-span prior-wave and blocker ledgers overlap");
  assert([...generatedArenaIds].every((id) => !priorArenaIds.has(id) && !blockedArenaIds.has(id)),
    "arena-span generated, prior-wave, and blocker ledgers overlap");
  assert([...censusArenaIds].every((id) => priorArenaIds.has(id) || generatedArenaIds.has(id) || blockedArenaIds.has(id)) &&
    priorArenaIds.size + generatedArenaIds.size + blockedArenaIds.size === censusArenaIds.size,
  "arena-span ledger does not completely partition the ABI-shape census");
  const scalarOwned = generatedDmSdkArtifacts.filter((entry) => scalar.artifacts.includes(entry));
  const enumOwned = generatedDmSdkArtifacts.filter((entry) => enumValue.artifacts.includes(entry));
  const fixedDigestOwned = generatedDmSdkArtifacts.filter((entry) => fixedDigest.artifacts.includes(entry));
  const base64SpanOwned = generatedDmSdkArtifacts.filter((entry) => base64Span.artifacts.includes(entry));
  const astcProbeOwned = generatedDmSdkArtifacts.filter((entry) => astcProbe.artifacts.includes(entry));
  const xteaSpanOwned = generatedDmSdkArtifacts.filter((entry) => xteaSpan.artifacts.includes(entry));
  const hashSpanOwned = generatedDmSdkArtifacts.filter((entry) => hashSpan.artifacts.includes(entry));
  const hashStateOwned = generatedDmSdkArtifacts.filter((entry) => hashState.artifacts.includes(entry));
  const arenaSpanOwned = generatedDmSdkArtifacts.filter((entry) => arenaSpan.artifacts.includes(entry));
  const borrowedHandleOwned = generatedDmSdkArtifacts.filter((entry) => borrowedHandle.artifacts.includes(entry));
  const scratchScalarOutOwned = generatedDmSdkArtifacts.filter((entry) => scratchScalarOut.artifacts.includes(entry));
  const cstringValueOwned = generatedDmSdkArtifacts.filter((entry) => cstringValue.artifacts.includes(entry));
  const universalOwned = generatedDmSdkArtifacts.filter((entry) => universal.artifacts.includes(entry));
  assert(scalarOwned.length === scalar.artifacts.length, "scalar report names an artifact absent from registry ownership");
  assert(enumOwned.length === enumValue.artifacts.length, "enum report names an artifact absent from registry ownership");
  assert(fixedDigestOwned.length === fixedDigest.artifacts.length,
    "fixed-digest report names an artifact absent from registry ownership");
  assert(base64SpanOwned.length === base64Span.artifacts.length,
    "base64-span report names an artifact absent from registry ownership");
  assert(astcProbeOwned.length === astcProbe.artifacts.length,
    "ASTC-probe report names an artifact absent from registry ownership");
  assert(xteaSpanOwned.length === xteaSpan.artifacts.length,
    "XTEA-span report names an artifact absent from registry ownership");
  assert(hashSpanOwned.length === hashSpan.artifacts.length,
    "hash-span report names an artifact absent from registry ownership");
  assert(hashStateOwned.length === hashState.artifacts.length,
    "hash-state report names an artifact absent from registry ownership");
  assert(arenaSpanOwned.length === arenaSpan.artifacts.length,
    "arena-span report names an artifact absent from registry ownership");
  assert(borrowedHandleOwned.length === borrowedHandle.artifacts.length,
    "borrowed-handle report names an artifact absent from registry ownership");
  assert(scratchScalarOutOwned.length === scratchScalarOut.artifacts.length,
    "scratch scalar-out report names an artifact absent from registry ownership");
  assert(cstringValueOwned.length === cstringValue.artifacts.length,
    "C-string/value report names an artifact absent from registry ownership");
  assert(universalOwned.length === universal.artifacts.length,
    "universal report names an artifact absent from registry ownership");
  return {
    runtimePendingCount: patterns.coverage.runtimePendingCount,
    scalarGeneratedCount: scalar.coverage.generated,
    enumGeneratedCount: enumValue.coverage.emitted,
    fixedDigestGeneratedCount: fixedDigest.coverage.emitted,
    base64SpanGeneratedCount: base64Span.coverage.emitted,
    astcProbeGeneratedCount: astcProbe.coverage.emitted,
    xteaSpanGeneratedCount: xteaSpan.coverage.emitted,
    hashSpanGeneratedCount: hashSpan.coverage.emitted,
    hashStateGeneratedCount: hashState.coverage.generated,
    borrowedHandleGeneratedCount: borrowedHandle.coverage.generated,
    borrowedHandleBlockedCount: borrowedHandle.coverage.blocked,
    scratchScalarOutGeneratedCount: scratchScalarOut.coverage.generated,
    scratchScalarOutBlockedCount: scratchScalarOut.coverage.blocked,
    cstringValueGeneratedCount: cstringValue.coverage.generated,
    universalRecipeCount: universal.coverage.recipes,
    universalReadyExactVectorCount: readyExact.verification.vectorCount,
    arenaSpanCensusCount: arenaSpan.coverage.arenaSpanCensus,
    arenaSpanPriorWaveCount: arenaSpan.coverage.coveredByPriorWaves,
    arenaSpanBlockedCount: arenaSpan.coverage.blocked,
    arenaSpanExecutableCount: arenaSpan.coverage.executableAdaptersEmitted,
    namedScalarReviewedCount: namedScalar.coverage.reviewed,
    namedScalarGeneratedCount: namedScalar.coverage.generated,
    namedScalarBlockedCount: namedScalar.coverage.policyBlocked,
    remainingWithoutGeneratedAdapters: generatedExact.specializationRequiredCount,
    uniqueShapeCount: shapes.coverage.uniqueShapes,
    trancheCount: shapes.coverage.tranches,
    projectedDeclarationCount: projection.coverage.projectedDeclarations,
    defoldRevision: shapes.defoldRevision
  };
}

async function fingerprint(root, inputs) {
  const hash = createHash("sha256");
  for (const relative of [...inputs].sort()) {
    hash.update(relative).update("\0").update(await readFile(path.join(root, relative))).update("\0");
  }
  return hash.digest("hex");
}

export async function runDmSdkCleanRoomRegeneration(options = {}) {
  const repositoryRoot = path.resolve(options.repositoryRoot ?? repositoryRootDefault);
  const lock = parseLock(await readFile(path.join(repositoryRoot, "upstream.lock"), "utf8"));
  const sources = await evidencePaths(repositoryRoot, lock.DEFOLD_REV);
  const groundTruth = await validateGroundTruth(repositoryRoot, sources);
  const inputs = [...new Set([
    ...dmSdkGeneratorSources,
    ...dmSdkPinnedInputs,
    ...sources,
    "package.json",
    "pnpm-lock.yaml"
  ])];
  const cleanRoot = await mkdtemp(path.join(tmpdir(), "deherm-dmsdk-clean-room-"));
  const keep = options.keep ?? process.env.DEHERM_KEEP_CLEAN_ROOM === "1";
  try {
    for (const relative of inputs) await copyRelative(repositoryRoot, cleanRoot, relative);
    await copyDeclaredGeneratorDependencies(repositoryRoot, cleanRoot);
    for (const relative of generatedDmSdkArtifacts) await mkdir(path.dirname(path.join(cleanRoot, relative)), { recursive: true });
    for (const step of dmSdkGenerationSteps) {
      await execFileAsync(process.execPath, [step.script], { cwd: cleanRoot, maxBuffer: 16 * 1024 * 1024 });
    }
    assertGeneratedDmSdkArtifactInventory(await discoverGeneratedDmSdkArtifacts(cleanRoot));
    assertGeneratedDmSdkArtifactInventory(await discoverGeneratedDmSdkArtifacts(repositoryRoot));
    const report = await validateReports(cleanRoot);
    const artifactSha256 = await compareArtifacts(cleanRoot, repositoryRoot);
    return {
      ...report,
      groundTruth,
      artifactCount: generatedDmSdkArtifacts.length,
      inputCount: inputs.length,
      aggregateInputSha256: await fingerprint(cleanRoot, inputs),
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
  const report = await runDmSdkCleanRoomRegeneration({ keep: process.argv.includes("--keep") });
  console.log(`Clean-room regeneration verified ${report.runtimePendingCount} dmSDK declarations across ${report.artifactCount} byte-identical artifacts.`);
  console.log(`Generated specialized adapters: ${report.scalarGeneratedCount} scalar + ${report.enumGeneratedCount} enum-value + ${report.fixedDigestGeneratedCount} fixed-digest + ${report.base64SpanGeneratedCount} base64-span + ${report.astcProbeGeneratedCount} ASTC-probe + ${report.xteaSpanGeneratedCount} XTEA-span + ${report.hashSpanGeneratedCount} hash-span + ${report.hashStateGeneratedCount} hash-state + ${report.borrowedHandleGeneratedCount} borrowed-handle provider-boundary; all ${report.universalRecipeCount} declarations retain a universal recipe beneath specialized lanes.`);
  console.log(`Borrowed-handle structural partition: ${report.borrowedHandleGeneratedCount}/348 generated; ${report.borrowedHandleBlockedCount} blocked; packaged-engine provider remains unverified.`);
  console.log(`Scratch scalar-out structural partition: ${report.scratchScalarOutGeneratedCount}/79 generated; ${report.scratchScalarOutBlockedCount} blocked; packaged-engine provider remains unverified.`);
  console.log(`Named-scalar policy: ${report.namedScalarGeneratedCount}/${report.namedScalarReviewedCount} generated; ${report.namedScalarBlockedCount} blocked.`);
  console.log(`Arena-span ledger: ${report.arenaSpanPriorWaveCount}/${report.arenaSpanCensusCount} covered by prior waves; ${report.arenaSpanBlockedCount} blocked; ${report.arenaSpanExecutableCount} adapters emitted by the ledger.`);
  console.log(`ABI census: ${report.uniqueShapeCount} shapes across ${report.trancheCount} tranches.`);
  console.log(`Pinned input fingerprint: ${report.aggregateInputSha256}`);
  if (report.cleanRoot) console.log(`Clean room retained at ${report.cleanRoot}`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    console.error(error.stack ?? error.message);
    process.exitCode = 1;
  });
}
