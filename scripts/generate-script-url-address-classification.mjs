#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { stableBindingId } from "./lib/binding-identity.mjs";

const root = new URL("../", import.meta.url);
const urls = {
  ir: new URL("bindings/generated/defold-script-api-ir.json", root),
  accounting: new URL("bindings/generated/defold-script-api-accounting.json", root),
  patterns: new URL("bindings/generated/defold-script-binding-patterns.json", root),
  override: new URL("bindings/overrides/script-url-address-classification.json", root),
  output: new URL("bindings/generated/defold-script-url-address-classification.json", root)
};

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function parse(text, label) {
  try { return JSON.parse(text); }
  catch (error) { throw new Error(`${label} is not valid JSON: ${error.message}`); }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function compare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function uniqueMap(rows, label) {
  const result = new Map();
  for (const row of rows) {
    assert(typeof row.id === "string" && row.id.length > 0, `${label} contains a row without an id`);
    assert(!result.has(row.id), `${label} contains duplicate id '${row.id}'`);
    result.set(row.id, row);
  }
  return result;
}

function countBy(values, select) {
  const counts = {};
  for (const value of values) {
    const key = select(value);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => compare(a, b)));
}

function allTypes(fn) {
  return [...fn.parameters.map(({ rawType }) => rawType), ...fn.returns];
}

function formsFor(rawType) {
  if (rawType === "string|hash|url") return ["string-shorthand", "hash-shorthand", "full-url"];
  if (rawType === "url|number|nil") return ["full-url", "numeric-camera-id", "nil-default"];
  throw new Error(`unreviewed URL parameter type '${rawType}'`);
}

function validateSources(override, sourceTexts) {
  assert(sourceTexts.size === override.sourceEvidence.length, "URL source evidence load is incomplete");
  for (const evidence of override.sourceEvidence) {
    const source = sourceTexts.get(evidence.source);
    assert(typeof source === "string", `${evidence.id}: source was not loaded`);
    assert(sha256(source) === evidence.sha256, `${evidence.id}: reviewed source hash is stale`);
    for (const anchor of evidence.anchors) {
      assert(source.includes(anchor), `${evidence.id}: reviewed source anchor '${anchor}' is stale`);
    }
  }
}

export function generateScriptUrlAddressClassification(inputs) {
  const ir = parse(inputs.irText, "script API IR");
  const accounting = parse(inputs.accountingText, "script API accounting");
  const patterns = parse(inputs.patternsText, "script binding patterns");
  const override = parse(inputs.overrideText, "URL classification override");
  assert(override.schemaVersion === 1, "URL classification override has an unsupported schema");
  assert(ir.defoldRevision === accounting.defoldRevision && ir.defoldRevision === patterns.defoldRevision &&
    ir.defoldRevision === override.defoldRevision, "URL classification inputs use different Defold revisions");
  assert(accounting.inputEvidence?.scriptIrSha256 === sha256(inputs.irText),
    "script API accounting is stale against the pinned IR");
  assert(accounting.inputEvidence?.bindingPatternsSha256 === sha256(inputs.patternsText),
    "script API accounting is stale against binding patterns");
  validateSources(override, inputs.sourceTexts);

  const irById = uniqueMap(ir.functions, "script API IR");
  const patternById = uniqueMap(patterns.bindings, "script binding patterns");
  const accountingById = uniqueMap(accounting.rows, "script API accounting");
  const classified = patterns.bindings.filter((row) => row.loweringFamily === "defold-value");
  assert(classified.length === override.expectedCounts.classifiedDefoldValue,
    `classified defold-value census drifted: expected ${override.expectedCounts.classifiedDefoldValue}, got ${classified.length}`);
  const carriesMatrix4 = ({ id }) => allTypes(irById.get(id)).some((type) => type.includes("matrix4"));
  const preexistingExecutable = classified.filter((row) =>
    accountingById.get(row.id).category === "executable-stable-id" && !carriesMatrix4(row));
  assert(preexistingExecutable.length === override.expectedCounts.preexistingExecutableNonMatrix,
    `pre-existing executable non-Matrix defold-value census drifted: expected ${override.expectedCounts.preexistingExecutableNonMatrix}, got ${preexistingExecutable.length}`);
  const preexistingIds = new Set(preexistingExecutable.map(({ id }) => id));
  const frontier = classified.filter(({ id }) => !preexistingIds.has(id));
  assert(frontier.length === override.expectedCounts.baselineFrontier,
    `classified defold-value frontier drifted: expected ${override.expectedCounts.baselineFrontier}, got ${frontier.length}`);

  const matrixIds = new Set();
  const urlIds = new Set();
  const remainderIds = new Set();
  for (const pattern of frontier) {
    const fn = irById.get(pattern.id);
    const accountingRow = accountingById.get(pattern.id);
    assert(fn && accountingRow, `${pattern.id}: pattern row is absent from pinned IR or accounting`);
    assert(fn.rawName === accountingRow.rawName && fn.source === accountingRow.source && fn.line === accountingRow.line,
      `${pattern.id}: accounting provenance differs from pinned IR`);
    assert(JSON.stringify(pattern.parameterCodecs.map(({ rawType }) => rawType)) ===
      JSON.stringify(fn.parameters.map(({ rawType }) => rawType)) &&
      JSON.stringify(pattern.returnCodecs.map(({ rawType }) => rawType)) === JSON.stringify(fn.returns),
    `${pattern.id}: binding-pattern shapes differ from pinned IR`);
    const types = allTypes(fn);
    if (types.some((type) => type.includes("matrix4"))) matrixIds.add(pattern.id);
    else if (types.some((type) => type.includes("url"))) urlIds.add(pattern.id);
    else remainderIds.add(pattern.id);
  }
  assert(matrixIds.size === override.expectedCounts.matrix4Disjoint,
    `matrix4 disjoint census drifted: expected ${override.expectedCounts.matrix4Disjoint}, got ${matrixIds.size}`);
  assert(urlIds.size === override.expectedCounts.total,
    `URL/address route count drifted: expected ${override.expectedCounts.total}, got ${urlIds.size}`);
  assert(remainderIds.size === override.expectedCounts.binaryStringRemainder + override.expectedCounts.currentCodecRemainder,
    "non-matrix/non-URL defold-value remainder drifted");
  const binaryIds = new Set(override.binaryStringRemainderIds);
  assert(binaryIds.size === override.expectedCounts.binaryStringRemainder,
    "binary-string reviewed remainder count drifted");
  for (const id of binaryIds) assert(remainderIds.has(id), `${id}: reviewed binary-string route left the remainder`);
  const isPendingDefoldValue = (id) => {
    const row = accountingById.get(id);
    return row.category === "pending" && row.reason?.loweringFamily === "defold-value";
  };
  const currentPendingIds = new Set(frontier.map(({ id }) => id).filter(isPendingDefoldValue));
  const remainingMatrix4 = [...matrixIds].filter(isPendingDefoldValue).length;
  const promotedMatrix4 = matrixIds.size - remainingMatrix4;
  assert(currentPendingIds.size === override.expectedCounts.currentPendingDefoldValue,
    `current pending defold-value census drifted: expected ${override.expectedCounts.currentPendingDefoldValue}, got ${currentPendingIds.size}`);
  assert(remainingMatrix4 === override.expectedCounts.remainingMatrix4,
    `remaining Matrix4 census drifted: expected ${override.expectedCounts.remainingMatrix4}, got ${remainingMatrix4}`);
  assert(promotedMatrix4 === override.expectedCounts.promotedMatrix4,
    `promoted Matrix4 census drifted: expected ${override.expectedCounts.promotedMatrix4}, got ${promotedMatrix4}`);
  assert([...urlIds].every(isPendingDefoldValue), "one or more URL/address routes are no longer pending");
  assert([...remainderIds].every(isPendingDefoldValue), "one or more non-URL remainder routes are no longer pending");
  assert(remainingMatrix4 + urlIds.size + remainderIds.size === currentPendingIds.size,
    "current pending defold-value partition is not exact");

  const rows = [...urlIds].sort(compare).map((id) => {
    const fn = irById.get(id);
    const accountingRow = accountingById.get(id);
    assert(accountingRow.category === "pending" && accountingRow.reason?.loweringFamily === "defold-value",
      `${id}: URL/address route is no longer pending in the expected defold-value family`);
    const urlParameters = fn.parameters.flatMap((parameter, index) => parameter.rawType.includes("url") ? [{
      index,
      name: parameter.rawName,
      rawType: parameter.rawType,
      forms: formsFor(parameter.rawType)
    }] : []);
    assert(urlParameters.length > 0, `${id}: selected URL route has no URL parameter`);
    assert(fn.returns.every((type) => !type.includes("url")),
      `${id}: URL result requires copy-before-pop routing not enabled by this planned classifier`);
    return {
      id,
      stableId: stableBindingId(id),
      rawName: fn.rawName,
      modulePath: fn.modulePath,
      member: fn.member,
      source: fn.source,
      line: fn.line,
      urlParameters,
      urlResults: [],
      routing: {
        status: "planned",
        fullUrl: "ScriptUrlArena token -> exact dmMessage::URL -> dmScript::PushURL",
        stringShorthand: "push unchanged Lua string; dmScript::ResolveURL applies captured-instance defaults",
        hashShorthand: "push unchanged Lua hash; dmScript::ResolveURL applies default socket and clears fragment",
        result: "copy dmMessage::URL into ScriptUrlArena before restoring/popping Lua stack"
      },
      targetSupport: override.targetSupport
    };
  });
  assert(new Set(rows.map(({ stableId }) => stableId)).size === rows.length,
    "URL/address route stable-ID collision detected");
  const moduleCounts = countBy(rows, ({ modulePath }) => modulePath.join("."));
  assert(JSON.stringify(moduleCounts) === JSON.stringify(override.expectedCounts.modules),
    `URL/address module census drifted: ${JSON.stringify(moduleCounts)}`);
  const urlParameters = rows.flatMap(({ urlParameters }) => urlParameters);
  assert(urlParameters.length === override.expectedCounts.urlParameters,
    `URL parameter count drifted: expected ${override.expectedCounts.urlParameters}, got ${urlParameters.length}`);
  const rawUrlParameterTypeCounts = countBy(urlParameters, ({ rawType }) => rawType);
  assert(JSON.stringify(rawUrlParameterTypeCounts) === JSON.stringify(override.expectedCounts.rawUrlParameterTypes),
    `URL parameter type census drifted: ${JSON.stringify(rawUrlParameterTypeCounts)}`);

  const inputEvidence = {
    scriptIrSha256: sha256(inputs.irText),
    scriptApiAccountingSha256: sha256(inputs.accountingText),
    bindingPatternsSha256: sha256(inputs.patternsText),
    classificationOverrideSha256: sha256(inputs.overrideText),
    defoldSources: [...override.sourceEvidence].sort((a, b) => compare(a.source, b.source)).map(({ id, source, sha256 }) => ({
      id, path: `upstream/defold/${source}`, sha256
    }))
  };
  inputEvidence.aggregateInputSha256 = sha256([
    inputEvidence.scriptIrSha256,
    inputEvidence.scriptApiAccountingSha256,
    inputEvidence.bindingPatternsSha256,
    inputEvidence.classificationOverrideSha256,
    ...inputEvidence.defoldSources.map(({ path, sha256 }) => `${path}\0${sha256}`)
  ].join("\0"));

  return {
    schemaVersion: 1,
    defoldRevision: ir.defoldRevision,
    scope: "The exact non-Matrix4 pending defold-value routes whose pinned IR contains a URL/address parameter",
    coverageClaim: override.coverageClaim,
    allocationClaim: override.allocationClaim,
    routeCount: rows.length,
    urlParameterCount: urlParameters.length,
    moduleCounts,
    rawUrlParameterTypeCounts,
    disjointCensus: {
      classifiedDefoldValue: classified.length,
      preexistingExecutableNonMatrix: preexistingExecutable.length,
      baselineFrontier: frontier.length,
      currentPendingDefoldValue: currentPendingIds.size,
      promotedMatrix4,
      remainingMatrix4,
      urlAddressPending: rows.length,
      binaryStringRemainder: binaryIds.size,
      currentCodecRemainder: remainderIds.size - binaryIds.size
    },
    representationPolicy: {
      fullUrl: "three exact uint64 components (socket, path, fragment) plus zero/preserved reserved lane in a generation-checked ScriptUrlArena slot",
      stringShorthand: "distinct string value resolved by Defold against captured Lua caller context",
      hashShorthand: "distinct hash value resolved by Defold as default-socket path with zero fragment",
      collapsedLegacyUrl: "fail-closed: ScriptHandleKind::kUrl with no sidecar slot is never interpreted as a full URL"
    },
    inputEvidence,
    rows
  };
}

export async function loadScriptUrlAddressInputs() {
  const [irText, accountingText, patternsText, overrideText] = await Promise.all([
    readFile(urls.ir, "utf8"), readFile(urls.accounting, "utf8"),
    readFile(urls.patterns, "utf8"), readFile(urls.override, "utf8")
  ]);
  const override = parse(overrideText, "URL classification override");
  const sourceTexts = new Map(await Promise.all(override.sourceEvidence.map(async ({ source }) => [
    source, await readFile(new URL(`upstream/defold/${source}`, root), "utf8")
  ])));
  return { irText, accountingText, patternsText, overrideText, sourceTexts };
}

async function main(argv = process.argv.slice(2)) {
  const outputIndex = argv.indexOf("--output");
  const outputPath = outputIndex >= 0 ? argv[outputIndex + 1] : null;
  const consumed = new Set(outputIndex >= 0 ? [outputIndex, outputIndex + 1] : []);
  const unknown = argv.filter((argument, index) => argument !== "--check" && !consumed.has(index));
  if (unknown.length) throw new Error(`Unknown argument: ${unknown[0]}`);
  if (outputIndex >= 0 && (!outputPath || outputPath.startsWith("--"))) {
    throw new Error("--output requires a file path");
  }
  const check = argv.includes("--check");
  if (check && outputPath) throw new Error("--check and --output are mutually exclusive");
  const generated = `${JSON.stringify(generateScriptUrlAddressClassification(
    await loadScriptUrlAddressInputs()), null, 2)}\n`;
  if (check) {
    const current = await readFile(urls.output, "utf8");
    if (current !== generated) throw new Error(`${urls.output.pathname} is stale; regenerate URL/address classification`);
  } else {
    await writeFile(outputPath ?? urls.output, generated);
  }
  console.log(`${check ? "Verified" : "Generated"} 70 planned URL/address routes with an exact composite sidecar policy.`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await main();
