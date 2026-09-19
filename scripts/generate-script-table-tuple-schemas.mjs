#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { hexBindingId, stableBindingId } from "./lib/binding-identity.mjs";

import { declaredDerivation, expectReviewedCount, expectSameRevision } from "./lib/reviewed-revision.mjs";
import { VOID, recordAudit } from "./lib/revision-audit.mjs";

const root = new URL("../", import.meta.url);
const urls = {
  ir: new URL("packages/bindings/generated/defold-script-api-ir.json", root),
  patterns: new URL("packages/bindings/generated/defold-script-binding-patterns.json", root),
  accounting: new URL("packages/bindings/generated/defold-script-api-accounting.json", root),
  overrides: new URL("packages/bindings/overrides/script-table-tuple-schema-overrides.json", root)
};
const reportUrl = new URL("packages/bindings/generated/defold-script-table-tuple-schemas.json", root);
const documentationUrl = new URL(".agents/docs/research/script-table-tuple-schema-classification.md", root);

const primitiveTypes = new Set([
  "boolean", "integer", "number", "string", "hash", "url", "vector", "vector3",
  "vector4", "quaternion", "matrix4", "nil"
]);
const familyOrder = ["lua-table", "multi-result"];
const bucketOrder = [
  "flat-record",
  "fixed-scalar-tuple",
  "fixed-value-tuple",
  "typed-sequence",
  "typed-map",
  "table-tuple-schema",
  "tagged-table-union",
  "opaque-record",
  "semantic-flat-record",
  "owned-handle-tuple",
  "binary-string-tuple",
  "dynamic-recursive"
];
const bucketDefinitions = {
  "flat-record": {
    family: "lua-table", origin: "mechanical-ir", implementationOrder: 1,
    description: "Fixed-field records whose fields are scalar, enum, hash, URL, or copied Defold values.",
    requirements: ["fixed-field-descriptor", "unknown-key-policy", "copy-results-before-lua-pop"]
  },
  "fixed-scalar-tuple": {
    family: "multi-result", origin: "mechanical-ir", implementationOrder: 2,
    description: "Fixed-arity tuples containing only scalar, enum, and nullable scalar slots.",
    requirements: ["exact-result-count", "preserve-interior-nil", "positional-codecs"]
  },
  "fixed-value-tuple": {
    family: "multi-result", origin: "mechanical-ir", implementationOrder: 2,
    description: "Fixed-arity tuples containing copied Defold values such as vectors and quaternions.",
    requirements: ["exact-result-count", "preserve-interior-nil", "copy-defold-values"]
  },
  "typed-sequence": {
    family: "lua-table", origin: "mechanical-shape-explicit-policy", implementationOrder: 3,
    description: "Arrays or records containing arrays with mechanically known element codecs but no IR size bound.",
    requirements: ["explicit-maximum-length", "dense-array-policy", "element-codec", "copy-results-before-lua-pop"]
  },
  "typed-map": {
    family: "lua-table", origin: "mechanical-shape-explicit-policy", implementationOrder: 4,
    description: "Maps with mechanically known key/value codecs but no IR entry bound or coercion policy.",
    requirements: ["explicit-maximum-entries", "own-keys-only", "key-coercion-collision-policy", "value-codec"]
  },
  "table-tuple-schema": {
    family: "multi-result", origin: "mechanical-shape-explicit-policy", implementationOrder: 5,
    description: "Fixed tuples with at least one table input or result that requires a bounded table schema.",
    requirements: ["exact-result-count", "explicit-table-schema", "bounded-collections", "ownership-policy"]
  },
  "tagged-table-union": {
    family: "lua-table", origin: "mechanical-shape-explicit-policy", implementationOrder: 5,
    description: "A table participates in a non-null union and requires an explicit branch discriminator.",
    requirements: ["explicit-branch-selection", "branch-specific-codecs", "reject-ambiguous-values"]
  },
  "opaque-record": {
    family: "lua-table", origin: "mechanical-shape-explicit-policy", implementationOrder: 5,
    description: "A record contains an opaque or unresolved nested value such as a render constant buffer.",
    requirements: ["explicit-nested-schema", "context-policy", "lifetime-policy"]
  },
  "semantic-flat-record": {
    family: "lua-table", origin: "reviewed-override", implementationOrder: 5,
    description: "A structurally flat record whose discriminator, binary data, or ownership semantics are not in the IR shape.",
    requirements: ["reviewed-semantic-schema", "source-anchored-probe", "ownership-or-discriminator-policy"]
  },
  "owned-handle-tuple": {
    family: "multi-result", origin: "reviewed-override", implementationOrder: 5,
    description: "A fixed tuple returning owned Lua userdata whose close and registry lifetime must be explicit.",
    requirements: ["exact-result-count", "generational-registry-handle", "explicit-close-policy", "queued-finalizer-release"]
  },
  "binary-string-tuple": {
    family: "multi-result", origin: "reviewed-override", implementationOrder: 5,
    description: "A fixed tuple containing a Lua byte string that cannot use a generic UTF-16 JavaScript string codec.",
    requirements: ["exact-result-count", "binary-byte-codec", "copy-before-lua-pop"]
  },
  "dynamic-recursive": {
    family: "lua-table", origin: "mechanical-shape-explicit-policy", implementationOrder: 6,
    description: "Recursive or any-valued tables requiring cycle, depth, size, and supported-value policies.",
    requirements: ["explicit-maximum-depth", "explicit-maximum-entries", "cycle-rejection", "supported-value-union"]
  }
};

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function splitTopLevel(source, delimiter = "|") {
  const parts = [];
  let start = 0;
  let depth = 0;
  let quote = "";
  for (let index = 0; index < source.length; ++index) {
    const character = source[index];
    if (quote) {
      if (character === quote && source[index - 1] !== "\\") quote = "";
      continue;
    }
    if (character === "\"" || character === "'") quote = character;
    else if ("<{[(".includes(character)) ++depth;
    else if (">}])".includes(character)) --depth;
    else if (character === delimiter && depth === 0) {
      parts.push(source.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(source.slice(start).trim());
  return parts.filter(Boolean);
}

function addFeatures(target, source) {
  for (const feature of source) target.add(feature);
  return target;
}

function analyzeType(rawType, types, depth = 0, seen = new Set()) {
  const concrete = splitTopLevel(String(rawType)).filter((part) => part !== "nil");
  if (concrete.length > 1) {
    const features = new Set(["tagged"]);
    for (const part of concrete) addFeatures(features, analyzeType(part, types, depth, seen));
    return features;
  }
  const type = concrete[0] ?? "nil";
  if (primitiveTypes.has(type)) return new Set();
  if (type === "any" || type.includes("any")) return new Set(["dynamic"]);
  if (type.endsWith("[]")) {
    return addFeatures(new Set(["sequence"]), analyzeType(type.slice(0, -2), types, depth, seen));
  }
  if (type.startsWith("table<") && type.endsWith(">")) {
    const features = new Set(["map"]);
    for (const part of splitTopLevel(type.slice(6, -1), ",")) {
      addFeatures(features, analyzeType(part, types, depth, seen));
    }
    return features;
  }
  if (type.startsWith("{") && type.endsWith("}")) {
    const features = new Set(depth > 0 ? ["nested"] : []);
    for (const field of splitTopLevel(type.slice(1, -1), ",")) {
      const separator = field.indexOf(":");
      if (separator < 0) features.add("opaque");
      else addFeatures(features, analyzeType(field.slice(separator + 1), types, depth + 1, seen));
    }
    return features;
  }
  const definition = types.get(type);
  if (!definition) return new Set(["opaque"]);
  if (seen.has(type)) return new Set(["dynamic"]);
  const nextSeen = new Set(seen).add(type);
  if (definition.kind === "enum") return new Set();
  if (definition.kind === "alias") {
    if (definition.rawType === "userdata" || /opaque|lifetime/i.test(definition.description ?? "")) {
      return new Set(["opaque"]);
    }
    return analyzeType(definition.rawType, types, depth, nextSeen);
  }
  if (definition.kind === "class") {
    const features = new Set(depth > 0 ? ["nested"] : []);
    for (const field of definition.fields) {
      addFeatures(features, analyzeType(field.rawType, types, depth + 1, nextSeen));
    }
    return features;
  }
  return new Set(["opaque"]);
}

function signature(fn) {
  return {
    parameters: fn.parameters.map(({ rawType }) => rawType),
    returns: [...fn.returns]
  };
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function classifyLuaTable(pattern, types) {
  const features = new Set();
  const tableCodecs = [...pattern.parameterCodecs, ...pattern.returnCodecs]
    .filter(({ codecs }) => codecs.includes("table"));
  assert(tableCodecs.length > 0, `${pattern.id}: lua-table route has no table codec`);
  for (const codec of tableCodecs) addFeatures(features, analyzeType(codec.rawType, types));
  if (features.has("dynamic")) return "dynamic-recursive";
  if (features.has("map")) return "typed-map";
  if (features.has("sequence")) return "typed-sequence";
  if (features.has("tagged")) return "tagged-table-union";
  if (features.has("opaque") || features.has("nested")) return "opaque-record";
  return "flat-record";
}

function classifyMultiResult(pattern) {
  assert(pattern.traits.includes("fixed-multi-result"), `${pattern.id}: multi-result route is not fixed`);
  const allCodecs = [...pattern.parameterCodecs, ...pattern.returnCodecs];
  if (allCodecs.some(({ codecs }) => codecs.includes("table"))) return "table-tuple-schema";
  if (pattern.returnCodecs.some(({ codecs }) => codecs.includes("value"))) return "fixed-value-tuple";
  return "fixed-scalar-tuple";
}

function validateOverrides(document, functions, inScope) {
  assert(document.schemaVersion === 1, "Unsupported table/tuple override schema");
  assert(Array.isArray(document.overrides), "Table/tuple overrides must be an array");
  const result = new Map();
  // A reviewed override describes ONE route as it was documented at the revision
  // it was read at. At that revision each of these is a regression in this tree
  // and stays fatal; deriving another revision, a route that went away, left the
  // structural scope, or is documented with a different signature or wording is
  // an override this revision does not bear out, so it is withdrawn and reported
  // rather than asserted against documentation that says something else.
  const withdraw = (id, reason, message) => {
    assert(declaredDerivation(), message);
    recordAudit({
      input: "packages/bindings/overrides/script-table-tuple-schema-overrides.json",
      id, status: VOID, reason, detail: message
    });
    return true;
  };
  for (const override of document.overrides) {
    assert(!result.has(override.id), `Duplicate table/tuple override: ${override.id}`);
    if (!inScope.has(override.id)) {
      withdraw(override.id, "out-of-scope", `Override is outside the structural table/tuple scope: ${override.id}`);
      continue;
    }
    const fn = functions.get(override.id);
    if (!fn) {
      withdraw(override.id, "absent-route", `Override route is absent from the pinned IR: ${override.id}`);
      continue;
    }
    assert(bucketDefinitions[override.bucket]?.origin === "reviewed-override",
      `${override.id}: ${override.bucket} is not an override bucket`);
    assert(bucketDefinitions[override.bucket].family === inScope.get(override.id),
      `${override.id}: override bucket belongs to the wrong lowering family`);
    if (!sameJson(signature(fn), { parameters: override.parameters, returns: override.returns })) {
      withdraw(override.id, "stale-signature", `${override.id}: reviewed signature drifted`);
      continue;
    }
    const documentation = [
      fn.description,
      ...fn.parameters.map(({ description }) => description),
      ...fn.returnDescriptions
    ].join("\n");
    if (!(typeof override.descriptionAnchor === "string" && documentation.includes(override.descriptionAnchor))) {
      withdraw(override.id, "stale-description-anchor", `${override.id}: reviewed description anchor drifted`);
      continue;
    }
    assert(typeof override.reasonCode === "string" && override.reasonCode.length > 0,
      `${override.id}: reasonCode is required`);
    result.set(override.id, override);
  }
  return result;
}

export function generateScriptTableTupleSchemas(texts) {
  const ir = JSON.parse(texts.ir);
  const patterns = JSON.parse(texts.patterns);
  const accounting = JSON.parse(texts.accounting);
  const overrideDocument = JSON.parse(texts.overrides);
  expectSameRevision({
    label: "script table/tuple schemas",
    inputs: [
      { path: "packages/bindings/generated/defold-script-api-ir.json", revision: ir.defoldRevision },
      { path: "packages/bindings/generated/defold-script-binding-patterns.json", revision: patterns.defoldRevision },
      { path: "packages/bindings/generated/defold-script-api-accounting.json", revision: accounting.defoldRevision }
    ]
  });
  const functions = new Map(ir.functions.map((fn) => [fn.id, fn]));
  const patternById = new Map(patterns.bindings.map((row) => [row.id, row]));
  const types = new Map(ir.types.map((type) => [type.name, type]));
  assert(new Set(accounting.rows.map(({ id }) => id)).size === accounting.rows.length,
    "Duplicate accounting route");
  const inScope = new Map();
  for (const accounted of accounting.rows) {
    const pattern = patternById.get(accounted.id);
    if (!pattern || !familyOrder.includes(pattern.loweringFamily)) continue;
    // Schema classification describes the source ABI shape independently of
    // whichever executable lane currently owns the route. Native value
    // dispatch already supplies its own tighter GUI table representation.
    if (accounted.evidence?.generator !== "native-value-dispatch") {
      inScope.set(pattern.id, pattern.loweringFamily);
    }
  }
  const overrides = validateOverrides(overrideDocument, functions, inScope);
  const rows = [];
  const stableIds = new Map();
  for (const [id, family] of [...inScope].sort(([left], [right]) => compareText(left, right))) {
    const fn = functions.get(id);
    const pattern = patternById.get(id);
    assert(fn && pattern, `${id}: route is missing from IR or binding-pattern inputs`);
    assert(pattern.loweringFamily === family, `${id}: accounting and pattern lowering families differ`);
    const override = overrides.get(id);
    const bucket = override?.bucket ?? (family === "lua-table"
      ? classifyLuaTable(pattern, types)
      : classifyMultiResult(pattern));
    const definition = bucketDefinitions[bucket];
    assert(definition?.family === family, `${id}: invalid bucket ${bucket} for ${family}`);
    const stableId = stableBindingId(id);
    assert(!stableIds.has(stableId),
      `Stable ID collision ${hexBindingId(stableId)}: ${stableIds.get(stableId)} and ${id}`);
    stableIds.set(stableId, id);
    rows.push({
      id,
      stableId,
      stableIdHex: hexBindingId(stableId),
      family,
      bucket,
      classificationOrigin: override ? "reviewed-override" : definition.origin,
      reasonCode: override?.reasonCode,
      source: fn.source,
      line: fn.line,
      parameters: pattern.parameterCodecs,
      returns: pattern.returnCodecs,
      traits: pattern.traits,
      requirements: definition.requirements
    });
  }
  assert(rows.length === inScope.size, "Not every in-scope route was classified exactly once");
  // At the reviewed revision every override is consumed and a gap is a
  // regression; at another revision this counts the overrides that revision
  // withdrew, each already named in the audit.
  expectReviewedCount({
    input: "packages/bindings/overrides/script-table-tuple-schema-overrides.json",
    label: "reviewed override consumption",
    expected: overrideDocument.overrides.length, observed: overrides.size
  });
  const familyCounts = Object.fromEntries(familyOrder.map((family) => [family, rows.filter((row) => row.family === family).length]));
  const bucketCounts = Object.fromEntries(bucketOrder.map((bucket) => [bucket, rows.filter((row) => row.bucket === bucket).length]));
  for (const family of [...familyOrder, "total"]) {
    expectReviewedCount({
      input: "packages/bindings/overrides/script-table-tuple-schema-overrides.json",
      label: `table/tuple route census:${family}`,
      expected: overrideDocument.expectedRouteCounts[family],
      observed: family === "total" ? rows.length : familyCounts[family]
    });
  }
  assert(Object.keys(overrideDocument.expectedBucketCounts).length === bucketOrder.length,
    "Expected bucket ledger does not contain every bucket exactly once");
  for (const bucket of bucketOrder) {
    expectReviewedCount({
      input: "packages/bindings/overrides/script-table-tuple-schema-overrides.json",
      label: `table/tuple bucket census:${bucket}`,
      expected: overrideDocument.expectedBucketCounts[bucket], observed: bucketCounts[bucket]
    });
  }
  const tupleArities = Object.fromEntries([2, 3, 4].map((arity) => [arity,
    rows.filter((row) => row.family === "multi-result" && row.returns.length === arity).length]));
  for (const [arity, expected] of Object.entries({ 2: 29, 3: 5, 4: 3 })) {
    expectReviewedCount({
      input: "packages/bindings/overrides/script-table-tuple-schema-overrides.json",
      label: `fixed tuple arity census:${arity}`, expected, observed: tupleArities[arity]
    });
  }
  const report = {
    schemaVersion: 1,
    defoldRevision: ir.defoldRevision,
    scope: "All lua-table and multi-result routes in the exact script API pattern ledger, including generated fixed tuples",
    evidencePolicy: "Planning/schema classification only. This artifact does not claim compilation, linkage, packaged-engine execution, or runtime behavior.",
    inputSha256: sha256([texts.ir, texts.patterns, texts.accounting, texts.overrides].join("\0")),
    routeCount: rows.length,
    familyCounts,
    bucketCounts,
    mechanicalIrRouteCount: rows.filter(({ classificationOrigin }) => classificationOrigin === "mechanical-ir").length,
    explicitPolicyRouteCount: rows.filter(({ classificationOrigin }) => classificationOrigin !== "mechanical-ir").length,
    reviewedOverrideCount: overrides.size,
    tupleArities,
    buckets: bucketOrder.map((name) => ({ name, count: bucketCounts[name], ...bucketDefinitions[name] })),
    rows
  };
  return report;
}

function markdown(report) {
  const rows = report.buckets.map((bucket) =>
    `| \`${bucket.name}\` | ${bucket.family} | ${bucket.count} | ${bucket.origin} | ${bucket.implementationOrder} | ${bucket.description} |`).join("\n");
  const overrides = report.rows.filter(({ classificationOrigin }) => classificationOrigin === "reviewed-override")
    .map((row) => `| \`${row.id}\` | \`${row.bucket}\` | \`${row.reasonCode}\` |`).join("\n");
  return `---
type: Research
title: Generated script table and tuple schema classification
description: Deterministic schema ledger for Lua-table and fixed multi-result routes.
tags: [research, generated, bindings, lua, abi, typescript]
status: active
generated: { by: scripts/generate-script-table-tuple-schemas.mjs, at: 2026-09-18T00:00:00-04:00 }
---

# Script table and tuple schema classification

This generated ledger classifies all **${report.routeCount}** table/tuple routes exactly once, including executable fixed tuples:
**${report.familyCounts["lua-table"]}** Lua-table routes and **${report.familyCounts["multi-result"]}** fixed multi-result routes.
It is a planning/schema compiler artifact. It does **not** claim compile, link, packaged-engine, or runtime evidence.

| Bucket | Family | Routes | Classification | Order | Meaning |
| --- | --- | ---: | --- | ---: | --- |
${rows}

## Implementation order

1. Generate fixed-field SoA descriptors for \`flat-record\` routes.
2. Generate exact positional result descriptors for scalar and copied-value tuples.
3. Add typed sequences with an explicit per-schema maximum length.
4. Add typed maps with own-key, key-coercion, collision, and maximum-entry policies.
5. Implement table tuples, tagged unions, opaque contexts, and reviewed ownership/discriminator exceptions behind explicit schemas.
6. Implement dynamic recursive tables last, with cycle rejection and hard depth/entry/value limits.

All targets fail closed when a bucket has no target-specific implementation. Browser-host support is not inferred from native captured-Lua support.
Output strings and Defold values must be copied before the Lua stack is restored; userdata must cross as generation-checked registry handles.

## Reviewed semantic exceptions

| Route | Bucket | Reason |
| --- | --- | --- |
${overrides}
`;
}

async function main(argv = process.argv.slice(2)) {
  const unknown = argv.filter((argument) => argument !== "--check");
  if (unknown.length) throw new Error(`Unknown argument: ${unknown[0]}`);
  const check = argv.includes("--check");
  const texts = Object.fromEntries(await Promise.all(Object.entries(urls).map(async ([name, url]) =>
    [name, await readFile(url, "utf8")]
  )));
  const report = generateScriptTableTupleSchemas(texts);
  const outputs = [
    [reportUrl, `${JSON.stringify(report, null, 2)}\n`],
    [documentationUrl, markdown(report)]
  ];
  for (const [url, expected] of outputs) {
    if (check) {
      if (await readFile(url, "utf8") !== expected) throw new Error(`${url.pathname} is stale`);
    } else await writeFile(url, expected);
  }
  console.log(`${check ? "Verified" : "Generated"} ${report.routeCount} table/tuple schema classifications ` +
    `(${report.familyCounts["lua-table"]} lua-table, ${report.familyCounts["multi-result"]} multi-result).`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await main();
