#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  DMSDK_UNIVERSAL_FALLBACK_PATTERN,
  compactDmSdkPatternDecision,
  selectDmSdkPattern,
} from "../packages/compiler/src/dmsdk-pattern-selector.mjs";
import { arenaCStringPatterns } from "../packages/compiler/src/dmsdk-pattern-catalog.mjs";
import {
  createDmSdkArenaCStringRecipeFacts,
  renderDmSdkArenaCStringOutputs,
} from "../packages/compiler/src/dmsdk-arena-cstring-output-emitter.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const paths = Object.freeze({
  ir: "packages/bindings/generated/defold-sdk-ir.json",
  shapes: "packages/bindings/generated/defold-dmsdk-abi-shapes.json",
  symbolEvidence: "packages/bindings/generated/defold-dmsdk-symbol-evidence.json",
  recipe: "packages/bindings/overrides/dmsdk-arena-span-blockers.json",
  output: "packages/bindings/generated/defold-dmsdk-arena-span-blockers.json",
});
const policyVersion = "arena-span-cstring-v3";
const arenaTranche = "arena-backed-spans";
const priorWaveReports = Object.freeze([
  { path: "packages/bindings/generated/defold-dmsdk-fixed-digest-bindings.json", policyVersion: "fixed-digest-v4" },
  { path: "packages/bindings/generated/defold-dmsdk-base64-span-bindings.json", policyVersion: "base64-span-v5" },
  { path: "packages/bindings/generated/defold-dmsdk-astc-probe-bindings.json", policyVersion: "astc-probe-v4" },
  { path: "packages/bindings/generated/defold-dmsdk-xtea-span-bindings.json", policyVersion: "xtea-span-v4" },
  { path: "packages/bindings/generated/defold-dmsdk-hash-span-bindings.json", policyVersion: "hash-span-v3" },
  { path: "packages/bindings/generated/defold-dmsdk-hash-state-bindings.json", policyVersion: "hash-state-v3" },
]);
const blockerDefinitions = Object.freeze({
  "handle-provenance-or-engine-context":
    "The ABI consumes or returns an engine handle whose provenance, context, ownership, nullability, or teardown contract is not encoded by the arena.",
  "opaque-byte-pointee-unit-or-lifetime":
    "The void pointer's pointee unit, mutability, returned lifetime, allocation source, or ownership is not fully represented by the mechanical span shape.",
  "record-layout-or-borrowed-record-lifetime":
    "The ABI crosses a record pointer whose exact layout, nested fields, borrowed lifetime, or engine-context relationship is not yet verified.",
  "template-element-layout-or-specialization":
    "The template element type or specialization is unresolved, so the arena cannot prove element size, alignment, copying, or native linkage.",
});
const arenaContract = Object.freeze({
  input:
    "The public bridge takes a counted byte span, rejects embedded NUL, copies at most maximumInputBytes into bounded thread-local scratch, and appends one terminator.",
  output:
    "The caller supplies non-null storage with capacity 1..maximumOutputBytes. Generated glue clears it before entry, requires an in-bounds terminator afterward, and clears it on transport or native failure.",
  reentrancy: "Same-thread nested dispatch is rejected before touching shared scratch.",
  ownership:
    "Input scratch and output storage are borrowed only for the synchronous native call; neither pointer may escape.",
  fallback:
    "Every declaration retains its universal usage-materialized recipe; the arena adapter is an additional preferred concrete path.",
});
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
const compare = (left, right) => left.localeCompare(right, "en");
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const exactCallee = (entry) => `deherm_dmsdk_arena_exact_callee_${entry.bindingId}`;

function exactKeys(value, expected, label) {
  assert(object(value), `${label} must be an object`);
  const actual = Object.keys(value).sort(compare);
  assert(
    JSON.stringify(actual) === JSON.stringify([...expected].sort(compare)),
    `${label} has unsupported schema keys: ${actual.join(", ")}`,
  );
}
function unique(values, key, label) {
  const seen = new Set();
  for (const value of values) {
    const identity = key(value);
    assert(typeof identity === "string" && identity.length, `${label} contains an invalid identity`);
    assert(!seen.has(identity), `${label} contains duplicate ${identity}`);
    seen.add(identity);
  }
  return seen;
}
function blockerFor(row) {
  const roles = [row.result, ...row.parameters].map(({ role }) => role);
  if (roles.some((role) => role.startsWith("handle:"))) return "handle-provenance-or-engine-context";
  if (roles.some((role) => role.includes("record:"))) return "record-layout-or-borrowed-record-lifetime";
  if (roles.some((role) => role.includes("opaque-pointer"))) return "opaque-byte-pointee-unit-or-lifetime";
  if (roles.some((role) => role.includes("cstring"))) return "cstring-termination-or-capacity-policy";
  if (roles.some((role) => role.includes("unknown:") || role.includes("template:")))
    return "template-element-layout-or-specialization";
  return "unclassified-arena-span-shape";
}
const specializationBlocker = "cstring-arena-specialization-unverified";
const specializationBlockerReason =
  "The declaration remains available through the universal dmSDK route, but this revision did not prove the bounded cstring-arena specialization recipe.";

function validateRecipe(value) {
  exactKeys(value, ["schemaVersion", "family", "recipe"], "arena-cstring recipe");
  assert(value.schemaVersion === 1, "arena-cstring recipe schemaVersion must be 1");
  assert(value.family === "arena-cstring", "arena-cstring recipe family is unsupported");
  exactKeys(
    value.recipe,
    [
      "transport",
      "maximumInputBytes",
      "maximumOutputBytes",
      "candidateSource",
      "semanticSource",
      "sourceGrouping",
      "fallback",
    ],
    "arena-cstring recipe.recipe",
  );
  assert(value.recipe.transport === "bounded-counted-input-caller-output", "arena-cstring transport is unsupported");
  assert(
    Number.isSafeInteger(value.recipe.maximumInputBytes) && value.recipe.maximumInputBytes > 0,
    "maximumInputBytes must be positive",
  );
  assert(
    Number.isSafeInteger(value.recipe.maximumOutputBytes) && value.recipe.maximumOutputBytes > 0,
    "maximumOutputBytes must be positive",
  );
  assert(
    value.recipe.candidateSource === "revision-ir-arena-backed-cstring-abi",
    "arena-cstring candidateSource is unsupported",
  );
  assert(
    value.recipe.semanticSource === "revision-ir-public-documentation",
    "arena-cstring semanticSource is unsupported",
  );
  assert(
    value.recipe.sourceGrouping === "single-revision-derived-translation-unit",
    "arena-cstring sourceGrouping is unsupported",
  );
  assert(value.recipe.fallback === "universal-recipe", "arena-cstring fallback is unsupported");
}

function patternFacts(row, semanticTokens = []) {
  return {
    id: row.id,
    kind: "function",
    result: row.result,
    parameters: row.parameters,
    families: [arenaTranche],
    semanticTokens,
  };
}

const normalizedText = (value) =>
  String(value ?? "")
    .replace(/<[^>]+>/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase();

export function inferArenaCStringSemantics(declaration, row) {
  if (!declaration || declaration.kind !== "function") return null;
  const description = normalizedText(declaration.description);
  const returnDescription = normalizedText(declaration.returnDescription);
  const parameters = declaration.parameters.map((parameter) => normalizedText(parameter.description));
  const evidence = {
    source: "revision-ir-public-documentation",
    description: declaration.description ?? null,
    returnDescription: declaration.returnDescription ?? null,
    parameters: declaration.parameters.map(({ name, description: detail }) => ({ name, description: detail ?? null })),
  };
  if (
    row.result.role === "scalar:void" &&
    description.includes("error code to string representation") &&
    description.includes("buffer") &&
    returnDescription.includes("null-terminated error message")
  ) {
    return {
      kind: "error-string",
      semanticTokens: ["bounded-cstring-output", "error-string", "null-terminated-output", "synchronous-noescape"],
      evidence,
    };
  }
  if (
    row.result.role === "scalar:usize" &&
    description.includes("removing leading and trailing whitespace") &&
    description.includes("null-terminated") &&
    returnDescription.includes("trimmed source string")
  ) {
    return {
      kind: "trimmed-string",
      semanticTokens: ["bounded-cstring-output", "counted-cstring-input", "null-terminated-output", "trimmed-string"],
      evidence,
    };
  }
  if (
    row.result.role === "scalar:u32" &&
    description.includes("normalized resource path") &&
    parameters.some((detail) => detail.includes("size of the output buffer")) &&
    returnDescription.includes("length of the output string")
  ) {
    return {
      kind: "canonical-path",
      semanticTokens: ["bounded-cstring-output", "canonical-path", "counted-cstring-input", "output-length-result"],
      evidence,
    };
  }
  if (
    row.result.role.startsWith("enum:") &&
    description.includes("url encoding") &&
    parameters.some((detail) => detail.includes("destination buffer"))
  ) {
    return {
      kind: "uri-encode",
      semanticTokens: ["bounded-cstring-output", "counted-cstring-input", "output-byte-count", "uri-encode"],
      evidence,
    };
  }
  return null;
}
export async function loadInputs(root = repositoryRoot) {
  const [irText, shapesText, symbolEvidenceText, recipeText] = await Promise.all([
    readFile(resolve(root, paths.ir), "utf8"),
    readFile(resolve(root, paths.shapes), "utf8"),
    readFile(resolve(root, paths.symbolEvidence), "utf8"),
    readFile(resolve(root, paths.recipe), "utf8"),
  ]);
  validateRecipe(JSON.parse(recipeText));
  const priorWaveTexts = new Map(
    await Promise.all(priorWaveReports.map(async ({ path }) => [path, await readFile(resolve(root, path), "utf8")])),
  );
  return { irText, shapesText, symbolEvidenceText, recipeText, priorWaveTexts };
}
export function generate(inputs) {
  const ir = JSON.parse(inputs.irText);
  const shapes = JSON.parse(inputs.shapesText);
  const symbolEvidence = JSON.parse(inputs.symbolEvidenceText);
  const recipeDocument = JSON.parse(inputs.recipeText);
  validateRecipe(recipeDocument);
  const recipe = recipeDocument.recipe;
  assert(ir.schemaVersion === 1 && shapes.schemaVersion === 1, "unsupported dmSDK input schemaVersion");
  assert(shapes.defoldRevision === ir.defoldRevision, "arena-span inputs use different Defold revisions");
  assert(
    symbolEvidence.schemaVersion === 2 &&
      symbolEvidence.defoldRevision === ir.defoldRevision &&
      object(symbolEvidence.declarations),
    "arena-span symbol evidence is invalid or revision-mismatched",
  );
  assert(
    shapes.sourceIr === paths.ir && shapes.sourceHashes?.ir === sha256(inputs.irText),
    "IR hash does not match ABI-shape census provenance",
  );
  unique(ir.declarations, ({ id }) => id, "dmSDK IR declarations");
  unique(shapes.rows, ({ id }) => id, "dmSDK ABI-shape rows");
  const irById = new Map(ir.declarations.map((declaration) => [declaration.id, declaration]));
  const census = shapes.rows.filter(({ tranche }) => tranche === arenaTranche).sort((a, b) => compare(a.id, b.id));
  const censusIds = new Set(census.map(({ id }) => id));
  const priorDeclarations = [];
  const priorWaves = [];
  for (const expected of priorWaveReports) {
    const text = inputs.priorWaveTexts.get(expected.path);
    const report = JSON.parse(text);
    assert(
      report.policyVersion === expected.policyVersion && report.defoldRevision === ir.defoldRevision,
      `${expected.path}: prior-wave identity drifted`,
    );
    assert(report.sourceHashes?.ir === sha256(inputs.irText), `${expected.path}: IR provenance drifted`);
    assert(report.sourceHashes?.shapes === sha256(inputs.shapesText), `${expected.path}: ABI-shape provenance drifted`);
    const applicable = report.declarations.filter(({ id }) => censusIds.has(id));
    for (const declaration of applicable) priorDeclarations.push({ ...declaration, sourceReport: expected.path });
    priorWaves.push({
      report: expected.path,
      policyVersion: report.policyVersion,
      sha256: sha256(text),
      declarationCount: applicable.length,
    });
  }
  const priorIds = unique(priorDeclarations, ({ id }) => id, "combined prior-wave declarations");
  const available = census.filter(({ id }) => !priorIds.has(id));
  const selected = available.filter((row) => blockerFor(row) === "cstring-termination-or-capacity-policy");
  const declined = [];
  const entries = [];
  const patterns = [...arenaCStringPatterns(), DMSDK_UNIVERSAL_FALLBACK_PATTERN];
  for (const candidate of selected) {
    const semantics = inferArenaCStringSemantics(irById.get(candidate.id), candidate);
    const decision = selectDmSdkPattern(patternFacts(candidate, semantics?.semanticTokens), patterns);
    const kind = decision.fallback ? null : decision.family.slice("arena-cstring.".length);
    const linkage = symbolEvidence.declarations[candidate.id];
    const linkageApplies =
      linkage?.name === candidate.symbol &&
      linkage.header === candidate.header &&
      (linkage.linkage === "header-only" ||
        (linkage.linkage === "external" && linkage.availability === "all-targets-all-variants"));
    if (!kind || kind !== semantics?.kind || !linkageApplies) {
      declined.push({
        ...candidate,
        disposition: "blocked",
        blocker: specializationBlocker,
        blockerReason: specializationBlockerReason,
        universalFallback: "retained",
        specializationEvidence: {
          semantics: semantics ? "holds" : "revision-documentation-insufficient",
          pattern: compactDmSdkPatternDecision(decision),
          linkage: linkageApplies ? "holds" : "unavailable",
        },
        patternDecision: decision,
        stages: {
          generated: "not-applicable",
          compiled: "not-claimed",
          linked: "not-claimed",
          runtime: "not-claimed",
          allocation: "not-claimed",
        },
      });
      continue;
    }
    entries.push({
      bindingId: entries.length,
      candidate,
      recipe: { kind, shape: candidate.shape },
      semantics,
      decision,
      linkage,
    });
  }
  const selectedIds = new Set(entries.map(({ candidate }) => candidate.id));
  const declinedIds = new Set(declined.map(({ id }) => id));
  const declarations = available
    .filter(({ id }) => !selectedIds.has(id) && !declinedIds.has(id))
    .map((row) => {
      const blocker = blockerFor(row);
      return {
        ...row,
        disposition: "blocked",
        blocker,
        blockerReason:
          blockerDefinitions[blocker] ??
          "No specialized arena-span lowering recipe currently applies; the universal dmSDK route remains available.",
        stages: {
          generated: "not-applicable",
          compiled: "not-claimed",
          linked: "not-claimed",
          runtime: "not-claimed",
          allocation: "not-claimed",
        },
      };
    });
  declarations.push(...declined);
  declarations.sort((a, b) => compare(a.id, b.id));
  const partitionSummary = Object.fromEntries(
    [...new Set(declarations.map(({ blocker }) => blocker))]
      .sort(compare)
      .map((blocker) => [blocker, declarations.filter((row) => row.blocker === blocker).length]),
  );
  const coverage = {
    arenaSpanCensus: census.length,
    coveredByPriorWaves: priorDeclarations.length,
    generatedCStringArena: entries.length,
    blocked: declarations.length,
    executableAdaptersEmitted: entries.length,
    exactCallTwinsEmitted: entries.length,
    overlap: 0,
    unaccounted: census.length - priorDeclarations.length - entries.length - declarations.length,
  };
  assert(coverage.unaccounted === 0, "arena-span partition is incomplete");
  const recipeFacts = createDmSdkArenaCStringRecipeFacts({
    defoldRevision: ir.defoldRevision,
    entries,
    recipe,
  });
  const generated = renderDmSdkArenaCStringOutputs(recipeFacts);
  const generatedDeclarations = entries.map(
    ({ bindingId, candidate, recipe: selectedRecipe, semantics, decision, linkage }) => ({
      ...candidate,
      disposition: "generated",
      preferredLowering: true,
      denseId: bindingId,
      wrapper: "deherm_dmsdk_arena_cstring_dispatch",
      exactWrapper: "deherm_dmsdk_arena_cstring_exact_dispatch",
      exactCallee: exactCallee({ bindingId }),
      recipe: selectedRecipe,
      patternDecision: decision,
      universalFallback: "retained-usage-materialized-recipe",
      sourceEvidence: [semantics.evidence],
      symbolEvidence: {
        path: paths.symbolEvidence,
        linkage: linkage.linkage,
        availability: linkage.availability,
        linkedIn: linkage.linkedIn,
      },
      stages: {
        generated: "production-and-exact-from-one-recipe",
        compiled: "pinned-header-production-and-exact-object-tests",
        linked: "all-target-all-variant-symbol-census-plus-exact-recording-callee",
        runtime: "exact-dispatch-all-vectors",
        allocation: "bounded-thread-local-input-scratch-no-heap-primitives",
      },
    }),
  );
  const sourceHashes = {
    ir: sha256(inputs.irText),
    shapes: sha256(inputs.shapesText),
    symbolEvidence: sha256(inputs.symbolEvidenceText),
    recipe: sha256(inputs.recipeText),
    priorWaveReports: Object.fromEntries(priorWaves.map(({ report, sha256: hash }) => [report, hash])),
  };
  const report = {
    schemaVersion: 1,
    policyVersion,
    defoldRevision: ir.defoldRevision,
    sources: { ...paths, priorWaveReports: priorWaveReports.map(({ path }) => path) },
    sourceHashes,
    scope: "Complete arena-backed-spans census with deterministic counted-input/caller-output cstring adapters",
    policy: {
      disposition: "generated-cstring-arena-plus-explicit-blockers",
      ...arenaContract,
      maximumInputBytes: recipe.maximumInputBytes,
      maximumOutputBytes: recipe.maximumOutputBytes,
    },
    coverage,
    priorWaves,
    coveredByPriorWaves: priorDeclarations
      .map(({ id, symbol, sourceReport }) => ({ id, symbol, sourceReport }))
      .sort((a, b) => compare(a.id, b.id)),
    partitionSummary,
    artifactHashes: Object.fromEntries([...generated].map(([path, content]) => [path, sha256(content)])),
    artifacts: [...generated.keys()].sort(compare),
    generatedDeclarations,
    declarations,
  };
  generated.set(paths.output, `${JSON.stringify(report, null, 2)}\n`);
  generated.set(
    "packages/bindings/generated/defold-dmsdk-arena-cstring-recipe-facts.json",
    `${JSON.stringify(recipeFacts, null, 2)}\n`,
  );
  return { report, artifacts: generated };
}
export async function run(argv = process.argv.slice(2), root = repositoryRoot) {
  let check = false;
  let outputRoot = root;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--check") check = true;
    else if (argv[index] === "--output-root") outputRoot = resolve(argv[++index]);
    else throw new Error(`Unknown argument: ${argv[index]}`);
  }
  const { report, artifacts: outputs } = generate(await loadInputs(root));
  for (const [relative, content] of outputs) {
    const output = resolve(outputRoot, relative);
    if (check) assert((await readFile(output, "utf8")) === content, `${relative} is stale`);
    else {
      await mkdir(dirname(output), { recursive: true });
      await writeFile(output, content);
    }
  }
  console.log(
    `${check ? "Verified" : "Generated"} ${report.coverage.generatedCStringArena} arena cstring adapters and exact twins; ${report.coverage.blocked} blockers remain.`,
  );
  return report;
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)
  run().catch((error) => {
    console.error(error.stack ?? error.message);
    process.exitCode = 1;
  });
