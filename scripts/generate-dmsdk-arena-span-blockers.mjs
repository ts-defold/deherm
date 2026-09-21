#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertReviewedRevision } from "./lib/reviewed-revision.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const paths = Object.freeze({
  ir: "packages/bindings/generated/defold-sdk-ir.json",
  shapes: "packages/bindings/generated/defold-dmsdk-abi-shapes.json",
  symbolEvidence: "packages/bindings/generated/defold-dmsdk-symbol-evidence.json",
  policy: "packages/bindings/overrides/dmsdk-arena-span-blockers.json",
  output: "packages/bindings/generated/defold-dmsdk-arena-span-blockers.json",
});
const artifacts = Object.freeze({
  header: "defold/defold_hermes/include/defold_hermes/generated_dmsdk_arena_cstring.h",
  production: "defold/defold_hermes/src/generated_dmsdk_arena_cstring.cpp",
  exact: "tests/fixtures/generated_dmsdk_arena_cstring_exact.cpp",
});
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const compare = (left, right) => left.localeCompare(right, "en");
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function exactKeys(value, expected, label) {
  assert(object(value), `${label} must be an object`);
  const actual = Object.keys(value).sort(compare);
  assert(JSON.stringify(actual) === JSON.stringify([...expected].sort(compare)), `${label} has unsupported schema keys: ${actual.join(", ")}`);
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
  if (roles.some((role) => role.includes("unknown:") || role.includes("template:"))) return "template-element-layout-or-specialization";
  throw new Error(`${row.id}: arena-span row has no reviewed blocker partition`);
}
function validatePolicy(policy) {
  exactKeys(policy, ["schemaVersion", "policyVersion", "defoldRevision", "tranche", "priorWaveReports", "coveredByPriorWaves", "expectedCoverage", "expectedPartitionSummary", "blockerDefinitions", "cstringArena"], "arena-span policy");
  assert(policy.schemaVersion === 1, "arena-span policy schemaVersion must be 1");
  assert(policy.policyVersion === "arena-span-cstring-v2", "arena-span policyVersion is unsupported");
  assert(/^[0-9a-f]{40}$/.test(policy.defoldRevision), "arena-span policy must pin a Defold revision");
  assert(policy.tranche === "arena-backed-spans", "arena-span policy tranche is unsupported");
  assert(Array.isArray(policy.priorWaveReports) && policy.priorWaveReports.length === 5, "arena-span policy must name five prior waves");
  unique(policy.priorWaveReports, ({ path }) => path, "priorWaveReports");
  unique(policy.coveredByPriorWaves.map((symbol) => ({ symbol })), ({ symbol }) => symbol, "coveredByPriorWaves");
  exactKeys(policy.expectedCoverage, ["arenaSpanCensus", "coveredByPriorWaves", "generatedCStringArena", "blocked"], "expectedCoverage");
  assert(JSON.stringify(Object.keys(policy.expectedPartitionSummary).sort(compare)) === JSON.stringify(Object.keys(policy.blockerDefinitions).sort(compare)), "blocker definitions must exactly match the blocked partition");
  exactKeys(policy.cstringArena, ["maximumInputBytes", "maximumOutputBytes", "selection", "recipes", "contract"], "cstringArena");
  assert(Number.isSafeInteger(policy.cstringArena.maximumInputBytes) && policy.cstringArena.maximumInputBytes > 0, "maximumInputBytes must be positive");
  assert(Number.isSafeInteger(policy.cstringArena.maximumOutputBytes) && policy.cstringArena.maximumOutputBytes > 0, "maximumOutputBytes must be positive");
  unique(policy.cstringArena.recipes, ({ shape }) => shape, "cstringArena recipes");
  for (const recipe of policy.cstringArena.recipes) {
    exactKeys(recipe, ["shape", "kind", "sourceEvidence"], "cstringArena recipe");
    assert(["error-string", "trimmed-string", "canonical-path", "uri-encode"].includes(recipe.kind), `${recipe.shape}: unsupported recipe kind`);
    assert(Array.isArray(recipe.sourceEvidence) && recipe.sourceEvidence.length, `${recipe.shape}: source evidence is required`);
  }
}
function includePath(source) {
  const marker = "/src/dmsdk/";
  const at = source.indexOf(marker);
  assert(at >= 0, `${source}: outside pinned dmSDK include projection`);
  return `dmsdk/${source.slice(at + marker.length)}`;
}
const exactCallee = (entry) => `deherm_dmsdk_arena_exact_callee_${entry.bindingId}`;
const kindConstant = (kind) => ({
  "error-string": "DEHERM_DMSDK_ARENA_CSTRING_ERROR",
  "trimmed-string": "DEHERM_DMSDK_ARENA_CSTRING_TRIM",
  "canonical-path": "DEHERM_DMSDK_ARENA_CSTRING_CANONICAL",
  "uri-encode": "DEHERM_DMSDK_ARENA_CSTRING_URI_ENCODE",
})[kind];

function exactNativeType(value) {
  if (value.role?.startsWith("enum:") && !value.nativeType.includes("::")) {
    return value.role.slice("enum:".length);
  }
  return value.nativeType;
}

function renderHeader(entries, policy) {
  return `// Generated by scripts/generate-dmsdk-arena-span-blockers.mjs. Do not edit.\n#ifndef DEFOLD_HERMES_GENERATED_DMSDK_ARENA_CSTRING_H\n#define DEFOLD_HERMES_GENERATED_DMSDK_ARENA_CSTRING_H\n#include <stdint.h>\n#define DEHERM_DMSDK_ARENA_CSTRING_MAX_INPUT UINT32_C(${policy.cstringArena.maximumInputBytes})\n#define DEHERM_DMSDK_ARENA_CSTRING_MAX_OUTPUT UINT32_C(${policy.cstringArena.maximumOutputBytes})\ntypedef enum DehermDmSdkArenaCStringStatus { DEHERM_DMSDK_ARENA_CSTRING_OK=0, DEHERM_DMSDK_ARENA_CSTRING_UNKNOWN_ID=1, DEHERM_DMSDK_ARENA_CSTRING_NULL_STORAGE=2, DEHERM_DMSDK_ARENA_CSTRING_INPUT_TOO_LARGE=3, DEHERM_DMSDK_ARENA_CSTRING_OUTPUT_TOO_LARGE=4, DEHERM_DMSDK_ARENA_CSTRING_EMBEDDED_NUL=5, DEHERM_DMSDK_ARENA_CSTRING_REENTRANT=6, DEHERM_DMSDK_ARENA_CSTRING_NATIVE_FAILURE=7, DEHERM_DMSDK_ARENA_CSTRING_UNTERMINATED_OUTPUT=8, DEHERM_DMSDK_ARENA_CSTRING_INVALID_SCALAR=9, DEHERM_DMSDK_ARENA_CSTRING_UNEXPECTED_INPUT=10 } DehermDmSdkArenaCStringStatus;\ntypedef enum DehermDmSdkArenaCStringKind { DEHERM_DMSDK_ARENA_CSTRING_ERROR=1, DEHERM_DMSDK_ARENA_CSTRING_TRIM=2, DEHERM_DMSDK_ARENA_CSTRING_CANONICAL=3, DEHERM_DMSDK_ARENA_CSTRING_URI_ENCODE=4 } DehermDmSdkArenaCStringKind;\ntypedef struct DehermDmSdkArenaCStringDescriptor { uint16_t id; uint8_t kind; uint8_t requires_input; const char* declaration_id; } DehermDmSdkArenaCStringDescriptor;\ntypedef struct DehermDmSdkArenaCStringResult { uint64_t native_result; uint32_t output_length; uint32_t required_length; } DehermDmSdkArenaCStringResult;\n#ifdef __cplusplus\nextern \"C\" {\n#endif\nuint32_t deherm_dmsdk_arena_cstring_count(void);\nconst DehermDmSdkArenaCStringDescriptor* deherm_dmsdk_arena_cstring_descriptors(void);\nDehermDmSdkArenaCStringStatus deherm_dmsdk_arena_cstring_dispatch(uint16_t id,const uint8_t* input,uint32_t input_length,uint64_t scalar_argument,char* output,uint32_t output_capacity,DehermDmSdkArenaCStringResult* result);\n#if defined(DEHERM_DMSDK_ARENA_CSTRING_EXACT)\nDehermDmSdkArenaCStringStatus deherm_dmsdk_arena_cstring_exact_dispatch(uint16_t id,const uint8_t* input,uint32_t input_length,uint64_t scalar_argument,char* output,uint32_t output_capacity,DehermDmSdkArenaCStringResult* result);\nuint32_t deherm_dmsdk_arena_cstring_exact_call_count(uint16_t id);\nuint32_t deherm_dmsdk_arena_cstring_exact_failure_count(uint16_t id);\nvoid deherm_dmsdk_arena_cstring_exact_reset(void);\nint deherm_dmsdk_arena_cstring_exact_verify(void);\n#endif\n#ifdef __cplusplus\n}\n#endif\n#endif\n// descriptor-count:${entries.length}\n`;
}
function renderCall(entry, callee) {
  if (entry.recipe.kind === "error-string") return `${callee}(output,static_cast<size_t>(output_capacity),static_cast<int>(static_cast<int32_t>(scalar_argument)));result->native_result=UINT64_C(0);result->required_length=UINT32_C(0);`;
  if (entry.recipe.kind === "trimmed-string") return `const size_t value=${callee}(output,static_cast<size_t>(output_capacity),input);result->native_result=static_cast<uint64_t>(value);result->required_length=static_cast<uint32_t>(value);`;
  if (entry.recipe.kind === "canonical-path") return `const uint32_t value=${callee}(input,output,output_capacity);result->native_result=value;result->required_length=value;`;
  return `uint32_t written=UINT32_C(0);const dmURI::Result value=${callee}(input,output,output_capacity,&written);result->native_result=static_cast<uint64_t>(static_cast<int64_t>(value));result->required_length=written;if(value!=dmURI::RESULT_OK)return DEHERM_DMSDK_ARENA_CSTRING_NATIVE_FAILURE;`;
}
function renderExactFake(entry) {
  const id = entry.bindingId;
  const name = exactCallee(entry);
  const observe = entry.recipe.kind === "error-string" ? `++gCalls[${id}];exactMaybeReenter();` : `++gCalls[${id}];exactMaybeReenter();if(input==nullptr||strcmp(input,${JSON.stringify(`arena_${id}`)})!=0)++gFailures[${id}];`;
  const write = `exactWrite(output,capacity,${JSON.stringify(`result_${id}`)});`;
  if (entry.recipe.kind === "error-string") return `void ${name}(char* output,size_t capacity,int scalar){${observe}if(scalar!=${100 + id})++gFailures[${id}];${write}}`;
  if (entry.recipe.kind === "trimmed-string") return `size_t ${name}(char* output,size_t capacity,const char* input){${observe}${write}return static_cast<size_t>(${500 + id});}`;
  if (entry.recipe.kind === "canonical-path") return `uint32_t ${name}(const char* input,char* output,uint32_t capacity){${observe}${write}return UINT32_C(${500 + id});}`;
  return `dmURI::Result ${name}(const char* input,char* output,uint32_t capacity,uint32_t* written){${observe}${write}if(written)*written=UINT32_C(${`result_${id}`.length + 1});return gForceUriNativeFailure?dmURI::RESULT_TOO_SMALL_BUFFER:dmURI::RESULT_OK;}`;
}
function renderExactDriver(entries) {
  const calls = entries.map((entry) => {
    const id = entry.bindingId;
    const input = entry.recipe.kind === "error-string" ? "nullptr,UINT32_C(0)" : `reinterpret_cast<const uint8_t*>(${JSON.stringify(`arena_${id}`)}),UINT32_C(${`arena_${id}`.length})`;
    const scalar = entry.recipe.kind === "error-string" ? `UINT64_C(${100 + id})` : "UINT64_C(0)";
    const native = entry.recipe.kind === "error-string" || entry.recipe.kind === "uri-encode" ? 0 : 500 + id;
    const required = entry.recipe.kind === "error-string" ? 0
      : entry.recipe.kind === "uri-encode" ? `result_${id}`.length + 1
        : 500 + id;
    return `{char output[64]={};DehermDmSdkArenaCStringResult result{};if(deherm_dmsdk_arena_cstring_exact_dispatch(UINT16_C(${id}),${input},${scalar},output,UINT32_C(64),&result)!=DEHERM_DMSDK_ARENA_CSTRING_OK)return ${10 + id};if(strcmp(output,${JSON.stringify(`result_${id}`)})!=0||result.native_result!=UINT64_C(${native})||result.output_length!=UINT32_C(${`result_${id}`.length})||result.required_length!=UINT32_C(${required})||gCalls[${id}]!=UINT32_C(1)||gFailures[${id}]!=UINT32_C(0))return ${30 + id};}`;
  }).join("\n");
  const first = entries[0];
  const overlap = entries.find(({ recipe }) => recipe.kind !== "error-string");
  const error = entries.find(({ recipe }) => recipe.kind === "error-string");
  const uri = entries.find(({ recipe }) => recipe.kind === "uri-encode");
  const firstInput = first.recipe.kind === "error-string" ? "nullptr,UINT32_C(0)" : `reinterpret_cast<const uint8_t*>(${JSON.stringify("arena_0")}),UINT32_C(7)`;
  const firstScalar = first.recipe.kind === "error-string" ? "UINT64_C(100)" : "UINT64_C(0)";
  const overlapInput = `arena_${overlap.bindingId}`;
  const overlapResult = `result_${overlap.bindingId}`;
  return `${calls}\n{char output[8]={'x'};DehermDmSdkArenaCStringResult result{UINT64_C(9),9,9};const uint8_t embedded[3]={'a',0,'b'};if(deherm_dmsdk_arena_cstring_exact_dispatch(UINT16_C(${first.bindingId}),embedded,UINT32_C(3),${firstScalar},output,UINT32_C(8),&result)!=DEHERM_DMSDK_ARENA_CSTRING_EMBEDDED_NUL||output[0]!='\\0'||result.native_result!=0)return 70;}\n{char output[64]={};DehermDmSdkArenaCStringResult result{};gRequestReentry=true;if(deherm_dmsdk_arena_cstring_exact_dispatch(UINT16_C(${first.bindingId}),${firstInput},${firstScalar},output,UINT32_C(64),&result)!=DEHERM_DMSDK_ARENA_CSTRING_OK||gNestedStatus!=DEHERM_DMSDK_ARENA_CSTRING_REENTRANT)return 71;}\n{char output[1]={'x'};DehermDmSdkArenaCStringResult result{UINT64_C(9),9,9};if(deherm_dmsdk_arena_cstring_exact_dispatch(UINT16_C(${first.bindingId}),${firstInput},${firstScalar},output,UINT32_MAX,&result)!=DEHERM_DMSDK_ARENA_CSTRING_OUTPUT_TOO_LARGE||output[0]!='x'||result.native_result!=0)return 72;}\n{char output[8]={'x'};DehermDmSdkArenaCStringResult result{UINT64_C(9),9,9};const uint8_t unexpected='x';if(deherm_dmsdk_arena_cstring_exact_dispatch(UINT16_C(${error.bindingId}),&unexpected,UINT32_C(1),UINT64_C(${100 + error.bindingId}),output,UINT32_C(8),&result)!=DEHERM_DMSDK_ARENA_CSTRING_UNEXPECTED_INPUT||output[0]!='\\0'||result.native_result!=0)return 73;}\n{char storage[64]=${JSON.stringify(overlapInput)};DehermDmSdkArenaCStringResult result{};if(deherm_dmsdk_arena_cstring_exact_dispatch(UINT16_C(${overlap.bindingId}),reinterpret_cast<const uint8_t*>(storage),UINT32_C(${overlapInput.length}),UINT64_C(0),storage,UINT32_C(64),&result)!=DEHERM_DMSDK_ARENA_CSTRING_OK||strcmp(storage,${JSON.stringify(overlapResult)})!=0)return 74;}\n{char storage[80]={};memcpy(storage+8,${JSON.stringify(overlapInput)},UINT32_C(${overlapInput.length + 1}));DehermDmSdkArenaCStringResult result{};if(deherm_dmsdk_arena_cstring_exact_dispatch(UINT16_C(${overlap.bindingId}),reinterpret_cast<const uint8_t*>(storage+8),UINT32_C(${overlapInput.length}),UINT64_C(0),storage,UINT32_C(64),&result)!=DEHERM_DMSDK_ARENA_CSTRING_OK||strcmp(storage,${JSON.stringify(overlapResult)})!=0)return 75;}\n{char output[64];memset(output,'x',sizeof(output));DehermDmSdkArenaCStringResult result{UINT64_C(9),9,9};gForceUriNativeFailure=true;const auto status=deherm_dmsdk_arena_cstring_exact_dispatch(UINT16_C(${uri.bindingId}),reinterpret_cast<const uint8_t*>(${JSON.stringify(`arena_${uri.bindingId}`)}),UINT32_C(${`arena_${uri.bindingId}`.length}),UINT64_C(0),output,UINT32_C(64),&result);gForceUriNativeFailure=false;if(status!=DEHERM_DMSDK_ARENA_CSTRING_NATIVE_FAILURE||result.native_result!=0||result.output_length!=0||result.required_length!=0)return 76;for(char value:output)if(value!='\\0')return 77;}`;
}
function renderSourceUnfixed(entries, exact) {
  const headers = [...new Set(entries.map(({ candidate }) => includePath(candidate.header)))].sort(compare);
  const descriptorRows = entries.map((entry) => `  {UINT16_C(${entry.bindingId}),UINT8_C(${kindConstant(entry.recipe.kind)}),UINT8_C(${entry.recipe.kind === "error-string" ? 0 : 1}),${JSON.stringify(entry.candidate.id)}}`).join(",\n");
  const signatureAssertions = exact ? "" : entries.map((entry) => {
    const signature = `DehermArenaCStringSignature${entry.bindingId}`;
    const parameters = entry.candidate.parameters.map(exactNativeType).join(", ") || "void";
    return `using ${signature}=${exactNativeType(entry.candidate.result)} (*)(${parameters});[[maybe_unused]] constexpr ${signature} kDehermArenaCStringSignature${entry.bindingId}=static_cast<${signature}>(&${entry.candidate.symbol});`;
  }).join("\n");
  const invokerBodies = entries.map((entry) => `DehermDmSdkArenaCStringStatus invoke_${entry.bindingId}(const char* input,uint64_t scalar_argument,char* output,uint32_t output_capacity,DehermDmSdkArenaCStringResult* result){(void)input;(void)scalar_argument;${renderCall(entry, exact ? exactCallee(entry) : entry.candidate.symbol)}return DEHERM_DMSDK_ARENA_CSTRING_OK;}`).join("\n");
  const invokers = `${exact ? "" : `${signatureAssertions}\n`}${invokerBodies}`;
  const cases = entries.map((entry) => `case ${entry.bindingId}:status=invoke_${entry.bindingId}(native_input,scalar_argument,output,output_capacity,result);break;`).join("");
  const first = entries[0];
  const nestedInput = first.recipe.kind === "error-string" ? "nullptr,UINT32_C(0)" : `reinterpret_cast<const uint8_t*>(${JSON.stringify("arena_0")}),UINT32_C(7)`;
  const nestedScalar = first.recipe.kind === "error-string" ? "UINT64_C(100)" : "UINT64_C(0)";
  const exactState = exact ? `uint32_t gCalls[${entries.length}]{};uint32_t gFailures[${entries.length}]{};bool gRequestReentry=false;bool gForceUriNativeFailure=false;DehermDmSdkArenaCStringStatus gNestedStatus=DEHERM_DMSDK_ARENA_CSTRING_OK;void exactWrite(char* output,size_t capacity,const char* value){if(!output||!capacity)return;const size_t length=strlen(value);const size_t copied=length<capacity-1?length:capacity-1;memcpy(output,value,copied);output[copied]='\\0';}void exactMaybeReenter(){if(!gRequestReentry)return;gRequestReentry=false;char output[32]={};DehermDmSdkArenaCStringResult result{};gNestedStatus=deherm_dmsdk_arena_cstring_exact_dispatch(UINT16_C(${first.bindingId}),${nestedInput},${nestedScalar},output,UINT32_C(32),&result);}\n${entries.map(renderExactFake).join("\n")}\n` : "";
  const exactExports = exact ? `uint32_t deherm_dmsdk_arena_cstring_exact_call_count(uint16_t id){return id<UINT16_C(${entries.length})?gCalls[id]:UINT32_C(0);}\nuint32_t deherm_dmsdk_arena_cstring_exact_failure_count(uint16_t id){return id<UINT16_C(${entries.length})?gFailures[id]:UINT32_C(0);}\nvoid deherm_dmsdk_arena_cstring_exact_reset(void){memset(gCalls,0,sizeof(gCalls));memset(gFailures,0,sizeof(gFailures));gRequestReentry=false;gForceUriNativeFailure=false;gNestedStatus=DEHERM_DMSDK_ARENA_CSTRING_OK;}\nint deherm_dmsdk_arena_cstring_exact_verify(void){deherm_dmsdk_arena_cstring_exact_reset();${renderExactDriver(entries)}return 0;}\n` : "";
  const prefix = exact ? "deherm_dmsdk_arena_cstring_exact" : "deherm_dmsdk_arena_cstring";
  return `// Generated by scripts/generate-dmsdk-arena-span-blockers.mjs. Do not edit.\n${exact ? "#define DEHERM_DMSDK_ARENA_CSTRING_EXACT 1\n" : ""}#include <defold_hermes/generated_dmsdk_arena_cstring.h>\n${headers.map((header) => `#include <${header}>`).join("\n")}\n#include <stddef.h>\n#include <string.h>\nnamespace {\nconst DehermDmSdkArenaCStringDescriptor kDescriptors[]={\n${descriptorRows}\n};\nthread_local char gInput[DEHERM_DMSDK_ARENA_CSTRING_MAX_INPUT+UINT32_C(1)]{};thread_local bool gActive=false;struct Scope{Scope(){gActive=true;}~Scope(){gActive=false;}};\nvoid clearResult(char* output,uint32_t capacity,DehermDmSdkArenaCStringResult* result){if(output&&capacity&&capacity<=DEHERM_DMSDK_ARENA_CSTRING_MAX_OUTPUT)memset(output,0,capacity);if(result)memset(result,0,sizeof(*result));}\nDehermDmSdkArenaCStringStatus fail(DehermDmSdkArenaCStringStatus status,char* output,uint32_t capacity,DehermDmSdkArenaCStringResult* result){clearResult(output,capacity,result);return status;}\nuint32_t boundedLength(const char* value,uint32_t capacity){const void* end=memchr(value,'\\0',capacity);return end?static_cast<uint32_t>(static_cast<const char*>(end)-value):capacity;}bool validI32(uint64_t value){return value==static_cast<uint64_t>(static_cast<int64_t>(static_cast<int32_t>(value)));}\n${exactState}${invokers}\n}\nextern \"C\" {\n${exact ? "" : `uint32_t deherm_dmsdk_arena_cstring_count(void){return UINT32_C(${entries.length});}\nconst DehermDmSdkArenaCStringDescriptor* deherm_dmsdk_arena_cstring_descriptors(void){return kDescriptors;}\n`}DehermDmSdkArenaCStringStatus ${prefix}_dispatch(uint16_t id,const uint8_t* input_bytes,uint32_t input_length,uint64_t scalar_argument,char* output,uint32_t output_capacity,DehermDmSdkArenaCStringResult* result){if(id>=UINT16_C(${entries.length}))return fail(DEHERM_DMSDK_ARENA_CSTRING_UNKNOWN_ID,output,output_capacity,result);if(!output||!result)return fail(DEHERM_DMSDK_ARENA_CSTRING_NULL_STORAGE,output,output_capacity,result);if(!output_capacity||output_capacity>DEHERM_DMSDK_ARENA_CSTRING_MAX_OUTPUT)return fail(DEHERM_DMSDK_ARENA_CSTRING_OUTPUT_TOO_LARGE,output,output_capacity,result);clearResult(output,output_capacity,result);if(gActive)return DEHERM_DMSDK_ARENA_CSTRING_REENTRANT;const bool needs_input=kDescriptors[id].requires_input!=0;if(input_length&&!input_bytes)return DEHERM_DMSDK_ARENA_CSTRING_NULL_STORAGE;if(!needs_input&&input_length)return DEHERM_DMSDK_ARENA_CSTRING_UNEXPECTED_INPUT;if(input_length>DEHERM_DMSDK_ARENA_CSTRING_MAX_INPUT)return DEHERM_DMSDK_ARENA_CSTRING_INPUT_TOO_LARGE;if(input_length&&memchr(input_bytes,'\\0',input_length))return DEHERM_DMSDK_ARENA_CSTRING_EMBEDDED_NUL;if(kDescriptors[id].kind==DEHERM_DMSDK_ARENA_CSTRING_ERROR&&!validI32(scalar_argument))return DEHERM_DMSDK_ARENA_CSTRING_INVALID_SCALAR;const char* native_input=nullptr;if(needs_input){if(input_length)memcpy(gInput,input_bytes,input_length);gInput[input_length]='\\0';native_input=gInput;}Scope scope;DehermDmSdkArenaCStringStatus status=DEHERM_DMSDK_ARENA_CSTRING_UNKNOWN_ID;switch(id){${cases}default:break;}if(status!=DEHERM_DMSDK_ARENA_CSTRING_OK)return fail(status,output,output_capacity,result);const uint32_t length=boundedLength(output,output_capacity);if(length==output_capacity)return fail(DEHERM_DMSDK_ARENA_CSTRING_UNTERMINATED_OUTPUT,output,output_capacity,result);result->output_length=length;return DEHERM_DMSDK_ARENA_CSTRING_OK;}\n${exactExports}}\n`;
}

function renderSource(entries, exact) {
  // Stage validated input before clearing output so the public C ABI supports
  // the in-place and partially overlapping buffers accepted by Defold's
  // string helpers. Every failure after valid result storage still clears the
  // public output deterministically.
  return renderSourceUnfixed(entries, exact)
    .replace(
      ";clearResult(output,output_capacity,result);if(gActive)return DEHERM_DMSDK_ARENA_CSTRING_REENTRANT;",
      ";if(gActive)return fail(DEHERM_DMSDK_ARENA_CSTRING_REENTRANT,output,output_capacity,result);",
    )
    .replace(
      "if(input_length&&!input_bytes)return DEHERM_DMSDK_ARENA_CSTRING_NULL_STORAGE;",
      "if(input_length&&!input_bytes)return fail(DEHERM_DMSDK_ARENA_CSTRING_NULL_STORAGE,output,output_capacity,result);",
    )
    .replace(
      "if(!needs_input&&input_length)return DEHERM_DMSDK_ARENA_CSTRING_UNEXPECTED_INPUT;",
      "if(!needs_input&&input_length)return fail(DEHERM_DMSDK_ARENA_CSTRING_UNEXPECTED_INPUT,output,output_capacity,result);",
    )
    .replace(
      "if(input_length>DEHERM_DMSDK_ARENA_CSTRING_MAX_INPUT)return DEHERM_DMSDK_ARENA_CSTRING_INPUT_TOO_LARGE;",
      "if(input_length>DEHERM_DMSDK_ARENA_CSTRING_MAX_INPUT)return fail(DEHERM_DMSDK_ARENA_CSTRING_INPUT_TOO_LARGE,output,output_capacity,result);",
    )
    .replace(
      "if(input_length&&memchr(input_bytes,'\\0',input_length))return DEHERM_DMSDK_ARENA_CSTRING_EMBEDDED_NUL;",
      "if(input_length&&memchr(input_bytes,'\\0',input_length))return fail(DEHERM_DMSDK_ARENA_CSTRING_EMBEDDED_NUL,output,output_capacity,result);",
    )
    .replace(
      "if(kDescriptors[id].kind==DEHERM_DMSDK_ARENA_CSTRING_ERROR&&!validI32(scalar_argument))return DEHERM_DMSDK_ARENA_CSTRING_INVALID_SCALAR;",
      "if(kDescriptors[id].kind==DEHERM_DMSDK_ARENA_CSTRING_ERROR&&!validI32(scalar_argument))return fail(DEHERM_DMSDK_ARENA_CSTRING_INVALID_SCALAR,output,output_capacity,result);",
    )
    .replace(
      "gInput[input_length]='\\0';native_input=gInput;}Scope scope;",
      "gInput[input_length]='\\0';native_input=gInput;}clearResult(output,output_capacity,result);Scope scope;",
    );
}

export async function loadInputs(root = repositoryRoot) {
  const [irText, shapesText, symbolEvidenceText, policyText] = await Promise.all([readFile(resolve(root, paths.ir), "utf8"), readFile(resolve(root, paths.shapes), "utf8"), readFile(resolve(root, paths.symbolEvidence), "utf8"), readFile(resolve(root, paths.policy), "utf8")]);
  const policy = JSON.parse(policyText);
  validatePolicy(policy);
  const priorWaveTexts = new Map(await Promise.all(policy.priorWaveReports.map(async ({ path }) => [path, await readFile(resolve(root, path), "utf8")])));
  const evidencePaths = [...new Set(policy.cstringArena.recipes.flatMap(({ sourceEvidence }) => sourceEvidence.map(({ path }) => path)))];
  const evidenceTexts = new Map(await Promise.all(evidencePaths.map(async (path) => [path, await readFile(resolve(root, path), "utf8")])));
  return { irText, shapesText, symbolEvidenceText, policyText, priorWaveTexts, evidenceTexts };
}
export function generate(inputs) {
  const ir = JSON.parse(inputs.irText);
  const shapes = JSON.parse(inputs.shapesText);
  const symbolEvidence = JSON.parse(inputs.symbolEvidenceText);
  const policy = JSON.parse(inputs.policyText);
  validatePolicy(policy);
  assert(ir.schemaVersion === 1 && shapes.schemaVersion === 1, "unsupported dmSDK input schemaVersion");
  assert(shapes.defoldRevision === ir.defoldRevision, "arena-span inputs use different Defold revisions");
  assert(symbolEvidence.schemaVersion === 2 && symbolEvidence.defoldRevision === ir.defoldRevision && object(symbolEvidence.declarations), "arena-span symbol evidence is invalid or revision-mismatched");
  assertReviewedRevision({ input: paths.policy, reviewed: policy.defoldRevision, derived: ir.defoldRevision, detail: "the reviewed arena/span cstring tranche" });
  assert(shapes.sourceIr === paths.ir && shapes.sourceHashes?.ir === sha256(inputs.irText), "IR hash does not match ABI-shape census provenance");
  unique(ir.declarations, ({ id }) => id, "dmSDK IR declarations");
  unique(shapes.rows, ({ id }) => id, "dmSDK ABI-shape rows");
  const priorDeclarations = [];
  const priorWaves = [];
  for (const expected of policy.priorWaveReports) {
    const text = inputs.priorWaveTexts.get(expected.path);
    const report = JSON.parse(text);
    assert(report.policyVersion === expected.policyVersion && report.defoldRevision === ir.defoldRevision, `${expected.path}: prior-wave identity drifted`);
    assert(report.sourceHashes?.ir === sha256(inputs.irText), `${expected.path}: IR provenance drifted`);
    assert(report.sourceHashes?.shapes === sha256(inputs.shapesText), `${expected.path}: ABI-shape provenance drifted`);
    for (const declaration of report.declarations) priorDeclarations.push({ ...declaration, sourceReport: expected.path });
    priorWaves.push({ report: expected.path, policyVersion: report.policyVersion, sha256: sha256(text), declarationCount: report.declarations.length });
  }
  const priorIds = unique(priorDeclarations, ({ id }) => id, "combined prior-wave declarations");
  assert(JSON.stringify([...new Set(priorDeclarations.map(({ symbol }) => symbol))].sort(compare)) === JSON.stringify([...policy.coveredByPriorWaves].sort(compare)), "coveredByPriorWaves does not exactly match generated prior-wave symbols");
  const recipes = new Map(policy.cstringArena.recipes.map((recipe) => [recipe.shape, recipe]));
  for (const recipe of recipes.values()) for (const evidence of recipe.sourceEvidence) {
    const source = inputs.evidenceTexts.get(evidence.path);
    assert(source?.split("\n")[evidence.line - 1] === evidence.text, `${evidence.path}:${evidence.line}: cstring arena source evidence drifted`);
  }
  const census = shapes.rows.filter(({ tranche }) => tranche === policy.tranche).sort((a, b) => compare(a.id, b.id));
  const available = census.filter(({ id }) => !priorIds.has(id));
  const selected = available.filter((row) => blockerFor(row) === policy.cstringArena.selection.blocker);
  const entries = selected.map((candidate, bindingId) => {
    const recipe = recipes.get(candidate.shape);
    assert(recipe, `${candidate.id}: mechanically selected cstring arena shape has no recipe`);
    assert(policy.cstringArena.selection.allowedResultRoles.includes(candidate.result.role), `${candidate.id}: result role left policy`);
    assert(candidate.parameters.every(({ role }) => policy.cstringArena.selection.allowedParameterRoles.includes(role)), `${candidate.id}: parameter role left policy`);
    const linkage = symbolEvidence.declarations[candidate.id];
    assert(linkage && linkage.name === candidate.symbol && linkage.header === candidate.header, `${candidate.id}: symbol evidence identity drifted`);
    assert(linkage.linkage === "header-only" || (linkage.linkage === "external" && linkage.availability === "all-targets-all-variants"), `${candidate.id}: native symbol is not available in every target and build variant`);
    return { bindingId, candidate, recipe, linkage };
  });
  assert(new Set(entries.map(({ recipe }) => recipe.shape)).size === recipes.size, "cstring arena policy contains an unused recipe");
  const selectedIds = new Set(entries.map(({ candidate }) => candidate.id));
  const declarations = available.filter(({ id }) => !selectedIds.has(id)).map((row) => {
    const blocker = blockerFor(row);
    assert(policy.blockerDefinitions[blocker], `${row.id}: blocker lacks a definition`);
    return { ...row, disposition: "blocked", blocker, blockerReason: policy.blockerDefinitions[blocker], stages: { generated: "not-applicable", compiled: "not-claimed", linked: "not-claimed", runtime: "not-claimed", allocation: "not-claimed" } };
  });
  const partitionSummary = Object.fromEntries(Object.keys(policy.blockerDefinitions).sort(compare).map((blocker) => [blocker, declarations.filter((row) => row.blocker === blocker).length]));
  assert(JSON.stringify(partitionSummary) === JSON.stringify(policy.expectedPartitionSummary), `arena-span blocked partition drifted: ${JSON.stringify(partitionSummary)}`);
  const coverage = { arenaSpanCensus: census.length, coveredByPriorWaves: priorDeclarations.length, generatedCStringArena: entries.length, blocked: declarations.length, executableAdaptersEmitted: entries.length, exactCallTwinsEmitted: entries.length, overlap: 0, unaccounted: census.length - priorDeclarations.length - entries.length - declarations.length };
  for (const [key, count] of Object.entries(policy.expectedCoverage)) assert(coverage[key] === count, `arena-span coverage.${key} drifted`);
  assert(coverage.unaccounted === 0, "arena-span partition is incomplete");
  const generated = new Map([[artifacts.header, renderHeader(entries, policy)], [artifacts.production, renderSource(entries, false)], [artifacts.exact, renderSource(entries, true)]]);
  const generatedDeclarations = entries.map(({ bindingId, candidate, recipe, linkage }) => ({ ...candidate, disposition: "generated", preferredLowering: true, denseId: bindingId, wrapper: "deherm_dmsdk_arena_cstring_dispatch", exactWrapper: "deherm_dmsdk_arena_cstring_exact_dispatch", exactCallee: exactCallee({ bindingId }), recipe: { kind: recipe.kind, shape: recipe.shape }, universalFallback: "retained-usage-materialized-recipe", sourceEvidence: recipe.sourceEvidence, symbolEvidence: { path: paths.symbolEvidence, linkage: linkage.linkage, availability: linkage.availability, linkedIn: linkage.linkedIn }, stages: { generated: "production-and-exact-from-one-recipe", compiled: "pinned-header-production-and-exact-object-tests", linked: "all-target-all-variant-symbol-census-plus-exact-recording-callee", runtime: "exact-dispatch-all-vectors", allocation: "bounded-thread-local-input-scratch-no-heap-primitives" } }));
  const sourceHashes = { ir: sha256(inputs.irText), shapes: sha256(inputs.shapesText), symbolEvidence: sha256(inputs.symbolEvidenceText), policy: sha256(inputs.policyText), priorWaveReports: Object.fromEntries(priorWaves.map(({ report, sha256: hash }) => [report, hash])), evidence: Object.fromEntries([...inputs.evidenceTexts].sort(([a], [b]) => compare(a, b)).map(([path, text]) => [path, sha256(text)])) };
  const report = { schemaVersion: 1, policyVersion: policy.policyVersion, defoldRevision: ir.defoldRevision, sources: { ...paths, priorWaveReports: policy.priorWaveReports.map(({ path }) => path) }, sourceHashes, scope: "Complete arena-backed-spans census with deterministic counted-input/caller-output cstring adapters", policy: { disposition: "generated-cstring-arena-plus-explicit-blockers", ...policy.cstringArena.contract, maximumInputBytes: policy.cstringArena.maximumInputBytes, maximumOutputBytes: policy.cstringArena.maximumOutputBytes }, coverage, priorWaves, coveredByPriorWaves: priorDeclarations.map(({ id, symbol, sourceReport }) => ({ id, symbol, sourceReport })).sort((a, b) => compare(a.id, b.id)), partitionSummary, artifactHashes: Object.fromEntries([...generated].map(([path, content]) => [path, sha256(content)])), artifacts: [...generated.keys()].sort(compare), generatedDeclarations, declarations };
  generated.set(paths.output, `${JSON.stringify(report, null, 2)}\n`);
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
    if (check) assert(await readFile(output, "utf8") === content, `${relative} is stale`);
    else { await mkdir(dirname(output), { recursive: true }); await writeFile(output, content); }
  }
  console.log(`${check ? "Verified" : "Generated"} ${report.coverage.generatedCStringArena} arena cstring adapters and exact twins; ${report.coverage.blocked} blockers remain.`);
  return report;
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) run().catch((error) => { console.error(error.stack ?? error.message); process.exitCode = 1; });
