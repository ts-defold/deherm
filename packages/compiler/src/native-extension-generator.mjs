import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function safeName(value, label) { if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new Error(`${label} must be an identifier`); return value; }
function walk(node, visit) { visit(node); for (const child of node.inner ?? []) walk(child, visit); }
function resultSpelling(node) { return node.type.qualType.replace(/\s*\([^()]*\)$/, "").trim(); }

const scalar = new Map([
  ["void", ["void", "void"]], ["_Bool", ["bool", "boolean"]], ["bool", ["bool", "boolean"]],
  ["uint8_t", ["u8", "number"]], ["uint16_t", ["u16", "number"]], ["uint32_t", ["u32", "number"]], ["uint64_t", ["u64", "bigint"]],
  ["int8_t", ["i8", "number"]], ["int16_t", ["i16", "number"]], ["int32_t", ["i32", "number"]], ["int64_t", ["i64", "bigint"]],
  ["float", ["f32", "number"]], ["double", ["f64", "number"]], ["const char *", ["cstring", "string"]], ["char const *", ["cstring", "string"]],
]);

function normalizeType(spelling, enums, records) {
  const text = spelling.replace(/\s+/g, " ").trim();
  if (scalar.has(text)) { const [kind, ts] = scalar.get(text); return { kind, nativeType: text, ts }; }
  const enumName = text.replace(/^enum /, "");
  if (enums.has(enumName)) return { kind: "enum", name: enumName, nativeType: text, ts: enumName };
  const recordName = text.replace(/^struct /, "");
  if (records.has(recordName)) return { kind: "record", name: recordName, nativeType: text, ts: recordName };
  if (/\*$/.test(text)) return { kind: "pointer", nativeType: text, ts: "NativeAddress" };
  return { kind: "unsupported", nativeType: text, ts: "never" };
}

function enumValues(nodes) { let next = 0; return nodes.filter((item) => item.kind === "EnumConstantDecl").map((item) => { const explicit = item.inner?.find((child) => child.kind === "ConstantExpr")?.value; const value = explicit === undefined ? next : Number(explicit); next = value + 1; return { name: item.name, value }; }); }
function typeSupported(type) { return !["record", "unsupported", "pointer"].includes(type.kind); }

function routeIdentity(module, symbol, parameters, result, variadic) {
  const signature = {
    schemaVersion: 1,
    module,
    symbol,
    parameters: parameters.map(({ position, type }) => ({ position, nativeType: type.nativeType })),
    resultNativeType: result.nativeType,
    variadic,
  };
  const digest = sha256(JSON.stringify(signature));
  return {
    numericId: Number.parseInt(digest.slice(0, 8), 16) >>> 0,
    stableId: `native-extension:${module}:${symbol}:${digest}`,
    signatureSha256: digest,
  };
}

export function ingestNativeExtensionHeader({ header, moduleName, clang = process.env.CLANG ?? "clang", include = [] }) {
  const absolute = path.resolve(header), module = safeName(moduleName, "moduleName");
  const ast = JSON.parse(execFileSync(clang, ["-x", "c", "-std=c11", "-Wno-pragma-once-outside-header", ...include.flatMap((entry) => ["-I", path.resolve(entry)]), "-Xclang", "-ast-dump=json", "-fsyntax-only", absolute], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }));
  const enums = new Map(), records = new Map(), functions = [];
  walk(ast, (node) => {
    if (node.kind === "EnumDecl" && node.name && node.loc?.file === absolute) enums.set(node.name, { name: node.name, values: enumValues(node.inner ?? []) });
    if (node.kind === "RecordDecl" && node.name && (node.loc?.file === absolute || node.loc?.line)) records.set(node.name, { name: node.name, fields: (node.inner ?? []).filter((item) => item.kind === "FieldDecl").map((item) => ({ name: item.name, nativeType: item.type.qualType })) });
    if (node.kind === "FunctionDecl" && node.name && node.name.startsWith(`${module}_`) && (node.loc?.file === absolute || node.loc?.line)) functions.push(node);
  });
  const candidates = functions.sort((a, b) => a.loc.line - b.loc.line || a.name.localeCompare(b.name)).map((node) => {
    const parameters = (node.inner ?? []).filter((item) => item.kind === "ParmVarDecl").map((item, position) => ({ position, name: item.name || `arg${position}`, type: normalizeType(item.type.qualType, enums, records) }));
    const result = normalizeType(resultSpelling(node), enums, records);
    const variadic = Boolean(node.variadic) || /,?\s*\.\.\.\s*\)/u.test(node.type.qualType);
    const blockers = [
      ...parameters.filter(({ type }) => !typeSupported(type)).map(({ position, type }) => `parameter-${position}:${type.kind}:${type.nativeType}`),
      ...(!typeSupported(result) ? [`result:${result.kind}:${result.nativeType}`] : []),
      ...(variadic ? ["variadic:requires-typed-nonvariadic-facade"] : []),
    ];
    const identity = routeIdentity(module, node.name, parameters, result, variadic);
    return { id: identity.numericId, ...identity, symbol: node.name, line: node.loc.line, variadic, parameters, result, disposition: blockers.length ? "cataloged-needs-layout" : "generated-c-abi", blockers };
  });
  const stableRoutes = new Map();
  for (const route of candidates) {
    if (!stableRoutes.has(route.stableId)) stableRoutes.set(route.stableId, route);
  }
  const routes = [...stableRoutes.values()];
  const numericOwners = new Map();
  for (const route of routes) {
    const owner = numericOwners.get(route.numericId);
    if (owner) throw new Error(`native extension numeric ID collision between ${owner.symbol} (${owner.stableId}) and ${route.symbol} (${route.stableId})`);
    numericOwners.set(route.numericId, route);
  }
  const referencedRecords = new Set(routes.flatMap((route) => [route.result, ...route.parameters.map(({ type }) => type)]).filter(({ kind }) => kind === "record").map(({ name }) => name));
  const referencedEnums = new Set(routes.flatMap((route) => [route.result, ...route.parameters.map(({ type }) => type)]).filter(({ kind }) => kind === "enum").map(({ name }) => name));
  return { schemaVersion: 1, module, header: path.basename(absolute), headerSha256: sha256(readFileSync(absolute)), enums: [...enums.values()].filter(({ name }) => referencedEnums.has(name)).sort((a, b) => a.name.localeCompare(b.name)), records: [...records.values()].filter(({ name }) => referencedRecords.has(name)).sort((a, b) => a.name.localeCompare(b.name)), routes };
}

function tag(type) { if (type.kind === "bool") return "DEHERM_DMSDK_UNIVERSAL_BOOL"; if (["f32", "f64"].includes(type.kind)) return "DEHERM_DMSDK_UNIVERSAL_F64"; if (["i8", "i16", "i32", "i64", "enum"].includes(type.kind)) return "DEHERM_DMSDK_UNIVERSAL_I64"; if (["u8", "u16", "u32", "u64"].includes(type.kind)) return "DEHERM_DMSDK_UNIVERSAL_U64"; if (type.kind === "cstring") return "DEHERM_DMSDK_UNIVERSAL_ADDRESS"; return type.kind === "void" ? "DEHERM_DMSDK_UNIVERSAL_VOID" : null; }
function condition(type, index, ir) { const tagged = `arguments[${index}].tag==${tag(type)}`; if (type.kind === "bool") return `${tagged}&&arguments[${index}].payload<=1`; if (["u8", "u16", "u32"].includes(type.kind)) return `${tagged}&&arguments[${index}].payload<=UINT${type.kind.slice(1)}_MAX`; if (["i8", "i16", "i32"].includes(type.kind)) return `${tagged}&&deherm_ext_unpack_i64(arguments[${index}].payload)>=INT${type.kind.slice(1)}_MIN&&deherm_ext_unpack_i64(arguments[${index}].payload)<=INT${type.kind.slice(1)}_MAX`; if (type.kind === "enum") { const domain = ir.enums.find(({ name }) => name === type.name)?.values ?? []; return `${tagged}&&(${domain.map(({ value }) => `deherm_ext_unpack_i64(arguments[${index}].payload)==INT64_C(${value})`).join("||") || "false"})`; } if (type.kind === "cstring") return `${tagged}&&arguments[${index}].payload!=0`; return tagged; }
function decode(type, index) { if (type.kind === "bool") return `arguments[${index}].payload != 0`; if (type.kind === "f32") return `static_cast<float>(deherm_ext_unpack_f64(arguments[${index}].payload))`; if (type.kind === "f64") return `deherm_ext_unpack_f64(arguments[${index}].payload)`; if (["i8", "i16", "i32", "i64", "enum"].includes(type.kind)) return `static_cast<${type.nativeType}>(deherm_ext_unpack_i64(arguments[${index}].payload))`; if (["u8", "u16", "u32", "u64"].includes(type.kind)) return `static_cast<${type.nativeType}>(arguments[${index}].payload)`; if (type.kind === "cstring") return `reinterpret_cast<const char*>(static_cast<uintptr_t>(arguments[${index}].payload))`; }
function encodeResult(type, call) { if (type.kind === "void") return `${call}; result->tag=DEHERM_DMSDK_UNIVERSAL_VOID;`;
  if (type.kind === "bool") return `auto value=${call};result->tag=DEHERM_DMSDK_UNIVERSAL_BOOL;result->payload=value?1:0;`;
  if (["f32", "f64"].includes(type.kind)) return `double value=static_cast<double>(${call});result->tag=DEHERM_DMSDK_UNIVERSAL_F64;memcpy(&result->payload,&value,sizeof(value));`;
  if (["i8", "i16", "i32", "i64", "enum"].includes(type.kind)) return `auto value=${call};result->tag=DEHERM_DMSDK_UNIVERSAL_I64;result->payload=static_cast<uint64_t>(static_cast<int64_t>(value));`;
  if (["u8", "u16", "u32", "u64"].includes(type.kind)) return `auto value=${call};result->tag=DEHERM_DMSDK_UNIVERSAL_U64;result->payload=static_cast<uint64_t>(value);`;
  if (type.kind === "cstring") return `const char* value=${call};result->tag=DEHERM_DMSDK_UNIVERSAL_ADDRESS;result->payload=reinterpret_cast<uintptr_t>(value);result->auxiliary=value?strlen(value):0;`;
}

function routeNames(ir, route) {
  const suffix = route.signatureSha256.slice(0, 16);
  return {
    productionWrapper: `deherm_ext_${ir.module}_route_${suffix}`,
    exactWrapper: `deherm_ext_${ir.module}_route_${suffix}__exact_call`,
    fakeCallee: `deherm_ext_${ir.module}_route_${suffix}__exact_callee`,
  };
}

function renderWrapper(route, ir, wrapper, callee) {
  const checks = route.parameters.map((parameter) => condition(parameter.type, parameter.position, ir));
  const call = `${callee}(${route.parameters.map((parameter) => decode(parameter.type, parameter.position)).join(",")})`;
  return `static DehermDmSdkUniversalStatus ${wrapper}(const DehermDmSdkUniversalValue* arguments,uint32_t argument_count,DehermDmSdkUniversalValue* result){if((argument_count&&!arguments)||!result)return DEHERM_DMSDK_UNIVERSAL_INVALID_STORAGE;if(argument_count!=${route.parameters.length})return DEHERM_DMSDK_UNIVERSAL_WRONG_ARITY;${checks.length ? `if(!(${checks.join("&&")}))return DEHERM_DMSDK_UNIVERSAL_TYPE_MISMATCH;` : ""}${encodeResult(route.result, call)}return DEHERM_DMSDK_UNIVERSAL_OK;}`;
}

function renderDispatcher(name, routes, wrapperKey) {
  return `extern "C" DehermDmSdkUniversalStatus ${name}(uint32_t id,const DehermDmSdkUniversalValue* arguments,uint32_t argument_count,DehermDmSdkUniversalValue* result){switch(id){${routes.map((route) => `case UINT32_C(${route.numericId}):return ${route.names[wrapperKey]}(arguments,argument_count,result);`).join("")}default:return DEHERM_DMSDK_UNIVERSAL_UNKNOWN_ID;}}`;
}

function fakeDeclaration(route) {
  return `extern "C" ${route.result.nativeType} ${route.names.fakeCallee}(${route.parameters.map(({ type }, index) => `${type.nativeType} arg${index}`).join(",")});`;
}

function sampleFor(type, position, ir, role) {
  if (type.kind === "void") return { kind: "void", tag: tag(type), value: null };
  if (type.kind === "bool") return { kind: type.kind, tag: tag(type), value: true };
  if (["u8", "u16", "u32", "u64"].includes(type.kind)) return { kind: type.kind, tag: tag(type), value: role === "result" ? 91 : 17 + position };
  if (["i8", "i16", "i32", "i64"].includes(type.kind)) return { kind: type.kind, tag: tag(type), value: role === "result" ? -31 : -7 - position };
  if (["f32", "f64"].includes(type.kind)) return { kind: type.kind, tag: tag(type), value: role === "result" ? 9.5 : 1.25 + position };
  if (type.kind === "cstring") return { kind: type.kind, tag: tag(type), value: role === "result" ? "deherm-exact-result" : `deherm-exact-argument-${position}` };
  if (type.kind === "enum") {
    const domain = ir.enums.find(({ name }) => name === type.name)?.values ?? [];
    if (!domain.length) throw new Error(`${type.name}: generated enum route has no declared values`);
    return { kind: type.kind, tag: tag(type), value: domain[role === "result" ? domain.length - 1 : position % domain.length].value, enumName: type.name };
  }
  throw new Error(`cannot generate exact-call sample for ${type.nativeType}`);
}

function nativeLiteral(type, sample) {
  if (type.kind === "bool") return sample.value ? "true" : "false";
  if (["u8", "u16", "u32", "u64", "i8", "i16", "i32", "i64"].includes(type.kind)) return `static_cast<${type.nativeType}>(${sample.value})`;
  if (type.kind === "f32") return `${sample.value}f`;
  if (type.kind === "f64") return `${sample.value}`;
  if (type.kind === "cstring") return JSON.stringify(sample.value);
  if (type.kind === "enum") return `static_cast<${type.nativeType}>(${sample.value})`;
  if (type.kind === "void") return "";
  throw new Error(`cannot render native exact-call value for ${type.nativeType}`);
}

function nativeComparison(type, expression, sample) {
  if (type.kind === "cstring") return `${expression}&&strcmp(${expression},${JSON.stringify(sample.value)})==0`;
  return `${expression}==${nativeLiteral(type, sample)}`;
}

function renderCellSetup(sample, index) {
  const slot = `arguments[${index}]`;
  if (sample.kind === "bool") return `${slot}.tag=${sample.tag};${slot}.payload=${sample.value ? 1 : 0};`;
  if (["u8", "u16", "u32", "u64"].includes(sample.kind)) return `${slot}.tag=${sample.tag};${slot}.payload=UINT64_C(${sample.value});`;
  if (["i8", "i16", "i32", "i64", "enum"].includes(sample.kind)) return `${slot}.tag=${sample.tag};${slot}.payload=static_cast<uint64_t>(${sample.value});`;
  if (["f32", "f64"].includes(sample.kind)) return `{double value=${sample.value};${slot}.tag=${sample.tag};memcpy(&${slot}.payload,&value,sizeof(value));}`;
  if (sample.kind === "cstring") return `{const char* value=${JSON.stringify(sample.value)};${slot}.tag=${sample.tag};${slot}.payload=reinterpret_cast<uintptr_t>(value);${slot}.auxiliary=strlen(value);}`;
  throw new Error(`cannot render exact-call cell for ${sample.kind}`);
}

function renderResultCheck(type, sample) {
  if (type.kind === "void") return `result.tag==${sample.tag}`;
  if (type.kind === "bool") return `result.tag==${sample.tag}&&result.payload==${sample.value ? 1 : 0}`;
  if (["u8", "u16", "u32", "u64"].includes(type.kind)) return `result.tag==${sample.tag}&&result.payload==UINT64_C(${sample.value})`;
  if (["i8", "i16", "i32", "i64", "enum"].includes(type.kind)) return `result.tag==${sample.tag}&&deherm_exact_result_i64(result)==${sample.value}`;
  if (["f32", "f64"].includes(type.kind)) return `result.tag==${sample.tag}&&deherm_exact_result_f64(result)==${sample.value}`;
  if (type.kind === "cstring") return `result.tag==${sample.tag}&&result.payload!=0&&strcmp(reinterpret_cast<const char*>(static_cast<uintptr_t>(result.payload)),${JSON.stringify(sample.value)})==0&&result.auxiliary==UINT64_C(${Buffer.byteLength(sample.value)})`;
  throw new Error(`cannot render exact-call result check for ${type.nativeType}`);
}

function extensionDeclaredOwnershipContract(route) {
  const parameters = route.parameters.map(({ position, type }) => ({
    position,
    transport: type.kind === "cstring" ? "address" : "value",
    direction: "value",
    effect: type.kind === "cstring" ? "in-address-borrowed-for-call" : "copied-value",
  }));
  const result = {
    transport: route.result.kind === "void" ? "none" : route.result.kind === "cstring" ? "address" : "value",
    direction: "return",
    effect: route.result.kind === "void" ? "no-result" : route.result.kind === "cstring" ? "returned-identity-unowned" : "copied-result",
  };
  const declaredOwnershipEffectMask = (parameters.some(({ transport }) => transport === "address") ? 16 : 0) |
    (result.transport === "address" ? 128 : 0);
  return { receiver: null, parameters, result, unresolvedRequirements: [], declaredOwnershipEffectMask };
}

function renderVerificationDriver(ir, routes, exactDispatch) {
  const definitions = [];
  const cases = [];
  for (const [routeIndex, route] of routes.entries()) {
    const inputs = route.parameters.map(({ type }, index) => sampleFor(type, index, ir, "parameter"));
    const output = sampleFor(route.result, 0, ir, "result");
    const conditions = route.parameters.map(({ type }, index) => nativeComparison(type, `arg${index}`, inputs[index]));
    const returnStatement = route.result.kind === "void" ? "return;" : `return ${nativeLiteral(route.result, output)};`;
    const declaredOwnership = extensionDeclaredOwnershipContract(route);
    definitions.push(`extern "C" ${route.result.nativeType} ${route.names.fakeCallee}(${route.parameters.map(({ type }, index) => `${type.nativeType} arg${index}`).join(",")}){++deherm_exact_calls[${routeIndex}];if(${conditions.length ? `!(${conditions.join("&&")})` : "false"}){++deherm_exact_failures[${routeIndex}];deherm_exact_failure=${routeIndex + 1};}${returnStatement}}`);
    const setups = inputs.map(renderCellSetup).join("");
    const id = `UINT32_C(${route.numericId})`;
    cases.push(`{DehermDmSdkUniversalValue arguments[${Math.max(1, route.parameters.length)}]={};DehermDmSdkUniversalValue result={};${setups}if(${exactDispatch}(${id},arguments,${route.parameters.length},&result)!=DEHERM_DMSDK_UNIVERSAL_OK)return deherm_exact_fail("dispatch",UINT32_C(${routeIndex}),${id});if(deherm_exact_calls[${routeIndex}]!=UINT32_C(1))return deherm_exact_fail("call-count",UINT32_C(${routeIndex}),${id});if(deherm_exact_failures[${routeIndex}]!=UINT32_C(0)||deherm_exact_failure)return deherm_exact_fail("arguments",UINT32_C(${routeIndex}),${id});if(!(${renderResultCheck(route.result, output)}))return deherm_exact_fail("result",UINT32_C(${routeIndex}),${id});}`);
    route.samples = { parameters: inputs, result: output };
    route.declaredOwnership = declaredOwnership;
  }
  const fakeDefinitions = definitions.join("\n");
  const source = `// Generated by @deherm/compiler native-extension exact-call driver. Do not edit.\n#include <defold_hermes/generated_dmsdk_universal.h>\n#include <${ir.header}>\n#include <stdio.h>\n#include <stdint.h>\n#include <string.h>\nextern "C" DehermDmSdkUniversalStatus ${exactDispatch}(uint32_t,const DehermDmSdkUniversalValue*,uint32_t,DehermDmSdkUniversalValue*);\nstatic int deherm_exact_failure=0;\nstatic uint32_t deherm_exact_calls[${Math.max(1, routes.length)}]={};\nstatic uint32_t deherm_exact_failures[${Math.max(1, routes.length)}]={};\nstatic int deherm_exact_fail(const char* stage,uint32_t vector,uint32_t id){fprintf(stderr,"extension exact-call failure: stage=%s vector=%u id=%u\\n",stage,vector,id);return 1;}\n[[maybe_unused]] static int64_t deherm_exact_result_i64(const DehermDmSdkUniversalValue& value){int64_t result=0;memcpy(&result,&value.payload,sizeof(result));return result;}\n[[maybe_unused]] static double deherm_exact_result_f64(const DehermDmSdkUniversalValue& value){double result=0;memcpy(&result,&value.payload,sizeof(result));return result;}\n${fakeDefinitions}\nint main(){${cases.join("")}return 0;}\n`;
  return { source, fakeDefinitionsSha256: sha256(fakeDefinitions) };
}

export function renderNativeExtensionBindings(ir, { headerInclude = path.basename(ir.header) } = {}) {
  const generated = ir.routes.filter((route) => route.disposition === "generated-c-abi").map((route) => ({ ...route, names: routeNames(ir, route) }));
  const enumLines = ir.enums.flatMap((item) => [`export const ${item.name}={${item.values.map((value) => `${value.name}:${value.value}`).join(",")}} as const;`, `export type ${item.name}=typeof ${item.name}[keyof typeof ${item.name}];`]);
  const recordLines = ir.records.map((item) => `export interface ${item.name}{${item.fields.map((field) => `readonly ${field.name}:number`).join(";")}}`);
  const functions = ir.routes.map((route) => route.disposition === "generated-c-abi" ? `  ${route.symbol.slice(ir.module.length + 1)}(${route.parameters.map((parameter) => `${parameter.name}:${parameter.type.ts}`).join(",")}):${route.result.ts};` : `  /** blocked: ${route.blockers.join(", ")} */ readonly ${route.symbol.slice(ir.module.length + 1)}:never;`);
  const typescript = `// Generated by @deherm/compiler native-extension-generator. Do not edit.\nexport type NativeAddress=bigint;\n${enumLines.join("\n")}\n${recordLines.join("\n")}\nexport interface ${ir.module[0].toUpperCase()+ir.module.slice(1)}NativeExtension {\n${functions.join("\n")}\n}\n`;
  const preamble = `#include <defold_hermes/generated_dmsdk_universal.h>\n#include <${headerInclude}>\n#include <stdint.h>\n#include <string.h>\n[[maybe_unused]] static int64_t deherm_ext_unpack_i64(uint64_t bits){int64_t value;memcpy(&value,&bits,sizeof(value));return value;}\n[[maybe_unused]] static double deherm_ext_unpack_f64(uint64_t bits){double value;memcpy(&value,&bits,sizeof(value));return value;}\n`;
  const productionDispatch = `deherm_ext_${ir.module}_dispatch`;
  const exactDispatch = `deherm_ext_${ir.module}_exact_dispatch`;
  const productionWrappers = generated.map((route) => renderWrapper(route, ir, route.names.productionWrapper, route.symbol));
  const exactWrappers = generated.map((route) => renderWrapper(route, ir, route.names.exactWrapper, route.names.fakeCallee));
  const source = `// Generated by @deherm/compiler native-extension-generator. Do not edit.\n${preamble}${productionWrappers.join("\n")}\n${renderDispatcher(productionDispatch, generated, "productionWrapper")}\n`;
  const verificationSource = `// Generated by @deherm/compiler native-extension exact-call materializer. Do not edit.\n${preamble}${generated.map(fakeDeclaration).join("\n")}\n${exactWrappers.join("\n")}\n${renderDispatcher(exactDispatch, generated, "exactWrapper")}\n`;
  const renderedDriver = renderVerificationDriver({ ...ir, header: headerInclude }, generated, exactDispatch);
  const verificationDriver = renderedDriver.source;
  const verification = {
    schemaVersion: 1,
    source: "deherm-native-extension-exact-call-verification",
    module: ir.module,
    header: ir.header,
    headerSha256: ir.headerSha256,
    productionDispatch,
    exactDispatch,
    artifacts: {
      productionSourceSha256: sha256(source),
      verificationSourceSha256: sha256(verificationSource),
      verificationDriverSha256: sha256(verificationDriver),
      fakeCalleeDefinitionsSha256: renderedDriver.fakeDefinitionsSha256,
    },
    vectorCount: generated.length,
    vectors: generated.map((route, index) => ({
      stableId: route.stableId,
      numericId: route.numericId,
      signatureSha256: route.signatureSha256,
      symbol: route.symbol,
      line: route.line,
      compileTimeResolution: {
        declaredNativeSymbol: route.symbol,
        callingConvention: "extern-c",
        callExpression: `${route.symbol}(${route.parameters.map((_, parameterIndex) => `arg${parameterIndex}`).join(", ")})`,
        returnCppType: route.result.nativeType,
        parameterCppTypes: route.parameters.map(({ type }) => type.nativeType),
        signatureSha256: route.signatureSha256,
      },
      parameters: route.parameters.map(({ position, name, type }, parameterIndex) => ({ position, name, type, sample: route.samples.parameters[parameterIndex] })),
      result: { type: route.result, sample: route.samples.result },
      declaredOwnership: {
        receiver: route.declaredOwnership.receiver,
        parameters: route.declaredOwnership.parameters,
        result: route.declaredOwnership.result,
        unresolvedRequirements: route.declaredOwnership.unresolvedRequirements,
      },
      declaredOwnershipEffectMask: route.declaredOwnership.declaredOwnershipEffectMask,
      productionWrapper: route.names.productionWrapper,
      exactWrapper: route.names.exactWrapper,
      fakeCallee: route.names.fakeCallee,
      productionWrapperSha256: sha256(productionWrappers[index]),
      exactWrapperSha256: sha256(exactWrappers[index]),
      fakeCalleeDeclarationSha256: sha256(fakeDeclaration(route)),
    })),
  };
  verification.manifestSha256 = sha256(JSON.stringify(verification));
  return { ir, typescript, source, verificationSource, verificationDriver, verification, generatedRouteCount: generated.length, blockedRouteCount: ir.routes.length - generated.length };
}
