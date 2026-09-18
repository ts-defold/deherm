#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { stableBindingId } from "./lib/binding-identity.mjs";

const root = new URL("../", import.meta.url);
const inputUrls = {
  ir: new URL("bindings/generated/defold-script-api-ir.json", root),
  accounting: new URL("bindings/generated/defold-script-api-accounting.json", root),
  patterns: new URL("bindings/generated/defold-script-binding-patterns.json", root),
  override: new URL("bindings/overrides/script-borrowed-handle-classification.json", root)
};
const outputUrl = new URL("bindings/generated/defold-script-borrowed-handle-classification.json", root);

const OPERATION_CLASSES = [
  "checked-handle-input-terminal",
  "checked-handle-return-capture",
  "checked-handle-invalidate",
  "declaration-token"
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function parse(text, label) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function compareText(left, right) {
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

function sortedIds(values) {
  return [...values].sort(compareText);
}

function sameIds(left, right) {
  return JSON.stringify(sortedIds(left)) === JSON.stringify(sortedIds(right));
}

function hasHandle(codec) {
  return codec.codecs.includes("handle");
}

function isInvalidatorName(rawName) {
  return /(^|\.)(delete|destroy)(_|$)/.test(rawName);
}

function countBy(rows, selector) {
  const counts = {};
  for (const row of rows) {
    const key = selector(row);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => compareText(left, right)));
}

function resolveContext(binding, operationClass, contextRules) {
  const module = binding.rawName.split(".")[0];
  const exact = contextRules.find((rule) => rule.ids?.includes(binding.id));
  if (exact) return exact.requiredContext;
  const operation = contextRules.find((rule) => rule.operationClass === operationClass);
  if (operation) return operation.requiredContext;
  const moduleRule = contextRules.find((rule) => rule.module === module);
  assert(moduleRule, `${binding.id}: no reviewed context rule matches module '${module}'`);
  return moduleRule.requiredContext;
}

function kindsForCodec(codec, rawTypeToKind, bindingId) {
  if (!hasHandle(codec)) return [];
  const kinds = [...new Set(codec.rawType.split("|")
    .map((type) => rawTypeToKind.get(type))
    .filter(Boolean))].sort(compareText);
  assert(kinds.length > 0, `${bindingId}: handle codec '${codec.rawType}' has no reviewed concrete handle kind`);
  return kinds;
}

function validateSourceEvidence(override, sourceTexts) {
  const evidenceById = uniqueMap(override.sourceEvidence, "borrowed-handle source evidence");
  assert(sourceTexts.size === evidenceById.size, "borrowed-handle source evidence load is incomplete");
  for (const evidence of override.sourceEvidence) {
    const text = sourceTexts.get(evidence.source);
    assert(typeof text === "string", `${evidence.id}: source '${evidence.source}' was not loaded`);
    assert(sha256(text) === evidence.sha256, `${evidence.id}: reviewed source hash is stale for ${evidence.source}`);
    for (const anchor of evidence.anchors) {
      assert(text.includes(anchor), `${evidence.id}: reviewed source anchor '${anchor}' is stale`);
    }
  }
  return evidenceById;
}

function validateHandleKinds(override, evidenceById) {
  const kindById = uniqueMap(override.handleKinds, "borrowed-handle kinds");
  const rawTypeToKind = new Map();
  for (const kind of override.handleKinds) {
    assert(Array.isArray(kind.rawTypes) && kind.rawTypes.length > 0, `${kind.id}: no raw handle types`);
    assert(["lua-rooted-userdata", "numeric-graphics-asset-handle", "declaration-only-token"].includes(kind.representation),
      `${kind.id}: unsupported representation '${kind.representation}'`);
    for (const rawType of kind.rawTypes) {
      assert(!rawTypeToKind.has(rawType), `${rawType}: assigned to multiple concrete handle kinds`);
      rawTypeToKind.set(rawType, kind.id);
    }
    for (const evidenceId of kind.sourceEvidence) {
      assert(evidenceById.has(evidenceId), `${kind.id}: unknown source evidence '${evidenceId}'`);
    }
    for (const field of ["ownership", "validity", "invalidationBoundary"]) {
      assert(typeof kind[field] === "string" && kind[field].length > 0, `${kind.id}: missing ${field}`);
    }
  }
  return { kindById, rawTypeToKind };
}

function validateExceptionalRoutes(override, borrowedById) {
  const exceptional = new Map();
  for (const operationClass of OPERATION_CLASSES.slice(1)) {
    const reviewed = override.exceptionalRoutes[operationClass];
    assert(Array.isArray(reviewed), `missing reviewed exceptions for '${operationClass}'`);
    const reviewedById = uniqueMap(reviewed, `${operationClass} exceptions`);
    for (const [id, row] of reviewedById) {
      assert(borrowedById.has(id), `${id}: reviewed exception is not a pending borrowed-handle route`);
      assert(row.stableId === stableBindingId(id), `${id}: reviewed stable ID is stale`);
      assert(!exceptional.has(id), `${id}: reviewed exceptional route appears in multiple operation classes`);
      exceptional.set(id, operationClass);
    }
  }
  return exceptional;
}

export function generateBorrowedHandleClassification(inputs) {
  const ir = parse(inputs.irText, "script API IR");
  const accounting = parse(inputs.accountingText, "script API accounting");
  const patterns = parse(inputs.patternsText, "script binding patterns");
  const override = parse(inputs.overrideText, "borrowed-handle override");

  assert(override.schemaVersion === 1, "borrowed-handle override has an unsupported schema");
  assert(ir.defoldRevision === accounting.defoldRevision && ir.defoldRevision === patterns.defoldRevision &&
    ir.defoldRevision === override.defoldRevision, "borrowed-handle inputs use different Defold revisions");
  assert(accounting.inputEvidence?.scriptIrSha256 === sha256(inputs.irText),
    "script API accounting is stale against the pinned IR");
  assert(accounting.inputEvidence?.bindingPatternsSha256 === sha256(inputs.patternsText),
    "script API accounting is stale against binding patterns");

  const irById = uniqueMap(ir.functions, "script API IR");
  const patternById = uniqueMap(patterns.bindings, "script binding patterns");
  const borrowedAccountingRows = accounting.rows.filter((row) =>
    row.category === "pending" && row.reason?.loweringFamily === "borrowed-handle");
  const borrowedById = uniqueMap(borrowedAccountingRows, "borrowed-handle accounting rows");
  assert(borrowedById.size === override.expectedCounts.total,
    `borrowed-handle route count drifted: expected ${override.expectedCounts.total}, got ${borrowedById.size}`);

  for (const [id, accountingRow] of borrowedById) {
    const fn = irById.get(id);
    const pattern = patternById.get(id);
    assert(fn, `${id}: borrowed-handle accounting row is absent from pinned IR`);
    assert(pattern?.loweringFamily === "borrowed-handle", `${id}: binding pattern is not borrowed-handle`);
    assert(fn.rawName === accountingRow.rawName && fn.source === accountingRow.source && fn.line === accountingRow.line,
      `${id}: accounting provenance differs from pinned IR`);
    assert(pattern.rawName === fn.rawName && pattern.source === fn.source && pattern.line === fn.line,
      `${id}: pattern provenance differs from pinned IR`);
  }

  const evidenceById = validateSourceEvidence(override, inputs.sourceTexts);
  const { rawTypeToKind } = validateHandleKinds(override, evidenceById);
  const exceptional = validateExceptionalRoutes(override, borrowedById);
  const declarationIds = new Set(override.exceptionalRoutes["declaration-token"].map(({ id }) => id));
  const producerIds = new Set(override.exceptionalRoutes["checked-handle-return-capture"].map(({ id }) => id));
  const invalidatorIds = new Set(override.exceptionalRoutes["checked-handle-invalidate"].map(({ id }) => id));

  const mechanicallyReturnedHandles = new Set();
  const mechanicallyInvalidatingNames = new Set();
  for (const id of borrowedById.keys()) {
    const binding = patternById.get(id);
    if (binding.returnCodecs.some(hasHandle) && !declarationIds.has(id)) mechanicallyReturnedHandles.add(id);
    if (isInvalidatorName(binding.rawName)) mechanicallyInvalidatingNames.add(id);
  }
  assert(sameIds(mechanicallyReturnedHandles, producerIds),
    "reviewed runtime handle producers differ from mechanically discovered handle returns");
  assert(sameIds(mechanicallyInvalidatingNames, invalidatorIds),
    "reviewed invalidators differ from mechanically discovered delete/destroy routes");

  const stableIdOwners = new Map();
  const rows = [];
  for (const id of sortedIds(borrowedById.keys())) {
    const accountingRow = borrowedById.get(id);
    const binding = patternById.get(id);
    const operationClass = exceptional.get(id) ?? "checked-handle-input-terminal";
    const stableId = stableBindingId(id);
    const stableOwner = stableIdOwners.get(stableId);
    assert(!stableOwner, `${id}: stable ID collides with '${stableOwner}'`);
    stableIdOwners.set(stableId, id);

    const inputHandleKinds = [...new Set(binding.parameterCodecs.flatMap((codec) =>
      kindsForCodec(codec, rawTypeToKind, id)))].sort(compareText);
    const returnHandleKinds = [...new Set(binding.returnCodecs.flatMap((codec) =>
      kindsForCodec(codec, rawTypeToKind, id)))].sort(compareText);
    assert(inputHandleKinds.length + returnHandleKinds.length > 0,
      `${id}: borrowed-handle route has no reviewed handle representation`);

    if (operationClass === "checked-handle-input-terminal") {
      assert(inputHandleKinds.length > 0, `${id}: terminal route has no handle input`);
      assert(returnHandleKinds.length === 0, `${id}: terminal route unexpectedly returns a handle`);
      assert(!isInvalidatorName(binding.rawName), `${id}: terminal route has invalidating semantics`);
    } else if (operationClass === "checked-handle-return-capture") {
      assert(returnHandleKinds.length > 0, `${id}: reviewed producer has no handle return`);
    } else if (operationClass === "checked-handle-invalidate") {
      assert(inputHandleKinds.length > 0, `${id}: reviewed invalidator has no handle input`);
      assert(returnHandleKinds.length === 0, `${id}: reviewed invalidator returns a handle`);
    } else {
      assert(operationClass === "declaration-token", `${id}: unsupported operation class '${operationClass}'`);
      assert(inputHandleKinds.includes("resource-declaration") || returnHandleKinds.includes("resource-declaration"),
        `${id}: declaration route does not carry resource_data`);
    }

    rows.push({
      id,
      stableId,
      rawName: binding.rawName,
      modulePath: accountingRow.modulePath,
      member: accountingRow.member,
      source: binding.source,
      line: binding.line,
      operationClass,
      requiredContext: resolveContext(binding, operationClass, override.contextRules),
      inputHandleKinds,
      returnHandleKinds
    });
  }

  const operationClassCounts = countBy(rows, ({ operationClass }) => operationClass);
  for (const operationClass of OPERATION_CLASSES) {
    assert(operationClassCounts[operationClass] === override.expectedCounts[operationClass],
      `${operationClass}: expected ${override.expectedCounts[operationClass]}, got ${operationClassCounts[operationClass] ?? 0}`);
  }
  assert(rows.length === override.expectedCounts.total, "borrowed-handle operation classes do not cover the full census");
  assert(Object.values(operationClassCounts).reduce((sum, count) => sum + count, 0) === rows.length,
    "borrowed-handle operation classes are not mutually exclusive");

  const handleKinds = [...override.handleKinds]
    .sort((left, right) => compareText(left.id, right.id))
    .map((kind) => ({ ...kind, rawTypes: [...kind.rawTypes].sort(compareText) }));
  const inputEvidence = {
    scriptIrSha256: sha256(inputs.irText),
    scriptApiAccountingSha256: sha256(inputs.accountingText),
    bindingPatternsSha256: sha256(inputs.patternsText),
    classificationOverrideSha256: sha256(inputs.overrideText),
    defoldSources: [...override.sourceEvidence]
      .sort((left, right) => compareText(left.source, right.source))
      .map(({ id, source, sha256: hash }) => ({ id, path: `upstream/defold/${source}`, sha256: hash }))
  };
  inputEvidence.aggregateInputSha256 = sha256([
    inputEvidence.scriptIrSha256,
    inputEvidence.scriptApiAccountingSha256,
    inputEvidence.bindingPatternsSha256,
    inputEvidence.classificationOverrideSha256,
    ...inputEvidence.defoldSources.map(({ path, sha256: hash }) => `${path}\0${hash}`)
  ].join("\0"));

  return {
    schemaVersion: 1,
    defoldRevision: ir.defoldRevision,
    scope: "Every pending borrowed-handle route in the pinned script API accounting artifact, exactly once",
    coverageClaim: override.coverageClaim,
    allocationClaim: override.allocationClaim,
    inputEvidence,
    routeCount: rows.length,
    operationClassCounts,
    moduleCounts: countBy(rows, ({ rawName }) => rawName.split(".")[0]),
    operationClassModuleCounts: Object.fromEntries(OPERATION_CLASSES.map((operationClass) => [
      operationClass,
      countBy(rows.filter((row) => row.operationClass === operationClass), ({ rawName }) => rawName.split(".")[0])
    ])),
    implementationOrder: override.implementationOrder,
    handleKinds,
    rows
  };
}

async function loadInputs() {
  const [irText, accountingText, patternsText, overrideText] = await Promise.all([
    readFile(inputUrls.ir, "utf8"),
    readFile(inputUrls.accounting, "utf8"),
    readFile(inputUrls.patterns, "utf8"),
    readFile(inputUrls.override, "utf8")
  ]);
  const override = parse(overrideText, "borrowed-handle override");
  const sourceTexts = new Map(await Promise.all(override.sourceEvidence.map(async ({ source }) => [
    source,
    await readFile(new URL(`upstream/defold/${source}`, root), "utf8")
  ])));
  return { irText, accountingText, patternsText, overrideText, sourceTexts };
}

async function main(argv = process.argv.slice(2)) {
  const unknown = argv.filter((argument) => argument !== "--check");
  if (unknown.length > 0) throw new Error(`Unknown argument: ${unknown[0]}`);
  const check = argv.includes("--check");
  const report = generateBorrowedHandleClassification(await loadInputs());
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (check) {
    const existing = await readFile(outputUrl, "utf8");
    if (existing !== serialized) throw new Error(`${outputUrl.pathname} is stale; regenerate borrowed-handle classification`);
  } else {
    await writeFile(outputUrl, serialized);
  }
  console.log(`${check ? "Verified" : "Generated"} borrowed-handle classification: ` +
    `${report.operationClassCounts["checked-handle-input-terminal"]} terminals, ` +
    `${report.operationClassCounts["checked-handle-return-capture"]} producers, ` +
    `${report.operationClassCounts["checked-handle-invalidate"]} invalidators, ` +
    `${report.operationClassCounts["declaration-token"]} declarations, ${report.routeCount} total.`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await main();
