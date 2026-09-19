#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { stableBindingId } from "./lib/binding-identity.mjs";
import { observeReviewedSource } from "./lib/reviewed-revision.mjs";

const root = new URL("../", import.meta.url);
const urls = {
  patterns: new URL("packages/bindings/generated/defold-script-binding-patterns.json", root),
  ir: new URL("packages/bindings/generated/defold-script-api-ir.json", root),
  overrides: new URL("packages/bindings/overrides/script-dynamic-value-bindings.json", root),
  report: new URL("packages/bindings/generated/defold-script-dynamic-value-bindings.json", root),
  header: new URL("defold/defold_hermes/include/defold_hermes/generated_script_dynamic_values.hpp", root),
  source: new URL("defold/defold_hermes/src/generated_script_dynamic_values.cpp", root),
  target: new URL("packages/sdk/src/generated/script/dynamic-values.ts", root)
};

function assert(value, message) { if (!value) throw new Error(message); }
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function compare(left, right) { return left < right ? -1 : left > right ? 1 : 0; }
function cpp(value) { return JSON.stringify(value); }
function hex(value) { return `0x${value.toString(16).padStart(8, "0")}`; }
function enumName(value) { return value.split("-").map((part) => part[0].toUpperCase() + part.slice(1)).join(""); }

const anchors = {
  "script:bit.band": /BIT_OP\(bit_band,\s*&=\)/,
  "script:bit.bor": /BIT_OP\(bit_bor,\s*\|=\)/,
  "script:bit.bxor": /BIT_OP\(bit_bxor,\s*\^=\)/,
  "script:socket.skip": /int ret = lua_gettop\(L\) - amount - 1;\s*return ret >= 0 \? ret : 0;/,
  "script:types.is_hash": /\{\s*"is_hash",\s*Types_IsHash\s*\}/,
  "script:types.is_matrix4": /\{\s*"is_matrix4",\s*Types_IsMatrix4\s*\}/,
  "script:types.is_quat": /\{\s*"is_quat",\s*Types_IsQuat\s*\}/,
  "script:types.is_url": /\{\s*"is_url",\s*Types_IsUrl\s*\}/,
  "script:types.is_vector": /\{\s*"is_vector",\s*Types_IsVector\s*\}/,
  "script:types.is_vector3": /\{\s*"is_vector3",\s*Types_IsVector3\s*\}/,
  "script:types.is_vector4": /\{\s*"is_vector4",\s*Types_IsVector4\s*\}/,
  "script:json.decode": /\{\s*"decode",\s*Json_Decode\s*\}/,
  "script:json.encode": /\{\s*"encode",\s*Json_Encode\s*\}/,
  "script:pprint": /int LuaPPrint\(lua_State\* L\)/
};

export async function loadInputs() {
  const [patternsText, irText, overridesText] = await Promise.all([
    readFile(urls.patterns, "utf8"), readFile(urls.ir, "utf8"), readFile(urls.overrides, "utf8")
  ]);
  const overrides = JSON.parse(overridesText);
  const sources = await Promise.all(overrides.sources.map(async (source) => ({
    ...source,
    text: await readFile(new URL(`upstream/defold/${source.path}`, root), "utf8")
  })));
  return { patternsText, irText, overridesText, sources };
}

export function generate(patternsText, irText, overridesText, sources) {
  const patterns = JSON.parse(patternsText);
  const ir = JSON.parse(irText);
  const overrides = JSON.parse(overridesText);
  assert(patterns.schemaVersion === 1, "dynamic-value binding-pattern schema drifted");
  assert(ir.schemaVersion === 1, "dynamic-value script IR schema drifted");
  assert(patterns.defoldRevision === ir.defoldRevision,
    "dynamic-value binding patterns and script IR use different Defold revisions");
  assert(patterns.sourceSha256 === sha256(irText),
    "dynamic-value binding patterns are stale against script IR");
  assert(ir.counts?.functions === ir.functions?.length, "dynamic-value script IR function count is stale");
  assert(patterns.classifiedFunctionCount === patterns.bindings?.length,
    "dynamic-value classified binding count is stale");
  assert(patterns.pendingFunctionCount === patterns.bindings?.length,
    "dynamic-value pending binding count is stale");
  assert(overrides.schemaVersion === 1, "dynamic-value override schema drifted");
  assert(Number.isInteger(overrides.maximumArgumentCount) && overrides.maximumArgumentCount > 0 && overrides.maximumArgumentCount <= 255,
    "dynamic-value maximum argument count must fit the generated descriptor");
  assert(sources.length === overrides.sources.length, "dynamic-value pinned source count drifted");
  const expectedSourceByKey = new Map();
  for (const source of overrides.sources) {
    assert(typeof source.key === "string" && source.key.length > 0, "dynamic-value pinned source has no key");
    assert(!expectedSourceByKey.has(source.key), `${source.key}: duplicate reviewed source`);
    expectedSourceByKey.set(source.key, source);
  }
  const sourceByKey = new Map();
  for (const source of sources) {
    const expected = expectedSourceByKey.get(source.key);
    assert(expected, `${source.key}: unreviewed pinned source`);
    assert(source.path === expected.path && source.sha256 === expected.sha256,
      `${source.key}: pinned source metadata drifted`);
    // OBSERVED, not asserted. A pinned hash only detects that Defold edited its
    // own source, which across a release is expected and is the input to this
    // generator rather than a failure of it. A moved file becomes an audit line
    // and a restated pin for this revision. What actually checks this policy
    // against the revision being generated is the census below, which is read
    // from that revision's IR.
    observeReviewedSource({
      input: "packages/bindings/overrides/script-dynamic-value-bindings.json",
      id: `${source.key}: dynamic-value`, source: source.text, evidence: expected
    });
    assert(!sourceByKey.has(source.key), `${source.key}: duplicate pinned source`);
    sourceByKey.set(source.key, source);
  }
  const irIds = new Set();
  for (const fn of ir.functions) {
    assert(typeof fn.id === "string" && fn.id.length > 0, "dynamic-value script IR contains a function without an id");
    assert(!irIds.has(fn.id), `${fn.id}: duplicate script IR function id`);
    irIds.add(fn.id);
  }
  const patternIds = new Set();
  for (const pattern of patterns.bindings) {
    assert(typeof pattern.id === "string" && pattern.id.length > 0,
      "dynamic-value binding patterns contain a row without an id");
    assert(!patternIds.has(pattern.id), `${pattern.id}: duplicate binding-pattern id`);
    patternIds.add(pattern.id);
  }
  const selected = patterns.bindings.filter((row) => row.loweringFamily === "dynamic-values");
  assert(selected.length === overrides.expectedRouteCount,
    `selected ${selected.length} dynamic-value routes, expected ${overrides.expectedRouteCount}`);
  assert(Object.keys(overrides.routes).length === selected.length, "dynamic-value override coverage drifted");
  const irById = new Map(ir.functions.map((fn) => [fn.id, fn]));
  const rows = selected.map((pattern) => {
    const rule = overrides.routes[pattern.id];
    assert(rule, `${pattern.id}: missing reviewed dynamic-value rule`);
    const fn = irById.get(pattern.id);
    assert(fn, `${pattern.id}: absent from pinned script IR`);
    const source = sourceByKey.get(rule.source);
    assert(source, `${pattern.id}: unknown source key ${rule.source}`);
    assert(anchors[pattern.id]?.test(source.text), `${pattern.id}: pinned implementation anchor drifted`);
    const candidate = rule.strategy !== "blocked";
    if (candidate) {
      assert(Number.isInteger(rule.minimumArguments), `${pattern.id}: executable route needs minimumArguments`);
      assert(["number", "boolean", "variable-values"].includes(rule.resultMode), `${pattern.id}: unknown result mode`);
    } else {
      assert(rule.blocker && rule.detail, `${pattern.id}: blocked route needs a machine blocker and detail`);
    }
    return {
      id: pattern.id,
      stableId: hex(stableBindingId(pattern.id)),
      modulePath: fn.modulePath,
      member: fn.member,
      strategy: rule.strategy,
      generatedFamilyExecutableCandidate: candidate,
      minimumArguments: candidate ? rule.minimumArguments : null,
      maximumArguments: candidate ? overrides.maximumArgumentCount : null,
      resultMode: candidate ? rule.resultMode : null,
      blocker: candidate ? null : rule.blocker,
      blockerDetail: candidate ? null : rule.detail,
      sourceEvidence: { path: source.path, sha256: source.sha256, anchor: anchors[pattern.id].source },
      focusedNativeEvidence: !candidate ? "not-applicable-blocked" : pattern.id.startsWith("script:bit.")
        ? "observed-exact-upstream-bitop-implementation"
        : pattern.id === "script:socket.skip"
          ? "observed-transport-with-source-equivalent-test-function"
          : "observed-transport-with-local-type-identity-stand-ins",
      targetSupport: candidate ? {
        nativeDynamicHermes: "candidate-awaits-shared-router-integration",
        nativeStaticHermes: "planned-generated-adapter",
        html5BrowserHost: "not-executable-no-generated-provider"
      } : {
        nativeDynamicHermes: `blocked-${rule.blocker}`,
        nativeStaticHermes: `blocked-${rule.blocker}`,
        html5BrowserHost: `blocked-${rule.blocker}`
      }
    };
  }).sort((left, right) => Number.parseInt(left.stableId) - Number.parseInt(right.stableId));
  assert(new Set(rows.map(({ stableId }) => stableId)).size === rows.length, "dynamic-value stable ID collision");
  const candidates = rows.filter((row) => row.generatedFamilyExecutableCandidate);
  const blocked = rows.filter((row) => !row.generatedFamilyExecutableCandidate);
  assert(candidates.length === overrides.expectedCandidateCount,
    `classified ${candidates.length} dynamic-value candidates, expected ${overrides.expectedCandidateCount}`);
  const report = {
    schemaVersion: 1,
    defoldRevision: ir.defoldRevision,
    scope: "All routes classified as dynamic-values by the pinned script binding classifier",
    inputEvidence: {
      scriptIrSha256: sha256(irText),
      bindingPatternsSha256: sha256(patternsText),
      reviewedOverridesSha256: sha256(overridesText)
    },
    routeCount: rows.length,
    generatedFamilyCandidateCount: candidates.length,
    blockedCount: blocked.length,
    maximumArgumentCount: overrides.maximumArgumentCount,
    allocationPolicy: "Generated dispatch uses sorted static descriptors and caller-owned ScriptCallFrame storage. The exact Lua backend must cache function references and use fixed-capacity stack/scratch; there is no heap fallback in generated glue.",
    evidencePolicy: "Source hashes and implementation anchors prove what was reviewed. Focused native tests prove the generated ABI and compile Defold's exact Lua BitOp implementation; socket.skip uses a source-equivalent local C function and types.* use local type-identity stand-ins, so neither is claimed semantically engine-proven. No route enters global executable accounting until the shared ScriptAdapter/JSI router is integrated, and no packaged-engine or browser execution is claimed.",
    blockerCounts: Object.fromEntries([...new Set(blocked.map(({ blocker }) => blocker))].sort(compare)
      .map((blocker) => [blocker, blocked.filter((row) => row.blocker === blocker).length])),
    bindings: rows
  };

  const descriptorRows = candidates.map((row, index) => ({ ...row, index }));
  const executable = candidates;
  const header = `// Generated by scripts/generate-script-dynamic-values.mjs. Do not edit.\n#pragma once\n\n#include <cstddef>\n#include <cstdint>\n#include <defold_hermes/script_bridge_capi.hpp>\n\nnamespace defold_hermes::dynamic_value {\nenum class DispatchStatus : uint8_t { kMissing, kSuccess, kError };\nenum class Strategy : uint8_t { kExactLuaCall, kExactLuaTypeQuery };\nenum class ResultMode : uint8_t { kNumber, kBoolean, kVariableValues };\nstruct Operation { uint16_t index; uint32_t stableId; const char* canonicalId; const char* modulePath; const char* member; Strategy strategy; ResultMode resultMode; uint8_t minimumArguments; uint8_t maximumArguments; };\nstruct LuaApi { void* context = nullptr; DispatchStatus (*invoke)(void*, const Operation&, ScriptCallFrame*, char*, size_t) noexcept = nullptr; };\ninline constexpr size_t kBindingCount = ${executable.length};\ninline constexpr size_t kMaximumArgumentCount = ${overrides.maximumArgumentCount};\nconst Operation* find(uint32_t stableId) noexcept;\nDispatchStatus dispatch(ScriptCallFrame*, char*, size_t, const LuaApi*) noexcept;\n}\n`;
  const source = `// Generated by scripts/generate-script-dynamic-values.mjs. Do not edit.\n#include <defold_hermes/generated_script_dynamic_values.hpp>\n#include <cstdio>\n\nnamespace defold_hermes::dynamic_value { namespace {\nconstexpr Operation kOperations[] = {\n${descriptorRows.map((row) => `  {${row.index}, ${row.stableId}u, ${cpp(row.id)}, ${cpp(row.modulePath.join("."))}, ${cpp(row.member)}, Strategy::k${enumName(row.strategy)}, ResultMode::k${enumName(row.resultMode)}, ${row.minimumArguments}, ${row.maximumArguments}},`).join("\n")}\n};\nvoid fail(char* error, size_t capacity, const char* message) noexcept { if (error && capacity) std::snprintf(error, capacity, "%s", message); }\nbool resultMatches(const Operation& operation, const ScriptCallFrame& frame) noexcept {\n  if (operation.resultMode == ResultMode::kVariableValues) return frame.resultCount <= frame.resultCapacity;\n  if (frame.resultCount != 1 || !frame.results) return false;\n  return operation.resultMode == ResultMode::kNumber ? frame.results[0].tag == ScriptValueTag::kNumber : frame.results[0].tag == ScriptValueTag::kBoolean;\n}\n}\nconst Operation* find(uint32_t stableId) noexcept { size_t first=0,count=kBindingCount; while(count){const size_t step=count/2,index=first+step;if(kOperations[index].stableId<stableId){first=index+1;count-=step+1;}else count=step;} return first<kBindingCount&&kOperations[first].stableId==stableId?&kOperations[first]:nullptr; }\nDispatchStatus dispatch(ScriptCallFrame* frame, char* error, size_t capacity, const LuaApi* api) noexcept {\n  if (!frame) { fail(error,capacity,"Dynamic-value call frame is null"); return DispatchStatus::kError; }\n  const Operation* operation=find(frame->stableId); if(!operation) return DispatchStatus::kMissing; frame->resultCount=0;\n  if(frame->argumentCount<operation->minimumArguments||frame->argumentCount>operation->maximumArguments||(frame->argumentCount&&!frame->arguments)){fail(error,capacity,"Dynamic-value argument count is outside the generated fixed capacity");return DispatchStatus::kError;}\n  if(!frame->results||frame->resultCapacity==0){fail(error,capacity,"Dynamic-value result storage is exhausted");return DispatchStatus::kError;}\n  if(!api||!api->invoke){fail(error,capacity,"Dynamic-value exact Lua backend is unavailable");return DispatchStatus::kError;}\n  const DispatchStatus status=api->invoke(api->context,*operation,frame,error,capacity);\n  if(status!=DispatchStatus::kSuccess){frame->resultCount=0;return status==DispatchStatus::kMissing?DispatchStatus::kError:status;}\n  if(!resultMatches(*operation,*frame)){frame->resultCount=0;fail(error,capacity,"Dynamic-value Lua result does not match the generated result mode");return DispatchStatus::kError;}\n  return DispatchStatus::kSuccess;\n}\n}\n`;
  const target = `// Generated by scripts/generate-script-dynamic-values.mjs. Do not edit.\nexport type DynamicBitOperand = number;\nexport type DynamicSocketValue = unknown;\nexport interface DynamicValueApi {\n  readonly bit: {\n    band(x1: DynamicBitOperand, ...values: readonly DynamicBitOperand[]): number;\n    bor(x1: DynamicBitOperand, ...values: readonly DynamicBitOperand[]): number;\n    bxor(x1: DynamicBitOperand, ...values: readonly DynamicBitOperand[]): number;\n  };\n  readonly socket: { skip(drop: number, ...values: readonly DynamicSocketValue[]): readonly DynamicSocketValue[] };\n  readonly types: {\n    is_hash(value?: unknown): boolean;\n    is_matrix4(value?: unknown): boolean;\n    is_quat(value?: unknown): boolean;\n    is_url(value?: unknown): boolean;\n    is_vector(value?: unknown): boolean;\n    is_vector3(value?: unknown): boolean;\n    is_vector4(value?: unknown): boolean;\n  };\n}\nexport const dynamicValueBindingDescriptors = ${JSON.stringify(candidates.map(({ id, stableId, strategy, resultMode }) => ({ id, stableId, strategy, resultMode })), null, 2)} as const;\nconst unsupportedHtml5Ids: ReadonlySet<string> = new Set(dynamicValueBindingDescriptors.map(({ id }) => id));\nexport function assertDynamicValueTargetSupport(target: string | undefined, canonicalId: string): void {\n  if (target === "html5-browser-host" && unsupportedHtml5Ids.has(canonicalId)) {\n    throw new Error(\`${"${canonicalId}"} is not executable in the HTML5 browser host: no generated dynamic-value provider\`);\n  }\n}\n`;
  return { report: `${JSON.stringify(report, null, 2)}\n`, header, source, target };
}

export async function run(check = false) {
  const inputs = await loadInputs();
  const outputs = generate(inputs.patternsText, inputs.irText, inputs.overridesText, inputs.sources);
  for (const [key, contents] of Object.entries(outputs)) {
    if (check) assert(await readFile(urls[key], "utf8") === contents, `${urls[key].pathname}: generated output is stale`);
    else await writeFile(urls[key], contents);
  }
  return JSON.parse(outputs.report);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  run(process.argv.includes("--check")).then((report) => {
    console.log(`Generated ${report.generatedFamilyCandidateCount}/${report.routeCount} dynamic-value executable-family candidates; ${report.blockedCount} are machine-blocked.`);
  }).catch((error) => { console.error(error.stack ?? error.message); process.exitCode = 1; });
}
