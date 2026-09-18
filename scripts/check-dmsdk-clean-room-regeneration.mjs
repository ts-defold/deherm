#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
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

async function evidencePaths(repositoryRoot, defoldRevision) {
  const ir = JSON.parse(await readFile(path.join(repositoryRoot, "bindings/generated/defold-sdk-ir.json"), "utf8"));
  assert(ir.defoldRevision === defoldRevision,
    `dmSDK IR revision ${ir.defoldRevision} does not match upstream.lock ${defoldRevision}`);
  const result = new Set(scalarImplementationEvidence);
  for (const declaration of ir.declarations) {
    if (declaration.disposition === "generated-raw-call") result.add(confined(declaration.header, `${declaration.id}.header`));
  }
  const sdkRoot = `upstream/extender/server/app/sdk/${defoldRevision}/defoldsdk`;
  result.add(`${sdkRoot}/sdk/include/dmsdk/graphics/graphics.h`);
  result.add(`${sdkRoot}/include/graphics/graphics_ddf.h`);
  const namedScalarPolicy = JSON.parse(await readFile(
    path.join(repositoryRoot, "bindings/overrides/dmsdk-named-scalar-policies.json"),
    "utf8"
  ));
  for (const rule of namedScalarPolicy.rules ?? []) {
    for (const [evidencePath] of rule.evidence ?? []) {
      result.add(confined(evidencePath, `${rule.id}.evidence.path`));
    }
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
  for (const file of await walk(path.join(repositoryRoot, "bindings/generated"))) {
    if (/^defold-dmsdk-(?:binding-patterns|scalar-thunks|abi-shapes|enum-value-bindings|named-scalar-bindings|fixed-digest-bindings|base64-span-bindings|astc-probe-bindings|xtea-span-bindings|arena-span-blockers)\.json$/.test(file)) {
      result.add(`bindings/generated/${file}`);
    }
  }
  for (const file of await walk(path.join(repositoryRoot, "defold/defold_hermes/include/defold_hermes"))) {
    if (/^generated_dmsdk_(?:scalar|enum_value|named_scalar|fixed_digest|base64_span|astc_probe|xtea_span)/.test(file)) {
      result.add(`defold/defold_hermes/include/defold_hermes/${file}`);
    }
  }
  for (const file of await walk(path.join(repositoryRoot, "defold/defold_hermes/src"))) {
    if (/^generated_dmsdk_(?:scalar|enum_value|named_scalar|fixed_digest|base64_span|astc_probe|xtea_span)/.test(file)) {
      result.add(`defold/defold_hermes/src/${file}`);
    }
  }
  const browser = "defold/defold_hermes/lib/web/generated_dmsdk_scalar.js";
  try {
    if ((await lstat(path.join(repositoryRoot, browser))).isFile()) result.add(browser);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  for (const file of ["scalar.ts", "enum-value.ts", "named-scalar.ts"]) {
    const relative = `packages/sdk/src/generated/dmsdk/${file}`;
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

async function validateReports(root) {
  const load = async (relative) => JSON.parse(await readFile(path.join(root, relative), "utf8"));
  const [patterns, scalar, shapes, enumValue, namedScalar, fixedDigest, base64Span, astcProbe, xteaSpan, arenaSpan] = await Promise.all([
    load("bindings/generated/defold-dmsdk-binding-patterns.json"),
    load("bindings/generated/defold-dmsdk-scalar-thunks.json"),
    load("bindings/generated/defold-dmsdk-abi-shapes.json"),
    load("bindings/generated/defold-dmsdk-enum-value-bindings.json"),
    load("bindings/generated/defold-dmsdk-named-scalar-bindings.json"),
    load("bindings/generated/defold-dmsdk-fixed-digest-bindings.json"),
    load("bindings/generated/defold-dmsdk-base64-span-bindings.json"),
    load("bindings/generated/defold-dmsdk-astc-probe-bindings.json"),
    load("bindings/generated/defold-dmsdk-xtea-span-bindings.json"),
    load("bindings/generated/defold-dmsdk-arena-span-blockers.json")
  ]);
  assert(patterns.coverage.runtimePendingCount === 1361 && patterns.coverage.classifiedCount === 1361,
    "dmSDK classifier did not account for all 1,361 runtime-pending declarations");
  assert(scalar.coverage.reviewed === 31 && scalar.coverage.generated === 26 && scalar.coverage.blocked === 5,
    "scalar report does not have the pinned 26/31 disposition");
  assert(shapes.coverage.runtimePending === 1361 && shapes.coverage.shaped === 1361 &&
    shapes.coverage.uniqueShapes === 881 && shapes.coverage.tranches === 15,
  "ABI-shape report does not have the pinned 1,361/881/15 census");
  assert(enumValue.coverage.discovered === 10 && enumValue.coverage.emitted === 7 &&
    enumValue.coverage.blocked === 3 && enumValue.coverage.remainingWithoutGeneratedAdapters === 1328,
  "enum-value report does not have the pinned 7/10 disposition or 1,328 remainder");
  assert(namedScalar.coverage.reviewed === 21 && namedScalar.coverage.generated === 0 &&
    namedScalar.coverage.policyBlocked === 21,
  "named-scalar report does not have the pinned 0/21 policy disposition");
  assert(fixedDigest.coverage.discovered === 4 && fixedDigest.coverage.emitted === 4 &&
    fixedDigest.coverage.policyBlocked === 0 && fixedDigest.coverage.remainingWithoutGeneratedAdapters === 1324,
  "fixed-digest report does not have the pinned 4/4 disposition or 1,324 remainder");
  assert(base64Span.coverage.discovered === 2 && base64Span.coverage.emitted === 2 &&
    base64Span.coverage.policyBlocked === 0 && base64Span.coverage.remainingWithoutGeneratedAdapters === 1322,
  "base64-span report does not have the pinned 2/2 disposition or 1,322 remainder");
  assert(astcProbe.coverage.discovered === 2 && astcProbe.coverage.emitted === 2 &&
    astcProbe.coverage.policyBlocked === 0 && astcProbe.coverage.remainingWithoutGeneratedAdapters === 1320,
  "ASTC-probe report does not have the pinned 2/2 disposition or 1,320 remainder");
  assert(xteaSpan.coverage.discovered === 2 && xteaSpan.coverage.emitted === 2 &&
    xteaSpan.coverage.policyBlocked === 0 && xteaSpan.coverage.remainingWithoutGeneratedAdapters === 1318,
  "XTEA-span report does not have the pinned 2/2 disposition or 1,318 remainder");
  assert(arenaSpan.coverage.arenaSpanCensus === 79 && arenaSpan.coverage.coveredByPriorWaves === 10 &&
    arenaSpan.coverage.blocked === 69 && arenaSpan.coverage.executableAdaptersEmitted === 0 &&
    arenaSpan.coverage.overlap === 0 && arenaSpan.coverage.unaccounted === 0,
  "arena-span blocker report does not have the pinned complete 10 generated + 69 blocked partition");
  const scalarIds = new Set(scalar.declarations.filter(({ emitted }) => emitted).map(({ id }) => id));
  const enumIds = new Set(enumValue.declarations.filter(({ emitted }) => emitted).map(({ id }) => id));
  const fixedDigestIds = new Set(fixedDigest.declarations.map(({ id }) => id));
  const base64SpanIds = new Set(base64Span.declarations.map(({ id }) => id));
  const astcProbeIds = new Set(astcProbe.declarations.map(({ id }) => id));
  const xteaSpanIds = new Set(xteaSpan.declarations.map(({ id }) => id));
  assert(scalarIds.size === 26 && enumIds.size === 7 && fixedDigestIds.size === 4 && base64SpanIds.size === 2 && astcProbeIds.size === 2 && xteaSpanIds.size === 2,
    "generated dmSDK IDs are not unique within a family");
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
  const priorArenaIds = new Set([...fixedDigestIds, ...base64SpanIds, ...astcProbeIds, ...xteaSpanIds]);
  const reportedPriorArenaIds = new Set(arenaSpan.coveredByPriorWaves.map(({ id }) => id));
  const blockedArenaIds = new Set(arenaSpan.declarations.map(({ id }) => id));
  const censusArenaIds = new Set(shapes.rows.filter(({ tranche }) => tranche === "arena-backed-spans").map(({ id }) => id));
  assert(priorArenaIds.size === 10 && reportedPriorArenaIds.size === 10 && blockedArenaIds.size === 69,
    "arena-span partition contains duplicate IDs");
  assert([...priorArenaIds].every((id) => reportedPriorArenaIds.has(id)),
    "arena-span prior-wave ledger does not exactly match generated families");
  assert([...priorArenaIds].every((id) => !blockedArenaIds.has(id)),
    "arena-span prior-wave and blocker ledgers overlap");
  assert([...censusArenaIds].every((id) => priorArenaIds.has(id) || blockedArenaIds.has(id)) &&
    priorArenaIds.size + blockedArenaIds.size === censusArenaIds.size,
  "arena-span ledger does not completely partition the ABI-shape census");
  const scalarOwned = generatedDmSdkArtifacts.filter((entry) => scalar.artifacts.includes(entry));
  const enumOwned = generatedDmSdkArtifacts.filter((entry) => enumValue.artifacts.includes(entry));
  const fixedDigestOwned = generatedDmSdkArtifacts.filter((entry) => fixedDigest.artifacts.includes(entry));
  const base64SpanOwned = generatedDmSdkArtifacts.filter((entry) => base64Span.artifacts.includes(entry));
  const astcProbeOwned = generatedDmSdkArtifacts.filter((entry) => astcProbe.artifacts.includes(entry));
  const xteaSpanOwned = generatedDmSdkArtifacts.filter((entry) => xteaSpan.artifacts.includes(entry));
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
  return {
    runtimePendingCount: patterns.coverage.runtimePendingCount,
    scalarGeneratedCount: scalar.coverage.generated,
    enumGeneratedCount: enumValue.coverage.emitted,
    fixedDigestGeneratedCount: fixedDigest.coverage.emitted,
    base64SpanGeneratedCount: base64Span.coverage.emitted,
    astcProbeGeneratedCount: astcProbe.coverage.emitted,
    xteaSpanGeneratedCount: xteaSpan.coverage.emitted,
    arenaSpanCensusCount: arenaSpan.coverage.arenaSpanCensus,
    arenaSpanPriorWaveCount: arenaSpan.coverage.coveredByPriorWaves,
    arenaSpanBlockedCount: arenaSpan.coverage.blocked,
    arenaSpanExecutableCount: arenaSpan.coverage.executableAdaptersEmitted,
    namedScalarReviewedCount: namedScalar.coverage.reviewed,
    namedScalarGeneratedCount: namedScalar.coverage.generated,
    namedScalarBlockedCount: namedScalar.coverage.policyBlocked,
    remainingWithoutGeneratedAdapters: xteaSpan.coverage.remainingWithoutGeneratedAdapters,
    uniqueShapeCount: shapes.coverage.uniqueShapes,
    trancheCount: shapes.coverage.tranches,
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
  const inputs = [...dmSdkGeneratorSources, ...dmSdkPinnedInputs, ...sources];
  const cleanRoot = await mkdtemp(path.join(tmpdir(), "deherm-dmsdk-clean-room-"));
  const keep = options.keep ?? process.env.DEHERM_KEEP_CLEAN_ROOM === "1";
  try {
    for (const relative of inputs) await copyRelative(repositoryRoot, cleanRoot, relative);
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
  console.log(`Generated adapters: ${report.scalarGeneratedCount} scalar + ${report.enumGeneratedCount} enum-value + ${report.fixedDigestGeneratedCount} fixed-digest + ${report.base64SpanGeneratedCount} base64-span + ${report.astcProbeGeneratedCount} ASTC-probe + ${report.xteaSpanGeneratedCount} XTEA-span; ${report.remainingWithoutGeneratedAdapters} remain.`);
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
