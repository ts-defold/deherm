import { createHash } from "node:crypto";

import { verifyDmSdkCallSymbolIndex } from "./dmsdk-call-symbol-index.mjs";
import { materializeDmSdkGeneratedAdapterUsages } from "./dmsdk-concrete-call-plan.mjs";

export const dmSdkGeneratedAdapterCorpusArtifacts = Object.freeze({
  plan: "packages/bindings/generated/defold-dmsdk-generated-adapter-exact-plan.json",
  verificationSource: "tests/fixtures/generated_dmsdk_adapter_exact_verification.cpp",
  jsiVerificationSource: "tests/fixtures/generated_dmsdk_adapter_jsi_exact_verification.cpp",
});

const familyDescriptor = Object.freeze({
  arenaCString: { count: "deherm_dmsdk_arena_cstring_count", descriptors: "deherm_dmsdk_arena_cstring_descriptors", id: "id", declaration: "declaration_id" },
  scalar: { count: "deherm_dmsdk_scalar_count", descriptors: "deherm_dmsdk_scalar_descriptors", id: "id", declaration: "declaration_id" },
  enumValue: { count: "deherm_dmsdk_enum_count", descriptors: "deherm_dmsdk_enum_descriptors", id: "id", declaration: "declaration_id" },
  fixedDigest: { count: "deherm_dmsdk_fixed_digest_count", descriptors: "deherm_dmsdk_fixed_digest_descriptors", id: "id", declaration: "declaration_id" },
  hashSpan: { count: "deherm_dmsdk_hash_span_count", descriptors: "deherm_dmsdk_hash_span_descriptors", id: "id", declaration: "declaration_id" },
  hashState: { count: "deherm_dmsdk_hash_state_count", descriptors: "deherm_dmsdk_hash_state_descriptors", id: "id", declaration: "declaration_id" },
  base64Span: { count: "deherm_dmsdk_base64_span_count", descriptors: "deherm_dmsdk_base64_span_descriptors", id: "id", declaration: "declaration_id" },
  astcProbe: { count: "deherm_dmsdk_astc_probe_count", descriptors: "deherm_dmsdk_astc_probe_descriptors", id: "id", declaration: "declaration_id" },
  cstringValue: { count: "deherm_dmsdk_cstring_value_count", descriptors: "deherm_dmsdk_cstring_value_descriptors", id: null, declaration: "source_id" },
  xteaSpan: { count: "deherm_dmsdk_xtea_span_count", descriptors: null, id: null, declaration: null },
});

function compareCodeUnits(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort(compareCodeUnits)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function authenticatedCatalog(catalog, index) {
  if (!catalog || !Array.isArray(catalog.recipes) ||
      !/^[0-9a-f]{64}$/.test(catalog.sourceHashes?.catalog ?? "")) {
    throw new Error("dmSDK generated-adapter corpus requires the authenticated recipe catalog");
  }
  const digest = sha256(JSON.stringify(catalog.recipes));
  if (digest !== catalog.sourceHashes.catalog || digest !== index.catalogSha256) {
    throw new Error("dmSDK generated-adapter corpus catalog identity does not match its recipes and symbol index");
  }
  return digest;
}

export function dmSdkGeneratedAdapterUsages(index, catalog) {
  const verified = verifyDmSdkCallSymbolIndex(index, "dmSDK generated-adapter corpus symbol index");
  authenticatedCatalog(catalog, verified);
  const usages = Object.entries(verified.declarations)
    .filter(([, declaration]) => declaration.materialization.state === "generated-adapter")
    .map(([declarationId, declaration]) => Object.freeze({
      declarationId,
      materialization: declaration.materialization,
      numericId: declaration.numericId,
    }))
    .sort((left, right) => left.numericId - right.numericId || compareCodeUnits(left.declarationId, right.declarationId));
  if (usages.length !== verified.generatedAdapterCount) {
    throw new Error("dmSDK generated-adapter corpus count disagrees with its authenticated symbol index");
  }
  return Object.freeze(usages.map(({ declarationId, materialization }) => Object.freeze({ declarationId, materialization })));
}

const familyCode = Object.freeze({
  scalar: 0, enumValue: 1, fixedDigest: 2, hashSpan: 3,
  base64Span: 4, xteaSpan: 5, astcProbe: 6, cstringValue: 7,
  arenaCString: 8,
  hashState: 9,
});

function enumValue(parameter, seed) {
  const members = parameter.enumeration?.members ?? parameter.shape?.members ?? [];
  return Number(members.length ? members[seed % members.length].value : 0);
}

function signedRaw(value) {
  return value < 0 ? `static_cast<uint64_t>(INT64_C(${value}))` : `UINT64_C(${value})`;
}

function scalarSentinel(shape, id, position, result = false) {
  const seed = (result ? 0x5100 : 0x1100) + id * 17 + position;
  if (shape.kind === "void") return { raw: "UINT64_C(0)", native: "", compare: "" };
  if (shape.kind === "enum") return { raw: signedRaw(0), native: "0", compare: "" };
  if (shape.kind === "named" || shape.name === "u64") {
    const value = 0x100000000 + seed;
    return { raw: `UINT64_C(${value})`, native: `UINT64_C(${value})` };
  }
  if (shape.name === "f32") {
    const value = `${100 + id + (result ? 0.75 : 0.25)}f`;
    return { raw: `pack_f32(${value})`, native: value };
  }
  if (shape.name === "bool") return { raw: "UINT64_C(1)", native: "UINT8_C(1)" };
  return { raw: `UINT64_C(${seed})`, native: `${seed}` };
}

function wrapperType(shape, family) {
  if (shape.kind === "void") return "void";
  if (family === "enumValue" && shape.kind === "enum") return "int32_t";
  if (shape.kind === "named" || shape.name === "u64") return "uint64_t";
  if (shape.name === "bool") return "uint8_t";
  return ({ u16: "uint16_t", u32: "uint32_t", f32: "float", i32: "int32_t" })[shape.name] ?? "int32_t";
}

function renderScalarFake(vector) {
  const code = familyCode[vector.family];
  const parameters = vector.abi.parameters.map((parameter, position) => {
    const type = wrapperType(parameter.shape, vector.family);
    return `${type} a${position}`;
  });
  const validations = vector.abi.parameters.map((parameter, position) => {
    const expected = parameter.shape.kind === "enum"
      ? enumValue(parameter, vector.adapterId + position)
      : scalarSentinel(parameter.shape, vector.adapterId, position).native;
    return `if(a${position}!=static_cast<${wrapperType(parameter.shape, vector.family)}>(${expected}))++g_failures[${code}][${vector.adapterId}];`;
  }).join("");
  const resultType = wrapperType(vector.abi.resultShape, vector.family);
  let returned = "";
  if (resultType !== "void") {
    const value = vector.abi.resultShape.kind === "enum"
      ? enumValue({ enumeration: vector.abi.resultEnumeration, shape: vector.abi.resultShape }, vector.adapterId + 1)
      : scalarSentinel(vector.abi.resultShape, vector.adapterId, 0, true).native;
    returned = `return static_cast<${resultType}>(${value});`;
  }
  return `extern \"C\" ${resultType} ${vector.exactCallee}(${parameters.join(",")}){++g_calls[${code}][${vector.adapterId}];${validations}${returned}}`;
}

function cstringNativeType(parameter) {
  if (parameter.shape.kind === "enum") return parameter.shape.name;
  if (parameter.shape.kind === "cstring") return "const char*";
  if (parameter.shape.name === "bool") return "bool";
  return parameter.nativeType;
}

function renderCStringFake(vector) {
  const code = familyCode.cstringValue;
  let stringIndex = 0;
  const parameters = vector.abi.parameters.map((parameter, position) => `${cstringNativeType(parameter)} a${position}`);
  const validations = vector.abi.parameters.map((parameter, position) => {
    if (parameter.shape.kind === "cstring") {
      const expected = `exact_${vector.adapterId}_${stringIndex++}`;
      return `if(a${position}==nullptr||strcmp(a${position},${JSON.stringify(expected)})!=0)++g_failures[${code}][${vector.adapterId}];`;
    }
    const expected = parameter.shape.kind === "enum" ? enumValue(parameter, vector.adapterId + position) : scalarSentinel(parameter.shape, vector.adapterId, position).native;
    return `if(a${position}!=static_cast<${cstringNativeType(parameter)}>(${expected}))++g_failures[${code}][${vector.adapterId}];`;
  }).join("");
  let resultType = vector.abi.resultShape.kind === "enum" ? vector.abi.resultShape.name : vector.abi.resultNativeType;
  let returned = "";
  if (vector.abi.resultShape.kind === "cstring") returned = `return ${JSON.stringify(`result_${vector.adapterId}`)};`;
  else if (vector.abi.resultShape.kind === "enum") returned = `return static_cast<${resultType}>(${enumValue({ enumeration: vector.abi.resultEnumeration, shape: vector.abi.resultShape }, vector.adapterId + 1)});`;
  else if (vector.abi.resultShape.kind !== "void") returned = `return static_cast<${resultType}>(${scalarSentinel(vector.abi.resultShape, vector.adapterId, 0, true).native});`;
  return `${resultType} ${vector.invocation.nativeSymbol}(${parameters.join(",")}){++g_calls[${code}][${vector.adapterId}];${validations}${returned}}`;
}

function renderFamilyFake(vector) {
  const id = vector.adapterId;
  const code = familyCode[vector.family];
  const name = vector.exactCallee;
  if (vector.family === "arenaCString") {
    const mode = vector.familyContract.mode;
    const output = JSON.stringify(`result_${id}`);
    const input = JSON.stringify(`arena_${id}`);
    const prefix = `++g_calls[${code}][${id}];`;
    const write = `if(output&&capacity){const char* value=${output};const size_t length=strlen(value);const size_t copied=length<capacity-1?length:capacity-1;memcpy(output,value,copied);output[copied]='\\0';}`;
    if (mode === "canonical-path") {
      return `uint32_t ${name}(const char* value,char* output,uint32_t capacity){${prefix}if(!value||strcmp(value,${input})!=0||!output||capacity!=UINT32_C(64))++g_failures[${code}][${id}];${write}return UINT32_C(${500 + id});}`;
    }
    if (mode === "error-string") {
      return `void ${name}(char* output,size_t capacity,int error){${prefix}if(!output||capacity!=size_t(64)||error!=${100 + id})++g_failures[${code}][${id}];${write}}`;
    }
    if (mode === "trimmed-string") {
      return `size_t ${name}(char* output,size_t capacity,const char* value){${prefix}if(!value||strcmp(value,${input})!=0||!output||capacity!=size_t(64))++g_failures[${code}][${id}];${write}return size_t(${500 + id});}`;
    }
    if (mode === "uri-encode") {
      return `dmURI::Result ${name}(const char* value,char* output,uint32_t capacity,uint32_t* written){${prefix}if(!value||strcmp(value,${input})!=0||!output||capacity!=UINT32_C(64)||!written)++g_failures[${code}][${id}];${write}if(written)*written=UINT32_C(${`result_${id}`.length + 1});return g_arena_uri_failure?dmURI::RESULT_TOO_SMALL_BUFFER:dmURI::RESULT_OK;}`;
    }
    throw new Error(`${vector.declarationId} has unsupported arena cstring mode ${mode}`);
  }
  if (vector.family === "fixedDigest") {
    const bytes = vector.familyContract.digestBytes;
    return `extern \"C\" uint8_t ${name}(const uint8_t* input,uint32_t length,uint8_t* output,uint32_t capacity){++g_calls[${code}][${id}];if(!input||length!=UINT32_C(${5 + id})||capacity<UINT32_C(${bytes}))++g_failures[${code}][${id}];for(uint32_t i=0;i<UINT32_C(${bytes});++i)output[i]=static_cast<uint8_t>(UINT8_C(${0x70 + id})+i);return UINT8_C(1);}`;
  }
  if (vector.family === "hashSpan") {
    const out = vector.familyContract.resultBits === 32 ? "uint32_t*" : "uint64_t*";
    const value = vector.familyContract.resultBits === 32 ? `UINT32_C(${0x65000000 + id})` : `UINT64_C(${0x6500000000000000 + id})`;
    return `extern \"C\" uint8_t ${name}(const uint8_t* input,uint32_t length,${out} output){++g_calls[${code}][${id}];if(!input||length!=UINT32_C(${7 + id})||input[0]!=UINT8_C(${0x30 + id})||!output)++g_failures[${code}][${id}];*output=${value};return UINT8_C(1);}`;
  }
  if (vector.family === "hashState") {
    const operation = vector.familyContract.operation;
    const width = vector.familyContract.width;
    const state = `HashState${width}`;
    const count = `++g_calls[${code}][${id}];`;
    if (operation === "Init") return `void ${name}(${state}* s,bool reverse){${count}s->m_Hash=reverse?${width}:${width === 32 ? 3 : 6};s->m_Tail=0;s->m_Count=0;s->m_Size=0;s->m_ReverseHashEntryIndex=0;}`;
    if (operation === "Clone") return `void ${name}(${state}* d,const ${state}* s,bool reverse){${count}d->m_Hash=s->m_Hash+(reverse?${width === 32 ? 7 : 9}:1);d->m_Tail=s->m_Tail;d->m_Count=s->m_Count;d->m_Size=s->m_Size;d->m_ReverseHashEntryIndex=0;}`;
    if (operation === "UpdateBuffer") return `void ${name}(${state}* s,const void* input,uint32_t length){${count}const auto* bytes=static_cast<const uint8_t*>(input);for(uint32_t i=0;i<length;++i)s->m_Hash+=bytes[i];}`;
    if (operation === "Final") return `uint${width}_t ${name}(${state}* s){${count}return s->m_Hash;}`;
    if (operation === "Release") return `void ${name}(${state}*){${count}}`;
    throw new Error(`${vector.declarationId} has unsupported hash-state operation ${operation}`);
  }
  if (vector.family === "base64Span") {
    return `extern \"C\" uint8_t ${name}(const uint8_t* input,uint32_t length,uint8_t* output,uint32_t* inout){++g_calls[${code}][${id}];if(!input||length!=UINT32_C(${id === 0 ? 4 : 5})||input[0]!=UINT8_C(${id === 0 ? 81 : 0x41 + id})||!output||!inout||*inout!=UINT32_C(32))++g_failures[${code}][${id}];if(output&&inout){output[0]=UINT8_C(${0x81 + id});output[1]=UINT8_C(${0x91 + id});*inout=UINT32_C(2);}return UINT8_C(1);}`;
  }
  if (vector.family === "xteaSpan") {
    return `extern \"C\" uint8_t ${name}(uint8_t* data,uint32_t length,const uint8_t* key,uint32_t key_length){++g_calls[${code}][${id}];if(!data||length!=UINT32_C(${9 + id})||data[0]!=UINT8_C(${0x41 + id})||!key||key_length!=UINT32_C(${3 + id})||key[0]!=UINT8_C(${0x61 + id}))++g_failures[${code}][${id}];if(data)data[0]=UINT8_C(${0xa1 + id});return UINT8_C(1);}`;
  }
  if (vector.family === "astcProbe") {
    return `extern \"C\" uint8_t ${name}(const uint8_t* input,uint32_t length,DehermDmSdkAstcProbeResult* output){++g_calls[${code}][${id}];if(!input||length!=UINT32_C(${16 + id})||input[0]!=UINT8_C(${0x51 + id})||!output)++g_failures[${code}][${id}];if(output){output->width=UINT32_C(${101 + id});output->height=UINT32_C(${201 + id});output->depth=UINT32_C(${301 + id});}return UINT8_C(1);}`;
  }
  return renderScalarFake(vector);
}

function renderDispatchCheck(vector, failure) {
  const id = vector.adapterId;
  const code = familyCode[vector.family];
  const common = `if(g_calls[${code}][${id}]!=UINT32_C(1)||g_failures[${code}][${id}]!=UINT32_C(0))return ${failure};`;
  if (vector.family === "arenaCString") {
    const mode = vector.familyContract.mode;
    const needsInput = mode === "error-string" ? 0 : 1;
    const scalar = mode === "error-string" ? 100 + id : 0;
    const input = `arena_${id}`;
    const nativeResult = mode === "error-string" || mode === "uri-encode" ? 0 : 500 + id;
    const requiredLength = mode === "error-string" ? 0 : mode === "uri-encode" ? `result_${id}`.length + 1 : 500 + id;
    return `{const uint8_t* input=${needsInput ? `reinterpret_cast<const uint8_t*>(${JSON.stringify(input)})` : "nullptr"};uint8_t output[64]={};DehermDmSdkArenaCStringResult result{};if(deherm_dmsdk_arena_cstring_dispatch(UINT16_C(${id}),input,UINT32_C(${needsInput ? input.length : 0}),UINT64_C(${scalar}),reinterpret_cast<char*>(output),UINT32_C(64),&result)!=DEHERM_DMSDK_ARENA_CSTRING_OK)return ${failure};${common}if(strcmp(reinterpret_cast<const char*>(output),${JSON.stringify(`result_${id}`)})!=0||result.output_length!=UINT32_C(${`result_${id}`.length})||result.required_length!=UINT32_C(${requiredLength})||result.native_result!=UINT64_C(${nativeResult}))return ${failure};}`;
  }
  if (vector.family === "scalar" || vector.family === "enumValue") {
    const isScalar = vector.family === "scalar";
    const args = vector.abi.parameters.map((parameter, position) => parameter.shape.kind === "enum"
      ? signedRaw(enumValue(parameter, id + position))
      : scalarSentinel(parameter.shape, id, position).raw);
    let expected = "UINT64_C(0)";
    if (vector.abi.resultShape.kind === "enum") expected = signedRaw(enumValue({ enumeration: vector.abi.resultEnumeration, shape: vector.abi.resultShape }, id + 1));
    else if (vector.abi.resultShape.kind !== "void") expected = scalarSentinel(vector.abi.resultShape, id, 0, true).raw;
    const prefix = isScalar ? "scalar" : "enum";
    const status = isScalar ? "DEHERM_DMSDK_SCALAR_OK" : "DEHERM_DMSDK_ENUM_OK";
    return `{uint64_t arguments[2]={${args.join(",") || "UINT64_C(0)"}};uint64_t result=UINT64_C(0xffff);if(deherm_dmsdk_${prefix}_dispatch(UINT16_C(${id}),arguments,UINT32_C(${args.length}),&result)!=${status})return ${failure};${common}if(result!=${expected})return ${failure};}`;
  }
  if (vector.family === "fixedDigest") {
    const bytes = vector.familyContract.digestBytes;
    return `{uint8_t input[16]={UINT8_C(${0x20 + id})};uint8_t output[64]={};uint32_t written=0;if(deherm_dmsdk_fixed_digest_dispatch(UINT16_C(${id}),input,UINT32_C(${5 + id}),output,UINT32_C(64),&written)!=DEHERM_DMSDK_FIXED_DIGEST_OK)return ${failure};${common}if(written!=UINT32_C(${bytes}))return ${failure};for(uint32_t i=0;i<written;++i)if(output[i]!=static_cast<uint8_t>(UINT8_C(${0x70 + id})+i))return ${failure};}`;
  }
  if (vector.family === "hashSpan") {
    const expected = vector.familyContract.resultBits === 32 ? `UINT64_C(${0x65000000 + id})` : `UINT64_C(${0x6500000000000000 + id})`;
    return `{uint8_t input[16]={UINT8_C(${0x30 + id})};uint64_t output=0;if(deherm_dmsdk_hash_span_dispatch(UINT16_C(${id}),input,UINT32_C(${7 + id}),&output)!=DEHERM_DMSDK_HASH_SPAN_OK)return ${failure};${common}if(output!=${expected})return ${failure};}`;
  }
  if (vector.family === "hashState") {
    const operation = vector.familyContract.operation;
    const width = vector.familyContract.width;
    const initId = width === 32 ? "DEHERM_DMSDK_HASH_STATE_INIT_32" : "DEHERM_DMSDK_HASH_STATE_INIT_64";
    const finalId = width === 32 ? "DEHERM_DMSDK_HASH_STATE_FINAL_32" : "DEHERM_DMSDK_HASH_STATE_FINAL_64";
    const releaseId = width === 32 ? "DEHERM_DMSDK_HASH_STATE_RELEASE_32" : "DEHERM_DMSDK_HASH_STATE_RELEASE_64";
    const bytes = `uint8_t input[4]={1,2,3,4};`;
    const before = `const uint32_t before=g_calls[${code}][${id}];`;
    const stateCommon = `if(g_calls[${code}][${id}]!=before+UINT32_C(1)||g_failures[${code}][${id}]!=UINT32_C(0))return ${failure};`;
    if (operation === "Init") return `{${before}uint64_t state=0,value=0;if(deherm_dmsdk_hash_state_dispatch(UINT16_C(${id}),0,nullptr,0,1,&state)!=DEHERM_DMSDK_HASH_STATE_OK||state==0)return ${failure};${stateCommon}if(deherm_dmsdk_hash_state_dispatch(${finalId},state,nullptr,0,0,&value)!=DEHERM_DMSDK_HASH_STATE_OK||value!=UINT64_C(${width}))return ${failure};}`;
    if (operation === "Clone") return `{uint64_t source=0,value=0,result=0;if(deherm_dmsdk_hash_state_dispatch(${initId},0,nullptr,0,0,&source)!=DEHERM_DMSDK_HASH_STATE_OK)return ${failure};${before}if(deherm_dmsdk_hash_state_dispatch(UINT16_C(${id}),source,nullptr,0,1,&value)!=DEHERM_DMSDK_HASH_STATE_OK||value==0||value==source)return ${failure};${stateCommon}if(deherm_dmsdk_hash_state_dispatch(${finalId},value,nullptr,0,0,&result)!=DEHERM_DMSDK_HASH_STATE_OK||result!=UINT64_C(${width === 32 ? 10 : 15}))return ${failure};if(deherm_dmsdk_hash_state_dispatch(${releaseId},source,nullptr,0,0,&result)!=DEHERM_DMSDK_HASH_STATE_OK)return ${failure};}`;
    if (operation === "UpdateBuffer") return `{uint64_t state=0,value=9,result=0;${bytes}if(deherm_dmsdk_hash_state_dispatch(${initId},0,nullptr,0,0,&state)!=DEHERM_DMSDK_HASH_STATE_OK)return ${failure};${before}if(deherm_dmsdk_hash_state_dispatch(UINT16_C(${id}),state,input,4,0,&value)!=DEHERM_DMSDK_HASH_STATE_OK||value!=0)return ${failure};${stateCommon}if(deherm_dmsdk_hash_state_dispatch(${finalId},state,nullptr,0,0,&result)!=DEHERM_DMSDK_HASH_STATE_OK||result!=UINT64_C(${width === 32 ? 13 : 16}))return ${failure};}`;
    if (operation === "Final") return `{uint64_t state=0,value=0;if(deherm_dmsdk_hash_state_dispatch(${initId},0,nullptr,0,0,&state)!=DEHERM_DMSDK_HASH_STATE_OK)return ${failure};${before}if(deherm_dmsdk_hash_state_dispatch(UINT16_C(${id}),state,nullptr,0,0,&value)!=DEHERM_DMSDK_HASH_STATE_OK||value!=UINT64_C(${width === 32 ? 3 : 6}))return ${failure};${stateCommon}}`;
    return `{uint64_t state=0,value=9;if(deherm_dmsdk_hash_state_dispatch(${initId},0,nullptr,0,0,&state)!=DEHERM_DMSDK_HASH_STATE_OK)return ${failure};${before}if(deherm_dmsdk_hash_state_dispatch(UINT16_C(${id}),state,nullptr,0,0,&value)!=DEHERM_DMSDK_HASH_STATE_OK||value!=0)return ${failure};${stateCommon}}`;
  }
  if (vector.family === "base64Span") {
    const init = id === 0 ? "'Q','Q','=','='" : `${0x41 + id},0x22,0x33,0x44,0x55`;
    return `{uint8_t input[5]={${init}};uint8_t output[32]={};uint32_t written=0;if(deherm_dmsdk_base64_span_dispatch(UINT16_C(${id}),input,UINT32_C(${id === 0 ? 4 : 5}),output,UINT32_C(32),&written)!=DEHERM_DMSDK_BASE64_SPAN_OK)return ${failure};${common}if(written!=UINT32_C(2)||output[0]!=UINT8_C(${0x81 + id})||output[1]!=UINT8_C(${0x91 + id}))return ${failure};}`;
  }
  if (vector.family === "xteaSpan") return `{uint8_t data[16]={UINT8_C(${0x41 + id})};uint8_t key[8]={UINT8_C(${0x61 + id})};if(deherm_dmsdk_xtea_span_dispatch(UINT16_C(${id}),data,UINT32_C(${9 + id}),key,UINT32_C(${3 + id}))!=DEHERM_DMSDK_XTEA_SPAN_OK)return ${failure};${common}if(data[0]!=UINT8_C(${0xa1 + id}))return ${failure};}`;
  if (vector.family === "astcProbe") return `{uint8_t input[17]={UINT8_C(${0x51 + id})};DehermDmSdkAstcProbeResult output{};if(deherm_dmsdk_astc_probe_dispatch(UINT16_C(${id}),input,UINT32_C(${16 + id}),&output)!=DEHERM_DMSDK_ASTC_PROBE_OK)return ${failure};${common}if(output.width!=UINT32_C(${101 + id})||output.height!=UINT32_C(${201 + id})||output.depth!=UINT32_C(${301 + id}))return ${failure};}`;
  const strings = vector.abi.parameters.filter(({ shape }) => shape.kind === "cstring");
  const scalars = vector.abi.parameters.filter(({ shape }) => shape.kind !== "cstring");
  const stringRows = strings.map((_, index) => `{reinterpret_cast<const uint8_t*>(${JSON.stringify(`exact_${id}_${index}`)}),UINT32_C(${`exact_${id}_${index}`.length})}`).join(",");
  const scalarRows = scalars.map((parameter, position) => parameter.shape.kind === "enum" ? signedRaw(enumValue(parameter, id + position)) : scalarSentinel(parameter.shape, id, position).raw).join(",");
  let resultCheck = "";
  if (vector.abi.resultShape.kind === "cstring") resultCheck = `if(!present||required!=UINT32_C(${`result_${id}`.length})||strcmp(reinterpret_cast<const char*>(output),${JSON.stringify(`result_${id}`)})!=0)return ${failure};`;
  else if (vector.abi.resultShape.kind === "enum") resultCheck = `if(result!=${signedRaw(enumValue({ enumeration: vector.abi.resultEnumeration, shape: vector.abi.resultShape }, id + 1))})return ${failure};`;
  else if (vector.abi.resultShape.kind !== "void") resultCheck = `if(result!=${scalarSentinel(vector.abi.resultShape, id, 0, true).raw})return ${failure};`;
  return `{uint8_t scratch_bytes[256]={};DehermDmSdkCStringScratch scratch{scratch_bytes,UINT32_C(256),UINT32_C(0)};DehermDmSdkCStringView strings[2]={${stringRows || "{nullptr,UINT32_C(0)}"}};uint64_t scalars[2]={${scalarRows || "UINT64_C(0)"}};uint64_t result=0;uint8_t output[64]={};uint32_t required=0;uint8_t present=0;if(deherm_dmsdk_cstring_value_dispatch(UINT16_C(${id}),&scratch,strings,UINT32_C(${strings.length}),scalars,UINT32_C(${scalars.length}),&result,output,UINT32_C(64),&required,&present)!=DEHERM_DMSDK_CSTRING_OK)return ${failure};${common}${resultCheck}}`;
}

function renderVerificationSource(generated) {
  const vectors = generated.verification.vectors;
  const headers = [...new Set(vectors.flatMap(({ productionHeader, family }) => [productionHeader, `defold_hermes/generated_dmsdk_${({ arenaCString: "arena_cstring", enumValue: "enum_value", fixedDigest: "fixed_digest", hashSpan: "hash_span", hashState: "hash_state", base64Span: "base64_span", xteaSpan: "xtea_span", astcProbe: "astc_probe", scalar: "scalar", cstringValue: "cstring_value" })[family]}.h`]))].sort(compareCodeUnits);
  const sdkHeaders = ["dmsdk/dlib/buffer.h", "dmsdk/dlib/dstrings.h", "dmsdk/dlib/hash.h", "dmsdk/dlib/socket.h", "dmsdk/dlib/sys.h", "dmsdk/dlib/uri.h", "dmsdk/dlib/utf8.h", "dmsdk/graphics/graphics.h", "dmsdk/resource/resource.h", "dmsdk/resource/resource.hpp"];
  const descriptorChecks = [];
  let failure = 1;
  for (const [family, descriptor] of Object.entries(familyDescriptor)) {
    const owned = vectors.filter((vector) => vector.family === family);
    if (!owned.length) continue;
    descriptorChecks.push(`if(${descriptor.count}()!=UINT32_C(${owned.length}))return ${failure++};`);
    for (const vector of owned) {
      if (!descriptor.descriptors) continue;
      const access = `${descriptor.descriptors}()[UINT16_C(${vector.adapterId})]`;
      if (descriptor.id) descriptorChecks.push(`if(${access}.${descriptor.id}!=UINT16_C(${vector.adapterId}))return ${failure++};`);
      descriptorChecks.push(`if(strcmp(${access}.${descriptor.declaration},${JSON.stringify(vector.declarationId)})!=0)return ${failure++};`);
    }
  }
  const calls = vectors.map((vector) => renderDispatchCheck(vector, failure++)).join("\n");
  const uri = vectors.find((vector) => vector.family === "arenaCString" && vector.familyContract.mode === "uri-encode");
  const nativeFailure = uri ? `{char output[64];memset(output,'x',sizeof(output));DehermDmSdkArenaCStringResult result{UINT64_C(9),9,9};g_arena_uri_failure=true;const char input[]=${JSON.stringify(`arena_${uri.adapterId}`)};const auto status=deherm_dmsdk_arena_cstring_dispatch(UINT16_C(${uri.adapterId}),reinterpret_cast<const uint8_t*>(input),UINT32_C(${`arena_${uri.adapterId}`.length}),UINT64_C(0),output,UINT32_C(64),&result);g_arena_uri_failure=false;if(status!=DEHERM_DMSDK_ARENA_CSTRING_NATIVE_FAILURE||result.native_result!=0||result.output_length!=0||result.required_length!=0)return ${failure++};for(char value:output)if(value!='\\0')return ${failure++};}` : "";
  const vectorRows = vectors.map((vector) => ` {UINT32_C(${vector.numericId}),UINT16_C(${vector.adapterId}),${JSON.stringify(vector.family)},${JSON.stringify(vector.vectorSha256)}}`).join(",\n");
  const fakes = vectors.map((vector) => vector.family === "cstringValue" ? renderCStringFake(vector) : renderFamilyFake(vector)).join("\n");
  return `// Generated by @deherm/compiler dmSDK generated-adapter exact corpus. Do not edit.
${headers.map((header) => `#include <${header}>`).join("\n")}
${sdkHeaders.map((header) => `#include <${header}>`).join("\n")}
#include <stdint.h>
#include <string.h>
namespace {uint32_t g_calls[10][32]{};uint32_t g_failures[10][32]{};bool g_arena_uri_failure=false;uint64_t pack_f32(float value){uint32_t bits=0;memcpy(&bits,&value,sizeof(bits));return bits;}}
${fakes}
struct DehermDmSdkAdapterExactVector{uint32_t recipe_id;uint16_t adapter_id;const char* family;const char* sha256;};
static const DehermDmSdkAdapterExactVector kVectors[]={
${vectorRows}
};
extern \"C\" uint32_t deherm_dmsdk_generated_adapter_exact_vector_count(void){return UINT32_C(${vectors.length});}
extern \"C\" const DehermDmSdkAdapterExactVector* deherm_dmsdk_generated_adapter_exact_vectors(void){return kVectors;}
extern \"C\" int deherm_dmsdk_run_generated_adapter_exact_verification(void){
${descriptorChecks.join("\n")}
${calls}
${nativeFailure}
return 0;}
`;
}

function scalarKind(shape, family) {
  if (shape.kind === "void") return family === "scalar" ? "DEHERM_DMSDK_SCALAR_VOID" : "DEHERM_DMSDK_ENUM_VOID";
  if (shape.kind === "enum") return family === "scalar" ? null : "DEHERM_DMSDK_ENUM_I32";
  if (shape.kind === "named") return family === "scalar" ? null : "DEHERM_DMSDK_ENUM_U64";
  const name = shape.name;
  const prefix = family === "scalar" ? "DEHERM_DMSDK_SCALAR_" : "DEHERM_DMSDK_ENUM_";
  return prefix + ({ bool: "BOOL", u16: "U16", u32: "U32", u64: "U64", f32: "F32" }[name] ?? "I32");
}

function jsiArgument(parameter, adapterId, position) {
  const shape = parameter.shape;
  if (shape.kind === "named" || shape.name === "u64") {
    const value = 0x100000000 + 0x1100 + adapterId * 17 + position;
    return { expression: `jsi::BigInt::fromUint64(runtime,UINT64_C(${value}))`, raw: `UINT64_C(${value})` };
  }
  if (shape.name === "bool") return { expression: "jsi::Value(true)", raw: "UINT64_C(1)" };
  if (shape.kind === "enum") {
    const value = enumValue(parameter, adapterId + position);
    return { expression: `jsi::Value(${value}.0)`, raw: signedRaw(value) };
  }
  if (shape.name === "f32") {
    const value = `${100 + adapterId + position + 0.25}`;
    return { expression: `jsi::Value(${value})`, raw: `pack_f32(${value}f)` };
  }
  const value = 0x1100 + adapterId * 17 + position;
  return { expression: `jsi::Value(${value}.0)`, raw: `UINT64_C(${value})` };
}

function jsiResultExpectation(vector) {
  const shape = vector.abi.resultShape;
  let raw = "UINT64_C(0)";
  let assertion = "if(!returned.isUndefined())return FAILURE;";
  if (shape.kind === "enum") {
    const value = enumValue({ enumeration: vector.abi.resultEnumeration, shape }, vector.adapterId + 1);
    raw = signedRaw(value);
    assertion = `if(!returned.isNumber()||returned.asNumber()!=${value}.0)return FAILURE;`;
  } else if (shape.kind === "named" || shape.name === "u64") {
    const value = 0x100000000 + 0x5100 + vector.adapterId * 17;
    raw = `UINT64_C(${value})`;
    assertion = `if(!returned.isBigInt()||!returned.asBigInt(runtime).isUint64(runtime)||returned.asBigInt(runtime).asUint64(runtime)!=${raw})return FAILURE;`;
  } else if (shape.name === "bool") {
    raw = "UINT64_C(1)";
    assertion = "if(!returned.isBool()||!returned.getBool())return FAILURE;";
  } else if (shape.name === "f32") {
    const value = 100 + vector.adapterId + 0.75;
    raw = `pack_f32(${value}f)`;
    assertion = `if(!returned.isNumber()||returned.asNumber()!=${value})return FAILURE;`;
  } else if (shape.kind !== "void") {
    const value = 0x5100 + vector.adapterId * 17;
    raw = `UINT64_C(${value})`;
    assertion = `if(!returned.isNumber()||returned.asNumber()!=${value}.0)return FAILURE;`;
  }
  return { raw, assertion };
}

function renderJsiVerificationSource(generated) {
  const vectors = generated.verification.vectors.filter((vector) =>
    vector.transports.dynamicHermesJsi.applicability === "callable");
  const byFamily = new Map(["scalar", "enumValue"].map((family) =>
    [family, vectors.filter((vector) => vector.family === family).sort((a, b) => a.adapterId - b.adapterId)]));
  const scalar = byFamily.get("scalar");
  const enumeration = byFamily.get("enumValue");
  const scalarRows = scalar.map((vector) => {
    const argumentsKinds = vector.abi.parameters.map((parameter) => scalarKind(parameter.shape, "scalar"));
    return ` {UINT16_C(${vector.adapterId}),UINT8_C(${argumentsKinds.length}),${scalarKind(vector.abi.resultShape, "scalar")},{${argumentsKinds[0] ?? "DEHERM_DMSDK_SCALAR_VOID"}},UINT8_C(1),${JSON.stringify(vector.declarationId)},${JSON.stringify(vector.invocation.nativeSymbol)}}`;
  }).join(",\n");
  const enumRows = enumeration.map((vector) => {
    const kinds = vector.abi.parameters.map((parameter) => scalarKind(parameter.shape, "enumValue"));
    return ` {UINT16_C(${vector.adapterId}),UINT8_C(${kinds.length}),${scalarKind(vector.abi.resultShape, "enumValue")},{${[kinds[0] ?? "DEHERM_DMSDK_ENUM_VOID", kinds[1] ?? "DEHERM_DMSDK_ENUM_VOID"].join(",")}},${JSON.stringify(vector.declarationId)}}`;
  }).join(",\n");
  const calls = vectors.map((vector, index) => {
    const args = vector.abi.parameters.map((parameter, position) => jsiArgument(parameter, vector.adapterId, position));
    const module = vector.transports.dynamicHermesJsi.module;
    const expectedFamily = { scalar: 1, enumValue: 2 }[vector.family];
    const expectedResult = jsiResultExpectation(vector);
    const laneChecks = args.map((argument, position) => `if(g_lanes[${position}]!=${argument.raw})return FAILURE;`).join("");
    return `{constexpr int FAILURE=${index + 1};reset();auto module=modules.getProperty(runtime,${JSON.stringify(module)}).asObject(runtime);auto call=module.getProperty(runtime,"call").asObject(runtime).asFunction(runtime);jsi::Value args[]={jsi::Value(${vector.adapterId}.0)${args.length ? `,${args.map(({ expression }) => expression).join(",")}` : ""}};auto returned=call.call(runtime,static_cast<const jsi::Value*>(args),static_cast<size_t>(sizeof(args)/sizeof(args[0])));if(g_family!=${expectedFamily}||g_id!=UINT16_C(${vector.adapterId})||g_count!=UINT32_C(${args.length}))return FAILURE;${laneChecks}${expectedResult.assertion}}`;
  }).join("\n ");
  return `// Generated by @deherm/compiler dmSDK generated-adapter JSI exact corpus. Do not edit.
#include <defold_hermes/generated_dmsdk_scalar_jsi.hpp>
#include <defold_hermes/generated_dmsdk_scalar_runtime.h>
#include <defold_hermes/generated_dmsdk_enum_value_jsi.hpp>
#include <defold_hermes/generated_dmsdk_enum_value_runtime.h>
#include <hermes/hermes.h>
#include <jsi/jsi.h>
#include <cstring>
#include <memory>
namespace jsi=facebook::jsi;
namespace {uint32_t g_family=0,g_count=0;uint16_t g_id=0;uint64_t g_lanes[2]={};uint64_t pack_f32(float value){uint32_t bits=0;memcpy(&bits,&value,sizeof(bits));return bits;}void reset(){g_family=g_count=0;g_id=0;g_lanes[0]=g_lanes[1]=0;}
const DehermDmSdkScalarDescriptor kScalar[]={${scalarRows}};
const DehermDmSdkEnumDescriptor kEnum[]={${enumRows}};
}
extern "C" uint32_t deherm_dmsdk_scalar_count(void){return UINT32_C(${scalar.length});}
extern "C" const DehermDmSdkScalarDescriptor* deherm_dmsdk_scalar_descriptors(void){return kScalar;}
extern "C" DehermDmSdkScalarStatus deherm_dmsdk_scalar_dispatch(uint16_t id,const uint64_t* lanes,uint32_t count,uint64_t* result){g_family=1;g_id=id;g_count=count;if(!result||id>=${scalar.length}||(count&&!lanes))return DEHERM_DMSDK_SCALAR_UNKNOWN_ID;for(uint32_t i=0;i<count;++i)g_lanes[i]=lanes[i];switch(id){${scalar.map((vector) => `case ${vector.adapterId}:*result=${jsiResultExpectation(vector).raw};break;`).join("")}default:return DEHERM_DMSDK_SCALAR_UNKNOWN_ID;}return DEHERM_DMSDK_SCALAR_OK;}
extern "C" uint32_t deherm_dmsdk_enum_count(void){return UINT32_C(${enumeration.length});}
extern "C" const DehermDmSdkEnumDescriptor* deherm_dmsdk_enum_descriptors(void){return kEnum;}
extern "C" DehermDmSdkEnumStatus deherm_dmsdk_enum_dispatch(uint16_t id,const uint64_t* lanes,uint32_t count,uint64_t* result){g_family=2;g_id=id;g_count=count;if(!result||id>=${enumeration.length}||(count&&!lanes))return DEHERM_DMSDK_ENUM_UNKNOWN_ID;for(uint32_t i=0;i<count;++i)g_lanes[i]=lanes[i];switch(id){${enumeration.map((vector) => `case ${vector.adapterId}:*result=${jsiResultExpectation(vector).raw};break;`).join("")}default:return DEHERM_DMSDK_ENUM_UNKNOWN_ID;}return DEHERM_DMSDK_ENUM_OK;}
extern "C" int deherm_dmsdk_run_generated_adapter_jsi_exact_verification(void){try{auto runtimeOwner=facebook::hermes::makeHermesRuntime();auto& runtime=*runtimeOwner;jsi::Object modules(runtime);defold_hermes::installDmSdkScalarModule(runtime,modules);defold_hermes::installDmSdkEnumValueModule(runtime,modules);
 ${calls}
 return 0;}catch(...){return 255;}}
`;
}

export function materializeDmSdkGeneratedAdapterCorpus(index, catalog) {
  const verified = verifyDmSdkCallSymbolIndex(index, "dmSDK generated-adapter corpus symbol index");
  const catalogSha256 = authenticatedCatalog(catalog, verified);
  const usages = dmSdkGeneratedAdapterUsages(verified, catalog);
  const generated = materializeDmSdkGeneratedAdapterUsages(usages, {
    recipes: catalog.recipes,
    catalogSha256,
    installName: "deherm_dmsdk_generated_adapter_corpus",
  });
  const verificationSource = renderVerificationSource(generated);
  const jsiVerificationSource = renderJsiVerificationSource(generated);
  const familyCounts = Object.fromEntries([...new Set(generated.verification.vectors.map(({ family }) => family))]
    .sort(compareCodeUnits)
    .map((family) => [family, generated.verification.vectors.filter((vector) => vector.family === family).length]));
  const body = {
    schemaVersion: 1,
    source: "deherm-dmsdk-generated-adapter-exact-corpus",
    ordering: "numeric-id-ascending",
    defoldRevision: verified.defoldRevision,
    catalogSha256,
    symbolIndexSha256: verified.indexSha256,
    recipeCount: verified.recipeCount,
    generatedAdapterCount: verified.generatedAdapterCount,
    universalReadyCount: verified.universalReadyCount,
    specializationRequiredCount: verified.specializationRequiredCount,
    silentlyOmitted: 0,
    familyCounts,
    verification: generated.verification,
    artifacts: {
      verificationSource: {
        path: dmSdkGeneratedAdapterCorpusArtifacts.verificationSource,
        sha256: sha256(verificationSource),
      },
      jsiVerificationSource: {
        path: dmSdkGeneratedAdapterCorpusArtifacts.jsiVerificationSource,
        sha256: sha256(jsiVerificationSource),
      },
    },
  };
  const report = Object.freeze({ ...body, corpusSha256: sha256(canonicalJson(body)) });
  return Object.freeze({ usages, generated, verificationSource, jsiVerificationSource, report });
}
