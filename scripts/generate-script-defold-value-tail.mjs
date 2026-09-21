#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { stableBindingId } from "./lib/binding-identity.mjs";
import { declaredDerivation, expectReviewedCount, observeReviewedSource } from "./lib/reviewed-revision.mjs";
import { VOID, recordAudit } from "./lib/revision-audit.mjs";

const root = new URL("../", import.meta.url);
const paths = {
  ir: new URL("packages/bindings/generated/defold-script-api-ir.json", root),
  patterns: new URL("packages/bindings/generated/defold-script-binding-patterns.json", root),
  value: new URL("packages/bindings/generated/defold-script-value-bindings.json", root),
  url: new URL("packages/bindings/generated/defold-script-url-address-classification.json", root),
  policy: new URL("packages/bindings/overrides/script-defold-value-tail-bindings.json", root),
  report: new URL("packages/bindings/generated/defold-script-value-tail-bindings.json", root),
  header: new URL("defold/defold_hermes/include/defold_hermes/generated_script_value_tail_bindings.hpp", root),
  source: new URL("defold/defold_hermes/src/generated_script_value_tail_bindings.cpp", root),
  target: new URL("packages/sdk/src/generated/script/value-tail-target-support.ts", root)
};

const CODECS = new Map([
  ["nil", "Nil"], ["boolean", "Boolean"], ["number", "Number"], ["integer", "Number"],
  ["string", "String"], ["hash", "Hash"], ["url", "Url"], ["vector3", "Vector3"], ["matrix4", "Matrix4"],
  ["image.TYPE", "String"], ["liveupdate.LIVEUPDATE", "Number"]
]);
const CODEC_VALUES = new Set([...CODECS.values(), "None"]);
const EXECUTION_CONTEXTS = new Set([
  "script-instance",
  "gui-script-instance",
  "render-script-instance",
]);
const UINT8_MAX = 0xff;
const UINT16_MAX = 0xffff;
const compare = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const quote = (value) => JSON.stringify(value).replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");
function assert(condition, message) { if (!condition) throw new Error(message); }
function identities(rows, label) {
  assert(Array.isArray(rows), `${label} must be an array`);
  const ids = new Set();
  for (const row of rows) {
    assert(row && typeof row.id === "string" && row.id.length !== 0, `${label} has an invalid identity`);
    assert(!ids.has(row.id), `${label} duplicates identity ${row.id}`);
    ids.add(row.id);
  }
  return ids;
}
function sameIdentitySet(left, right, leftLabel, rightLabel) {
  assert(left.size === right.size && [...left].every((id) => right.has(id)), `${leftLabel} identities do not exactly match ${rightLabel}`);
}
function validateCrossInputProvenance(ir, patterns, value, url, irText, patternsText, valueText, urlText) {
  assert(ir.schemaVersion === 1 && typeof ir.defoldRevision === "string" && ir.defoldRevision.length !== 0 && Array.isArray(ir.functions), "script IR schema is unsupported");
  assert(patterns.schemaVersion === 1 && typeof patterns.defoldRevision === "string" && Array.isArray(patterns.bindings), "script binding-pattern schema is unsupported");
  assert(value.schemaVersion === 1 && typeof value.defoldRevision === "string" && Array.isArray(value.bindings), "script value-binding schema is unsupported");
  assert(url.schemaVersion === 1 && typeof url.defoldRevision === "string" && Array.isArray(url.rows), "script URL-binding schema is unsupported");
  assert(patterns.defoldRevision === ir.defoldRevision && value.defoldRevision === ir.defoldRevision && url.defoldRevision === ir.defoldRevision,
    "script IR, patterns, value bindings, and URL bindings Defold revisions differ");
  assert(patterns.sourceSha256 === sha256(irText), "script binding patterns are stale against script IR");
  assert(url.inputEvidence?.scriptIrSha256 === sha256(irText), "script URL bindings are stale against script IR");
  assert(url.inputEvidence?.bindingPatternsSha256 === sha256(patternsText), "script URL bindings are stale against script binding patterns");
  const irIds = identities(ir.functions, "script IR functions");
  const patternIds = identities(patterns.bindings, "script binding patterns");
  const pendingIrIds = new Set(ir.functions.filter(({ runtimeStatus }) => runtimeStatus === "requires-universal-lua-bridge").map(({ id }) => id));
  sameIdentitySet(patternIds, pendingIrIds, "script binding patterns", "runtime-pending script IR functions");
  const valueIds = identities(value.bindings, "script value bindings");
  const urlIds = identities(url.rows, "script URL bindings");
  assert(value.bindingCount === value.bindings.length, "script value-binding count is stale");
  assert(url.routeCount === url.rows.length, "script URL-binding count is stale");
  for (const id of valueIds) assert(patternIds.has(id), `${id}: script value binding is not runtime-pending`);
  for (const id of urlIds) assert(patternIds.has(id) && !valueIds.has(id), `${id}: script URL binding is missing or overlaps value bindings`);
  assert(patterns.pendingFunctionCount === patterns.bindings.length && patterns.classifiedFunctionCount === patterns.bindings.length,
    "script binding-pattern count differs from its unique binding identities");
  assert(sha256(valueText) !== sha256(urlText), "script value and URL binding evidence unexpectedly aliases");
}

function splitUnion(type) { return type.split("|").map((part) => part.trim()).filter(Boolean); }
function codecForType(type, id) {
  if (CODECS.has(type)) return CODECS.get(type);
  throw new Error(`${id}: exact tail codec is not reviewed for ${type}`);
}
function callShapes(fn) {
  let required = fn.parameters.length;
  while (required > 0 && fn.parameters[required - 1].optional) --required;
  const result = [];
  for (let count = required; count <= fn.parameters.length; ++count) {
    const alternatives = fn.parameters.slice(0, count).map(({ rawType }) => splitUnion(rawType).map((type) => codecForType(type, fn.id)));
    let rows = [[]];
    for (const choices of alternatives) rows = rows.flatMap((row) => choices.map((choice) => [...row, choice]));
    result.push(...rows);
  }
  return [...new Map(result.map((shape) => [JSON.stringify(shape), shape])).values()];
}
function resultCodec(fn) {
  assert(fn.returns.length <= 1, `${fn.id}: tail candidate has multiple results`);
  return fn.returns.length === 0 ? "None" : codecForType(fn.returns[0], fn.id);
}
function tableRegistration(source, member) {
  const match = source.match(new RegExp(`\\{\\s*"${member}"\\s*,\\s*([A-Za-z_][A-Za-z0-9_:]*)\\s*\\}`));
  return match && { symbol: match[1], anchor: match[0] };
}
function globalRegistration(source, member) {
  const expression = new RegExp(`lua_pushcfunction\\(L,\\s*([A-Za-z_][A-Za-z0-9_]*)\\s*\\);\\s*lua_setglobal\\(L,\\s*"${member}"\\s*\\)`, "m");
  const match = source.match(expression);
  return match && { symbol: match[1], anchor: match[0] };
}
function registration(source, member, kind) {
  const value = kind === "lua-global" ? globalRegistration(source, member) : tableRegistration(source, member);
  assert(value, `${member}: pinned ${kind ?? "lua-table"} registration is stale`);
  return value;
}

function escapeRegExp(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function enumResultDomain(policy, sourceByKey, sourceTexts, id) {
  if (!policy) return { names: [], values: [] };
  const enumSource = sourceByKey.get(policy.source);
  const exportSource = sourceByKey.get(policy.exportSource);
  assert(enumSource && exportSource, `${id}: named result-domain source is missing`);
  const enumText = sourceTexts.get(enumSource.path);
  const exportText = sourceTexts.get(exportSource.path);
  const enumMatch = enumText.match(new RegExp(`\\benum\\s+${escapeRegExp(policy.enumName)}\\s*\\{([\\s\\S]*?)\\}`));
  assert(enumMatch, `${id}: named result enum ${policy.enumName} is missing`);
  const valuesByName = new Map();
  const constant = new RegExp(`\\b${escapeRegExp(policy.constantPrefix)}([A-Z0-9_]+)\\s*=\\s*(-?[0-9]+)\\s*,?`, "g");
  for (const match of enumMatch[1].matchAll(constant)) valuesByName.set(match[1], Number(match[2]));
  assert(valuesByName.size > 0, `${id}: named result enum has no explicit integer constants`);
  const exported = [...exportText.matchAll(new RegExp(`\\b${escapeRegExp(policy.exportMacro)}\\(([A-Z0-9_]+)\\)`, "g"))]
    .map((match) => match[1])
    .filter((name) => !name.startsWith("_"));
  assert(exported.length > 0 && new Set(exported).size === exported.length,
    `${id}: exported named result domain is empty or duplicated`);
  assert(exported.length === valuesByName.size && exported.every((name) => valuesByName.has(name)),
    `${id}: exported named result domain differs from ${policy.enumName}`);
  const values = exported.map((name) => {
    assert(valuesByName.has(name), `${id}: exported result ${name} is absent from ${policy.enumName}`);
    return valuesByName.get(name);
  });
  assert(new Set(values).size === values.length, `${id}: named result domain aliases integer values`);
  return { names: exported.map((name) => `${policy.constantPrefix}${name}`), values };
}

function renderRuntime(rows) {
  const candidates = rows.filter(({ disposition }) => disposition === "candidate");
  const shapes = candidates.flatMap(({ callShapes }) => callShapes);
  const routeOffsets = [0];
  for (const row of candidates) routeOffsets.push(routeOffsets.at(-1) + row.callShapes.length);
  const argumentOffsets = [0];
  for (const shape of shapes) argumentOffsets.push(argumentOffsets.at(-1) + shape.length);
  const resultDomainValues = rows.flatMap((row) => row.resultDomain?.values ?? []);
  const resultDomainOffsets = new Map();
  let resultDomainOffset = 0;
  for (const row of rows) {
    resultDomainOffsets.set(row.id, resultDomainOffset);
    resultDomainOffset += row.resultDomain?.values.length ?? 0;
  }
  assert(rows.length <= UINT16_MAX && candidates.length <= UINT16_MAX && shapes.length <= UINT16_MAX, "value-tail descriptor table exceeds uint16_t capacity");
  assert(routeOffsets.every((value) => value <= UINT16_MAX) && argumentOffsets.every((value) => value <= UINT16_MAX), "value-tail descriptor offset exceeds uint16_t capacity");
  assert(shapes.every((shape) => shape.length <= UINT8_MAX), "value-tail call shape exceeds uint8_t argument capacity");
  assert(resultDomainValues.length <= UINT16_MAX && rows.every((row) => (row.resultDomain?.values.length ?? 0) <= UINT8_MAX),
    "value-tail result domain exceeds generated descriptor capacity");
  const candidateIndex = new Map(candidates.map((row, index) => [row.id, index]));
  const headerBase = `// Generated by scripts/generate-script-defold-value-tail.mjs. Do not edit.\n#pragma once\n\n#include <cstddef>\n#include <cstdint>\n#include <defold_hermes/script_bridge_capi.hpp>\n\nnamespace defold_hermes::value_tail {\nenum class DispatchStatus : uint8_t { kMissing, kSuccess, kError };\nenum class Codec : uint8_t { kNil, kBoolean, kNumber, kString, kHash, kUrl, kVector3, kMatrix4, kNone };\nenum class Disposition : uint8_t { kCandidate, kBlocked };\nenum class Context : uint8_t { kGameObject, kGui, kRender };\nstruct Route { uint16_t index; uint16_t candidateIndex; uint32_t stableId; const char* canonicalId; const char* modulePath; const char* member; const char* sourcePath; const char* sourceSymbol; Disposition disposition; Codec resultCodec; Context context; const char* blocker; };\nstruct LuaApi { void* context = nullptr; DispatchStatus (*invoke)(void*, const Route&, ScriptCallFrame*, char*, size_t) noexcept = nullptr; };\ninline constexpr size_t kRouteCount = ${rows.length};\ninline constexpr size_t kCandidateCount = ${candidates.length};\nconst Route* routes() noexcept;\nconst uint16_t* candidateRouteOffsets() noexcept;\nconst uint16_t* shapeArgumentOffsets() noexcept;\nconst uint8_t* shapeArgumentCounts() noexcept;\nconst Codec* argumentCodecs() noexcept;\nconst Route* find(uint32_t stableId) noexcept;\nDispatchStatus dispatch(ScriptCallFrame*, char*, size_t, const LuaApi*) noexcept;\n}  // namespace defold_hermes::value_tail\n`;
  const header = headerBase.replace("const Route* find(uint32_t stableId) noexcept;",
    "const int32_t* resultDomainValues() noexcept;\nconst uint16_t* resultDomainOffsets() noexcept;\nconst uint8_t* resultDomainCounts() noexcept;\nconst Route* find(uint32_t stableId) noexcept;");
  const contextName = (context) => context === "script-instance"
    ? "GameObject" : context === "gui-script-instance" ? "Gui" : "Render";
  const source = `// Generated by scripts/generate-script-defold-value-tail.mjs. Do not edit.\n#include <defold_hermes/generated_script_value_tail_bindings.hpp>\n#include <cstdio>\n\nnamespace defold_hermes::value_tail { namespace {\nconstexpr uint16_t kNoCandidate = UINT16_MAX;\nconstexpr Route kRoutes[] = {\n${rows.map((row, index) => `  {${index}, ${candidateIndex.get(row.id) ?? "kNoCandidate"}, 0x${row.stableId.toString(16).padStart(8, "0")}u, ${quote(row.id)}, ${quote(row.modulePath.join("."))}, ${quote(row.member)}, ${quote(`upstream/defold/${row.sourcePath}`)}, ${quote(row.sourceSymbol)}, Disposition::k${row.disposition === "candidate" ? "Candidate" : "Blocked"}, Codec::k${row.resultCodec}, Context::k${contextName(row.requiredContext)}, ${row.blocker ? quote(row.blocker) : "nullptr"}},`).join("\n")}\n};\nconstexpr uint16_t kCandidateRouteOffsets[] = { ${routeOffsets.join(", ")} };\nconstexpr uint16_t kShapeArgumentOffsets[] = { ${argumentOffsets.join(", ")} };\nconstexpr uint8_t kShapeArgumentCounts[] = { ${shapes.map((shape) => shape.length).join(", ")} };\nconstexpr Codec kArgumentCodecs[] = { ${shapes.flat().map((codec) => `Codec::k${codec}`).join(", ")} };\nstatic_assert(kCandidateRouteOffsets[kCandidateCount] == sizeof(kShapeArgumentCounts) / sizeof(kShapeArgumentCounts[0]), "candidate shape offsets drifted");\nstatic_assert(kShapeArgumentOffsets[kCandidateRouteOffsets[kCandidateCount]] == sizeof(kArgumentCodecs) / sizeof(kArgumentCodecs[0]), "shape argument offsets drifted");\nvoid fail(char* error, size_t capacity, const char* message) noexcept { if (error && capacity) std::snprintf(error, capacity, "%s", message); }\nbool matches(Codec codec, const ScriptValue& value) noexcept {\n  if (codec == Codec::kNil) return value.tag == ScriptValueTag::kUndefined || value.tag == ScriptValueTag::kNull;\n  if (codec == Codec::kBoolean) return value.tag == ScriptValueTag::kBoolean;\n  if (codec == Codec::kNumber) return value.tag == ScriptValueTag::kNumber;\n  if (codec == Codec::kString) return value.tag == ScriptValueTag::kString && (!value.length || value.data);\n  if (codec == Codec::kHash) return value.tag == ScriptValueTag::kHandle && value.handleKind == ScriptHandleKind::kHash;\n  if (codec == Codec::kUrl) return value.tag == ScriptValueTag::kHandle && value.handleKind == ScriptHandleKind::kUrl;\n  if (value.tag != ScriptValueTag::kDefoldValue) return false;\n  return codec == Codec::kVector3 ? value.defoldKind == ScriptDefoldValueKind::kVector3 : value.defoldKind == ScriptDefoldValueKind::kMatrix4;\n}\nbool validShape(const Route& route, const ScriptCallFrame& frame) noexcept {\n  if (route.disposition != Disposition::kCandidate || route.candidateIndex >= kCandidateCount) return false;\n  for (size_t shape = kCandidateRouteOffsets[route.candidateIndex]; shape < kCandidateRouteOffsets[route.candidateIndex + 1]; ++shape) {\n    if (kShapeArgumentCounts[shape] != frame.argumentCount) continue;\n    bool valid = true; const size_t offset = kShapeArgumentOffsets[shape];\n    for (size_t index = 0; index < frame.argumentCount; ++index) valid = valid && matches(kArgumentCodecs[offset + index], frame.arguments[index]);\n    if (valid) return true;\n  }\n  return false;\n}\nbool validResult(const Route& route, const ScriptCallFrame& frame) noexcept {\n  if (route.resultCodec == Codec::kNone) return frame.resultCount == 0;\n  return frame.resultCount == 1 && frame.results && matches(route.resultCodec, frame.results[0]);\n}\n}  // namespace\nconst Route* find(uint32_t stableId) noexcept { size_t first=0,count=kRouteCount; while(count){const size_t step=count/2,index=first+step;if(kRoutes[index].stableId<stableId){first=index+1;count-=step+1;}else count=step;} return first<kRouteCount&&kRoutes[first].stableId==stableId?&kRoutes[first]:nullptr; }\nDispatchStatus dispatch(ScriptCallFrame* frame, char* error, size_t capacity, const LuaApi* api) noexcept {\n  if (!frame) { fail(error, capacity, "Defold value-tail call frame is null"); return DispatchStatus::kError; }\n  const Route* route = find(frame->stableId); if (!route) return DispatchStatus::kMissing; frame->resultCount = 0;\n  if (route->disposition == Disposition::kBlocked) { fail(error, capacity, route->blocker); return DispatchStatus::kError; }\n  if ((frame->argumentCount && !frame->arguments) || !validShape(*route, *frame)) { fail(error, capacity, "Defold value-tail arguments do not match a reviewed exact codec shape"); return DispatchStatus::kError; }\n  if (!api || !api->invoke) { fail(error, capacity, "Defold value-tail captured Lua backend is unavailable"); return DispatchStatus::kError; }\n  const DispatchStatus status = api->invoke(api->context, *route, frame, error, capacity);\n  if (status != DispatchStatus::kSuccess) { frame->resultCount = 0; return status == DispatchStatus::kMissing ? DispatchStatus::kError : status; }\n  if (!validResult(*route, *frame)) { frame->resultCount = 0; fail(error, capacity, "Defold value-tail Lua result does not match the reviewed codec"); return DispatchStatus::kError; }\n  return DispatchStatus::kSuccess;\n}\n}  // namespace defold_hermes::value_tail\n`;
  const sourceWithDomains = source.replace(
    "constexpr uint16_t kCandidateRouteOffsets[]",
    `constexpr int32_t kResultDomainValues[] = { ${resultDomainValues.join(", ")} };\nconstexpr uint16_t kResultDomainOffsets[] = { ${rows.map((row) => resultDomainOffsets.get(row.id)).join(", ")} };\nconstexpr uint8_t kResultDomainCounts[] = { ${rows.map((row) => row.resultDomain?.values.length ?? 0).join(", ")} };\nconstexpr uint16_t kCandidateRouteOffsets[]`).replace(
    "  return frame.resultCount == 1 && frame.results && matches(route.resultCodec, frame.results[0]);",
    `  if (frame.resultCount != 1 || !frame.results || !matches(route.resultCodec, frame.results[0])) return false;\n  const uint8_t domainCount = kResultDomainCounts[route.index];\n  if (!domainCount) return true;\n  const double value = frame.results[0].number;\n  const uint16_t domainOffset = kResultDomainOffsets[route.index];\n  for (uint8_t index = 0; index < domainCount; ++index) {\n    if (value == static_cast<double>(kResultDomainValues[domainOffset + index])) return true;\n  }\n  return false;`);
  const sourceWithAccessors = sourceWithDomains.replace(
    "constexpr uint16_t kNoCandidate = UINT16_MAX;",
    "[[maybe_unused]] constexpr uint16_t kNoCandidate = UINT16_MAX;").replace(
    "}  // namespace\nconst Route* find",
    "}  // namespace\nconst Route* routes() noexcept { return kRoutes; }\nconst uint16_t* candidateRouteOffsets() noexcept { return kCandidateRouteOffsets; }\nconst uint16_t* shapeArgumentOffsets() noexcept { return kShapeArgumentOffsets; }\nconst uint8_t* shapeArgumentCounts() noexcept { return kShapeArgumentCounts; }\nconst Codec* argumentCodecs() noexcept { return kArgumentCodecs; }\nconst int32_t* resultDomainValues() noexcept { return kResultDomainValues; }\nconst uint16_t* resultDomainOffsets() noexcept { return kResultDomainOffsets; }\nconst uint8_t* resultDomainCounts() noexcept { return kResultDomainCounts; }\nconst Route* find");
  return { header, source: sourceWithAccessors };
}

export function generateScriptDefoldValueTail(inputs) {
  const ir = JSON.parse(inputs.irText); const patterns = JSON.parse(inputs.patternsText);
  const value = JSON.parse(inputs.valueText); const url = JSON.parse(inputs.urlText); const policy = JSON.parse(inputs.policyText);
  validateCrossInputProvenance(ir, patterns, value, url, inputs.irText, inputs.patternsText, inputs.valueText, inputs.urlText);
  assert(policy.schemaVersion === 1 && Array.isArray(policy.sources) && Array.isArray(policy.families), "value-tail policy schema is unsupported");
  assert(same(policy.codecVocabulary, ["Nil", "Boolean", "Number", "String", "Hash", "Url", "Vector3", "Matrix4", "None"]), "value-tail codec vocabulary drifted");
  const sourceByKey = new Map();
  for (const source of policy.sources) {
    assert(!sourceByKey.has(source.key) && inputs.sourceTexts.has(source.path), `${source.path}: value-tail source is missing or duplicated`);
    // OBSERVED, not asserted. A pinned hash only detects that Defold edited its
    // own source, which across a release is expected and is the input to this
    // generator rather than a failure of it. A moved file becomes an audit line
    // and a restated pin for this revision. What actually checks this policy
    // against the revision being generated is the census below, which is read
    // from that revision's IR.
    observeReviewedSource({
      input: "packages/bindings/overrides/script-defold-value-tail-bindings.json",
      id: `${source.path}: value-tail`, source: inputs.sourceTexts.get(source.path), evidence: source
    });
    sourceByKey.set(source.key, source);
  }
  const patternRows = patterns.bindings.filter(({ loweringFamily }) => loweringFamily === "defold-value");
  const alreadyOwned = new Set([...value.bindings, ...url.rows].map(({ id }) => id));
  const tailPatterns = patternRows.filter(({ id }) => !alreadyOwned.has(id));
  expectReviewedCount({
    input: "packages/bindings/overrides/script-defold-value-tail-bindings.json",
    label: "value-tail pattern census",
    expected: policy.expectedRouteCount, observed: tailPatterns.length
  });
  const fnById = new Map(ir.functions.map((fn) => [fn.id, fn])); const patternById = new Map(tailPatterns.map((row) => [row.id, row]));
  const seen = new Set(); const rows = [];
  for (const family of policy.families) {
    assert(["candidate", "blocked"].includes(family.disposition) && Number.isInteger(family.expectedRouteCount), `${family.id}: invalid value-tail family`);
    assert(EXECUTION_CONTEXTS.has(family.requiredContext), `${family.id}: invalid or missing value-tail execution context`);
    const familyIds = family.sourceRoutes.flatMap(({ ids }) => ids);
    assert(familyIds.length === family.expectedRouteCount && new Set(familyIds).size === familyIds.length, `${family.id}: reviewed route count drifted`);
    for (const group of family.sourceRoutes) {
      const source = sourceByKey.get(group.source); assert(source, `${family.id}: unknown source ${group.source}`);
      const text = inputs.sourceTexts.get(source.path);
      for (const id of group.ids) {
        assert(!seen.has(id), `${id}: value-tail policy duplicates a route`); seen.add(id);
        const fn = fnById.get(id); const pattern = patternById.get(id);
        // A reviewed tail route this revision does not leave in the tail - it
        // went away, or another lane now owns it. Fatal at the reviewed
        // revision; withdrawn and reported in a declared derivation.
        if (!fn || !pattern) {
          assert(declaredDerivation(), `${id}: reviewed value-tail route is no longer the unimplemented defold-value tail`);
          recordAudit({
            input: "packages/bindings/overrides/script-defold-value-tail-bindings.json",
            id, status: VOID, reason: "absent-route", family: family.id
          });
          continue;
        }
        const entry = { id, stableId: stableBindingId(id), modulePath: fn.modulePath, member: fn.member, sourcePath: source.path, disposition: family.disposition, family: family.id, backend: family.backend ?? null, accountingDisposition: family.accountingDisposition ?? "generated-family", requiredContext: family.requiredContext };
        if (family.disposition === "candidate") {
          const found = registration(text, fn.member, group.registration);
          entry.sourceSymbol = found.symbol; entry.sourceAnchor = found.anchor; entry.callShapes = callShapes(fn); entry.resultCodec = resultCodec(fn); entry.blocker = null;
          assert(entry.callShapes.length !== 0 && entry.callShapes.flat().every((codec) => CODEC_VALUES.has(codec)), `${id}: candidate codec shape is invalid`);
          if (family.codecEvidence) entry.codecEvidence = family.codecEvidence;
          if (id === "script:gui.set_texture_data") {
            assert(entry.callShapes.every((shape) => shape[3] === "String"),
              `${id}: pinned Lua source requires a string texture-type codec`);
          }
          if (id === "script:liveupdate.remove_mount") {
            assert(entry.resultCodec === "Number",
              `${id}: pinned Lua source pushes an integer dmLiveUpdate::Result`);
          }
          entry.resultDomain = enumResultDomain(family.resultDomain, sourceByKey, inputs.sourceTexts, id);
          if (entry.resultDomain.values.length === 0) delete entry.resultDomain;
        } else {
          assert(typeof family.blocker === "string" && typeof family.detail === "string", `${id}: blocked route lacks a machine-readable blocker`);
          const found = registration(text, fn.member, group.registration);
          entry.sourceSymbol = found.symbol; entry.sourceAnchor = found.anchor; entry.callShapes = []; entry.resultCodec = "None"; entry.blocker = family.blocker; entry.blockerDetail = family.detail;
        }
        rows.push(entry);
      }
    }
  }
  // The reviewed policy must cover the whole remaining tail. At the reviewed
  // revision a gap is a regression in this tree; deriving another revision it
  // counts the routes that revision added to or removed from the tail.
  expectReviewedCount({
    input: "packages/bindings/overrides/script-defold-value-tail-bindings.json",
    label: "value-tail policy coverage",
    expected: tailPatterns.length, observed: [...patternById].filter(([id]) => seen.has(id)).length
  });
  rows.sort((left, right) => left.stableId - right.stableId || compare(left.id, right.id));
  assert(new Set(rows.map(({ stableId }) => stableId)).size === rows.length, "value-tail stable ID collision");
  const candidates = rows.filter(({ disposition }) => disposition === "candidate");
  expectReviewedCount({
    input: "packages/bindings/overrides/script-defold-value-tail-bindings.json",
    label: "value-tail candidate census",
    expected: policy.expectedCandidateCount, observed: candidates.length
  });
  const report = {
    schemaVersion: 1, defoldRevision: ir.defoldRevision,
    scope: "the complete remaining defold-value tail after the generated native value-binding wave",
    coverageClaim: "The shared native-dynamic ScriptAdapter/JSI router can execute all 26 game-object, GUI-script, and render-script tail routes when the caller supplies the matching captured context, with source-pinned descriptors and exact ABI shape/result validation. The generated real-Lua adapter fixture reaches every descriptor through its required captured instance. Product GUI/render proxy attachment and packaged-engine semantic execution remain unverified.",
    allocationClaim: "Descriptor lookup, cached Lua references, and caller-owned ScriptCallFrame/arena storage avoid C++ heap allocation on the measured warmed path. The zero-allocation observation covers C++ operator new only; Lua, Hermes, and engine-internal allocators are outside that claim.",
    targetSupport: { nativeDynamicHermes: "generated-executable-shared-script-adapter", nativeStaticHermes: "not-integrated-fail-closed", html5BrowserHost: "not-executable-no-provider" },
    inputEvidence: { scriptIrSha256: sha256(inputs.irText), bindingPatternsSha256: sha256(inputs.patternsText), valueBindingsSha256: sha256(inputs.valueText), urlBindingsSha256: sha256(inputs.urlText), reviewedPolicySha256: sha256(inputs.policyText), defoldSources: policy.sources.map(({ path, sha256: hash }) => ({ path: `upstream/defold/${path}`, sha256: hash })).sort((a, b) => compare(a.path, b.path)) },
    routeCount: rows.length, candidateCount: candidates.length, blockedCount: rows.length - candidates.length,
    blockerCounts: Object.fromEntries([...new Set(rows.filter(({ blocker }) => blocker).map(({ blocker }) => blocker))].sort(compare).map((blocker) => [blocker, rows.filter((row) => row.blocker === blocker).length])),
    bindings: rows
  };
  return { report, ...renderRuntime(rows) };
}

export async function loadScriptDefoldValueTailInputs() {
  const [irText, patternsText, valueText, urlText, policyText] = await Promise.all([readFile(paths.ir, "utf8"), readFile(paths.patterns, "utf8"), readFile(paths.value, "utf8"), readFile(paths.url, "utf8"), readFile(paths.policy, "utf8")]);
  const policy = JSON.parse(policyText);
  const sourceTexts = new Map(await Promise.all(policy.sources.map(async ({ path }) => [path, await readFile(new URL(`upstream/defold/${path}`, root), "utf8")])));
  return { irText, patternsText, valueText, urlText, policyText, sourceTexts };
}

function renderTarget(report) {
  const routes = report.bindings.map(({ id, stableId, disposition, family, resultCodec, accountingDisposition, requiredContext, blocker }) => ({ id, stableId: `0x${stableId.toString(16).padStart(8, "0")}`, disposition, family, resultCodec, accountingDisposition, requiredContext, blocker }));
  return `// Generated by scripts/generate-script-defold-value-tail.mjs. Do not edit.\nexport const scriptValueTailRoutes = ${JSON.stringify(routes, null, 2)} as const;\nexport const scriptValueTailTargetSupport = ${JSON.stringify(report.targetSupport, null, 2)} as const;\nexport function assertScriptValueTailTargetSupport(stableId: number, target: string | undefined): void {\n  if (target !== "html5-browser-host") return;\n  if (scriptValueTailRoutes.some((route) => Number(route.stableId) === (stableId >>> 0))) throw new Error("Defold value-tail routes are not executable in the HTML5 browser host");\n}\n`;
}

async function main(argv = process.argv.slice(2)) {
  const check = argv.includes("--check"); assert(argv.length === (check ? 1 : 0), `Unknown argument: ${argv.find((argument) => argument !== "--check")}`);
  const generated = generateScriptDefoldValueTail(await loadScriptDefoldValueTailInputs()); const report = `${JSON.stringify(generated.report, null, 2)}\n`; const target = renderTarget(generated.report);
  const output = [[paths.report, report], [paths.header, generated.header], [paths.source, generated.source], [paths.target, target]];
  if (check) for (const [path, content] of output) assert(await readFile(path, "utf8") === content, `${path.pathname}: generated value-tail output is stale`);
  else await Promise.all(output.map(([path, content]) => writeFile(path, content)));
  console.log(`${check ? "Verified" : "Generated"} ${generated.report.candidateCount}/${generated.report.routeCount} Defold value-tail captured-Lua candidates; ${generated.report.blockedCount} blocked.`);
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) main().catch((error) => { console.error(error.stack ?? error.message); process.exitCode = 1; });
