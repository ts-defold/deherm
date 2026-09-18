#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const paths = Object.freeze({
  ir: "bindings/generated/defold-sdk-ir.json",
  shapes: "bindings/generated/defold-dmsdk-abi-shapes.json",
  policy: "bindings/overrides/dmsdk-arena-span-blockers.json",
  output: "bindings/generated/defold-dmsdk-arena-span-blockers.json"
});

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
const compare = (left, right) => left.localeCompare(right, "en");
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function assertExactKeys(value, expected, label) {
  assert(isObject(value), `${label} must be an object`);
  const actual = Object.keys(value).sort(compare);
  assert(JSON.stringify(actual) === JSON.stringify([...expected].sort(compare)),
    `${label} has unsupported schema keys: ${actual.join(", ")}`);
}

function uniqueBy(values, key, label) {
  const seen = new Set();
  for (const value of values) {
    const identity = key(value);
    assert(typeof identity === "string" && identity.length > 0, `${label} contains an invalid identity`);
    assert(!seen.has(identity), `${label} contains duplicate ${identity}`);
    seen.add(identity);
  }
  return seen;
}

function blockerFor(row) {
  const roles = [row.result, ...row.parameters].map(({ role }) => role);
  if (roles.some((role) => role.startsWith("handle:"))) return "handle-provenance-or-engine-context";
  if (roles.some((role) => role.includes("record:"))) return "record-layout-or-borrowed-record-lifetime";
  if (row.symbol.startsWith("dmHashBuffer")) return "hash-buffer-runtime-and-allocation-evidence";
  if (roles.some((role) => role.includes("opaque-pointer"))) return "opaque-byte-pointee-unit-or-lifetime";
  if (roles.some((role) => role.includes("cstring"))) return "cstring-termination-or-capacity-policy";
  if (roles.some((role) => role.includes("unknown:") || role.includes("template:"))) return "template-element-layout-or-specialization";
  throw new Error(`${row.id}: arena-span row has no reviewed blocker partition`);
}

function validatePolicy(policy) {
  assertExactKeys(policy, [
    "schemaVersion", "policyVersion", "defoldRevision", "tranche", "priorWaveReports",
    "coveredByPriorWaves", "expectedCoverage", "expectedPartitionSummary", "blockerDefinitions"
  ], "arena-span blocker policy");
  assert(policy.schemaVersion === 1, "arena-span blocker policy schemaVersion must be 1");
  assert(policy.policyVersion === "arena-span-blockers-v1", "arena-span blocker policyVersion is unsupported");
  assert(/^[0-9a-f]{40}$/.test(policy.defoldRevision), "arena-span blocker policy must pin a Defold revision");
  assert(policy.tranche === "arena-backed-spans", "arena-span blocker policy tranche is unsupported");
  assert(Array.isArray(policy.priorWaveReports) && policy.priorWaveReports.length === 4,
    "arena-span blocker policy must name exactly four prior-wave reports");
  assert(Array.isArray(policy.coveredByPriorWaves), "coveredByPriorWaves must be an array");
  uniqueBy(policy.priorWaveReports, ({ path }) => path, "priorWaveReports");
  uniqueBy(policy.coveredByPriorWaves.map((symbol) => ({ symbol })), ({ symbol }) => symbol,
    "coveredByPriorWaves");
  for (const entry of policy.priorWaveReports) {
    assertExactKeys(entry, ["path", "policyVersion"], "prior-wave report entry");
    assert(/^bindings\/generated\/defold-dmsdk-[a-z0-9-]+-bindings\.json$/.test(entry.path),
      `prior-wave report path is not confined: ${entry.path}`);
    assert(typeof entry.policyVersion === "string" && entry.policyVersion.length > 0,
      `${entry.path}: expected policyVersion is missing`);
  }
  for (const symbol of policy.coveredByPriorWaves) {
    assert(typeof symbol === "string" && symbol.length > 0, "coveredByPriorWaves contains an invalid symbol");
  }
  assertExactKeys(policy.expectedCoverage, ["arenaSpanCensus", "coveredByPriorWaves", "blocked"],
    "expectedCoverage");
  for (const [name, count] of Object.entries(policy.expectedCoverage)) {
    assert(Number.isSafeInteger(count) && count >= 0, `expectedCoverage.${name} must be a non-negative integer`);
  }
  assert(isObject(policy.expectedPartitionSummary), "expectedPartitionSummary must be an object");
  assert(isObject(policy.blockerDefinitions), "blockerDefinitions must be an object");
  const partitionKeys = Object.keys(policy.expectedPartitionSummary).sort(compare);
  const definitionKeys = Object.keys(policy.blockerDefinitions).sort(compare);
  assert(JSON.stringify(partitionKeys) === JSON.stringify(definitionKeys),
    "blocker definitions must exactly match the expected partition");
  for (const key of partitionKeys) {
    assert(Number.isSafeInteger(policy.expectedPartitionSummary[key]) && policy.expectedPartitionSummary[key] > 0,
      `expectedPartitionSummary.${key} must be a positive integer`);
    assert(typeof policy.blockerDefinitions[key] === "string" && policy.blockerDefinitions[key].length > 0,
      `blockerDefinitions.${key} must be non-empty`);
  }
}

export async function loadInputs(root = repositoryRoot) {
  const [irText, shapesText, policyText] = await Promise.all([
    readFile(resolve(root, paths.ir), "utf8"),
    readFile(resolve(root, paths.shapes), "utf8"),
    readFile(resolve(root, paths.policy), "utf8")
  ]);
  const policy = JSON.parse(policyText);
  validatePolicy(policy);
  const priorWaveTexts = new Map(await Promise.all(policy.priorWaveReports.map(async ({ path }) => [
    path,
    await readFile(resolve(root, path), "utf8")
  ])));
  return { irText, shapesText, policyText, priorWaveTexts };
}

export function generate(inputs) {
  const ir = JSON.parse(inputs.irText);
  const shapes = JSON.parse(inputs.shapesText);
  const policy = JSON.parse(inputs.policyText);
  validatePolicy(policy);
  assert(ir.schemaVersion === 1, "dmSDK IR schemaVersion must be 1");
  assert(shapes.schemaVersion === 1, "dmSDK ABI-shape schemaVersion must be 1");
  assert(Array.isArray(ir.declarations), "dmSDK IR declarations must be an array");
  assert(Array.isArray(shapes.rows), "dmSDK ABI-shape rows must be an array");
  assert(ir.defoldRevision === policy.defoldRevision && shapes.defoldRevision === policy.defoldRevision,
    "arena-span blocker inputs use different Defold revisions");
  assert(shapes.sourceIr === paths.ir, "ABI-shape census names an unexpected source IR");
  assert(shapes.sourceHashes?.ir === sha256(inputs.irText),
    "IR hash does not match ABI-shape census provenance");
  uniqueBy(ir.declarations, ({ id }) => id, "dmSDK IR declarations");
  uniqueBy(shapes.rows, ({ id }) => id, "dmSDK ABI-shape rows");

  const priorWaves = [];
  const priorDeclarations = [];
  for (const expected of policy.priorWaveReports) {
    const text = inputs.priorWaveTexts.get(expected.path);
    assert(typeof text === "string", `${expected.path}: prior-wave report text is missing`);
    const report = JSON.parse(text);
    assert(report.schemaVersion === 1, `${expected.path}: unsupported schemaVersion`);
    assert(report.policyVersion === expected.policyVersion, `${expected.path}: unexpected policyVersion`);
    assert(report.defoldRevision === policy.defoldRevision, `${expected.path}: Defold revision drifted`);
    assert(report.sourceHashes?.ir === sha256(inputs.irText), `${expected.path}: IR provenance drifted`);
    assert(report.sourceHashes?.shapes === sha256(inputs.shapesText), `${expected.path}: ABI-shape provenance drifted`);
    assert(Array.isArray(report.declarations) && report.declarations.length > 0,
      `${expected.path}: declarations must be a non-empty array`);
    uniqueBy(report.declarations, ({ id }) => id, `${expected.path} declarations`);
    for (const declaration of report.declarations) {
      assert(declaration.tranche === policy.tranche, `${declaration.id}: prior wave left the arena-span tranche`);
      assert(declaration.stages?.generated === "complete", `${declaration.id}: prior wave is not generated`);
      priorDeclarations.push({ ...declaration, sourceReport: expected.path });
    }
    priorWaves.push({
      report: expected.path,
      policyVersion: report.policyVersion,
      sha256: sha256(text),
      declarationCount: report.declarations.length
    });
  }
  const priorIds = uniqueBy(priorDeclarations, ({ id }) => id, "combined prior-wave declarations");
  const priorSymbols = [...new Set(priorDeclarations.map(({ symbol }) => symbol))].sort(compare);
  assert(priorSymbols.length === priorDeclarations.length,
    "combined prior-wave declarations contain duplicate symbols");
  assert(JSON.stringify(priorSymbols) === JSON.stringify([...policy.coveredByPriorWaves].sort(compare)),
    "coveredByPriorWaves does not exactly match generated prior-wave symbols");

  const census = shapes.rows.filter(({ tranche }) => tranche === policy.tranche).sort((a, b) => compare(a.id, b.id));
  const censusIds = new Set(census.map(({ id }) => id));
  for (const declaration of priorDeclarations) {
    assert(censusIds.has(declaration.id), `${declaration.id}: prior-wave declaration is absent from arena-span census`);
    const row = census.find(({ id }) => id === declaration.id);
    assert(row.symbol === declaration.symbol, `${declaration.id}: prior-wave symbol drifted from census`);
  }
  const blockedRows = census.filter(({ id }) => !priorIds.has(id));
  const blockedIds = new Set(blockedRows.map(({ id }) => id));
  const overlap = [...priorIds].filter((id) => blockedIds.has(id));
  const partitioned = new Set([...priorIds, ...blockedIds]);
  const unaccounted = [...censusIds].filter((id) => !partitioned.has(id));
  assert(overlap.length === 0, `arena-span partition overlaps at ${overlap.join(", ")}`);
  assert(unaccounted.length === 0 && partitioned.size === censusIds.size,
    `arena-span partition is incomplete: ${unaccounted.join(", ")}`);

  const declarations = blockedRows.map((row) => {
    const blocker = blockerFor(row);
    return {
      ...row,
      disposition: "blocked",
      blocker,
      blockerReason: policy.blockerDefinitions[blocker],
      stages: {
        generated: "not-applicable",
        compiled: "not-claimed",
        linked: "not-claimed",
        runtime: "not-claimed",
        allocation: "not-claimed"
      }
    };
  });
  const partitionSummary = Object.fromEntries([...new Set(declarations.map(({ blocker }) => blocker))]
    .sort(compare)
    .map((blocker) => [blocker, declarations.filter((row) => row.blocker === blocker).length]));
  assert(JSON.stringify(partitionSummary) === JSON.stringify(policy.expectedPartitionSummary),
    `arena-span blocker partition drifted: ${JSON.stringify(partitionSummary)}`);
  const coverage = {
    arenaSpanCensus: census.length,
    coveredByPriorWaves: priorDeclarations.length,
    blocked: declarations.length,
    executableAdaptersEmitted: 0,
    overlap: overlap.length,
    unaccounted: unaccounted.length
  };
  assert(coverage.arenaSpanCensus === policy.expectedCoverage.arenaSpanCensus &&
    coverage.coveredByPriorWaves === policy.expectedCoverage.coveredByPriorWaves &&
    coverage.blocked === policy.expectedCoverage.blocked,
  `arena-span coverage drifted: ${JSON.stringify(coverage)}`);
  assert(coverage.coveredByPriorWaves + coverage.blocked === coverage.arenaSpanCensus,
    "arena-span census is not a complete prior-wave/blocked partition");

  return {
    schemaVersion: 1,
    policyVersion: policy.policyVersion,
    defoldRevision: policy.defoldRevision,
    sources: {
      ir: paths.ir,
      shapes: paths.shapes,
      policy: paths.policy,
      priorWaveReports: policy.priorWaveReports.map(({ path }) => path)
    },
    sourceHashes: {
      ir: sha256(inputs.irText),
      shapes: sha256(inputs.shapesText),
      policy: sha256(inputs.policyText),
      priorWaveReports: Object.fromEntries(priorWaves.map(({ report, sha256: hash }) => [report, hash]))
    },
    scope: "Complete arena-backed-spans census after the four generated prior waves",
    policy: {
      disposition: "blocked-metadata-only",
      reason: "No executable adapter is emitted by this ledger. Every remaining row lacks at least one reviewed ABI, ownership, runtime-behavior, or allocation-safety contract required for promotion."
    },
    coverage,
    priorWaves,
    coveredByPriorWaves: priorDeclarations
      .map(({ id, symbol, sourceReport }) => ({ id, symbol, sourceReport }))
      .sort((a, b) => compare(a.id, b.id)),
    partitionSummary,
    declarations
  };
}

export async function run(argv = process.argv.slice(2), root = repositoryRoot) {
  const unknown = argv.filter((argument) => argument !== "--check");
  assert(unknown.length === 0, `Unknown argument: ${unknown[0]}`);
  const check = argv.includes("--check");
  const report = generate(await loadInputs(root));
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  const output = resolve(root, paths.output);
  if (check) {
    assert(await readFile(output, "utf8") === serialized, `${paths.output} is stale`);
  } else {
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, serialized);
  }
  console.log(`${check ? "Verified" : "Generated"} ${report.coverage.blocked} deterministic arena-span blockers; ${report.coverage.coveredByPriorWaves}/${report.coverage.arenaSpanCensus} covered by prior waves.`);
  return report;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  run().catch((error) => {
    console.error(error.stack ?? error.message);
    process.exitCode = 1;
  });
}
