import assert from "node:assert/strict";

export const DMSDK_CSTRING_VALUE_RECIPE_FACTS_NAME = "defold-dmsdk-cstring-value-recipe-facts.json";
const quote = JSON.stringify;
const pascal = (value) =>
  value
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join("");
const camel = (value) => {
  const result = pascal(value);
  return result ? result[0].toLowerCase() + result.slice(1) : "binding";
};

export function createDmSdkCStringValueRecipeFacts(entries, recipe, domains) {
  return {
    schemaVersion: 1,
    kind: "deherm.recipe.dmsdk-cstring-value-output",
    scratchCapacity: recipe.scratchCapacity,
    entries: entries.map((entry) => ({
      stableId: entry.stableId,
      typescriptName: entry.typescriptName,
      contract: entry.contract,
      row: {
        id: entry.row.id,
        projectionId: entry.row.projectionId,
        symbol: entry.row.symbol,
        provenance: {
          header: entry.row.provenance.header,
          line: entry.row.provenance.line,
          nativeSignature: entry.row.provenance.nativeSignature,
        },
        signature: entry.row.signature,
      },
    })),
    domains,
  };
}
function unpack(facts) {
  if (
    facts?.schemaVersion !== 1 ||
    facts?.kind !== "deherm.recipe.dmsdk-cstring-value-output" ||
    !Number.isInteger(facts.scratchCapacity) ||
    !Array.isArray(facts.entries) ||
    !Array.isArray(facts.domains)
  )
    throw new Error("Unsupported dmSDK C-string/value output recipe facts");
  return facts;
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
    bool: "BOOL",
    i8: "I8",
    u8: "U8",
    i16: "I16",
    u16: "U16",
    i32: "I32",
    u32: "U32",
    i64: "I64",
    u64: "U64",
    isize: "ISIZE",
    usize: "USIZE",
    "word-signed": "ISIZE",
    "word-unsigned": "USIZE",
    f32: "F32",
    f64: "F64",
  };
  assert.ok(names[type.name], `Unsupported C-string scalar ${type.name}`);
  return `DEHERM_DMSDK_CSTRING_${names[type.name]}`;
}
const cppIdentifier = (value) => value.replace(/[^A-Za-z0-9_]/g, "_");
function cppArgument(parameter, stringIndex, scalarIndex, prologue) {
  if (parameter.type.kind === "cstring") return `native_strings[${stringIndex.value++}]`;
  const index = scalarIndex.value++;
  const local = `scalar_${index}`;
  if (parameter.type.kind === "enum") {
    prologue.push(
      `    ${parameter.type.name} ${local}{}; if(!decode_${cppIdentifier(parameter.type.name)}(scalar_args[${index}],&${local})) return DEHERM_DMSDK_CSTRING_SCALAR_RANGE;`,
    );
    return local;
  }
  if (parameter.type.name === "u32") {
    prologue.push(`    if(scalar_args[${index}]>UINT32_MAX) return DEHERM_DMSDK_CSTRING_SCALAR_RANGE;`);
    return `static_cast<uint32_t>(scalar_args[${index}])`;
  }
  assert.equal(parameter.type.name, "u64", `Unsupported selected scalar parameter ${parameter.type.name}`);
  return `scalar_args[${index}]`;
}
function renderEnumDecoder(domain) {
  const checks = domain.members
    .map((member) => `  if(value==static_cast<Underlying>(${member.name})){*output=${member.name};return true;}`)
    .join("\n");
  return `bool decode_${cppIdentifier(domain.name)}(uint64_t raw,${domain.name}* output){\n  using Underlying=typename std::underlying_type<${domain.name}>::type;\n  Underlying value{};\n  if constexpr(std::is_signed<Underlying>::value){\n    const int64_t signed_value=raw<=INT64_MAX?static_cast<int64_t>(raw):-INT64_C(1)-static_cast<int64_t>(UINT64_MAX-raw);\n    if(signed_value<static_cast<int64_t>(std::numeric_limits<Underlying>::min())||signed_value>static_cast<int64_t>(std::numeric_limits<Underlying>::max()))return false;\n    value=static_cast<Underlying>(signed_value);\n  }else{\n    if(raw>static_cast<uint64_t>(std::numeric_limits<Underlying>::max()))return false;\n    value=static_cast<Underlying>(raw);\n  }\n${checks}\n  return false;\n}`;
}
function invokeCase(entry) {
  const strings = { value: 0 },
    scalars = { value: 0 },
    prologue = [];
  const args = entry.row.signature.parameters.map((p) => cppArgument(p, strings, scalars, prologue)).join(", ");
  const call = `${entry.row.symbol}(${args})`;
  const result = entry.row.signature.result;
  if (result.kind === "cstring")
    return `${prologue.join("\n")}\n    const char* native_result=${call};\n    const auto output_status=deherm_dmsdk_cstring_write_output(native_result, output, output_capacity, out_required, out_present);\n    if(output_status!=DEHERM_DMSDK_CSTRING_OK)return output_status;\n    if(!native_result&&!descriptor.nullable_result)return DEHERM_DMSDK_CSTRING_UNEXPECTED_NULL_RESULT;\n    return DEHERM_DMSDK_CSTRING_OK;`;
  if (result.kind === "void") return `${prologue.join("\n")}\n    ${call};\n    return DEHERM_DMSDK_CSTRING_OK;`;
  if (result.kind === "scalar" && result.name === "bool")
    return `${prologue.join("\n")}\n    *out_scalar = ${call} ? UINT64_C(1) : UINT64_C(0);\n    return DEHERM_DMSDK_CSTRING_OK;`;
  if (result.kind === "scalar" && ["i8", "i16", "i32", "i64", "isize", "word-signed"].includes(result.name))
    return `${prologue.join("\n")}\n    *out_scalar = static_cast<uint64_t>(static_cast<int64_t>(${call}));\n    return DEHERM_DMSDK_CSTRING_OK;`;
  if (result.kind === "enum")
    return `${prologue.join("\n")}\n    *out_scalar = encode_enum(${call});\n    return DEHERM_DMSDK_CSTRING_OK;`;
  return `${prologue.join("\n")}\n    *out_scalar = static_cast<uint64_t>(${call});\n    return DEHERM_DMSDK_CSTRING_OK;`;
}
function storageShape(entries) {
  const counts = entries.map(({ row }) => ({
    strings: row.signature.parameters.filter(({ type }) => type.kind === "cstring").length,
    scalars: row.signature.parameters.filter(({ type }) => type.kind !== "cstring").length,
  }));
  return {
    strings: Math.max(1, ...counts.map((x) => x.strings)),
    scalars: Math.max(1, ...counts.map((x) => x.scalars)),
  };
}
function renderHeader(entries, scratchCapacity) {
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
#define DEHERM_DMSDK_CSTRING_TLS_SCRATCH_CAPACITY UINT32_C(${scratchCapacity})
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
const RUNTIME = `// Generated by scripts/generate-dmsdk-cstring-value-bindings.mjs. Do not edit.
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
function renderNative(entries, storage, domains) {
  const includes = [...new Set(entries.map(({ row }) => includeFor(row.provenance.header)))]
    .sort()
    .map((value) => `#include <${value}>`)
    .join("\n");
  const descriptors = entries
    .map((entry) => {
      const strings = entry.row.signature.parameters.filter(({ type }) => type.kind === "cstring").length;
      const scalars = entry.row.signature.parameters.length - strings;
      const nullable = entry.contract?.result?.nullability === "nullable" ? 1 : 0;
      return `  {UINT32_C(${entry.stableId}),${strings},${scalars},${kind(entry.row.signature.result)},${nullable},${quote(entry.row.projectionId)},${quote(entry.row.id)}},`;
    })
    .join("\n");
  const assertions = domains
    .map(({ name }) => `static_assert(sizeof(${name})<=sizeof(int32_t),"${name} exceeds the exact JS-safe enum lane");`)
    .join("\n");
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
${domains.map(renderEnumDecoder).join("\n")}
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
function tsType(type) {
  if (type.kind === "cstring") return "string";
  if (type.kind === "void") return "void";
  if (type.kind === "scalar" && ["u64", "i64", "usize", "isize", "word-signed", "word-unsigned"].includes(type.name))
    return "bigint";
  if (type.kind === "scalar" && type.name === "bool") return "boolean";
  return "number";
}
function renderTypescript(entries) {
  const ids = entries.map((entry, index) => `  ${entry.typescriptName}: ${index},`).join("\n");
  const functions = entries
    .map((entry) => {
      const params = entry.row.signature.parameters.map((p, i) => `${camel(p.name || `arg ${i}`)}: ${tsType(p.type)}`);
      const names = entry.row.signature.parameters.map((p, i) => camel(p.name || `arg ${i}`));
      const result =
        tsType(entry.row.signature.result) + (entry.contract?.result?.nullability === "nullable" ? " | undefined" : "");
      return `/** ${entry.row.provenance.nativeSignature}. Source: ${entry.row.provenance.header}:${entry.row.provenance.line}. */\nexport function ${entry.typescriptName}(${params.join(", ")}): ${result} { return module().call(DmSdkCStringValueId.${entry.typescriptName}${names.length ? `, ${names.join(", ")}` : ""}) as ${result}; }`;
    })
    .join("\n\n");
  return `// Generated by scripts/generate-dmsdk-cstring-value-bindings.mjs. Do not edit.\ninterface DmSdkCStringValueModule { call(id:number,...args:readonly unknown[]):unknown; }\ndeclare global { var __defoldModulesV1:Record<string,object>|undefined; }\nfunction module():DmSdkCStringValueModule { const value=globalThis.__defoldModulesV1?.DmSdkCStringValue as DmSdkCStringValueModule|undefined;if(!value)throw new Error("Defold module is not registered: DmSdkCStringValue");return value; }\nexport const DmSdkCStringValueId={\n${ids}\n} as const;\n${functions}\n`;
}
function renderBrowser(entries) {
  const rows = entries
    .map((entry, index) => {
      const strings = entry.row.signature.parameters.filter(({ type }) => type.kind === "cstring").length;
      const scalarKinds = entry.row.signature.parameters
        .filter(({ type }) => type.kind !== "cstring")
        .map(({ type }) => (type.kind === "scalar" ? type.name : `enum:${type.name}`));
      const result = entry.row.signature.result;
      const resultKind =
        result.kind === "scalar" ? result.name : result.kind === "enum" ? `enum:${result.name}` : result.kind;
      return `      {id:${index},stableId:${entry.stableId},strings:${strings},scalarKinds:Object.freeze(${quote(scalarKinds)}),resultKind:${quote(resultKind)},resultLaneBytes:${result.kind === "void" ? 0 : result.kind === "cstring" ? 1 : 8},nullableResult:${entry.contract?.result?.nullability === "nullable"}}`;
    })
    .join(",\n");
  return `// Generated by scripts/generate-dmsdk-cstring-value-bindings.mjs. Do not edit.\nvar LibraryDefoldHermesDmSdkCStringValue={\n  $DEFOLD_HERMES_DMSDK_CSTRING_VALUE:{install:function(){return Object.freeze({privateStaging:true,registered:false,abi:"direct-wasm-memory-v1",dispatch:"deherm_dmsdk_cstring_value_dispatch",viewLayout:Object.freeze({data:0,length:4,size:8}),scratchLayout:Object.freeze({data:0,capacity:4,used:8,size:12}),outputLayout:Object.freeze({scalarBytes:8,requiredBytes:4,presentBytes:1,capacityIncludesTrailingNul:true}),stringInputContract:Object.freeze({encoding:"utf8",emptyView:"null-data-with-zero-length-means-empty",embeddedNul:"rejected",terminator:"synthesized-in-scratch"}),routes:Object.freeze([\n${rows}\n    ])});}}\n};\nautoAddDeps(LibraryDefoldHermesDmSdkCStringValue,'$DEFOLD_HERMES_DMSDK_CSTRING_VALUE');addToLibrary(LibraryDefoldHermesDmSdkCStringValue);\n`;
}

function renderJsi(entries, storage) {
  const cases = entries
    .map((entry, id) => {
      const params = entry.row.signature.parameters;
      let stringIndex = 0,
        scalarIndex = 0;
      const encode = params
        .map((parameter, index) => {
          if (parameter.type.kind === "cstring") {
            const current = stringIndex++;
            return `        if(!args[${index + 1}].isString())throw jsi::JSError(runtime,"dmSDK C-string argument must be string"); encoded[${current}]=args[${index + 1}].getString(runtime).utf8(runtime); if(encoded[${current}].size()>=std::numeric_limits<uint32_t>::max())throw jsi::JSError(runtime,"dmSDK C-string argument is too large"); views[${current}]={reinterpret_cast<const uint8_t*>(encoded[${current}].data()),static_cast<uint32_t>(encoded[${current}].size())};`;
          }
          const current = scalarIndex++;
          if (parameter.type.kind === "scalar" && parameter.type.name === "u64")
            return `        if(!args[${index + 1}].isBigInt())throw jsi::JSError(runtime,"dmSDK u64 argument must be bigint"); {const auto bigint=args[${index + 1}].asBigInt(runtime);if(!bigint.isUint64(runtime))throw jsi::JSError(runtime,"dmSDK u64 argument is out of range");scalars[${current}]=bigint.asUint64(runtime);}`;
          if (parameter.type.kind === "scalar" && parameter.type.name === "u32")
            return `        if(!args[${index + 1}].isNumber()||!std::isfinite(args[${index + 1}].asNumber())||std::trunc(args[${index + 1}].asNumber())!=args[${index + 1}].asNumber()||args[${index + 1}].asNumber()<0||args[${index + 1}].asNumber()>UINT32_MAX)throw jsi::JSError(runtime,"dmSDK u32 argument is out of range");scalars[${current}]=static_cast<uint32_t>(args[${index + 1}].asNumber());`;
          return `        if(!args[${index + 1}].isNumber()||!std::isfinite(args[${index + 1}].asNumber())||std::trunc(args[${index + 1}].asNumber())!=args[${index + 1}].asNumber()||args[${index + 1}].asNumber()<-9007199254740991.0||args[${index + 1}].asNumber()>9007199254740991.0)throw jsi::JSError(runtime,"dmSDK enum argument must be a safe integer");scalars[${current}]=static_cast<uint64_t>(static_cast<int64_t>(args[${index + 1}].asNumber()));`;
        })
        .join("\n");
      return `      case ${id}: { if(count!=${params.length + 1})throw jsi::JSError(runtime,"Wrong dmSDK C-string argument count");\n${encode}\n        break; }`;
    })
    .join("\n");
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

export function renderDmSdkCStringValueOutputs(rawFacts) {
  const facts = unpack(rawFacts),
    entries = facts.entries,
    storage = storageShape(entries);
  return Object.freeze({
    header: renderHeader(entries, facts.scratchCapacity),
    runtime: RUNTIME,
    native: renderNative(entries, storage, facts.domains),
    jsi: renderJsi(entries, storage),
    typescript: renderTypescript(entries),
    browser: renderBrowser(entries),
    storage,
  });
}
