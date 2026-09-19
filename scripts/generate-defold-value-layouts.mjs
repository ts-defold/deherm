#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const relativePaths = Object.freeze({
  projection: "packages/bindings/generated/defold-script-projection-ir.json",
  policy: "packages/bindings/overrides/defold-value-layouts.json",
  report: "packages/bindings/generated/defold-value-layouts.json",
  header: "defold/defold_hermes/include/defold_hermes/generated_defold_value_layout.h"
});

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function compare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Every `defold-value` constructor name reachable from the pinned script
 * projection, including names that appear only inside union variants. The walk
 * is exhaustive on purpose: an unclassified name must fail the generator rather
 * than silently reach a transport that cannot carry it.
 */
function collectDefoldValueNames(value, output = new Set()) {
  if (!value || typeof value !== "object") return output;
  if (Array.isArray(value)) {
    for (const item of value) collectDefoldValueNames(item, output);
    return output;
  }
  if (value.kind === "defold-value" && typeof value.name === "string") output.add(value.name);
  for (const child of Object.values(value)) collectDefoldValueNames(child, output);
  return output;
}

function lineOf(text, index) {
  return text.slice(0, index).split("\n").length;
}

/** One pinned dmSDK doc block, addressed by its `@name` tag. */
function docBlock(text, file, declaration) {
  const pattern = new RegExp(`/\\*#[^]*?\\*/`, "g");
  for (const match of text.matchAll(pattern)) {
    const body = match[0];
    if (!new RegExp(`^\\s*\\*\\s*@name\\s+${declaration}\\s*$`, "m").test(body)) continue;
    return { body, file, line: lineOf(text, match.index) };
  }
  throw new Error(`${file}: no pinned doc block declares @name ${declaration}`);
}

function note(block, pattern, description) {
  const match = block.body.match(pattern);
  assert(match, `${block.file}:${block.line}: pinned ${description} note is missing`);
  return match;
}

function vmathLayout(text, file, declaration, transport) {
  const block = docBlock(text, file, declaration);
  const alignment = Number.parseInt(
    note(block, /^\s*\*\s*@note\s+(\d+) byte aligned\s*$/m, "alignment")[1], 10);
  const tuple = block.body.match(/^\/\*#\s*(\d+)-tuple/m);
  const matrix = block.body.match(/^\/\*#\s*(\d+)x(\d+) matrix/m);
  assert(tuple || matrix, `${file}: ${declaration} declares neither a tuple nor a matrix arity`);
  if (tuple) {
    const storage = Number.parseInt(
      note(block, /^\s*\*\s*@note\s+Always size of (\d+) float32\s*$/m, "storage")[1], 10);
    const lanes = Number.parseInt(tuple[1], 10);
    assert(lanes <= storage, `${file}: ${declaration} declares more lanes than storage`);
    return {
      transport,
      element: "f32",
      semanticLanes: lanes,
      storageElements: storage,
      byteSize: storage * 4,
      alignment,
      ordering: "lane-order",
      evidence: { file, line: block.line, declaration }
    };
  }
  const rows = Number.parseInt(matrix[1], 10);
  const columns = Number.parseInt(matrix[2], 10);
  const composition = note(block,
    /^\s*\*\s*@note\s+Implemented as (\d+) x (Vector\d)\s*$/m, "composition");
  const columnCount = Number.parseInt(composition[1], 10);
  assert(columnCount === columns, `${file}: ${declaration} column count disagrees with its arity`);
  const column = vmathLayout(text, file, composition[2], "float-lanes");
  note(block, /^\s*\*\s*@note\s+Column major\s*$/m, "ordering");
  const storage = columnCount * column.storageElements;
  return {
    transport,
    element: "f32",
    semanticLanes: rows * columns,
    storageElements: storage,
    byteSize: storage * 4,
    alignment,
    ordering: "column-major",
    composedOf: { count: columnCount, declaration: composition[2] },
    evidence: { file, line: block.line, declaration }
  };
}

const fixedWidthBytes = Object.freeze({ uint64_t: 8, int64_t: 8, uint32_t: 4, int32_t: 4 });

/** Resolve a C typedef chain inside one pinned header down to a fixed-width type. */
function resolveScalar(sources, file, name, seen = new Set()) {
  if (fixedWidthBytes[name] !== undefined) {
    return { element: name, byteSize: fixedWidthBytes[name], chain: [...seen] };
  }
  assert(!seen.has(name), `${file}: typedef chain for ${name} is cyclic`);
  seen.add(name);
  for (const [alias, text] of Object.entries(sources)) {
    const match = text.match(new RegExp(`^\\s*typedef\\s+([A-Za-z_][A-Za-z0-9_]*)\\s+${name};`, "m"));
    if (!match) continue;
    const resolved = resolveScalar(sources, alias, match[1], seen);
    return { ...resolved, chain: [`${name}=${match[1]}`, ...resolved.chain.filter((entry) => entry !== name)] };
  }
  throw new Error(`${file}: no pinned typedef resolves ${name} to a fixed-width integer`);
}

function scalarLayout(sources, file, declaration, transport) {
  const resolved = resolveScalar(sources, file, declaration);
  return {
    transport,
    element: resolved.element,
    semanticLanes: 1,
    storageElements: 1,
    byteSize: resolved.byteSize,
    alignment: resolved.byteSize,
    ordering: "scalar",
    typedefChain: resolved.chain,
    evidence: { file, declaration }
  };
}

function structLayout(sources, file, declaration, transport) {
  const text = sources[file];
  const match = text.match(new RegExp(`\\n\\s*struct\\s+${declaration}\\s*\\n\\s*\\{([^]*?)\\n\\s*\\};`));
  assert(match, `${file}: no pinned struct ${declaration} is declared`);
  const fields = [];
  for (const line of match[1].split("\n")) {
    const field = line.match(/^\s{4,}([A-Za-z_][A-Za-z0-9_]*)\s+([A-Za-z_][A-Za-z0-9_]*)\s*;/);
    if (!field) continue;
    const resolved = resolveScalar(sources, file, field[1]);
    fields.push({ name: field[2], declared: field[1], element: resolved.element, byteSize: resolved.byteSize });
  }
  assert(fields.length > 0, `${file}: struct ${declaration} exposes no fixed-width fields`);
  const element = fields[0].element;
  assert(fields.every((field) => field.element === element),
    `${file}: struct ${declaration} mixes element widths and needs an explicit lowering`);
  const byteSize = fields.reduce((total, field) => total + field.byteSize, 0);
  return {
    transport,
    element,
    semanticLanes: fields.length,
    storageElements: fields.length,
    byteSize,
    alignment: fields[0].byteSize,
    ordering: "declaration-order",
    fields: fields.map(({ name, declared }) => ({ name, declared })),
    evidence: { file, declaration, line: lineOf(text, match.index) }
  };
}

const transportBuilders = Object.freeze({
  "float-lanes": (sources, entry) => vmathLayout(sources[entry.source], entry.source, entry.declaration, entry.transport),
  "float-arena": (sources, entry) => vmathLayout(sources[entry.source], entry.source, entry.declaration, entry.transport),
  "u64-scalar": (sources, entry) => scalarLayout(sources, entry.source, entry.declaration, entry.transport),
  "u64-lane-quad": (sources, entry) => structLayout(sources, entry.source, entry.declaration, entry.transport)
});

export function generateDefoldValueLayouts({ projection, policy, sources, sourcePaths }) {
  assert(policy.schemaVersion === 1, "Unsupported Defold value layout policy schema");
  const names = [...collectDefoldValueNames(projection.rows.map((row) => row.signature))].sort(compare);
  const classified = new Set([...Object.keys(policy.transparent), ...Object.keys(policy.opaque)]);
  const unclassified = names.filter((name) => !classified.has(name));
  const unreachable = [...classified].filter((name) => !names.includes(name)).sort(compare);

  const transparent = {};
  for (const name of Object.keys(policy.transparent).sort(compare)) {
    const entry = policy.transparent[name];
    assert(sources[entry.source] !== undefined, `${name}: unknown pinned source ${entry.source}`);
    const builder = transportBuilders[entry.transport];
    assert(builder, `${name}: unsupported transparent transport ${entry.transport}`);
    const layout = builder(sources, entry);
    layout.evidence = { ...layout.evidence, file: sourcePaths[layout.evidence.file] ?? layout.evidence.file };
    transparent[name] = layout;
  }
  const opaque = {};
  for (const name of Object.keys(policy.opaque).sort(compare)) {
    if (!names.includes(name)) continue;
    const reason = policy.opaque[name];
    assert(policy.opaqueReasons[reason], `${name}: undeclared opaque reason ${reason}`);
    opaque[name] = {
      reason,
      note: policy.opaqueReasons[reason],
      classification: "reviewed",
      proof: "reviewed-semantic-classification",
      fallbackTransport: "script-universal-value"
    };
  }
  for (const name of unclassified) {
    opaque[name] = {
      reason: "source-derived-conservative-fallback",
      note: "This Defold revision documents the value name, but no reviewed fixed-layout or retained-handle specialization exists yet. It remains available through the generated universal value transport and is excluded only from transparent typed-native lowering.",
      classification: "generated",
      proof: "source-derived-name; specialized-layout-unproven",
      fallbackTransport: "script-universal-value",
      alert: "specialized-layout-unproven"
    };
  }

  return {
    schemaVersion: 1,
    defoldRevision: projection.defoldRevision,
    scope: "Fixed-layout Defold script value types derived from the pinned dmSDK headers, reviewed opaque classifications, and generated conservative opaque fallbacks for revision-specific names. Conservative entries remain usable through the universal value transport but are excluded from transparent typed-native lowering until specialized layout evidence exists. Layout only; this is not compile, link, runtime, or conformance evidence.",
    policySha256: sha256(JSON.stringify(policy)),
    sourceSha256: Object.fromEntries(Object.entries(sourcePaths).sort(([left], [right]) => compare(left, right))
      .map(([alias, file]) => [alias, { path: file, sha256: sha256(sources[alias]) }])),
    coverage: {
      projectedValueTypes: names.length,
      transparent: Object.keys(transparent).length,
      opaque: Object.keys(opaque).length,
      reviewedOpaque: Object.values(opaque).filter(({ classification }) => classification === "reviewed").length,
      conservativeOpaque: unclassified.length,
      dormantPolicyEntries: unreachable.length
    },
    alerts: unclassified.map((name) => ({
      code: "specialized-layout-unproven",
      valueType: name,
      severity: "warning",
      fallbackTransport: "script-universal-value",
      effect: "available through the universal transport; excluded from transparent typed-native lowering"
    })),
    dormantPolicyEntries: unreachable,
    transports: {
      "float-lanes": "Copied as exact float32 lanes through the typed frame. No arena and no ownership.",
      "float-arena": "Copied through the caller-owned bounded float arena because the record exceeds the four inline lanes.",
      "u64-scalar": "Copied as an exact 64-bit value split into two uint32 halves; the typed frontend never narrows it to a double.",
      "u64-lane-quad": "Copied as four exact 64-bit lanes through the caller-owned bounded URL arena."
    },
    transparent,
    opaque
  };
}

function renderHeader(report) {
  const constant = (name, value, comment) => `#define ${name} ${value}u${comment ? ` // ${comment}` : ""}`;
  const lines = [];
  for (const [name, layout] of Object.entries(report.transparent)) {
    const token = `DEHERM_DEFOLD_${name.toUpperCase().replaceAll(/[^A-Z0-9]+/g, "_")}`;
    lines.push(`// ${layout.evidence.file}: ${layout.evidence.declaration} (${layout.transport}, ${layout.ordering})`);
    lines.push(constant(`${token}_SEMANTIC_LANES`, layout.semanticLanes));
    lines.push(constant(`${token}_STORAGE_ELEMENTS`, layout.storageElements));
    lines.push(constant(`${token}_BYTES`, layout.byteSize));
    lines.push(constant(`${token}_ALIGNMENT`, layout.alignment));
    lines.push("");
  }
  return `// Generated by scripts/generate-defold-value-layouts.mjs. Do not edit.
// Layout constants derived from the pinned Defold revision ${report.defoldRevision}.
#pragma once

#include <stdint.h>

${lines.join("\n")}#ifdef __cplusplus
static_assert(sizeof(float) * DEHERM_DEFOLD_MATRIX4_STORAGE_ELEMENTS == DEHERM_DEFOLD_MATRIX4_BYTES,
    "Defold Matrix4 storage drifted from the pinned dmVMath layout");
static_assert(sizeof(uint64_t) * DEHERM_DEFOLD_URL_STORAGE_ELEMENTS == DEHERM_DEFOLD_URL_BYTES,
    "Defold URL storage drifted from the pinned dmMessage layout");
#endif
`;
}

async function writeOrCheck(target, content, check) {
  if (check) {
    const current = await readFile(target, "utf8");
    if (current !== content) throw new Error(`${path.relative(repositoryRoot, target)} is stale; regenerate Defold value layouts`);
    return;
  }
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
}

export async function run(argv = process.argv.slice(2)) {
  const options = { check: false, outputRoot: repositoryRoot };
  for (let index = 0; index < argv.length; ++index) {
    if (argv[index] === "--check") options.check = true;
    else if (argv[index] === "--output-root") options.outputRoot = path.resolve(argv[++index] ?? "");
    else throw new Error(`Unknown argument: ${argv[index]}`);
  }
  const [projectionText, policyText] = await Promise.all([
    readFile(path.join(repositoryRoot, relativePaths.projection), "utf8"),
    readFile(path.join(repositoryRoot, relativePaths.policy), "utf8")
  ]);
  const policy = JSON.parse(policyText);
  const sourcePaths = policy.sources;
  const sources = Object.fromEntries(await Promise.all(Object.entries(sourcePaths).map(async ([alias, file]) => [
    alias,
    await readFile(path.join(repositoryRoot, file), "utf8")
  ])));
  const report = generateDefoldValueLayouts({
    projection: JSON.parse(projectionText),
    policy,
    sources,
    sourcePaths
  });
  await writeOrCheck(path.join(options.outputRoot, relativePaths.report), `${JSON.stringify(report, null, 2)}\n`, options.check);
  await writeOrCheck(path.join(options.outputRoot, relativePaths.header), renderHeader(report), options.check);
  process.stdout.write(`${options.check ? "Verified" : "Generated"} ${report.coverage.transparent} transparent and ${report.coverage.opaque} opaque Defold value layouts from ${Object.keys(sourcePaths).length} pinned headers.\n`);
  if (report.coverage.conservativeOpaque > 0) {
    process.stderr.write(`warning: ${report.coverage.conservativeOpaque} revision-specific Defold value type(s) use the generated universal fallback; transparent typed-native layout remains unproven: ${report.alerts.map(({ valueType }) => valueType).join(", ")}\n`);
  }
  return report;
}

if (import.meta.url === `file://${process.argv[1]}`) await run();
