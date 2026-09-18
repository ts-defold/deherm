import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const relative = Object.freeze({
  projection: "packages/bindings/generated/defold-dmsdk-projection-ir.json",
  sdkIr: "packages/bindings/generated/defold-sdk-ir.json",
  policy: "packages/bindings/overrides/dmsdk-cstring-value-bindings.json",
  report: "packages/bindings/generated/defold-dmsdk-cstring-value-bindings.json",
  header: "defold/defold_hermes/include/defold_hermes/generated_dmsdk_cstring_value.h",
  runtime: "defold/defold_hermes/src/generated_dmsdk_cstring_value_runtime.cpp",
  native: "defold/defold_hermes/src/generated_dmsdk_cstring_value.cpp",
  jsiHeader: "defold/defold_hermes/include/defold_hermes/generated_dmsdk_cstring_value_jsi.hpp",
  jsi: "defold/defold_hermes/src/generated_dmsdk_cstring_value_jsi.cpp",
  browser: "defold/defold_hermes/lib/web/generated_dmsdk_cstring_value.js",
  typescript: "packages/sdk/src/generated/dmsdk/cstring-value.ts",
  staticHermes: "packages/static-hermes/src/generated/dmsdk-cstring-value.ts"
});

function options(argv) {
  const value = { check: false, outputRoot: root };
  for (let index = 0; index < argv.length; ++index) {
    if (argv[index] === "--check") value.check = true;
    else if (argv[index] === "--output-root") value.outputRoot = path.resolve(argv[++index]);
    else throw new Error(`Unknown argument: ${argv[index]}`);
  }
  return value;
}

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const quote = (value) => JSON.stringify(value);
const supportedInputContractTokens = Object.freeze({
  nullability: Object.freeze(["non-null"]),
  encoding: Object.freeze(["js-string-utf8-no-embedded-nul"])
});
const supportedResultContractTokens = Object.freeze({
  nullability: Object.freeze(["non-null", "nullable"]),
  encoding: Object.freeze(["native-null-terminated-bytes-decoded-as-utf8"])
});
const pascal = (value) => value.split(/[^A-Za-z0-9]+/).filter(Boolean)
  .map((part) => `${part[0].toUpperCase()}${part.slice(1)}`).join("");
const camel = (value) => {
  const result = pascal(value);
  return result ? result[0].toLowerCase() + result.slice(1) : "binding";
};

function candidate(row) {
  const result = row.signature.result;
  const resultSupported = result.kind === "void" || result.kind === "enum" || result.kind === "cstring" ||
    (result.kind === "scalar" && ["bool", "i32", "u32", "u64"].includes(result.name));
  const parametersSupported = row.signature.parameters.every(({ type }) =>
    type.kind === "cstring" || type.kind === "enum" ||
    (type.kind === "scalar" && ["u32", "u64"].includes(type.name)));
  return row.effects.context.kind === "global" &&
    row.provenance.declarationKind === "function" &&
    row.provenance.primaryFamily === "pointer" &&
    row.signature.variadic === false &&
    row.effects.callbacks.present === false &&
    row.effects.records.present === false &&
    row.effects.templates.present === false &&
    row.effects.spans.present === false &&
    resultSupported && parametersSupported &&
    [result, ...row.signature.parameters.map(({ type }) => type)].some(({ kind }) => kind === "cstring") &&
    row.signature.parameters.filter(({ type }) => type.kind === "cstring")
      .every(({ direction, type }) => direction === "in" && type.mutable === false);
}

function blocker(row, policy) {
  const matches = policy.blockerRules.filter((rule) =>
    (!rule.symbolPattern || new RegExp(rule.symbolPattern).test(row.symbol)) &&
    (!rule.headerPattern || new RegExp(rule.headerPattern).test(row.provenance.header)));
  assert.ok(matches.length <= 1, `${row.id} matches overlapping C-string blocker rules`);
  return matches[0];
}

function validateContractShape(row, contract, policy) {
  const hasInput = row.signature.parameters.some(({ type }) => type.kind === "cstring");
  const hasResult = row.signature.result.kind === "cstring";
  assert.equal(Boolean(contract.input), hasInput, `${row.id}: C-string input contract shape drifted`);
  assert.equal(Boolean(contract.result), hasResult, `${row.id}: C-string result contract shape drifted`);
  if (contract.input) {
    assert.ok(supportedInputContractTokens.nullability.includes(contract.input.nullability), `${contract.id}: unsupported input nullability token`);
    assert.ok(supportedInputContractTokens.encoding.includes(contract.input.encoding), `${contract.id}: unsupported input encoding token`);
  }
  if (contract.result) {
    assert.ok(supportedResultContractTokens.nullability.includes(contract.result.nullability), `${contract.id}: unsupported result nullability token`);
    assert.ok(supportedResultContractTokens.encoding.includes(contract.result.encoding), `${contract.id}: unsupported result encoding token`);
  }
}

export function resolveCStringContracts(rows, policy) {
  assert.deepEqual(policy.inputContractTokens, supportedInputContractTokens, "C-string input token catalog differs from generator capabilities");
  assert.deepEqual(policy.resultContractTokens, supportedResultContractTokens, "C-string result token catalog differs from generator capabilities");
  const seenRuleIds = new Set();
  const declaredRows = new Set();
  for (const contract of policy.stringContractRules) {
    assert.ok(typeof contract.id === "string" && contract.id, "C-string contract rule has no id");
    assert.ok(!seenRuleIds.has(contract.id), `duplicate C-string contract rule id: ${contract.id}`);
    seenRuleIds.add(contract.id);
    assert.ok(Array.isArray(contract.declarationIds) && contract.declarationIds.length > 0, `${contract.id}: no declaration IDs`);
    for (const declarationId of contract.declarationIds) declaredRows.add(declarationId);
  }
  const candidateIds = new Set(rows.map(({ id }) => id));
  for (const declarationId of declaredRows) {
    assert.ok(candidateIds.has(declarationId), `C-string contract declaration drifted or is not a candidate: ${declarationId}`);
  }

  return rows.map((row) => {
    const rule = blocker(row, policy);
    const matches = policy.stringContractRules.filter(({ declarationIds }) => declarationIds.includes(row.id));
    assert.ok(matches.length <= 1, `${row.id} matches overlapping C-string contract rules`);
    assert.ok(!(rule && matches.length), `${row.id} is both policy-blocked and assigned a C-string contract`);
    const contract = matches[0] ?? null;
    if (contract) validateContractShape(row, contract, policy);
    return {
      row,
      rule: rule ?? (contract ? null : { id: "cstring-semantic-contract-unresolved" }),
      contract
    };
  });
}

function stableId(row) {
  return Number.parseInt(sha256(row.projectionId).slice(0, 8), 16) >>> 0;
}

function includeFor(header) {
  const marker = "/dmsdk/";
  const index = header.indexOf(marker);
  assert.ok(index >= 0, `No public dmSDK include path in ${header}`);
  return `dmsdk/${header.slice(index + marker.length)}`;
}

function kind(type) {
  if (type.kind === "void") return "DEHERM_DMSDK_CSTRING_VOID";
  if (type.kind === "cstring") return "DEHERM_DMSDK_CSTRING_STRING";
  if (type.kind === "enum") return "DEHERM_DMSDK_CSTRING_ENUM";
  const names = {
    bool: "BOOL", i8: "I8", u8: "U8", i16: "I16", u16: "U16", i32: "I32", u32: "U32",
    i64: "I64", u64: "U64", isize: "ISIZE", usize: "USIZE", "word-signed": "ISIZE",
    "word-unsigned": "USIZE", f32: "F32", f64: "F64"
  };
  assert.ok(names[type.name], `Unsupported C-string scalar ${type.name}`);
  return `DEHERM_DMSDK_CSTRING_${names[type.name]}`;
}

function cppArgument(parameter, stringIndex, scalarIndex, prologue) {
  if (parameter.type.kind === "cstring") return `native_strings[${stringIndex.value++}]`;
  const index = scalarIndex.value++;
  const local = `scalar_${index}`;
  if (parameter.type.kind === "enum") {
    prologue.push(`    ${parameter.type.name} ${local}{}; if(!decode_${cppIdentifier(parameter.type.name)}(scalar_args[${index}],&${local})) return DEHERM_DMSDK_CSTRING_SCALAR_RANGE;`);
    return local;
  }
  if (parameter.type.name === "u32") {
    prologue.push(`    if(scalar_args[${index}]>UINT32_MAX) return DEHERM_DMSDK_CSTRING_SCALAR_RANGE;`);
    return `static_cast<uint32_t>(scalar_args[${index}])`;
  }
  assert.equal(parameter.type.name, "u64", `Unsupported selected scalar parameter ${parameter.type.name}`);
  return `scalar_args[${index}]`;
}

function cppIdentifier(value) {
  return value.replace(/[^A-Za-z0-9_]/g, "_");
}

function enumDomains(entries, sdkIr) {
  const required = [...new Set(entries.flatMap(({ row }) => row.signature.parameters.map(({ type }) => type))
    .filter(({ kind: value }) => value === "enum").map(({ name }) => name))].sort();
  const declarations = new Map(sdkIr.declarations.filter(({ kind }) => kind === "enum").map((declaration) => [declaration.name, declaration]));
  return required.map((name) => {
    const declaration = declarations.get(name);
    assert.ok(declaration, `Missing SDK IR enum declaration for ${name}`);
    const members = declaration.members.filter(({ name: member }) => !/(?:^|_)(?:MAX|COUNT|NUM)(?:_|$)/.test(member));
    assert.ok(members.length > 0, `${name}: no callable enum members after sentinel filtering`);
    const scope = name.includes("::") ? name.slice(0, name.lastIndexOf("::")) : "";
    return { name, members: members.map(({ name: member, value }) => ({
      name: `${scope ? `${scope}::` : ""}${member}`,
      value
    })) };
  });
}

function renderEnumDecoder(domain) {
  const checks = domain.members.map((member) => `  if(value==static_cast<Underlying>(${member.name})){*output=${member.name};return true;}`).join("\n");
  return `bool decode_${cppIdentifier(domain.name)}(uint64_t raw,${domain.name}* output){
  using Underlying=typename std::underlying_type<${domain.name}>::type;
  Underlying value{};
  if constexpr(std::is_signed<Underlying>::value){
    const int64_t signed_value=raw<=INT64_MAX?static_cast<int64_t>(raw):-INT64_C(1)-static_cast<int64_t>(UINT64_MAX-raw);
    if(signed_value<static_cast<int64_t>(std::numeric_limits<Underlying>::min())||signed_value>static_cast<int64_t>(std::numeric_limits<Underlying>::max()))return false;
    value=static_cast<Underlying>(signed_value);
  }else{
    if(raw>static_cast<uint64_t>(std::numeric_limits<Underlying>::max()))return false;
    value=static_cast<Underlying>(raw);
  }
${checks}
  return false;
}`;
}

function invokeCase(entry) {
  const strings = { value: 0 };
  const scalars = { value: 0 };
  const prologue = [];
  const args = entry.row.signature.parameters.map((parameter) => cppArgument(parameter, strings, scalars, prologue)).join(", ");
  const call = `${entry.row.symbol}(${args})`;
  const result = entry.row.signature.result;
  if (result.kind === "cstring") {
    return `${prologue.join("\n")}\n    const char* native_result=${call};\n    const auto output_status=deherm_dmsdk_cstring_write_output(native_result, output, output_capacity, out_required, out_present);\n    if(output_status!=DEHERM_DMSDK_CSTRING_OK)return output_status;\n    if(!native_result&&!descriptor.nullable_result)return DEHERM_DMSDK_CSTRING_UNEXPECTED_NULL_RESULT;\n    return DEHERM_DMSDK_CSTRING_OK;`;
  }
  if (result.kind === "void") return `${prologue.join("\n")}\n    ${call};\n    return DEHERM_DMSDK_CSTRING_OK;`;
  if (result.kind === "scalar" && result.name === "bool") {
    return `${prologue.join("\n")}\n    *out_scalar = ${call} ? UINT64_C(1) : UINT64_C(0);\n    return DEHERM_DMSDK_CSTRING_OK;`;
  }
  if (result.kind === "scalar" && ["i8", "i16", "i32", "i64", "isize", "word-signed"].includes(result.name)) {
    return `${prologue.join("\n")}\n    *out_scalar = static_cast<uint64_t>(static_cast<int64_t>(${call}));\n    return DEHERM_DMSDK_CSTRING_OK;`;
  }
  if (result.kind === "enum") {
    return `${prologue.join("\n")}\n    *out_scalar = encode_enum(${call});\n    return DEHERM_DMSDK_CSTRING_OK;`;
  }
  return `${prologue.join("\n")}\n    *out_scalar = static_cast<uint64_t>(${call});\n    return DEHERM_DMSDK_CSTRING_OK;`;
}

function storageShape(entries) {
  const counts = entries.map(({ row }) => ({
    strings: row.signature.parameters.filter(({ type }) => type.kind === "cstring").length,
    scalars: row.signature.parameters.filter(({ type }) => type.kind !== "cstring").length
  }));
  return {
    strings: Math.max(1, ...counts.map(({ strings }) => strings)),
    scalars: Math.max(1, ...counts.map(({ scalars }) => scalars))
  };
}

function renderHeader(entries, policy) {
  return `// Generated by scripts/generate-dmsdk-cstring-value-bindings.mjs. Do not edit.
#ifndef DEFOLD_HERMES_GENERATED_DMSDK_CSTRING_VALUE_H
#define DEFOLD_HERMES_GENERATED_DMSDK_CSTRING_VALUE_H
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif
typedef uint32_t DehermDmSdkCStringStatus;
enum {
  DEHERM_DMSDK_CSTRING_OK=0, DEHERM_DMSDK_CSTRING_UNKNOWN_ID=1,
  DEHERM_DMSDK_CSTRING_ARGUMENT_COUNT=2, DEHERM_DMSDK_CSTRING_NULL_STORAGE=3,
  DEHERM_DMSDK_CSTRING_EMBEDDED_NUL=4, DEHERM_DMSDK_CSTRING_LENGTH_OVERFLOW=5,
  DEHERM_DMSDK_CSTRING_SCRATCH_EXHAUSTED=6, DEHERM_DMSDK_CSTRING_OUTPUT_TOO_SMALL=7,
  DEHERM_DMSDK_CSTRING_SCALAR_RANGE=8, DEHERM_DMSDK_CSTRING_UNEXPECTED_NULL_RESULT=9
};
typedef enum DehermDmSdkCStringKind {
  DEHERM_DMSDK_CSTRING_VOID=0, DEHERM_DMSDK_CSTRING_BOOL=1, DEHERM_DMSDK_CSTRING_I8=2,
  DEHERM_DMSDK_CSTRING_U8=3, DEHERM_DMSDK_CSTRING_I16=4, DEHERM_DMSDK_CSTRING_U16=5,
  DEHERM_DMSDK_CSTRING_I32=6, DEHERM_DMSDK_CSTRING_U32=7, DEHERM_DMSDK_CSTRING_I64=8,
  DEHERM_DMSDK_CSTRING_U64=9, DEHERM_DMSDK_CSTRING_ISIZE=10, DEHERM_DMSDK_CSTRING_USIZE=11,
  DEHERM_DMSDK_CSTRING_F32=12, DEHERM_DMSDK_CSTRING_F64=13, DEHERM_DMSDK_CSTRING_ENUM=14,
  DEHERM_DMSDK_CSTRING_STRING=15
} DehermDmSdkCStringKind;
typedef struct DehermDmSdkCStringView { const uint8_t* data; uint32_t length; } DehermDmSdkCStringView;
typedef struct DehermDmSdkCStringScratch { uint8_t* data; uint32_t capacity; uint32_t used; } DehermDmSdkCStringScratch;
typedef struct DehermDmSdkCStringFrame { DehermDmSdkCStringScratch* scratch; uint32_t mark; } DehermDmSdkCStringFrame;
typedef struct DehermDmSdkCStringDescriptor {
  uint32_t stable_id; uint8_t string_count; uint8_t scalar_count; uint8_t result_kind; uint8_t nullable_result;
  const char* projection_id; const char* source_id;
} DehermDmSdkCStringDescriptor;
#define DEHERM_DMSDK_CSTRING_TLS_SCRATCH_CAPACITY UINT32_C(${policy.scratchCapacity})
uint32_t deherm_dmsdk_cstring_value_count(void);
const DehermDmSdkCStringDescriptor* deherm_dmsdk_cstring_value_descriptors(void);
DehermDmSdkCStringStatus deherm_dmsdk_cstring_frame_begin(DehermDmSdkCStringScratch*, DehermDmSdkCStringFrame*);
DehermDmSdkCStringStatus deherm_dmsdk_cstring_frame_input(DehermDmSdkCStringFrame*, DehermDmSdkCStringView, const char**);
void deherm_dmsdk_cstring_frame_end(DehermDmSdkCStringFrame*);
DehermDmSdkCStringStatus deherm_dmsdk_cstring_write_output(const char*, uint8_t*, uint32_t, uint32_t*, uint8_t*);
DehermDmSdkCStringStatus deherm_dmsdk_cstring_value_dispatch(
    uint16_t id, DehermDmSdkCStringScratch* scratch,
    const DehermDmSdkCStringView* string_args, uint32_t string_count,
    const uint64_t* scalar_args, uint32_t scalar_count, uint64_t* out_scalar,
    uint8_t* output, uint32_t output_capacity, uint32_t* out_required, uint8_t* out_present);
#ifdef __cplusplus
}
#endif
#endif
`;
}

function renderRuntime() {
  return `// Generated by scripts/generate-dmsdk-cstring-value-bindings.mjs. Do not edit.
#if defined(DEHERM_ENABLE_PRIVATE_DMSDK_CSTRING_VALUE)
#include <defold_hermes/generated_dmsdk_cstring_value.h>
#include <cstring>
#include <limits>
namespace { thread_local uint8_t g_data[DEHERM_DMSDK_CSTRING_TLS_SCRATCH_CAPACITY]; thread_local DehermDmSdkCStringScratch g_scratch={g_data,DEHERM_DMSDK_CSTRING_TLS_SCRATCH_CAPACITY,0}; }
extern "C" {
DehermDmSdkCStringStatus deherm_dmsdk_cstring_frame_begin(DehermDmSdkCStringScratch* scratch, DehermDmSdkCStringFrame* frame) {
  if(!frame) return DEHERM_DMSDK_CSTRING_NULL_STORAGE; if(!scratch) scratch=&g_scratch;
  if((scratch->capacity && !scratch->data)||scratch->used>scratch->capacity) return DEHERM_DMSDK_CSTRING_NULL_STORAGE;
  frame->scratch=scratch; frame->mark=scratch->used; return DEHERM_DMSDK_CSTRING_OK;
}
DehermDmSdkCStringStatus deherm_dmsdk_cstring_frame_input(DehermDmSdkCStringFrame* frame, DehermDmSdkCStringView view, const char** out) {
  if(!frame||!frame->scratch||!out||(view.length&&!view.data)) return DEHERM_DMSDK_CSTRING_NULL_STORAGE;
  if(view.length==std::numeric_limits<uint32_t>::max()) return DEHERM_DMSDK_CSTRING_LENGTH_OVERFLOW;
  if(view.length&&std::memchr(view.data,0,view.length)) return DEHERM_DMSDK_CSTRING_EMBEDDED_NUL;
  DehermDmSdkCStringScratch* scratch=frame->scratch; const uint32_t needed=view.length+1;
  if((scratch->capacity&&!scratch->data)||scratch->used>scratch->capacity) return DEHERM_DMSDK_CSTRING_NULL_STORAGE;
  if(needed>scratch->capacity-scratch->used) return DEHERM_DMSDK_CSTRING_SCRATCH_EXHAUSTED;
  uint8_t* target=scratch->data+scratch->used; if(view.length) std::memmove(target,view.data,view.length); target[view.length]=0;
  scratch->used+=needed; *out=reinterpret_cast<const char*>(target); return DEHERM_DMSDK_CSTRING_OK;
}
void deherm_dmsdk_cstring_frame_end(DehermDmSdkCStringFrame* frame) { if(frame&&frame->scratch){frame->scratch->used=frame->mark;frame->scratch=nullptr;frame->mark=0;} }
DehermDmSdkCStringStatus deherm_dmsdk_cstring_write_output(const char* value,uint8_t* output,uint32_t capacity,uint32_t* required,uint8_t* present) {
  if(!required||!present||(capacity&&!output)) return DEHERM_DMSDK_CSTRING_NULL_STORAGE;
  if(!value){*required=0;*present=0;if(capacity)output[0]=0;return DEHERM_DMSDK_CSTRING_OK;}
  const size_t length=std::strlen(value); if(length>=std::numeric_limits<uint32_t>::max()) return DEHERM_DMSDK_CSTRING_LENGTH_OVERFLOW;
  *required=static_cast<uint32_t>(length);*present=1;
  if(length+1>capacity){if(capacity)output[0]=0;return DEHERM_DMSDK_CSTRING_OUTPUT_TOO_SMALL;}
  std::memmove(output,value,length+1);return DEHERM_DMSDK_CSTRING_OK;
}
}
#endif
`;
}

function renderNative(entries, storage, domains) {
  const includes = [...new Set(entries.map(({ row }) => includeFor(row.provenance.header)))].sort()
    .map((value) => `#include <${value}>`).join("\n");
  const descriptors = entries.map((entry) => {
    const strings = entry.row.signature.parameters.filter(({ type }) => type.kind === "cstring").length;
    const scalars = entry.row.signature.parameters.length - strings;
    const nullable = entry.contract?.result?.nullability === "nullable" ? 1 : 0;
    return `  {UINT32_C(${entry.stableId}),${strings},${scalars},${kind(entry.row.signature.result)},${nullable},${quote(entry.row.projectionId)},${quote(entry.row.id)}},`;
  }).join("\n");
  const enumTypes = domains.map(({ name }) => name);
  const assertions = enumTypes.map((name) => `static_assert(sizeof(${name})<=sizeof(int32_t),"${name} exceeds the exact JS-safe enum lane");`).join("\n");
  const enumDecoders = domains.map(renderEnumDecoder).join("\n");
  const cases = entries.map((entry, id) => `  case ${id}: {\n${invokeCase(entry)}\n  }`).join("\n");
  return `// Generated by scripts/generate-dmsdk-cstring-value-bindings.mjs. Do not edit.
#if defined(DEHERM_ENABLE_PRIVATE_DMSDK_CSTRING_VALUE)
#include <defold_hermes/generated_dmsdk_cstring_value.h>
${includes}
#include <cstddef>
#include <limits>
#include <type_traits>
${assertions}
namespace {
${enumDecoders}
template <typename Enum> uint64_t encode_enum(Enum value){using Underlying=typename std::underlying_type<Enum>::type;if constexpr(std::is_signed<Underlying>::value)return static_cast<uint64_t>(static_cast<int64_t>(static_cast<Underlying>(value)));else return static_cast<uint64_t>(static_cast<Underlying>(value));}
constexpr DehermDmSdkCStringDescriptor kDescriptors[]={
${descriptors}
}; struct FrameScope { DehermDmSdkCStringFrame* frame; ~FrameScope(){deherm_dmsdk_cstring_frame_end(frame);} }; }
extern "C" {
uint32_t deherm_dmsdk_cstring_value_count(void){return UINT32_C(${entries.length});}
const DehermDmSdkCStringDescriptor* deherm_dmsdk_cstring_value_descriptors(void){return kDescriptors;}
DehermDmSdkCStringStatus deherm_dmsdk_cstring_value_dispatch(uint16_t id,DehermDmSdkCStringScratch* scratch,const DehermDmSdkCStringView* string_args,uint32_t string_count,const uint64_t* scalar_args,uint32_t scalar_count,uint64_t* out_scalar,uint8_t* output,uint32_t output_capacity,uint32_t* out_required,uint8_t* out_present){
  if(id>=deherm_dmsdk_cstring_value_count())return DEHERM_DMSDK_CSTRING_UNKNOWN_ID;const auto& descriptor=kDescriptors[id];
  if(string_count!=descriptor.string_count||scalar_count!=descriptor.scalar_count||(string_count&&!string_args)||(scalar_count&&!scalar_args))return DEHERM_DMSDK_CSTRING_ARGUMENT_COUNT;
  if(descriptor.result_kind!=DEHERM_DMSDK_CSTRING_STRING&&descriptor.result_kind!=DEHERM_DMSDK_CSTRING_VOID&&!out_scalar)return DEHERM_DMSDK_CSTRING_NULL_STORAGE;
  DehermDmSdkCStringFrame frame{};auto status=deherm_dmsdk_cstring_frame_begin(scratch,&frame);if(status!=DEHERM_DMSDK_CSTRING_OK)return status;FrameScope frame_scope{&frame};
  const char* native_strings[${storage.strings}]={};for(uint32_t i=0;i<string_count;++i){status=deherm_dmsdk_cstring_frame_input(&frame,string_args[i],&native_strings[i]);if(status!=DEHERM_DMSDK_CSTRING_OK)return status;}
  switch(id){
${cases}
  default: status=DEHERM_DMSDK_CSTRING_UNKNOWN_ID;break;
  }
  return status;
}
}
#endif
`;
}

function renderJsiHeader() {
  return `// Generated by scripts/generate-dmsdk-cstring-value-bindings.mjs. Do not edit.\n#pragma once\n#if defined(DEHERM_ENABLE_PRIVATE_DMSDK_CSTRING_VALUE) && !defined(DM_PLATFORM_HTML5)\n#include <jsi/jsi.h>\nnamespace defold_hermes { void installDmSdkCStringValueModule(facebook::jsi::Runtime&,facebook::jsi::Object&); }\n#endif\n`;
}

function renderJsi(entries, storage) {
  const cases = entries.map((entry, id) => {
    const params = entry.row.signature.parameters;
    let stringIndex = 0;
    let scalarIndex = 0;
    const encode = params.map((parameter, index) => {
      if (parameter.type.kind === "cstring") {
        const current = stringIndex++;
        return `        if(!args[${index + 1}].isString())throw jsi::JSError(runtime,"dmSDK C-string argument must be string"); encoded[${current}]=args[${index + 1}].getString(runtime).utf8(runtime); if(encoded[${current}].size()>=std::numeric_limits<uint32_t>::max())throw jsi::JSError(runtime,"dmSDK C-string argument is too large"); views[${current}]={reinterpret_cast<const uint8_t*>(encoded[${current}].data()),static_cast<uint32_t>(encoded[${current}].size())};`;
      }
      const current = scalarIndex++;
      if (parameter.type.kind === "scalar" && parameter.type.name === "u64") return `        if(!args[${index + 1}].isBigInt())throw jsi::JSError(runtime,"dmSDK u64 argument must be bigint"); {const auto bigint=args[${index + 1}].asBigInt(runtime);if(!bigint.isUint64(runtime))throw jsi::JSError(runtime,"dmSDK u64 argument is out of range");scalars[${current}]=bigint.asUint64(runtime);}`;
      if (parameter.type.kind === "scalar" && parameter.type.name === "u32") return `        if(!args[${index + 1}].isNumber()||!std::isfinite(args[${index + 1}].asNumber())||std::trunc(args[${index + 1}].asNumber())!=args[${index + 1}].asNumber()||args[${index + 1}].asNumber()<0||args[${index + 1}].asNumber()>UINT32_MAX)throw jsi::JSError(runtime,"dmSDK u32 argument is out of range");scalars[${current}]=static_cast<uint32_t>(args[${index + 1}].asNumber());`;
      return `        if(!args[${index + 1}].isNumber()||!std::isfinite(args[${index + 1}].asNumber())||std::trunc(args[${index + 1}].asNumber())!=args[${index + 1}].asNumber()||args[${index + 1}].asNumber()<-9007199254740991.0||args[${index + 1}].asNumber()>9007199254740991.0)throw jsi::JSError(runtime,"dmSDK enum argument must be a safe integer");scalars[${current}]=static_cast<uint64_t>(static_cast<int64_t>(args[${index + 1}].asNumber()));`;
    }).join("\n");
    return `      case ${id}: { if(count!=${params.length + 1})throw jsi::JSError(runtime,"Wrong dmSDK C-string argument count");\n${encode}\n        break; }`;
  }).join("\n");
  return `// Generated by scripts/generate-dmsdk-cstring-value-bindings.mjs. Do not edit.
#if defined(DEHERM_ENABLE_PRIVATE_DMSDK_CSTRING_VALUE) && !defined(DM_PLATFORM_HTML5)
#include <defold_hermes/generated_dmsdk_cstring_value_jsi.hpp>
#include <defold_hermes/generated_dmsdk_cstring_value.h>
#include <array>
#include <cmath>
#include <limits>
#include <string>
namespace defold_hermes { namespace jsi=facebook::jsi; namespace { thread_local std::array<uint8_t,DEHERM_DMSDK_CSTRING_TLS_SCRATCH_CAPACITY> g_output{}; int64_t signed_lane(uint64_t raw){return raw<=INT64_MAX?static_cast<int64_t>(raw):-INT64_C(1)-static_cast<int64_t>(UINT64_MAX-raw);} const char* status_message(DehermDmSdkCStringStatus status){switch(status){case DEHERM_DMSDK_CSTRING_UNKNOWN_ID:return "unknown binding id";case DEHERM_DMSDK_CSTRING_ARGUMENT_COUNT:return "argument count mismatch";case DEHERM_DMSDK_CSTRING_NULL_STORAGE:return "null or corrupt storage";case DEHERM_DMSDK_CSTRING_EMBEDDED_NUL:return "embedded NUL in string input";case DEHERM_DMSDK_CSTRING_SCRATCH_EXHAUSTED:return "bounded string scratch exhausted";case DEHERM_DMSDK_CSTRING_OUTPUT_TOO_SMALL:return "bounded string output exhausted";case DEHERM_DMSDK_CSTRING_LENGTH_OVERFLOW:return "string length overflow";case DEHERM_DMSDK_CSTRING_SCALAR_RANGE:return "scalar or enum outside generated domain";case DEHERM_DMSDK_CSTRING_UNEXPECTED_NULL_RESULT:return "non-null string result was absent";case DEHERM_DMSDK_CSTRING_OK:return "ok";}return "unknown status";} }
void installDmSdkCStringValueModule(jsi::Runtime& runtime,jsi::Object& modules){jsi::Object module(runtime);auto call=jsi::Function::createFromHostFunction(runtime,jsi::PropNameID::forAscii(runtime,"call"),3,
[](jsi::Runtime& runtime,const jsi::Value&,const jsi::Value* args,size_t count)->jsi::Value{if(count<1||!args[0].isNumber()||!std::isfinite(args[0].asNumber())||std::trunc(args[0].asNumber())!=args[0].asNumber()||args[0].asNumber()<0||args[0].asNumber()>=${entries.length})throw jsi::JSError(runtime,"DmSdkCStringValue.call expects a known integer binding id");const uint16_t id=static_cast<uint16_t>(args[0].asNumber());
  std::string encoded[${storage.strings}];DehermDmSdkCStringView views[${storage.strings}]{};uint64_t scalars[${storage.scalars}]{};
  switch(id){
${cases}
  default:throw jsi::JSError(runtime,"Unknown dmSDK C-string binding id");}
  const auto& descriptor=deherm_dmsdk_cstring_value_descriptors()[id];uint64_t raw=0;uint32_t required=0;uint8_t present=0;
  const auto status=deherm_dmsdk_cstring_value_dispatch(id,nullptr,views,descriptor.string_count,scalars,descriptor.scalar_count,&raw,g_output.data(),static_cast<uint32_t>(g_output.size()),&required,&present);
  if(status!=DEHERM_DMSDK_CSTRING_OK)throw jsi::JSError(runtime,status_message(status));if(descriptor.result_kind==DEHERM_DMSDK_CSTRING_STRING){if(!present){if(!descriptor.nullable_result)throw jsi::JSError(runtime,"dmSDK non-null C-string result was absent");return jsi::Value::undefined();}return jsi::String::createFromUtf8(runtime,g_output.data(),required);}
  if(descriptor.result_kind==DEHERM_DMSDK_CSTRING_VOID)return jsi::Value::undefined();if(descriptor.result_kind==DEHERM_DMSDK_CSTRING_BOOL)return jsi::Value(raw!=0);if(descriptor.result_kind==DEHERM_DMSDK_CSTRING_U64)return jsi::Value(runtime,jsi::BigInt::fromUint64(runtime,raw));if(descriptor.result_kind==DEHERM_DMSDK_CSTRING_U32)return jsi::Value(static_cast<double>(raw));return jsi::Value(static_cast<double>(signed_lane(raw)));
});module.setProperty(runtime,"call",std::move(call));modules.setProperty(runtime,"DmSdkCStringValue",std::move(module));}
}
#endif
`;
}

function tsType(type) {
  if (type.kind === "cstring") return "string";
  if (type.kind === "void") return "void";
  if (type.kind === "scalar" && ["u64", "i64", "usize", "isize", "word-signed", "word-unsigned"].includes(type.name)) return "bigint";
  if (type.kind === "scalar" && type.name === "bool") return "boolean";
  return "number";
}

function routeName(row) { return camel(row.symbol.replace(/::/g, " ")); }

function renderTypescript(entries) {
  const ids = entries.map((entry, index) => `  ${routeName(entry.row)}: ${index},`).join("\n");
  const functions = entries.map((entry) => {
    const params = entry.row.signature.parameters.map((parameter, index) => `${camel(parameter.name || `arg ${index}`)}: ${tsType(parameter.type)}`);
    const names = entry.row.signature.parameters.map((parameter, index) => camel(parameter.name || `arg ${index}`));
    const result = tsType(entry.row.signature.result) + (entry.contract?.result?.nullability === "nullable" ? " | undefined" : "");
    return `/** ${entry.row.provenance.nativeSignature}. Source: ${entry.row.provenance.header}:${entry.row.provenance.line}. */\nexport function ${routeName(entry.row)}(${params.join(", ")}): ${result} { return module().call(DmSdkCStringValueId.${routeName(entry.row)}${names.length ? `, ${names.join(", ")}` : ""}) as ${result}; }`;
  }).join("\n\n");
  return `// Generated by scripts/generate-dmsdk-cstring-value-bindings.mjs. Do not edit.
interface DmSdkCStringValueModule { call(id:number,...args:readonly unknown[]):unknown; }
declare global { var __defoldModulesV1:Record<string,object>|undefined; }
function module():DmSdkCStringValueModule { const value=globalThis.__defoldModulesV1?.DmSdkCStringValue as DmSdkCStringValueModule|undefined;if(!value)throw new Error("Defold module is not registered: DmSdkCStringValue");return value; }
export const DmSdkCStringValueId={
${ids}
} as const;
${functions}
`;
}

function renderStaticHermes() {
  return `// Generated by scripts/generate-dmsdk-cstring-value-bindings.mjs. Do not edit.
// Direct-memory ABI: callers provide descriptor arrays, result storage, and optional scratch.
"use strict";
const __ffi_dmsdkCStringValueDispatch=$SHBuiltin.extern_c(
  {include:"defold_hermes/generated_dmsdk_cstring_value.h"},
  function deherm_dmsdk_cstring_value_dispatch(id:c_ushort,scratch:c_ptr,stringArgs:c_ptr,stringCount:c_uint,scalarArgs:c_ptr,scalarCount:c_uint,outScalar:c_ptr,output:c_ptr,outputCapacity:c_uint,outRequired:c_ptr,outPresent:c_ptr):c_uint{throw 0;}
);
`;
}

function renderBrowser(entries) {
  const rows = entries.map((entry, index) => {
    const strings = entry.row.signature.parameters.filter(({ type }) => type.kind === "cstring").length;
    const scalarKinds = entry.row.signature.parameters.filter(({ type }) => type.kind !== "cstring")
      .map(({ type }) => type.kind === "scalar" ? type.name : `enum:${type.name}`);
    const result = entry.row.signature.result;
    const resultKind = result.kind === "scalar" ? result.name : result.kind === "enum" ? `enum:${result.name}` : result.kind;
    return `      {id:${index},stableId:${entry.stableId},strings:${strings},scalarKinds:Object.freeze(${quote(scalarKinds)}),resultKind:${quote(resultKind)},resultLaneBytes:${result.kind === "void" ? 0 : result.kind === "cstring" ? 1 : 8},nullableResult:${entry.contract?.result?.nullability === "nullable"}}`;
  }).join(",\n");
  return `// Generated by scripts/generate-dmsdk-cstring-value-bindings.mjs. Do not edit.
var LibraryDefoldHermesDmSdkCStringValue={
  $DEFOLD_HERMES_DMSDK_CSTRING_VALUE:{install:function(){return Object.freeze({privateStaging:true,registered:false,abi:"direct-wasm-memory-v1",dispatch:"deherm_dmsdk_cstring_value_dispatch",viewLayout:Object.freeze({data:0,length:4,size:8}),scratchLayout:Object.freeze({data:0,capacity:4,used:8,size:12}),outputLayout:Object.freeze({scalarBytes:8,requiredBytes:4,presentBytes:1,capacityIncludesTrailingNul:true}),stringInputContract:Object.freeze({encoding:"utf8",emptyView:"null-data-with-zero-length-means-empty",embeddedNul:"rejected",terminator:"synthesized-in-scratch"}),routes:Object.freeze([
${rows}
    ])});}}
};
autoAddDeps(LibraryDefoldHermesDmSdkCStringValue,'$DEFOLD_HERMES_DMSDK_CSTRING_VALUE');addToLibrary(LibraryDefoldHermesDmSdkCStringValue);
`;
}

async function writeOrCheck(outputRoot, name, content, check) {
  const target = path.join(outputRoot, name);
  if (check) assert.equal(await readFile(target, "utf8"), content, `${name} is stale`);
  else { await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, content); }
}

async function main() {
  const opt = options(process.argv.slice(2));
  const [projectionRaw, irRaw, policyRaw] = await Promise.all([
    readFile(path.join(root, relative.projection), "utf8"), readFile(path.join(root, relative.sdkIr), "utf8"), readFile(path.join(root, relative.policy), "utf8")
  ]);
  const projection = JSON.parse(projectionRaw); const sdkIr = JSON.parse(irRaw); const policy = JSON.parse(policyRaw);
  assert.equal(policy.schemaVersion, 2); const candidates = projection.rows.filter(candidate);
  const semanticEvidence = {};
  const semanticEvidenceIds = new Set();
  for (const evidence of policy.sourceEvidence) {
    assert.ok(!semanticEvidenceIds.has(evidence.id), `duplicate C-string source evidence id: ${evidence.id}`);
    semanticEvidenceIds.add(evidence.id);
    const content = await readFile(path.join(root, evidence.path), "utf8");
    assert.equal(sha256(content), evidence.sha256, `${evidence.id} evidence hash drifted`);
    for (const anchor of evidence.anchors) assert.ok(content.includes(anchor), `${evidence.id} evidence anchor drifted: ${anchor}`);
    semanticEvidence[evidence.id] = evidence;
  }
  for (const contract of policy.stringContractRules) {
    for (const evidenceId of contract.sourceEvidence) assert.ok(semanticEvidenceIds.has(evidenceId), `${contract.id}: unknown source evidence ${evidenceId}`);
  }
  const blockerEvidence = {};
  const blockerEvidenceById = new Map(policy.blockerSourceEvidence.map((evidence) => [evidence.id, evidence]));
  assert.equal(blockerEvidenceById.size, policy.blockerSourceEvidence.length, "duplicate C-string blocker evidence id");
  for (const rule of policy.blockerRules) {
    for (const evidenceId of rule.sourceEvidence) {
      const evidence = blockerEvidenceById.get(evidenceId);
      assert.ok(evidence, `${rule.id}: unknown blocker evidence ${evidenceId}`);
      const content = await readFile(path.join(root, evidence.path), "utf8");
      assert.ok(content.includes(evidence.contains), `${rule.id} evidence drifted`);
      blockerEvidence[evidenceId] = { ...evidence, sha256: sha256(content) };
    }
  }
  const classified = resolveCStringContracts(candidates, policy).map((entry) => ({ ...entry, stableId: stableId(entry.row) }));
  const entries = classified.filter(({ rule }) => !rule);
  const blocked = classified.filter(({ rule }) => rule);
  assert.deepEqual({ candidates: candidates.length, generated: entries.length, blocked: blocked.length }, policy.expectedCoverage);
  assert.equal(new Set(classified.map(({ stableId: value }) => value)).size, classified.length, "Stable ID collision");
  const storage = storageShape(entries);
  const domains = enumDomains(entries, sdkIr);
  const artifacts = new Map([
    [relative.header, renderHeader(entries, policy)], [relative.runtime, renderRuntime()], [relative.native, renderNative(entries, storage, domains)],
    [relative.jsiHeader, renderJsiHeader()], [relative.jsi, renderJsi(entries, storage)], [relative.browser, renderBrowser(entries)],
    [relative.typescript, renderTypescript(entries)], [relative.staticHermes, renderStaticHermes()]
  ]);
  const report = {
    schemaVersion: 1, defoldRevision: projection.defoldRevision,
    sources: { projection: relative.projection, sdkIr: relative.sdkIr, policy: relative.policy, hashes: { projection: sha256(projectionRaw), sdkIr: sha256(irRaw), policy: sha256(policyRaw), semanticEvidence, blockerEvidence } },
    selector: "global pointer-family function + nonvariadic + no callback/record/template/span + const input cstrings + exact result {void,cstring,enum,bool,i32,u32,u64} + exact parameter {cstring,enum,u32,u64}; independent of lowering/evidence disposition",
    coverage: { ...policy.expectedCoverage, nativeAbiGenerated: entries.length, headerObjectCompiled: 0, pinnedEngineLinked: 0, stubAbiLinkedAndRuntimeTested: 0, nativeDynamicHermesAdapterGenerated: entries.length, nativeStaticHermesDirectMemoryAbiGenerated: entries.length, browserDirectMemoryDescriptorGenerated: entries.length, allTargetConformant: 0 },
    stringPolicy: {
      input: "The staged JavaScript adapter deliberately narrows const char* inputs to non-null JavaScript strings, uses the host JSI UTF-8 conversion, rejects embedded NUL, and synthesizes the terminator. Lone-surrogate handling therefore follows the selected JSI engine and remains outside cross-target conformance until a shared UTF-16-to-UTF-8 policy is generated. The C ABI itself continues to accept exact caller-provided non-NUL byte views; this policy does not claim every native byte domain is intrinsically UTF-8.",
      result: "Reviewed result contracts explicitly choose nullable or non-null and decode copied null-terminated native bytes as UTF-8. Source hashes and anchors pin the declaration evidence; they do not prove arbitrary engine-returned bytes are valid Unicode.",
      unresolved: "A candidate without exactly one non-overlapping reviewed contract is blocked as cstring-semantic-contract-unresolved."
    },
    abi: { input: "exact byte view; null data is valid only with zero length and means an empty string; embedded NUL rejected; terminator synthesized in bounded caller/TLS scratch", enumInput: "exact declared-value membership generated from pinned SDK IR; sentinel COUNT/MAX/NUM enumerators are rejected", enumDomains: Object.fromEntries(domains.map(({ name, members }) => [name, members])), output: "immediate overlap-safe copy to caller-owned dst/capacity/out_required/present; capacity includes the required trailing NUL, so capacity == required is too small for a present result", browserDescriptor: "route-specific scalar/enum input kinds, exact result lane width, result nullability, memory layouts, and string policy are generated; the descriptor remains private and unregistered", status: "fixed-width uint32_t / Static Hermes c_uint", storage, tlsScratchCapacity: policy.scratchCapacity, reentrant: "mark/reset frames on thread-local or caller-owned scratch", allocation: "generated C ABI contains no explicit allocation primitive; an independent test observes zero warmed C++ operator-new calls. Caller-owned scratch is the strict caller-controlled capacity path; TLS scratch is a bounded convenience path. Engine implementations and JS string conversion are outside this claim" },
    truthBoundary: "Private staging only: the TypeScript wrapper is not exported from the SDK barrel, the JSI installer is not registered, the Static Hermes artifact is not compiled into an application, the browser descriptor is not installed by a public module, and the guarded native sources are not linked into a production runtime target. This generated report claims generation only and intentionally records compile/link/runtime evidence as zero. tests/dmsdk-cstring-value-bindings.test.mjs independently object-compiles the generated native, runtime, and JSI units against pinned headers and links/runs every native adapter against ABI-compatible stubs. Pinned Defold engine linkage, extension retention, target execution, and engine-allocation observations remain unproven; generated does not mean engine-proven.",
    declarations: classified.map(({ row, rule, contract, stableId: value }) => ({
      id: row.id, projectionId: row.projectionId, stableId: value, denseId: rule ? null : entries.findIndex(({ row: candidateRow }) => candidateRow.id === row.id), symbol: row.symbol,
      provenance: row.provenance, disposition: rule ? "blocked" : "generated", blocker: rule?.id ?? null,
      stringContract: contract ? { id: contract.id, input: contract.input, result: contract.result, sourceEvidence: contract.sourceEvidence } : null,
      targetDisposition: rule ? { nativeDynamicHermes: "blocked", nativeStaticHermes: "blocked", html5BrowserHost: "blocked" } : { typescriptSdk: "staged-private-not-barrel-exported", nativeDynamicHermes: "staged-private-jsi-unregistered-unlinked", nativeStaticHermes: "staged-private-c-abi-uncompiled-unlinked", html5BrowserHost: "staged-private-descriptor-unregistered-unlinked" }
    })),
    artifacts: [...artifacts.keys()], artifactHashes: Object.fromEntries([...artifacts].map(([name, content]) => [name, sha256(content)]))
  };
  artifacts.set(relative.report, `${JSON.stringify(report, null, 2)}\n`);
  for (const [name, content] of artifacts) await writeOrCheck(opt.outputRoot, name, content, opt.check);
  process.stdout.write(`${opt.check ? "Verified" : "Generated"} ${entries.length}/${candidates.length} dmSDK C-string/value adapters; ${blocked.length} fail closed.\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
