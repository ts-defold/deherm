export const DMSDK_SCRATCH_SCALAR_OUT_RECIPE_FACTS_KIND = "deherm.dmsdk-scratch-scalar-out-recipe-facts";
export const DMSDK_SCRATCH_SCALAR_OUT_RECIPE_FACTS_SCHEMA_VERSION = 1;

export const DMSDK_SCRATCH_SCALAR_OUT_OUTPUTS = Object.freeze({
  header: "defold/defold_hermes/include/defold_hermes/generated_dmsdk_scratch_scalar_out.h",
  runtime: "defold/defold_hermes/src/generated_dmsdk_scratch_scalar_out_runtime.cpp",
  jsiHeader: "defold/defold_hermes/include/defold_hermes/generated_dmsdk_scratch_scalar_out_jsi.hpp",
  jsi: "defold/defold_hermes/src/generated_dmsdk_scratch_scalar_out_jsi.cpp",
  browser: "defold/defold_hermes/lib/web/generated_dmsdk_scratch_scalar_out.js",
  typescript: "packages/sdk/src/generated/dmsdk/scratch-scalar-out.ts",
  staticHermes: "packages/static-hermes/src/generated/dmsdk-scratch-scalar-out.ts",
  headerAudit: "native/generated_dmsdk_scratch_scalar_out_header_audit.cpp",
});

const snake = (value) =>
  String(value)
    .replace(/::/g, "_")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();

const camel = (value) =>
  snake(value)
    .split("_")
    .filter(Boolean)
    .map((word, index) => (index ? word[0].toUpperCase() + word.slice(1) : word))
    .join("");

function cKind(kind) {
  return {
    handle: "DEHERM_DMSDK_SCRATCH_HANDLE",
    bool: "DEHERM_DMSDK_SCRATCH_BOOL",
    i32: "DEHERM_DMSDK_SCRATCH_I32",
    u16: "DEHERM_DMSDK_SCRATCH_U16",
    u32: "DEHERM_DMSDK_SCRATCH_U32",
    u64: "DEHERM_DMSDK_SCRATCH_U64",
    f32: "DEHERM_DMSDK_SCRATCH_F32",
    enum: "DEHERM_DMSDK_SCRATCH_ENUM",
    void: "DEHERM_DMSDK_SCRATCH_VOID",
  }[kind];
}

const cDirection = (direction) => `DEHERM_DMSDK_SCRATCH_${direction.toUpperCase()}`;

function tsType(value) {
  if (value.kind === "void") return "undefined";
  if (value.kind === "handle") return `ScratchBorrowedHandle<${JSON.stringify(value.handleName)}>`;
  if (value.kind === "bool") return "boolean";
  if (value.kind === "u64") return "bigint";
  return "number";
}

function outputName(parameter) {
  const name = camel(parameter.name);
  return `output${name ? name[0].toUpperCase() + name.slice(1) : `Value${parameter.position}`}`;
}

function normalizeRecipeFacts(recipeFacts) {
  if (
    recipeFacts?.schemaVersion !== DMSDK_SCRATCH_SCALAR_OUT_RECIPE_FACTS_SCHEMA_VERSION ||
    recipeFacts?.kind !== DMSDK_SCRATCH_SCALAR_OUT_RECIPE_FACTS_KIND
  ) {
    throw new Error("invalid dmSDK scratch scalar-out recipe facts");
  }
  if (!Array.isArray(recipeFacts.bindings) || !Array.isArray(recipeFacts.handleKinds)) {
    throw new Error("scratch scalar-out recipe facts are missing bindings or handle kinds");
  }
  const handleKinds = recipeFacts.handleKinds.map(({ name, representation }, id) => ({ id, name, representation }));
  const handleNames = new Set(handleKinds.map(({ name }) => name));
  if (handleNames.size !== handleKinds.length) throw new Error("scratch handle kind names must be unique");
  const initialNames = recipeFacts.bindings.map(({ symbol }) => camel(symbol));
  const counts = new Map();
  for (const name of initialNames) counts.set(name, (counts.get(name) ?? 0) + 1);
  const names = new Set();
  const bindings = recipeFacts.bindings.map((binding, id) => {
    const functionName = counts.get(initialNames[id]) === 1 ? initialNames[id] : `${initialNames[id]}Binding${id}`;
    if (!functionName || names.has(functionName)) {
      throw new Error("scratch TypeScript names must be unique");
    }
    names.add(functionName);
    if (!cKind(binding.result.kind)) throw new Error(`${binding.declarationId}: unsupported scratch result kind`);
    if (!Array.isArray(binding.parameters)) throw new Error(`${binding.declarationId}: scratch parameters are missing`);
    for (const parameter of binding.parameters) {
      if (!cKind(parameter.kind)) throw new Error(`${binding.declarationId}: unsupported scratch parameter kind`);
      if (!new Set(["value", "in", "out", "inout"]).has(parameter.direction)) {
        throw new Error(`${binding.declarationId}: unsupported scratch parameter direction`);
      }
      if (parameter.kind === "handle" && !handleNames.has(parameter.handleName)) {
        throw new Error(`${binding.declarationId}: unknown scratch handle kind`);
      }
    }
    return { ...binding, id, functionName };
  });
  return {
    ...recipeFacts,
    maxParameters: Math.max(0, ...bindings.map(({ parameters }) => parameters.length)),
    maxOutputs: Math.max(
      0,
      ...bindings.map(
        ({ parameters }) => parameters.filter(({ direction }) => direction === "out" || direction === "inout").length,
      ),
    ),
    handleKinds,
    bindings,
  };
}

export function createDmSdkScratchScalarOutRecipeFacts({ defoldRevision, entries, handleKinds }) {
  const bindings = entries.map((entry) => ({
    declarationId: entry.projection.id,
    symbol: entry.projection.symbol,
    result: { kind: entry.result.kind },
    parameters: entry.parameters.map((parameter) => ({
      position: parameter.position,
      name: parameter.name,
      kind: parameter.kind,
      handleName: parameter.handleName ?? null,
      direction: parameter.direction,
    })),
  }));
  const recipeFacts = {
    schemaVersion: DMSDK_SCRATCH_SCALAR_OUT_RECIPE_FACTS_SCHEMA_VERSION,
    kind: DMSDK_SCRATCH_SCALAR_OUT_RECIPE_FACTS_KIND,
    defoldRevision,
    handleKinds: [...handleKinds.values()].map(({ name, representation }) => ({ name, representation })),
    bindings,
  };
  normalizeRecipeFacts(recipeFacts);
  return recipeFacts;
}

function renderHeader(recipe) {
  const maxParameters = Math.max(1, recipe.maxParameters);
  return `// Generated by scripts/generate-dmsdk-scratch-scalar-out-bindings.mjs. Do not edit.\n#ifndef DEFOLD_HERMES_GENERATED_DMSDK_SCRATCH_SCALAR_OUT_H\n#define DEFOLD_HERMES_GENERATED_DMSDK_SCRATCH_SCALAR_OUT_H\n#include <stdint.h>\n#define DEHERM_DMSDK_SCRATCH_PROVIDER_ABI UINT32_C(2)\n#define DEHERM_DMSDK_SCRATCH_MAX_PARAMETERS ${maxParameters}\n#define DEHERM_DMSDK_SCRATCH_NO_HANDLE_KIND UINT16_MAX\ntypedef enum DehermDmSdkScratchKind { DEHERM_DMSDK_SCRATCH_HANDLE=1, DEHERM_DMSDK_SCRATCH_BOOL=2, DEHERM_DMSDK_SCRATCH_I32=3, DEHERM_DMSDK_SCRATCH_U32=4, DEHERM_DMSDK_SCRATCH_U64=5, DEHERM_DMSDK_SCRATCH_F32=6, DEHERM_DMSDK_SCRATCH_ENUM=7, DEHERM_DMSDK_SCRATCH_U16=8, DEHERM_DMSDK_SCRATCH_VOID=9 } DehermDmSdkScratchKind;\ntypedef enum DehermDmSdkScratchDirection { DEHERM_DMSDK_SCRATCH_VALUE=1, DEHERM_DMSDK_SCRATCH_IN=2, DEHERM_DMSDK_SCRATCH_OUT=3, DEHERM_DMSDK_SCRATCH_INOUT=4 } DehermDmSdkScratchDirection;\ntypedef enum DehermDmSdkScratchStatus { DEHERM_DMSDK_SCRATCH_OK=0, DEHERM_DMSDK_SCRATCH_UNKNOWN_ID=1, DEHERM_DMSDK_SCRATCH_WRONG_ARITY=2, DEHERM_DMSDK_SCRATCH_NULL_STORAGE=3, DEHERM_DMSDK_SCRATCH_PROVIDER_MISSING=4, DEHERM_DMSDK_SCRATCH_WRONG_THREAD=5, DEHERM_DMSDK_SCRATCH_INVALID_HANDLE=6, DEHERM_DMSDK_SCRATCH_INVALID_PROVIDER=7, DEHERM_DMSDK_SCRATCH_PROVIDER_ERROR=8, DEHERM_DMSDK_SCRATCH_REENTRANT=9, DEHERM_DMSDK_SCRATCH_INVALID_LANE=10 } DehermDmSdkScratchStatus;\ntypedef struct DehermDmSdkScratchDescriptor { uint16_t id; uint8_t parameter_count; uint8_t js_argument_count; uint8_t output_count; uint8_t result_kind; uint8_t parameter_kinds[DEHERM_DMSDK_SCRATCH_MAX_PARAMETERS]; uint8_t parameter_directions[DEHERM_DMSDK_SCRATCH_MAX_PARAMETERS]; uint16_t handle_kinds[DEHERM_DMSDK_SCRATCH_MAX_PARAMETERS]; const char* declaration_id; } DehermDmSdkScratchDescriptor;\ntypedef struct DehermDmSdkScratchHandleKind { uint16_t id; const char* name; const char* native_representation; } DehermDmSdkScratchHandleKind;\ntypedef uint8_t (*DehermDmSdkScratchCurrentThreadFn)(void* context);\ntypedef uint8_t (*DehermDmSdkScratchValidateHandleFn)(void* context, uint16_t handle_kind, uint64_t value);\ntypedef DehermDmSdkScratchStatus (*DehermDmSdkScratchInvokeFn)(void* context, uint16_t id, uint64_t* parameter_slots, uint32_t parameter_count, uint64_t* out_result);\ntypedef struct DehermDmSdkScratchProvider { uint32_t abi_version; void* context; DehermDmSdkScratchCurrentThreadFn is_current_thread; DehermDmSdkScratchValidateHandleFn validate_handle; DehermDmSdkScratchInvokeFn invoke; } DehermDmSdkScratchProvider;\n#ifdef __cplusplus\nextern "C" {\n#endif\nuint32_t deherm_dmsdk_scratch_count(void);\nconst DehermDmSdkScratchDescriptor* deherm_dmsdk_scratch_descriptors(void);\nuint32_t deherm_dmsdk_scratch_handle_kind_count(void);\nconst DehermDmSdkScratchHandleKind* deherm_dmsdk_scratch_handle_kinds(void);\nDehermDmSdkScratchStatus deherm_dmsdk_scratch_set_provider(const DehermDmSdkScratchProvider* provider);\nDehermDmSdkScratchStatus deherm_dmsdk_scratch_dispatch(uint16_t id, uint64_t* parameter_slots, uint32_t parameter_count, uint64_t* out_result);\n#ifdef __cplusplus\n}\n#endif\n#endif\n`;
}

function renderRuntime(recipe) {
  const maxParameters = Math.max(1, recipe.maxParameters);
  const handleKindByName = new Map(recipe.handleKinds.map((value) => [value.name, value]));
  const descriptorRows = recipe.bindings
    .map((entry) => {
      const kinds = entry.parameters.map(({ kind }) => cKind(kind));
      const directions = entry.parameters.map(({ direction }) => cDirection(direction));
      const handles = entry.parameters.map(({ handleName }) =>
        handleName ? handleKindByName.get(handleName).id : "DEHERM_DMSDK_SCRATCH_NO_HANDLE_KIND",
      );
      while (kinds.length < maxParameters) kinds.push("0");
      while (directions.length < maxParameters) directions.push("0");
      while (handles.length < maxParameters) handles.push("DEHERM_DMSDK_SCRATCH_NO_HANDLE_KIND");
      return `  { UINT16_C(${entry.id}), UINT8_C(${entry.parameters.length}), UINT8_C(${entry.parameters.filter(({ direction }) => direction !== "out").length}), UINT8_C(${entry.parameters.filter(({ direction }) => direction === "out" || direction === "inout").length}), UINT8_C(${cKind(entry.result.kind)}), { ${kinds.join(", ")} }, { ${directions.join(", ")} }, { ${handles.map((value) => (typeof value === "number" ? `UINT16_C(${value})` : value)).join(", ")} }, ${JSON.stringify(entry.declarationId)} }`;
    })
    .join(",\n");
  const handleRows = recipe.handleKinds
    .map(
      ({ id, name, representation }) =>
        `  { UINT16_C(${id}), ${JSON.stringify(name)}, ${JSON.stringify(representation)} }`,
    )
    .join(",\n");
  return `// Generated by scripts/generate-dmsdk-scratch-scalar-out-bindings.mjs. Do not edit.\n#include <defold_hermes/generated_dmsdk_scratch_scalar_out.h>\n#include <string.h>\nnamespace {\nconst DehermDmSdkScratchDescriptor kDescriptors[] = {\n${descriptorRows}\n};\nconst DehermDmSdkScratchHandleKind kHandleKinds[] = {\n${handleRows}\n};\nDehermDmSdkScratchProvider gProvider = {};\nthread_local bool gDispatchActive = false;\nbool validLane(uint8_t kind, uint64_t value) {\n  if (kind == DEHERM_DMSDK_SCRATCH_VOID) return value == UINT64_C(0);\n  if (kind == DEHERM_DMSDK_SCRATCH_BOOL) return value <= UINT64_C(1);\n  if (kind == DEHERM_DMSDK_SCRATCH_U16) return value <= UINT64_C(0xffff);\n  if (kind == DEHERM_DMSDK_SCRATCH_U32 || kind == DEHERM_DMSDK_SCRATCH_F32) return value <= UINT64_C(0xffffffff);\n  if (kind == DEHERM_DMSDK_SCRATCH_I32 || kind == DEHERM_DMSDK_SCRATCH_ENUM) return value == static_cast<uint64_t>(static_cast<int64_t>(static_cast<int32_t>(value)));\n  return true;\n}\nvoid clearWritable(const DehermDmSdkScratchDescriptor& descriptor, uint64_t* slots) { for (uint32_t index=0; index<descriptor.parameter_count; ++index) if (descriptor.parameter_directions[index] == DEHERM_DMSDK_SCRATCH_OUT || descriptor.parameter_directions[index] == DEHERM_DMSDK_SCRATCH_INOUT) slots[index]=0; }\nstruct DispatchScope { DispatchScope(){gDispatchActive=true;} ~DispatchScope(){gDispatchActive=false;} };\n}\nextern "C" {\nuint32_t deherm_dmsdk_scratch_count(void) { return UINT32_C(${recipe.bindings.length}); }\nconst DehermDmSdkScratchDescriptor* deherm_dmsdk_scratch_descriptors(void) { return kDescriptors; }\nuint32_t deherm_dmsdk_scratch_handle_kind_count(void) { return UINT32_C(${recipe.handleKinds.length}); }\nconst DehermDmSdkScratchHandleKind* deherm_dmsdk_scratch_handle_kinds(void) { return kHandleKinds; }\nDehermDmSdkScratchStatus deherm_dmsdk_scratch_set_provider(const DehermDmSdkScratchProvider* provider) {\n  if (provider == nullptr) { memset(&gProvider, 0, sizeof(gProvider)); return DEHERM_DMSDK_SCRATCH_OK; }\n  if (provider->abi_version != DEHERM_DMSDK_SCRATCH_PROVIDER_ABI || provider->is_current_thread == nullptr || provider->validate_handle == nullptr || provider->invoke == nullptr) return DEHERM_DMSDK_SCRATCH_INVALID_PROVIDER;\n  gProvider = *provider; return DEHERM_DMSDK_SCRATCH_OK;\n}\nDehermDmSdkScratchStatus deherm_dmsdk_scratch_dispatch(uint16_t id, uint64_t* slots, uint32_t parameter_count, uint64_t* out_result) {\n  if (id >= deherm_dmsdk_scratch_count()) return DEHERM_DMSDK_SCRATCH_UNKNOWN_ID;\n  const DehermDmSdkScratchDescriptor& descriptor = kDescriptors[id];\n  if (parameter_count != descriptor.parameter_count) return DEHERM_DMSDK_SCRATCH_WRONG_ARITY;\n  if (slots == nullptr || out_result == nullptr) return DEHERM_DMSDK_SCRATCH_NULL_STORAGE;\n  *out_result = 0;\n  for (uint32_t index=0; index<parameter_count; ++index) if (descriptor.parameter_directions[index] == DEHERM_DMSDK_SCRATCH_OUT) slots[index]=0;\n  if (gProvider.invoke == nullptr) { clearWritable(descriptor, slots); return DEHERM_DMSDK_SCRATCH_PROVIDER_MISSING; }\n  if (gDispatchActive) { clearWritable(descriptor, slots); return DEHERM_DMSDK_SCRATCH_REENTRANT; }\n  if (gProvider.is_current_thread(gProvider.context) == 0) { clearWritable(descriptor, slots); return DEHERM_DMSDK_SCRATCH_WRONG_THREAD; }\n  for (uint32_t index=0; index<parameter_count; ++index) {\n    if (descriptor.parameter_directions[index] != DEHERM_DMSDK_SCRATCH_OUT && !validLane(descriptor.parameter_kinds[index], slots[index])) { clearWritable(descriptor, slots); return DEHERM_DMSDK_SCRATCH_INVALID_LANE; }\n    if (descriptor.parameter_kinds[index] == DEHERM_DMSDK_SCRATCH_HANDLE && (slots[index] == 0 || gProvider.validate_handle(gProvider.context, descriptor.handle_kinds[index], slots[index]) == 0)) { clearWritable(descriptor, slots); return DEHERM_DMSDK_SCRATCH_INVALID_HANDLE; }\n  }\n  DispatchScope scope;\n  const DehermDmSdkScratchStatus status = gProvider.invoke(gProvider.context, id, slots, parameter_count, out_result);\n  if (status != DEHERM_DMSDK_SCRATCH_OK || !validLane(descriptor.result_kind, *out_result)) { clearWritable(descriptor, slots); *out_result=0; return status == DEHERM_DMSDK_SCRATCH_OK ? DEHERM_DMSDK_SCRATCH_INVALID_LANE : status; }\n  for (uint32_t index=0; index<parameter_count; ++index) if ((descriptor.parameter_directions[index] == DEHERM_DMSDK_SCRATCH_OUT || descriptor.parameter_directions[index] == DEHERM_DMSDK_SCRATCH_INOUT) && !validLane(descriptor.parameter_kinds[index], slots[index])) { clearWritable(descriptor, slots); *out_result=0; return DEHERM_DMSDK_SCRATCH_INVALID_LANE; }\n  return DEHERM_DMSDK_SCRATCH_OK;\n}\n}\n`;
}

const renderJsiHeader = () =>
  `// Generated by scripts/generate-dmsdk-scratch-scalar-out-bindings.mjs. Do not edit.\n#pragma once\n#if !defined(DM_PLATFORM_HTML5)\n#include <jsi/jsi.h>\nnamespace defold_hermes { void installDmSdkScratchScalarOutModule(facebook::jsi::Runtime&, facebook::jsi::Object&); }\n#endif\n`;

function renderJsi(recipe) {
  const maxParameters = Math.max(1, recipe.maxParameters);
  return `// Generated by scripts/generate-dmsdk-scratch-scalar-out-bindings.mjs. Do not edit.\n#include <defold_hermes/generated_dmsdk_scratch_scalar_out_jsi.hpp>\n#if !defined(DM_PLATFORM_HTML5)\n#include <defold_hermes/generated_dmsdk_scratch_scalar_out.h>\n#include <cmath>\n#include <cstring>\nnamespace defold_hermes { namespace jsi=facebook::jsi; namespace {\nbool integer(const jsi::Value& value){return value.isNumber()&&std::isfinite(value.asNumber())&&std::trunc(value.asNumber())==value.asNumber();}\nuint64_t encode(jsi::Runtime& runtime,const jsi::Value& value,uint8_t kind){if(kind==DEHERM_DMSDK_SCRATCH_HANDLE||kind==DEHERM_DMSDK_SCRATCH_U64){if(!value.isBigInt())throw jsi::JSError(runtime,"expected u64 bigint");auto bigint=value.getBigInt(runtime);if(!bigint.isUint64(runtime))throw jsi::JSError(runtime,"bigint outside u64 range");auto raw=bigint.asUint64(runtime);if(kind==DEHERM_DMSDK_SCRATCH_HANDLE&&raw==0)throw jsi::JSError(runtime,"handle must be nonzero");return raw;}if(kind==DEHERM_DMSDK_SCRATCH_BOOL){if(!value.isBool())throw jsi::JSError(runtime,"expected boolean");return value.getBool()?1:0;}if(!value.isNumber()||!std::isfinite(value.asNumber()))throw jsi::JSError(runtime,"expected finite number");const double number=value.asNumber();if(kind==DEHERM_DMSDK_SCRATCH_F32){const float narrowed=static_cast<float>(number);uint32_t bits=0;std::memcpy(&bits,&narrowed,4);return bits;}if(!integer(value))throw jsi::JSError(runtime,"expected integer");if(kind==DEHERM_DMSDK_SCRATCH_U16&&(number<0||number>65535.0))throw jsi::JSError(runtime,"u16 out of range");if(kind==DEHERM_DMSDK_SCRATCH_U32&&(number<0||number>4294967295.0))throw jsi::JSError(runtime,"u32 out of range");if((kind==DEHERM_DMSDK_SCRATCH_I32||kind==DEHERM_DMSDK_SCRATCH_ENUM)&&(number<-2147483648.0||number>2147483647.0))throw jsi::JSError(runtime,"i32 out of range");return (kind==DEHERM_DMSDK_SCRATCH_I32||kind==DEHERM_DMSDK_SCRATCH_ENUM)?static_cast<uint64_t>(static_cast<int64_t>(static_cast<int32_t>(number))):static_cast<uint64_t>(number);}\njsi::Value decode(jsi::Runtime& runtime,uint8_t kind,uint64_t raw){if(kind==DEHERM_DMSDK_SCRATCH_VOID)return jsi::Value::undefined();if(kind==DEHERM_DMSDK_SCRATCH_BOOL)return jsi::Value(raw!=0);if(kind==DEHERM_DMSDK_SCRATCH_U64)return jsi::Value(runtime,jsi::BigInt::fromUint64(runtime,raw));if(kind==DEHERM_DMSDK_SCRATCH_I32||kind==DEHERM_DMSDK_SCRATCH_ENUM)return jsi::Value(static_cast<double>(static_cast<int32_t>(raw)));if(kind==DEHERM_DMSDK_SCRATCH_F32){uint32_t bits=static_cast<uint32_t>(raw);float value=0;std::memcpy(&value,&bits,4);return jsi::Value(static_cast<double>(value));}return jsi::Value(static_cast<double>(static_cast<uint32_t>(raw)));}\n}\nvoid installDmSdkScratchScalarOutModule(jsi::Runtime& runtime,jsi::Object& modules){jsi::Object module(runtime);auto call=jsi::Function::createFromHostFunction(runtime,jsi::PropNameID::forAscii(runtime,"call"),2,[](jsi::Runtime& runtime,const jsi::Value&,const jsi::Value* args,size_t count){if(count==0||!integer(args[0])||args[0].asNumber()<0||args[0].asNumber()>65535)throw jsi::JSError(runtime,"scratch call expects u16 id");const uint16_t id=static_cast<uint16_t>(args[0].asNumber());if(id>=deherm_dmsdk_scratch_count())throw jsi::JSError(runtime,"unknown scratch id");const auto& descriptor=deherm_dmsdk_scratch_descriptors()[id];if(count!=static_cast<size_t>(descriptor.js_argument_count)+1)throw jsi::JSError(runtime,"wrong scratch arity");uint64_t slots[${maxParameters}]={};size_t input=1;for(uint8_t index=0;index<descriptor.parameter_count;++index)if(descriptor.parameter_directions[index]!=DEHERM_DMSDK_SCRATCH_OUT)slots[index]=encode(runtime,args[input++],descriptor.parameter_kinds[index]);uint64_t result=0;const auto status=deherm_dmsdk_scratch_dispatch(id,slots,descriptor.parameter_count,&result);if(status!=DEHERM_DMSDK_SCRATCH_OK)throw jsi::JSError(runtime,"scratch scalar-out dispatch failed");jsi::Array output(runtime,static_cast<size_t>(descriptor.output_count)+1);output.setValueAtIndex(runtime,0,decode(runtime,descriptor.result_kind,result));size_t outputIndex=1;for(uint8_t index=0;index<descriptor.parameter_count;++index)if(descriptor.parameter_directions[index]==DEHERM_DMSDK_SCRATCH_OUT||descriptor.parameter_directions[index]==DEHERM_DMSDK_SCRATCH_INOUT)output.setValueAtIndex(runtime,outputIndex++,decode(runtime,descriptor.parameter_kinds[index],slots[index]));return output;});module.setProperty(runtime,"call",std::move(call));modules.setProperty(runtime,"DmSdkScratchScalarOut",std::move(module));}\n}\n#endif\n`;
}

function renderBrowser(recipe) {
  const descriptors = recipe.bindings
    .map(
      (entry) =>
        `{id:${entry.id},resultKind:${JSON.stringify(entry.result.kind)},parameterKinds:Object.freeze(${JSON.stringify(entry.parameters.map(({ kind }) => kind))}),directions:Object.freeze(${JSON.stringify(entry.parameters.map(({ direction }) => direction))}),handleKinds:Object.freeze(${JSON.stringify(entry.parameters.map(({ handleName }) => handleName))}),declarationId:${JSON.stringify(entry.declarationId)}}`,
    )
    .join(",\n      ");
  return `// Generated by scripts/generate-dmsdk-scratch-scalar-out-bindings.mjs. Do not edit.\nvar LibraryDefoldHermesDmSdkScratchScalarOut={\n  $DEFOLD_HERMES_DMSDK_SCRATCH_SCALAR_OUT__deps:['deherm_dmsdk_scratch_dispatch'],\n  $DEFOLD_HERMES_DMSDK_SCRATCH_SCALAR_OUT:{\n    abi:Object.freeze({slotBytes:8,maxParameters:${Math.max(1, recipe.maxParameters)},resultBytes:8,storage:'caller-owned',reentrancy:'rejected'}),\n    handleKinds:Object.freeze(${JSON.stringify(recipe.handleKinds)}),\n    descriptors:Object.freeze([\n      ${descriptors}\n    ]),\n    callRaw:function(id,slotsPointer,parameterCount,resultPointer){return _deherm_dmsdk_scratch_dispatch(id,slotsPointer,parameterCount,resultPointer);}\n  }\n};\nautoAddDeps(LibraryDefoldHermesDmSdkScratchScalarOut,'$DEFOLD_HERMES_DMSDK_SCRATCH_SCALAR_OUT');\naddToLibrary(LibraryDefoldHermesDmSdkScratchScalarOut);\n`;
}

function renderTypeScript(recipe) {
  const ids = recipe.bindings.map((entry) => `  ${entry.functionName}: ${entry.id}`).join(",\n");
  const functions = recipe.bindings
    .map((entry) => {
      const inputs = entry.parameters.filter(({ direction }) => direction !== "out");
      const outputs = entry.parameters.filter(({ direction }) => direction === "out" || direction === "inout");
      const parameters = inputs.map((parameter) => `${camel(parameter.name)}: ${tsType(parameter)}`).join(", ");
      const argumentsList = inputs.map(({ name }) => camel(name)).join(", ");
      const resultField = entry.result.kind === "void" ? "" : `readonly result: ${tsType(entry.result)}; `;
      const resultType = `{ ${resultField}${outputs.map((output) => `readonly ${outputName(output)}: ${tsType(output)};`).join(" ")} }`;
      const fields = [
        ...(entry.result.kind === "void" ? [] : [`result:tuple[0] as ${tsType(entry.result)}`]),
        ...outputs.map(
          (output, outputIndex) => `${outputName(output)}: tuple[${outputIndex + 1}] as ${tsType(output)}`,
        ),
      ].join(", ");
      return `/** Caller-owned one-slot scalar output bridge for ${entry.symbol}; no pointer escapes. */\nexport function ${entry.functionName}(${parameters}): ${resultType} { const tuple=module().call(DmSdkScratchScalarOutId.${entry.functionName}${argumentsList ? `, ${argumentsList}` : ""});if(tuple.length!==${outputs.length + 1})throw new Error("invalid scratch scalar-out tuple");return {${fields}}; }`;
    })
    .join("\n\n");
  return `// Generated by scripts/generate-dmsdk-scratch-scalar-out-bindings.mjs. Do not edit.\ndeclare const scratchHandleBrand: unique symbol;\nexport type ScratchBorrowedHandle<Kind extends string> = bigint & { readonly [scratchHandleBrand]: Kind };\ninterface DmSdkScratchScalarOutModule { call(id:number,...args:readonly (number|boolean|bigint)[]):readonly unknown[]; }\ndeclare global { var __defoldModulesV1: Record<string,object>|undefined; }\nfunction module():DmSdkScratchScalarOutModule { const value=globalThis.__defoldModulesV1?.DmSdkScratchScalarOut as DmSdkScratchScalarOutModule|undefined;if(!value)throw new Error("Defold module is not registered: DmSdkScratchScalarOut");return value; }\nexport function unsafeScratchBorrowedHandle<Kind extends string>(kind:Kind,value:bigint):ScratchBorrowedHandle<Kind>{void kind;if(value<=0n||value>0xffff_ffff_ffff_ffffn)throw new RangeError("handle must be a nonzero u64");return value as ScratchBorrowedHandle<Kind>;}\nexport const DmSdkScratchScalarOutId={\n${ids}\n} as const;\n\n${functions}\n`;
}

const renderStaticHermes = () =>
  `// Generated by scripts/generate-dmsdk-scratch-scalar-out-bindings.mjs. Do not edit.\n// Caller owns contiguous u64 parameter slots and one u64 result slot.\n"use strict";\nconst __ffiDmSdkScratchScalarOutDispatch=$SHBuiltin.extern_c(\n  {include:"defold_hermes/generated_dmsdk_scratch_scalar_out.h"},\n  function deherm_dmsdk_scratch_dispatch(id:c_ushort,slotsPointer:c_ptr,parameterCount:c_uint,resultPointer:c_ptr):c_uint{throw 0;}\n);\nexport function dispatchDmSdkScratchScalarOut(id:c_ushort,slotsPointer:c_ptr,parameterCount:c_uint,resultPointer:c_ptr):c_uint{return __ffiDmSdkScratchScalarOutDispatch(id,slotsPointer,parameterCount,resultPointer);}\n`;

function resultAssertion(entry, expression) {
  if (entry.result.kind === "void") return `std::is_void<decltype(${expression})>::value`;
  if (entry.result.kind === "bool") return `std::is_same<decltype(${expression}), bool>::value`;
  if (entry.result.kind === "f32")
    return `std::is_floating_point<decltype(${expression})>::value && sizeof(decltype(${expression})) == 4`;
  if (entry.result.kind === "enum")
    return `std::is_enum<decltype(${expression})>::value && sizeof(decltype(${expression})) <= 4`;
  const bytes = entry.result.kind === "u64" ? 8 : 4;
  return `(std::is_integral<decltype(${expression})>::value || std::is_enum<decltype(${expression})>::value) && sizeof(decltype(${expression})) <= ${bytes}`;
}

export function renderDmSdkScratchScalarOutHeaderAudit(entries) {
  const headers = [...new Set(entries.map(({ audit }) => audit.header))].sort();
  const lines = [
    "// Generated by scripts/generate-dmsdk-scratch-scalar-out-bindings.mjs. Do not edit.",
    "#include <cstdint>",
    "#include <type_traits>",
    "#include <utility>",
    ...headers.map((header) => `#include <${header}>`),
    "",
  ];
  for (const entry of entries) {
    const args = entry.audit.parameterTypes.map((nativeType) => `std::declval<${nativeType}>()`).join(", ");
    const expression = `${entry.projection.symbol}(${args})`;
    lines.push(`static_assert(${resultAssertion(entry, expression)}, ${JSON.stringify(entry.projection.id)});`);
    for (const [index, parameter] of entry.parameters.entries()) {
      if (parameter.direction === "value") continue;
      const nativeType = entry.audit.parameterTypes[index];
      const bytes = parameter.kind === "u64" ? 8 : 4;
      const trait =
        parameter.kind === "f32"
          ? `std::is_floating_point<typename std::remove_pointer<${nativeType}>::type>::value && sizeof(typename std::remove_pointer<${nativeType}>::type) == 4`
          : parameter.kind === "bool"
            ? `std::is_same<typename std::remove_pointer<${nativeType}>::type, bool>::value`
            : `(std::is_integral<typename std::remove_pointer<${nativeType}>::type>::value || std::is_enum<typename std::remove_pointer<${nativeType}>::type>::value) && sizeof(typename std::remove_pointer<${nativeType}>::type) <= ${bytes}`;
      lines.push(`static_assert(${trait}, ${JSON.stringify(`${entry.projection.id}:parameter:${index}`)});`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

export function renderDmSdkScratchScalarOutOutputs(recipeFacts) {
  const recipe = normalizeRecipeFacts(recipeFacts);
  return new Map([
    [DMSDK_SCRATCH_SCALAR_OUT_OUTPUTS.header, renderHeader(recipe)],
    [DMSDK_SCRATCH_SCALAR_OUT_OUTPUTS.runtime, renderRuntime(recipe)],
    [DMSDK_SCRATCH_SCALAR_OUT_OUTPUTS.jsiHeader, renderJsiHeader()],
    [DMSDK_SCRATCH_SCALAR_OUT_OUTPUTS.jsi, renderJsi(recipe)],
    [DMSDK_SCRATCH_SCALAR_OUT_OUTPUTS.browser, renderBrowser(recipe)],
    [DMSDK_SCRATCH_SCALAR_OUT_OUTPUTS.typescript, renderTypeScript(recipe)],
    [DMSDK_SCRATCH_SCALAR_OUT_OUTPUTS.staticHermes, renderStaticHermes()],
  ]);
}
