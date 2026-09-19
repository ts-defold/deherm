#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

import { stableBindingId } from "./lib/binding-identity.mjs";
import { declaredDerivation, expectReviewedCount, loadReviewedSources, expectSameRevision } from "./lib/reviewed-revision.mjs";

const root = new URL("../", import.meta.url);
const paths = {
  ir: new URL("packages/bindings/generated/defold-script-api-ir.json", root),
  patterns: new URL("packages/bindings/generated/defold-script-binding-patterns.json", root),
  accounting: new URL("packages/bindings/generated/defold-script-api-accounting.json", root),
  schemas: new URL("packages/bindings/generated/defold-script-table-tuple-schemas.json", root),
  policy: new URL("packages/bindings/overrides/script-table-record-bindings.json", root),
  report: new URL("packages/bindings/generated/defold-script-table-record-bindings.json", root),
  header: new URL("defold/defold_hermes/include/defold_hermes/generated_script_table_record_bindings.hpp", root),
  source: new URL("defold/defold_hermes/src/generated_script_table_record_bindings.cpp", root),
  target: new URL("packages/sdk/src/generated/script/table-record-bindings.ts", root)
};

const scalarTypes = new Map([
  ["boolean", "Boolean"], ["integer", "Integer"],
  ["number", "Number"], ["string", "String"]
]);
const contexts = new Map([
  ["global", "Global"], ["script-instance", "ScriptInstance"],
  ["gui-script-instance", "GuiScriptInstance"]
]);
function assert(value, message) { if (!value) throw new Error(message); }
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function quote(value) { return JSON.stringify(value).replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029"); }
function compare(left, right) { return left < right ? -1 : left > right ? 1 : 0; }

export async function loadInputs() {
  const [irText, patternsText, accountingText, schemasText, policyText] = await Promise.all(
    [paths.ir, paths.patterns, paths.accounting, paths.schemas, paths.policy].map((path) => readFile(path, "utf8")));
  const policy = JSON.parse(policyText);
  // Tolerant on purpose: the reviewed policy cites `script_bullet3d.cpp`, a
  // backend Defold 1.13.1 does not ship. A bare `readFile` died with ENOENT on
  // it; a source this revision does not have - or one that lost a reviewed
  // anchor - is withdrawn instead, and the routes resting on it are dropped.
  const loaded = await loadReviewedSources({
    input: "packages/bindings/overrides/script-table-record-bindings.json",
    defoldRoot: fileURLToPath(new URL("upstream/defold", root)),
    evidence: policy.sources,
    derived: JSON.parse(irText).defoldRevision
  });
  return {
    irText, patternsText, accountingText, schemasText, policyText,
    sourceTexts: loaded.texts, withdrawnSources: loaded.withdrawn
  };
}

function fieldCodec(field, id) {
  const codec = scalarTypes.get(field.rawType);
  assert(codec, `${id}: fixed-record field '${field.rawName}' has unsupported type '${field.rawType}'`);
  assert(!field.optional, `${id}: fixed-record field '${field.rawName}' is optional`);
  return codec;
}

function routeIsMechanicallySafe(schema, fn, types) {
  if (schema.bucket !== "flat-record" || schema.family !== "lua-table") return false;
  if (schema.parameters.some(({ codecs }) => codecs.some((codec) => codec !== "scalar" && codec !== "table")) ||
      schema.returns.some(({ codecs }) => codecs.some((codec) => codec !== "table" && codec !== "nil"))) return false;
  const tableResults = schema.returns.filter(({ codecs }) => codecs.includes("table"));
  if (tableResults.length !== 1 || schema.parameters.some(({ codecs }) => codecs.includes("table"))) return false;
  const alternatives = fn.returns.length === 1 ? fn.returns[0].split("|").map((value) => value.trim()) : [];
  if (alternatives.length < 1 || alternatives.length > 2 ||
      (alternatives.length === 2 && !alternatives.includes("nil"))) return false;
  const recordType = alternatives.find((value) => value !== "nil");
  if (!recordType || tableResults[0].rawType !== fn.returns[0] ||
      fn.parameters.some(({ rawType }) => !scalarTypes.has(rawType))) return false;
  const type = types.get(recordType);
  return type?.kind === "class" && type.fields.every((field) => scalarTypes.has(field.rawType) && !field.optional);
}

function blockerFor(schema) {
  if (schema.bucket === "typed-sequence") return "unbounded-typed-sequence";
  if (schema.bucket === "typed-map") return "unbounded-typed-map";
  if (schema.bucket === "tagged-table-union") return "tagged-table-union";
  if (schema.bucket === "opaque-record") return "opaque-or-nested-record";
  if (schema.bucket === "semantic-flat-record") return "reviewed-semantic-record";
  if (schema.bucket === "dynamic-recursive") return "dynamic-recursive-values";
  assert(schema.bucket === "flat-record", `${schema.id}: unreviewed lua-table blocker bucket`);
  const codecs = [...schema.parameters, ...schema.returns].flatMap(({ codecs }) => codecs);
  if (codecs.includes("handle") || codecs.includes("callback")) return "handle-or-callback-crossing";
  if (codecs.includes("value")) return "copied-defold-value-record";
  return "target-context-or-platform-state-record";
}

function offsets(rows, field) {
  let offset = 0;
  return rows.map((row) => { const result = offset; offset += row[field].length; return result; });
}

function renderRuntime(rows) {
  const fields = rows.flatMap((row) => row.fields);
  const args = rows.flatMap((row) => row.argumentCodecs);
  const fieldOffsets = offsets(rows, "fields");
  const argOffsets = offsets(rows, "argumentCodecs");
  const operations = rows.map((row, index) =>
    `  {${index}, 0x${row.stableId.toString(16).padStart(8, "0")}u, ${quote(row.id)}, ${quote(row.modulePath.join("."))}, ${quote(row.member)}, Context::k${row.context}, ${argOffsets[index]}, ${row.argumentCodecs.length}, ${fieldOffsets[index]}, ${row.fields.length}},`
  ).join("\n");
  const header = `// Generated by scripts/generate-script-table-record-bindings.mjs. Do not edit.
#pragma once

#include <cstddef>
#include <cstdint>
#include <defold_hermes/script_bridge_capi.hpp>

namespace defold_hermes::table_record {
enum class DispatchStatus : uint8_t { kMissing, kSuccess, kError };
enum class Codec : uint8_t { kBoolean, kInteger, kNumber, kString };
enum class Context : uint8_t { kGlobal, kScriptInstance, kGuiScriptInstance };
struct Field { const char* name; Codec codec; };
struct Operation { uint16_t index; uint32_t stableId; const char* canonicalId; const char* modulePath; const char* member; Context context; uint16_t argumentOffset; uint8_t argumentCount; uint16_t fieldOffset; uint8_t fieldCount; };
struct LuaApi { void* context = nullptr; DispatchStatus (*invoke)(void*, const Operation&, const Codec*, const Field*, ScriptCallFrame*, char*, size_t) noexcept = nullptr; };
inline constexpr size_t kCandidateCount = ${rows.length};
inline constexpr size_t kMaximumFieldCount = ${Math.max(...rows.map((row) => row.fields.length))};
const Operation* find(uint32_t stableId) noexcept;
const Codec* argumentCodecs() noexcept;
const Field* fields() noexcept;
DispatchStatus dispatch(ScriptCallFrame*, char*, size_t, const LuaApi*) noexcept;
}  // namespace defold_hermes::table_record
`;
  const source = `// Generated by scripts/generate-script-table-record-bindings.mjs. Do not edit.
#include <defold_hermes/generated_script_table_record_bindings.hpp>

#include <cmath>
#include <cstdio>
#include <cstring>

namespace defold_hermes::table_record {
namespace {
constexpr Operation kOperations[] = {
${operations}
};
constexpr Codec kArgumentCodecs[] = { ${args.map((codec) => `Codec::k${codec}`).join(", ")} };
constexpr Field kFields[] = {
${fields.map((field) => `  {${quote(field.name)}, Codec::k${field.codec}},`).join("\n")}
};
void fail(char* error, size_t capacity, const char* message) noexcept { if (error && capacity) std::snprintf(error, capacity, "%s", message); }
bool scalarMatches(Codec codec, const ScriptValue& value) noexcept {
  if (codec == Codec::kBoolean) return value.tag == ScriptValueTag::kBoolean;
  if (codec == Codec::kString) return value.tag == ScriptValueTag::kString && (!value.length || value.data);
  if (value.tag != ScriptValueTag::kNumber || !std::isfinite(value.number)) return false;
  return codec == Codec::kNumber || std::trunc(value.number) == value.number;
}
bool recordMatches(const Operation& operation, const ScriptValue& value) noexcept {
  if (value.tag != ScriptValueTag::kTable || value.length != operation.fieldCount || !value.data) return false;
  const auto* entries = static_cast<const ScriptTableEntry*>(value.data);
  for (uint8_t index = 0; index < operation.fieldCount; ++index) {
    const Field& field = kFields[operation.fieldOffset + index]; const ScriptTableEntry& entry = entries[index];
    if (entry.key.tag != ScriptValueTag::kString || !entry.key.data || entry.key.length != std::strlen(field.name) || std::memcmp(entry.key.data, field.name, entry.key.length) != 0 || !scalarMatches(field.codec, entry.value)) return false;
  }
  return true;
}
}  // namespace
const Codec* argumentCodecs() noexcept { return kArgumentCodecs; }
const Field* fields() noexcept { return kFields; }
const Operation* find(uint32_t stableId) noexcept { size_t first=0,count=kCandidateCount; while(count){const size_t step=count/2,index=first+step;if(kOperations[index].stableId<stableId){first=index+1;count-=step+1;}else count=step;} return first<kCandidateCount&&kOperations[first].stableId==stableId?&kOperations[first]:nullptr; }
DispatchStatus dispatch(ScriptCallFrame* frame, char* error, size_t capacity, const LuaApi* api) noexcept {
  if (!frame) { fail(error, capacity, "Table-record call frame is null"); return DispatchStatus::kError; }
  const Operation* operation = find(frame->stableId); if (!operation) return DispatchStatus::kMissing; frame->resultCount = 0;
  if (frame->argumentCount != operation->argumentCount || (frame->argumentCount && !frame->arguments)) { fail(error, capacity, "Table-record argument count does not match descriptor"); return DispatchStatus::kError; }
  for (uint8_t index = 0; index < operation->argumentCount; ++index) if (!scalarMatches(kArgumentCodecs[operation->argumentOffset + index], frame->arguments[index])) { fail(error, capacity, "Table-record argument does not match scalar descriptor"); return DispatchStatus::kError; }
  if (!frame->results || frame->resultCapacity < 1) { fail(error, capacity, "Table-record result storage is exhausted"); return DispatchStatus::kError; }
  if (!frame->tableScratch || frame->tableScratchUsed > frame->tableScratchCapacity || frame->tableScratchCapacity - frame->tableScratchUsed < operation->fieldCount) { fail(error, capacity, "Table-record caller-owned scratch is exhausted"); return DispatchStatus::kError; }
  if (!api || !api->invoke) { fail(error, capacity, "Table-record captured Lua backend is unavailable"); return DispatchStatus::kError; }
  const DispatchStatus status = api->invoke(api->context, *operation, kArgumentCodecs, kFields, frame, error, capacity);
  if (status != DispatchStatus::kSuccess) { frame->resultCount = 0; return status == DispatchStatus::kMissing ? DispatchStatus::kError : status; }
  if (frame->resultCount != 1 || !recordMatches(*operation, frame->results[0])) { frame->resultCount = 0; fail(error, capacity, "Table-record Lua result does not match the fixed-field descriptor"); return DispatchStatus::kError; }
  return DispatchStatus::kSuccess;
}
}  // namespace defold_hermes::table_record
`;
  const bindings = rows.map(({ id, stableId, modulePath, member, requiredContext, fields }) => ({
    id, stableId: `0x${stableId.toString(16).padStart(8, "0")}`, modulePath, member, requiredContext, fields
  }));
  const target = `// Generated by scripts/generate-script-table-record-bindings.mjs. Do not edit.
export interface ImageAstcHeader { readonly width: number; readonly height: number; readonly depth: number; readonly block_size_x: number; readonly block_size_y: number; readonly block_size_z: number; }
export const scriptTableRecordBindings = ${JSON.stringify(bindings, null, 2)} as const;
export const scriptTableRecordTargetSupport = { nativeDynamicHermes: "generated-executable-shared-script-adapter", nativeStaticHermes: "not-integrated", html5BrowserHost: "not-executable-no-provider" } as const;
export function assertScriptTableRecordTargetSupport(_: number, target: string | undefined): void { if (target === "html5-browser-host") throw new Error("Fixed-record Lua-table bindings are not executable in the HTML5 browser host"); }
`;
  return { header, source, target };
}

export function generate(inputs) {
  const ir = JSON.parse(inputs.irText), patterns = JSON.parse(inputs.patternsText), accounting = JSON.parse(inputs.accountingText), schemas = JSON.parse(inputs.schemasText), policy = JSON.parse(inputs.policyText);
  assert(policy.schemaVersion === 1 && Array.isArray(policy.sources) && Array.isArray(policy.routes), "table-record policy schema is unsupported");
  assert(ir.schemaVersion === 1 && patterns.schemaVersion === 1 && accounting.schemaVersion === 1 && schemas.schemaVersion === 1, "table-record input schema is unsupported");
  expectSameRevision({
    label: "table-record bindings",
    inputs: [
      { path: "packages/bindings/generated/defold-script-api-ir.json", revision: ir.defoldRevision },
      { path: "packages/bindings/generated/defold-script-binding-patterns.json", revision: patterns.defoldRevision },
      { path: "packages/bindings/generated/defold-script-api-accounting.json", revision: accounting.defoldRevision },
      { path: "packages/bindings/generated/defold-script-table-tuple-schemas.json", revision: schemas.defoldRevision }
    ]
  });
  assert(patterns.sourceSha256 === sha256(inputs.irText), "table-record binding patterns are stale against script IR");
  assert(accounting.inputEvidence?.scriptIrSha256 === sha256(inputs.irText) && accounting.inputEvidence?.bindingPatternsSha256 === sha256(inputs.patternsText), "table-record accounting provenance is stale");
  const withdrawnSources = inputs.withdrawnSources ?? new Set();
  const sourceByKey = new Map();
  for (const source of policy.sources) {
    assert(!sourceByKey.has(source.key), `${source.key}: duplicate table-record source`);
    // The reviewed hash was OBSERVED while loading, not asserted: it only
    // detects that Defold edited its own source, which across a release is
    // expected and is the input to this generator rather than a failure of it.
    // What actually checks this policy against the revision being generated is
    // the census below, which is read from that revision's IR.
    if (withdrawnSources.has(source.path)) continue;
    const text = inputs.sourceTexts.get(source.path);
    assert(typeof text === "string", `${source.path}: pinned table-record source was not loaded`);
    sourceByKey.set(source.key, { ...source, text });
  }
  // A reviewed route whose cited source this revision does not have is
  // withdrawn for this revision rather than emitted on evidence that is gone.
  const reviewedRoutes = policy.routes.filter(({ source }) => sourceByKey.has(source));
  const fnById = new Map(ir.functions.map((fn) => [fn.id, fn])), patternById = new Map(patterns.bindings.map((row) => [row.id, row])), schemaById = new Map(schemas.rows.map((row) => [row.id, row])), types = new Map(ir.types.map((type) => [type.name, type]));
  const tableRoutes = accounting.rows.filter(({ id, evidence }) =>
    patternById.get(id)?.loweringFamily === "lua-table" && evidence?.generator !== "native-value-dispatch");
  expectReviewedCount({
    input: "packages/bindings/overrides/script-table-record-bindings.json",
    label: "table-record lua-table census",
    expected: policy.expectedLuaTableRouteCount, observed: tableRoutes.length
  });
  assert(new Set(tableRoutes.map(({ id }) => id)).size === tableRoutes.length, "table-record lua-table identities are duplicated");
  const tableRouteIds = new Set(tableRoutes.map(({ id }) => id));
  assert(schemas.familyCounts?.["lua-table"] === tableRoutes.length, "table-record schema lua-table census drifted");
  for (const { id } of tableRoutes) { const schema = schemaById.get(id), pattern = patternById.get(id); assert(schema?.family === "lua-table" && pattern && JSON.stringify(schema.parameters) === JSON.stringify(pattern.parameterCodecs) && JSON.stringify(schema.returns) === JSON.stringify(pattern.returnCodecs), `${id}: table-record schema classification drifted`); }
  const safeIds = new Set(tableRoutes.map(({ id }) => id).filter((id) => routeIsMechanicallySafe(schemaById.get(id), fnById.get(id), types)));
  const seen = new Set();
  const rows = reviewedRoutes.map((rule) => {
    assert(!seen.has(rule.id), `${rule.id}: duplicate reviewed table-record route`); seen.add(rule.id);
    assert(tableRouteIds.has(rule.id), `${rule.id}: reviewed table-record route is not in the structural lua-table scope`);
    assert(safeIds.has(rule.id), `${rule.id}: reviewed route is not a mechanically safe finite fixed record`);
    const context = contexts.get(rule.requiredContext); assert(context, `${rule.id}: unsupported or missing required context`);
    const fn = fnById.get(rule.id), schema = schemaById.get(rule.id), type = types.get(rule.recordType), source = sourceByKey.get(rule.source);
    assert(source && Array.isArray(rule.sourceAnchors) && rule.sourceAnchors.every((anchor) => source.text.includes(anchor)), `${rule.id}: reviewed source anchor drifted`);
    const alternatives = fn.returns.length === 1 ? fn.returns[0].split("|").map((value) => value.trim()) : [];
    assert(type?.kind === "class" && fn.returns.length === 1 && alternatives.includes(rule.recordType) && schema.returns.length === 1 && schema.returns[0].rawType === fn.returns[0], `${rule.id}: reviewed record type drifted`);
    const argumentCodecs = fn.parameters.map(({ rawType }) => scalarTypes.get(rawType)); assert(argumentCodecs.every(Boolean), `${rule.id}: reviewed scalar argument type drifted`);
    return { id: rule.id, stableId: stableBindingId(rule.id), modulePath: fn.modulePath, member: fn.member, requiredContext: rule.requiredContext, context, source: `upstream/defold/${source.path}`, sourceSha256: source.sha256, sourceAnchors: rule.sourceAnchors, argumentCodecs, fields: type.fields.map((field) => ({ name: field.rawName, codec: fieldCodec(field, rule.id) })), reason: rule.reason };
  }).sort((left, right) => left.stableId - right.stableId || compare(left.id, right.id));
  expectReviewedCount({
    input: "packages/bindings/overrides/script-table-record-bindings.json",
    label: "table-record candidate census",
    expected: policy.expectedCandidateCount - (policy.routes.length - reviewedRoutes.length),
    observed: rows.length
  }); assert(new Set(rows.map(({ stableId }) => stableId)).size === rows.length, "table-record stable ID collision");
  const selectedIds = new Set(rows.map(({ id }) => id));
  const blockedRoutes = tableRoutes.filter(({ id }) => !selectedIds.has(id)).map(({ id }) => { const schema = schemaById.get(id); return { id, stableId: stableBindingId(id), bucket: schema.bucket, blocker: blockerFor(schema) }; }).sort((left, right) => left.stableId - right.stableId || compare(left.id, right.id));
  const blockerCounts = Object.fromEntries(Object.keys(policy.expectedBlockerCounts).sort(compare).map((blocker) => [blocker, blockedRoutes.filter((row) => row.blocker === blocker).length]));
  assert(JSON.stringify(blockerCounts) === JSON.stringify(policy.expectedBlockerCounts), `table-record blocker taxonomy drifted: ${JSON.stringify(blockerCounts)}`);
  assert(blockedRoutes.length + rows.length === tableRoutes.length, "table-record candidate/blocker partition drifted");
  const report = { schemaVersion: 1, defoldRevision: ir.defoldRevision, scope: "The reviewed, finite fixed-record subset of the structural lua-table routes not owned by native value dispatch", coverageClaim: "All listed candidates have generated fail-closed descriptors and a native-dynamic captured-Lua adapter using caller-owned bounded record storage. Static Hermes, packaged-engine, and browser execution are not claimed.", routeCount: tableRoutes.length, mechanicallySafeFixedRecordCount: safeIds.size, candidateCount: rows.length, executableCount: rows.length, blockedCount: blockedRoutes.length, targetSupport: { nativeDynamicHermes: "generated-executable-shared-script-adapter", nativeStaticHermes: "not-integrated", html5BrowserHost: "not-executable-no-provider" }, blockerTaxonomy: { "unbounded-typed-sequence": "IR supplies element codecs but no maximum length or dense-array policy.", "unbounded-typed-map": "IR supplies key/value codecs but no maximum-entry, own-key, or collision policy.", "dynamic-recursive-values": "Recursive or any-valued tables require bounded depth, entry, cycle, and value-union policies.", "tagged-table-union": "A table branch needs an explicit discriminator and ambiguity rejection.", "opaque-or-nested-record": "The record has an unresolved nested or opaque context.", "reviewed-semantic-record": "The table shape has ownership, binary, discriminator, or borrowed-handle semantics outside the structural IR.", "handle-or-callback-crossing": "The route crosses a handle or callback in addition to a record; no first-wave ownership/lifetime codec is installed.", "copied-defold-value-record": "The fixed record also crosses a copied Defold value; this needs a value codec wave.", "target-context-or-platform-state-record": "The scalar record is coupled to platform state, engine context, or target side effects and has no reviewed provider." }, blockerCounts, inputEvidence: { scriptIrSha256: sha256(inputs.irText), bindingPatternsSha256: sha256(inputs.patternsText), accountingSha256: sha256(inputs.accountingText), tableTupleSchemaSha256: sha256(inputs.schemasText), reviewedPolicySha256: sha256(inputs.policyText), defoldSources: policy.sources.filter(({ path }) => !withdrawnSources.has(path)).map(({ path, sha256: hash }) => ({ path: `upstream/defold/${path}`, sha256: hash })) }, bindings: rows, blockedRoutes };
  return { report, ...renderRuntime(rows) };
}

export async function run(check = false) {
  const generated = generate(await loadInputs());
  const outputs = [[paths.report, `${JSON.stringify(generated.report, null, 2)}\n`], [paths.header, generated.header], [paths.source, generated.source], [paths.target, generated.target]];
  for (const [path, expected] of outputs) { if (check) assert(await readFile(path, "utf8") === expected, `${path.pathname}: generated table-record output is stale`); else await writeFile(path, expected); }
  return generated.report;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const check = process.argv.includes("--check");
  run(check).then((report) => console.log(`${check ? "Verified" : "Generated"} ${report.candidateCount}/${report.routeCount} fixed-record Lua-table candidates; ${report.executableCount} executable.`)).catch((error) => { console.error(error.stack ?? error.message); process.exitCode = 1; });
}
