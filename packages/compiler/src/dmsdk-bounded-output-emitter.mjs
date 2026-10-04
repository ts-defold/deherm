export const DMSDK_BOUNDED_RECIPE_FACTS_KIND = "deherm.dmsdk-bounded-output-recipe-facts";
export const DMSDK_BOUNDED_RECIPE_FACTS_SCHEMA_VERSION = 1;

export const DMSDK_BOUNDED_OUTPUTS = Object.freeze({
  "fixed-digest": Object.freeze([
    "defold/defold_hermes/include/defold_hermes/generated_dmsdk_fixed_digest.h",
    "defold/defold_hermes/include/defold_hermes/generated_dmsdk_fixed_digest_runtime.h",
    "defold/defold_hermes/src/generated_dmsdk_fixed_digest_crypt.cpp",
    "defold/defold_hermes/src/generated_dmsdk_fixed_digest_runtime.cpp",
  ]),
  "base64-span": Object.freeze([
    "defold/defold_hermes/include/defold_hermes/generated_dmsdk_base64_span.h",
    "defold/defold_hermes/include/defold_hermes/generated_dmsdk_base64_span_runtime.h",
    "defold/defold_hermes/src/generated_dmsdk_base64_span_crypt.cpp",
    "defold/defold_hermes/src/generated_dmsdk_base64_span_runtime.cpp",
  ]),
  "astc-probe": Object.freeze([
    "defold/defold_hermes/include/defold_hermes/generated_dmsdk_astc_probe.h",
    "defold/defold_hermes/include/defold_hermes/generated_dmsdk_astc_probe_runtime.h",
    "defold/defold_hermes/src/generated_dmsdk_astc_probe_image.cpp",
    "defold/defold_hermes/src/generated_dmsdk_astc_probe_runtime.cpp",
  ]),
  "xtea-span": Object.freeze([
    "defold/defold_hermes/include/defold_hermes/generated_dmsdk_xtea_span.h",
    "defold/defold_hermes/include/defold_hermes/generated_dmsdk_xtea_span_runtime.h",
    "defold/defold_hermes/src/generated_dmsdk_xtea_span_crypt.cpp",
    "defold/defold_hermes/src/generated_dmsdk_xtea_span_runtime.cpp",
  ]),
  "hash-span": Object.freeze([
    "defold/defold_hermes/include/defold_hermes/generated_dmsdk_hash_span.h",
    "defold/defold_hermes/include/defold_hermes/generated_dmsdk_hash_span_runtime.h",
    "defold/defold_hermes/src/generated_dmsdk_hash_span.cpp",
    "defold/defold_hermes/src/generated_dmsdk_hash_span_runtime.cpp",
  ]),
});

function publicHeader(source) {
  const marker = "/src/dmsdk/";
  const position = source.indexOf(marker);
  if (position < 0) throw new Error(`bounded-family header is outside the dmSDK projection: ${source}`);
  return `dmsdk/${source.slice(position + marker.length)}`;
}

function normalizeFacts(facts) {
  if (
    facts?.schemaVersion !== DMSDK_BOUNDED_RECIPE_FACTS_SCHEMA_VERSION ||
    facts?.kind !== DMSDK_BOUNDED_RECIPE_FACTS_KIND ||
    !Object.hasOwn(DMSDK_BOUNDED_OUTPUTS, facts.family) ||
    !Array.isArray(facts.entries)
  ) {
    throw new Error("invalid dmSDK bounded-family recipe facts");
  }
  return facts;
}

export function createDmSdkBoundedRecipeFacts({ defoldRevision, family, entries }) {
  const facts = {
    schemaVersion: DMSDK_BOUNDED_RECIPE_FACTS_SCHEMA_VERSION,
    kind: DMSDK_BOUNDED_RECIPE_FACTS_KIND,
    defoldRevision,
    family,
    entries: entries.map((entry) => ({
      id: entry.id,
      declarationId: entry.declaration.id,
      symbol: entry.declaration.name,
      include: publicHeader(entry.declaration.header),
      wrapper: entry.wrapper,
      ...(family === "fixed-digest" ? { digestBytes: entry.digestBytes } : {}),
      ...(family === "base64-span" ? { requirePaddedInput: entry.requirePaddedInput } : {}),
      ...(family === "astc-probe" ? { minimumHeaderBytes: entry.minimumHeaderBytes } : {}),
      ...(family === "xtea-span"
        ? {
            maximumKeyBytes: entry.maximumKeyBytes,
            algorithmExpression: entry.algorithmExpression,
            successExpression: entry.successExpression,
          }
        : {}),
      ...(family === "hash-span" ? { resultBits: entry.resultBits } : {}),
    })),
  };
  return normalizeFacts(facts);
}

const includes = (entries) =>
  [...new Set(entries.map(({ include }) => include))]
    .sort()
    .map((header) => `#include <${header}>`)
    .join("\n");

function renderFixedDigest({ entries }) {
  const declarations = entries
    .map(
      ({ wrapper, digestBytes }) =>
        `uint8_t ${wrapper}(const uint8_t* input, uint32_t input_length, uint8_t output[${digestBytes}], uint32_t output_capacity);`,
    )
    .join("\n");
  const maximum = Math.max(...entries.map(({ digestBytes }) => digestBytes));
  const descriptors = entries
    .map(
      ({ id, digestBytes, declarationId }) =>
        `  { UINT16_C(${id}), UINT16_C(${digestBytes}), ${JSON.stringify(declarationId)} }`,
    )
    .join(",\n");
  const cases = entries
    .map(
      ({ id, wrapper }) =>
        `    case ${id}: if(!${wrapper}(input, input_length, output, output_capacity)) return DEHERM_DMSDK_FIXED_DIGEST_NULL_STORAGE; break;`,
    )
    .join("\n");
  const wrappers = entries
    .map(
      ({ wrapper, symbol, digestBytes }) =>
        `uint8_t ${wrapper}(const uint8_t* input, uint32_t input_length, uint8_t* output, uint32_t output_capacity)\n{\n  if(output==nullptr||output_capacity<UINT32_C(${digestBytes})||(input_length!=0&&input==nullptr))return UINT8_C(0); ${symbol}(input, input_length, output); return UINT8_C(1);\n}`,
    )
    .join("\n");
  return [
    `// Generated by scripts/generate-dmsdk-fixed-digest-bindings.mjs. Do not edit.\n#ifndef DEFOLD_HERMES_GENERATED_DMSDK_FIXED_DIGEST_H\n#define DEFOLD_HERMES_GENERATED_DMSDK_FIXED_DIGEST_H\n#include <stdint.h>\n#ifdef __cplusplus\nextern "C" {\n#endif\n${declarations}\n#ifdef __cplusplus\n}\n#endif\n#endif\n`,
    `// Generated by scripts/generate-dmsdk-fixed-digest-bindings.mjs. Do not edit.\n#ifndef DEFOLD_HERMES_GENERATED_DMSDK_FIXED_DIGEST_RUNTIME_H\n#define DEFOLD_HERMES_GENERATED_DMSDK_FIXED_DIGEST_RUNTIME_H\n#include <stdint.h>\n#define DEHERM_DMSDK_FIXED_DIGEST_MAX_BYTES ${maximum}\ntypedef enum DehermDmSdkFixedDigestStatus { DEHERM_DMSDK_FIXED_DIGEST_OK=0, DEHERM_DMSDK_FIXED_DIGEST_UNKNOWN_ID=1, DEHERM_DMSDK_FIXED_DIGEST_NULL_STORAGE=2, DEHERM_DMSDK_FIXED_DIGEST_OUTPUT_TOO_SMALL=3 } DehermDmSdkFixedDigestStatus;\ntypedef struct DehermDmSdkFixedDigestDescriptor { uint16_t id; uint16_t digest_bytes; const char* declaration_id; } DehermDmSdkFixedDigestDescriptor;\n#ifdef __cplusplus\nextern "C" {\n#endif\nuint32_t deherm_dmsdk_fixed_digest_count(void);\nconst DehermDmSdkFixedDigestDescriptor* deherm_dmsdk_fixed_digest_descriptors(void);\nDehermDmSdkFixedDigestStatus deherm_dmsdk_fixed_digest_dispatch(uint16_t id, const uint8_t* input, uint32_t input_length, uint8_t* output, uint32_t output_capacity, uint32_t* out_written);\n#ifdef __cplusplus\n}\n#endif\n#endif\n`,
    `// Generated by scripts/generate-dmsdk-fixed-digest-bindings.mjs. Do not edit.\n#include <defold_hermes/generated_dmsdk_fixed_digest.h>\n${includes(entries)}\nextern "C" {\n${wrappers} }\n`,
    `// Generated by scripts/generate-dmsdk-fixed-digest-bindings.mjs. Do not edit.\n#include <defold_hermes/generated_dmsdk_fixed_digest.h>\n#include <defold_hermes/generated_dmsdk_fixed_digest_runtime.h>\nnamespace { const DehermDmSdkFixedDigestDescriptor kDescriptors[] = {\n${descriptors}\n}; }\nextern "C" {\nuint32_t deherm_dmsdk_fixed_digest_count(void) { return UINT32_C(${entries.length}); }\nconst DehermDmSdkFixedDigestDescriptor* deherm_dmsdk_fixed_digest_descriptors(void) { return kDescriptors; }\nDehermDmSdkFixedDigestStatus deherm_dmsdk_fixed_digest_dispatch(uint16_t id, const uint8_t* input, uint32_t input_length, uint8_t* output, uint32_t output_capacity, uint32_t* out_written) {\n  if (id >= deherm_dmsdk_fixed_digest_count()) return DEHERM_DMSDK_FIXED_DIGEST_UNKNOWN_ID;\n  if (out_written == nullptr || output == nullptr || (input_length != 0 && input == nullptr)) return DEHERM_DMSDK_FIXED_DIGEST_NULL_STORAGE;\n  const uint32_t digest_bytes=kDescriptors[id].digest_bytes;\n  if (output_capacity < digest_bytes) return DEHERM_DMSDK_FIXED_DIGEST_OUTPUT_TOO_SMALL;\n  switch (id) {\n${cases}\n    default: return DEHERM_DMSDK_FIXED_DIGEST_UNKNOWN_ID;\n  }\n  *out_written=digest_bytes; return DEHERM_DMSDK_FIXED_DIGEST_OK;\n}\n}\n`,
  ];
}

function renderBase64({ entries }) {
  const declarations = entries
    .map(
      ({ wrapper }) =>
        `uint8_t ${wrapper}(const uint8_t* input, uint32_t input_length, uint8_t* output, uint32_t* inout_output_length);`,
    )
    .join("\n");
  const wrappers = entries
    .map(
      ({ wrapper, symbol }) =>
        `uint8_t ${wrapper}(const uint8_t* input, uint32_t input_length, uint8_t* output, uint32_t* inout_output_length)\n{\n  if(inout_output_length==nullptr||(input_length!=0&&input==nullptr)||(*inout_output_length!=0&&output==nullptr))return UINT8_C(0); return ${symbol}(input, input_length, output, inout_output_length) ? UINT8_C(1) : UINT8_C(0);\n}`,
    )
    .join("\n");
  const hasPadding = entries.some(({ requirePaddedInput }) => requirePaddedInput);
  const validators = hasPadding
    ? `uint8_t sextet(uint8_t value) {\n  if (value >= 'A' && value <= 'Z') return value - 'A';\n  if (value >= 'a' && value <= 'z') return value - 'a' + UINT8_C(26);\n  if (value >= '0' && value <= '9') return value - '0' + UINT8_C(52);\n  if (value == '+') return UINT8_C(62);\n  if (value == '/') return UINT8_C(63);\n  return UINT8_MAX;\n}\nbool canonical(const uint8_t* input, uint32_t length) {\n  if ((length & UINT32_C(3)) != 0) return false;\n  uint32_t padding = 0;\n  if (length && input[length - 1] == '=') ++padding;\n  if (length > 1 && input[length - 2] == '=') ++padding;\n  if (padding > 2) return false;\n  for (uint32_t index = 0; index < length - padding; ++index) {\n    if (sextet(input[index]) == UINT8_MAX) return false;\n  }\n  for (uint32_t index = length - padding; index < length; ++index) {\n    if (input[index] != '=') return false;\n  }\n  if (padding == 2 && (sextet(input[length - 3]) & UINT8_C(0x0f)) != 0) return false;\n  if (padding == 1 && (sextet(input[length - 2]) & UINT8_C(0x03)) != 0) return false;\n  return true;\n}\n`
    : "";
  const gate = hasPadding
    ? "  if (kDescriptors[id].requires_padded_input && !canonical(input,input_length)) return DEHERM_DMSDK_BASE64_SPAN_NONCANONICAL_INPUT;\n"
    : "";
  const descriptors = entries
    .map(
      ({ id, declarationId, requirePaddedInput }) =>
        `  { UINT16_C(${id}), UINT8_C(${requirePaddedInput ? 1 : 0}), ${JSON.stringify(declarationId)} }`,
    )
    .join(",\n");
  const cases = entries
    .map(({ id, wrapper }) => `    case ${id}: success=${wrapper}(input,input_length,output,&written); break;`)
    .join("\n");
  return [
    `// Generated by scripts/generate-dmsdk-base64-span-bindings.mjs. Do not edit.\n#ifndef DEFOLD_HERMES_GENERATED_DMSDK_BASE64_SPAN_H\n#define DEFOLD_HERMES_GENERATED_DMSDK_BASE64_SPAN_H\n#include <stdint.h>\n#ifdef __cplusplus\nextern "C" {\n#endif\n${declarations}\n#ifdef __cplusplus\n}\n#endif\n#endif\n`,
    `// Generated by scripts/generate-dmsdk-base64-span-bindings.mjs. Do not edit.\n#ifndef DEFOLD_HERMES_GENERATED_DMSDK_BASE64_SPAN_RUNTIME_H\n#define DEFOLD_HERMES_GENERATED_DMSDK_BASE64_SPAN_RUNTIME_H\n#include <stdint.h>\ntypedef enum DehermDmSdkBase64SpanStatus { DEHERM_DMSDK_BASE64_SPAN_OK=0, DEHERM_DMSDK_BASE64_SPAN_UNKNOWN_ID=1, DEHERM_DMSDK_BASE64_SPAN_NULL_STORAGE=2, DEHERM_DMSDK_BASE64_SPAN_QUERY=3, DEHERM_DMSDK_BASE64_SPAN_NONCANONICAL_INPUT=4, DEHERM_DMSDK_BASE64_SPAN_NATIVE_FAILURE=5 } DehermDmSdkBase64SpanStatus;\ntypedef struct DehermDmSdkBase64SpanDescriptor { uint16_t id; uint8_t requires_padded_input; const char* declaration_id; } DehermDmSdkBase64SpanDescriptor;\n#ifdef __cplusplus\nextern "C" {\n#endif\nuint32_t deherm_dmsdk_base64_span_count(void);\nconst DehermDmSdkBase64SpanDescriptor* deherm_dmsdk_base64_span_descriptors(void);\nDehermDmSdkBase64SpanStatus deherm_dmsdk_base64_span_dispatch(uint16_t id, const uint8_t* input, uint32_t input_length, uint8_t* output, uint32_t output_capacity, uint32_t* out_written);\n#ifdef __cplusplus\n}\n#endif\n#endif\n`,
    `// Generated by scripts/generate-dmsdk-base64-span-bindings.mjs. Do not edit.\n#include <defold_hermes/generated_dmsdk_base64_span.h>\n${includes(entries)}\nextern "C" {\n${wrappers} }\n`,
    `// Generated by scripts/generate-dmsdk-base64-span-bindings.mjs. Do not edit.\n#include <defold_hermes/generated_dmsdk_base64_span.h>\n#include <defold_hermes/generated_dmsdk_base64_span_runtime.h>\nnamespace {\n${validators}const DehermDmSdkBase64SpanDescriptor kDescriptors[] = {\n${descriptors}\n};\n}\nextern "C" {\nuint32_t deherm_dmsdk_base64_span_count(void) { return UINT32_C(${entries.length}); }\nconst DehermDmSdkBase64SpanDescriptor* deherm_dmsdk_base64_span_descriptors(void) { return kDescriptors; }\nDehermDmSdkBase64SpanStatus deherm_dmsdk_base64_span_dispatch(uint16_t id, const uint8_t* input, uint32_t input_length, uint8_t* output, uint32_t output_capacity, uint32_t* out_written) {\n  if (id >= deherm_dmsdk_base64_span_count()) return DEHERM_DMSDK_BASE64_SPAN_UNKNOWN_ID;\n  if (out_written == nullptr || (input_length != 0 && input == nullptr) || (output_capacity != 0 && output == nullptr)) return DEHERM_DMSDK_BASE64_SPAN_NULL_STORAGE;\n${gate}  uint32_t written=output_capacity; uint8_t success=0;\n  switch (id) {\n${cases}\n    default: return DEHERM_DMSDK_BASE64_SPAN_UNKNOWN_ID;\n  }\n  *out_written=written;\n  if (output_capacity == 0) return DEHERM_DMSDK_BASE64_SPAN_QUERY;\n  return success ? DEHERM_DMSDK_BASE64_SPAN_OK : DEHERM_DMSDK_BASE64_SPAN_NATIVE_FAILURE;\n}\n}\n`,
  ];
}

function renderAstc({ entries }) {
  const minimum = Math.max(...entries.map(({ minimumHeaderBytes }) => minimumHeaderBytes));
  const declarations = entries
    .map(
      ({ wrapper }) =>
        `uint8_t ${wrapper}(const uint8_t* input, uint32_t input_length, DehermDmSdkAstcProbeResult* out_result);`,
    )
    .join("\n");
  const wrappers = entries
    .map(
      ({ wrapper, symbol }) =>
        `uint8_t ${wrapper}(const uint8_t* input,uint32_t input_length,DehermDmSdkAstcProbeResult* out_result)\n{\n  if(input==nullptr||out_result==nullptr||input_length<UINT32_C(${minimum}))return UINT8_C(0); uint32_t width=0,height=0,depth=0; const bool valid=${symbol}(input,input_length,&width,&height,&depth); if(valid){out_result->width=width;out_result->height=height;out_result->depth=depth;} return valid ? UINT8_C(1) : UINT8_C(0);\n}`,
    )
    .join("\n");
  const descriptors = entries
    .map(({ id, declarationId }) => `  { UINT16_C(${id}), ${JSON.stringify(declarationId)} }`)
    .join(",\n");
  const cases = entries
    .map(({ id, wrapper }) => `case ${id}: valid=${wrapper}(input,input_length,out_result);break;`)
    .join("\n    ");
  return [
    `// Generated by scripts/generate-dmsdk-astc-probe-bindings.mjs. Do not edit.\n#ifndef DEFOLD_HERMES_GENERATED_DMSDK_ASTC_PROBE_H\n#define DEFOLD_HERMES_GENERATED_DMSDK_ASTC_PROBE_H\n#include <stdint.h>\ntypedef struct DehermDmSdkAstcProbeResult { uint32_t width; uint32_t height; uint32_t depth; } DehermDmSdkAstcProbeResult;\n#ifdef __cplusplus\nextern "C" {\n#endif\n${declarations}\n#ifdef __cplusplus\n}\n#endif\n#endif\n`,
    `// Generated by scripts/generate-dmsdk-astc-probe-bindings.mjs. Do not edit.\n#ifndef DEFOLD_HERMES_GENERATED_DMSDK_ASTC_PROBE_RUNTIME_H\n#define DEFOLD_HERMES_GENERATED_DMSDK_ASTC_PROBE_RUNTIME_H\n#include <defold_hermes/generated_dmsdk_astc_probe.h>\ntypedef enum DehermDmSdkAstcProbeStatus { DEHERM_DMSDK_ASTC_PROBE_OK=0, DEHERM_DMSDK_ASTC_PROBE_UNKNOWN_ID=1, DEHERM_DMSDK_ASTC_PROBE_NULL_STORAGE=2, DEHERM_DMSDK_ASTC_PROBE_INPUT_TOO_SHORT=3, DEHERM_DMSDK_ASTC_PROBE_NOT_ASTC=4 } DehermDmSdkAstcProbeStatus;\ntypedef struct DehermDmSdkAstcProbeDescriptor { uint16_t id; const char* declaration_id; } DehermDmSdkAstcProbeDescriptor;\n#ifdef __cplusplus\nextern "C" {\n#endif\nuint32_t deherm_dmsdk_astc_probe_count(void); const DehermDmSdkAstcProbeDescriptor* deherm_dmsdk_astc_probe_descriptors(void); DehermDmSdkAstcProbeStatus deherm_dmsdk_astc_probe_dispatch(uint16_t id,const uint8_t* input,uint32_t input_length,DehermDmSdkAstcProbeResult* out_result);\n#ifdef __cplusplus\n}\n#endif\n#endif\n`,
    `// Generated by scripts/generate-dmsdk-astc-probe-bindings.mjs. Do not edit.\n#include <defold_hermes/generated_dmsdk_astc_probe.h>\n${includes(entries)}\nextern "C" {\n${wrappers} }\n`,
    `// Generated by scripts/generate-dmsdk-astc-probe-bindings.mjs. Do not edit.\n#include <defold_hermes/generated_dmsdk_astc_probe.h>\n#include <defold_hermes/generated_dmsdk_astc_probe_runtime.h>\nnamespace { const DehermDmSdkAstcProbeDescriptor kDescriptors[]={\n${descriptors}\n}; }\nextern "C" { uint32_t deherm_dmsdk_astc_probe_count(void){return UINT32_C(${entries.length});} const DehermDmSdkAstcProbeDescriptor* deherm_dmsdk_astc_probe_descriptors(void){return kDescriptors;} DehermDmSdkAstcProbeStatus deherm_dmsdk_astc_probe_dispatch(uint16_t id,const uint8_t* input,uint32_t input_length,DehermDmSdkAstcProbeResult* out_result){if(id>=deherm_dmsdk_astc_probe_count())return DEHERM_DMSDK_ASTC_PROBE_UNKNOWN_ID;if(out_result==nullptr||(input_length&&input==nullptr))return DEHERM_DMSDK_ASTC_PROBE_NULL_STORAGE;out_result->width=out_result->height=out_result->depth=0;if(input_length<UINT32_C(${minimum}))return DEHERM_DMSDK_ASTC_PROBE_INPUT_TOO_SHORT;uint8_t valid=0;switch(id){${cases}default:return DEHERM_DMSDK_ASTC_PROBE_UNKNOWN_ID;}return valid?DEHERM_DMSDK_ASTC_PROBE_OK:DEHERM_DMSDK_ASTC_PROBE_NOT_ASTC;} }\n`,
  ];
}

function renderXtea({ entries }) {
  const maximum = Math.max(...entries.map(({ maximumKeyBytes }) => maximumKeyBytes));
  const declarations = entries
    .map(({ wrapper }) => `uint8_t ${wrapper}(uint8_t*,uint32_t,const uint8_t*,uint32_t);`)
    .join("\n");
  const wrappers = entries
    .map(
      ({ wrapper, symbol, algorithmExpression, successExpression }) =>
        `uint8_t ${wrapper}(uint8_t*d,uint32_t n,const uint8_t*k,uint32_t z){if(!d||!k||z>${maximum})return 0;return ${symbol}(${algorithmExpression},d,n,k,z)==${successExpression};}`,
    )
    .join("");
  const cases = entries.map(({ id, wrapper }) => `case ${id}:ok=${wrapper}(d,n,k,z);break;`).join("");
  return [
    `// Generated by scripts/generate-dmsdk-xtea-span-bindings.mjs. Do not edit.\n#ifndef DEFOLD_HERMES_GENERATED_DMSDK_XTEA_SPAN_H\n#define DEFOLD_HERMES_GENERATED_DMSDK_XTEA_SPAN_H\n#include <stdint.h>\n#ifdef __cplusplus\nextern "C" {\n#endif\n${declarations}\n#ifdef __cplusplus\n}\n#endif\n#endif\n`,
    `// Generated by scripts/generate-dmsdk-xtea-span-bindings.mjs. Do not edit.\n#ifndef DEFOLD_HERMES_GENERATED_DMSDK_XTEA_SPAN_RUNTIME_H\n#define DEFOLD_HERMES_GENERATED_DMSDK_XTEA_SPAN_RUNTIME_H\n#include <stdint.h>\ntypedef enum DehermDmSdkXteaSpanStatus{DEHERM_DMSDK_XTEA_SPAN_OK,DEHERM_DMSDK_XTEA_SPAN_UNKNOWN_ID,DEHERM_DMSDK_XTEA_SPAN_NULL_STORAGE,DEHERM_DMSDK_XTEA_SPAN_KEY_TOO_LONG,DEHERM_DMSDK_XTEA_SPAN_NATIVE_FAILURE}DehermDmSdkXteaSpanStatus;\n#ifdef __cplusplus\nextern "C" {\n#endif\nuint32_t deherm_dmsdk_xtea_span_count(void);DehermDmSdkXteaSpanStatus deherm_dmsdk_xtea_span_dispatch(uint16_t,uint8_t*,uint32_t,const uint8_t*,uint32_t);\n#ifdef __cplusplus\n}\n#endif\n#endif\n`,
    `// Generated by scripts/generate-dmsdk-xtea-span-bindings.mjs. Do not edit.\n#include <defold_hermes/generated_dmsdk_xtea_span.h>\n${includes(entries)}\nextern "C" {${wrappers} }\n`,
    `// Generated by scripts/generate-dmsdk-xtea-span-bindings.mjs. Do not edit.\n#include <defold_hermes/generated_dmsdk_xtea_span.h>\n#include <defold_hermes/generated_dmsdk_xtea_span_runtime.h>\nextern "C" {uint32_t deherm_dmsdk_xtea_span_count(void){return ${entries.length};}DehermDmSdkXteaSpanStatus deherm_dmsdk_xtea_span_dispatch(uint16_t id,uint8_t*d,uint32_t n,const uint8_t*k,uint32_t z){if(id>=${entries.length})return DEHERM_DMSDK_XTEA_SPAN_UNKNOWN_ID;if(!d||!k)return DEHERM_DMSDK_XTEA_SPAN_NULL_STORAGE;if(z>${maximum})return DEHERM_DMSDK_XTEA_SPAN_KEY_TOO_LONG;uint8_t ok=0;switch(id){${cases}default:return DEHERM_DMSDK_XTEA_SPAN_UNKNOWN_ID;}return ok?DEHERM_DMSDK_XTEA_SPAN_OK:DEHERM_DMSDK_XTEA_SPAN_NATIVE_FAILURE;}}\n`,
  ];
}

function renderHashSpan({ entries }) {
  const declarations = entries
    .map(
      ({ wrapper, resultBits }) =>
        `uint8_t ${wrapper}(const uint8_t* input, uint32_t input_length, uint${resultBits}_t* out_hash);`,
    )
    .join("\n");
  const wrappers = entries
    .map(
      ({ wrapper, resultBits, symbol }) =>
        `uint8_t ${wrapper}(const uint8_t* input, uint32_t input_length, uint${resultBits}_t* out_hash)\n{\n  if (out_hash == 0 || (input_length != 0 && input == 0)) return UINT8_C(0);\n  *out_hash = ${symbol}(input, input_length);\n  return UINT8_C(1);\n}`,
    )
    .join("\n");
  const descriptors = entries
    .map(
      ({ id, resultBits, declarationId }) =>
        `  { UINT16_C(${id}), UINT8_C(${resultBits}), ${JSON.stringify(declarationId)} }`,
    )
    .join(",\n");
  const cases = entries
    .map(({ id, resultBits, wrapper }) =>
      resultBits === 64
        ? `    case ${id}: return ${wrapper}(input, input_length, out_hash) ? DEHERM_DMSDK_HASH_SPAN_OK : DEHERM_DMSDK_HASH_SPAN_NULL_STORAGE;`
        : `    case ${id}: { uint32_t value=0; if (!${wrapper}(input, input_length, &value)) return DEHERM_DMSDK_HASH_SPAN_NULL_STORAGE; *out_hash=value; return DEHERM_DMSDK_HASH_SPAN_OK; }`,
    )
    .join("\n");
  return [
    `// Generated by scripts/generate-dmsdk-hash-span-bindings.mjs. Do not edit.\n#ifndef DEFOLD_HERMES_GENERATED_DMSDK_HASH_SPAN_H\n#define DEFOLD_HERMES_GENERATED_DMSDK_HASH_SPAN_H\n#include <stdint.h>\n#ifdef __cplusplus\nextern "C" {\n#endif\n${declarations}\n#ifdef __cplusplus\n}\n#endif\n#endif\n`,
    `// Generated by scripts/generate-dmsdk-hash-span-bindings.mjs. Do not edit.\n#ifndef DEFOLD_HERMES_GENERATED_DMSDK_HASH_SPAN_RUNTIME_H\n#define DEFOLD_HERMES_GENERATED_DMSDK_HASH_SPAN_RUNTIME_H\n#include <stdint.h>\ntypedef enum DehermDmSdkHashSpanStatus { DEHERM_DMSDK_HASH_SPAN_OK=0, DEHERM_DMSDK_HASH_SPAN_UNKNOWN_ID=1, DEHERM_DMSDK_HASH_SPAN_NULL_STORAGE=2 } DehermDmSdkHashSpanStatus;\ntypedef struct DehermDmSdkHashSpanDescriptor { uint16_t id; uint8_t result_bits; const char* declaration_id; } DehermDmSdkHashSpanDescriptor;\n#ifdef __cplusplus\nextern "C" {\n#endif\nuint32_t deherm_dmsdk_hash_span_count(void);\nconst DehermDmSdkHashSpanDescriptor* deherm_dmsdk_hash_span_descriptors(void);\nDehermDmSdkHashSpanStatus deherm_dmsdk_hash_span_dispatch(uint16_t id, const uint8_t* input, uint32_t input_length, uint64_t* out_hash);\n#ifdef __cplusplus\n}\n#endif\n#endif\n`,
    `// Generated by scripts/generate-dmsdk-hash-span-bindings.mjs. Do not edit.\n#include <defold_hermes/generated_dmsdk_hash_span.h>\n${includes(entries)}\nextern "C" {\n${wrappers}\n}\n`,
    `// Generated by scripts/generate-dmsdk-hash-span-bindings.mjs. Do not edit.\n#include <defold_hermes/generated_dmsdk_hash_span.h>\n#include <defold_hermes/generated_dmsdk_hash_span_runtime.h>\nnamespace {\nconst DehermDmSdkHashSpanDescriptor kDescriptors[] = {\n${descriptors}\n};\n}\nextern "C" {\nuint32_t deherm_dmsdk_hash_span_count(void) { return UINT32_C(${entries.length}); }\nconst DehermDmSdkHashSpanDescriptor* deherm_dmsdk_hash_span_descriptors(void) { return kDescriptors; }\nDehermDmSdkHashSpanStatus deherm_dmsdk_hash_span_dispatch(uint16_t id, const uint8_t* input, uint32_t input_length, uint64_t* out_hash)\n{\n  if (id >= deherm_dmsdk_hash_span_count()) return DEHERM_DMSDK_HASH_SPAN_UNKNOWN_ID;\n  if (out_hash == 0 || (input_length != 0 && input == 0)) return DEHERM_DMSDK_HASH_SPAN_NULL_STORAGE;\n  switch (id) {\n${cases}\n    default: return DEHERM_DMSDK_HASH_SPAN_UNKNOWN_ID;\n  }\n}\n}\n`,
  ];
}

const REGISTRY = Object.freeze({
  "fixed-digest": renderFixedDigest,
  "base64-span": renderBase64,
  "astc-probe": renderAstc,
  "xtea-span": renderXtea,
  "hash-span": renderHashSpan,
});

export function renderDmSdkBoundedOutputs(recipeFacts) {
  const facts = normalizeFacts(recipeFacts);
  return new Map(
    DMSDK_BOUNDED_OUTPUTS[facts.family].map((path, index) => [path, REGISTRY[facts.family](facts)[index]]),
  );
}
