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

export function ingestNativeExtensionHeader({ header, moduleName, clang = process.env.CLANG ?? "clang", include = [] }) {
  const absolute = path.resolve(header), module = safeName(moduleName, "moduleName");
  const ast = JSON.parse(execFileSync(clang, ["-x", "c", "-std=c11", "-Wno-pragma-once-outside-header", ...include.flatMap((entry) => ["-I", path.resolve(entry)]), "-Xclang", "-ast-dump=json", "-fsyntax-only", absolute], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }));
  const enums = new Map(), records = new Map(), functions = [];
  walk(ast, (node) => {
    if (node.kind === "EnumDecl" && node.name && node.loc?.file === absolute) enums.set(node.name, { name: node.name, values: enumValues(node.inner ?? []) });
    if (node.kind === "RecordDecl" && node.name && (node.loc?.file === absolute || node.loc?.line)) records.set(node.name, { name: node.name, fields: (node.inner ?? []).filter((item) => item.kind === "FieldDecl").map((item) => ({ name: item.name, nativeType: item.type.qualType })) });
    if (node.kind === "FunctionDecl" && node.name && node.name.startsWith(`${module}_`) && (node.loc?.file === absolute || node.loc?.line)) functions.push(node);
  });
  const routes = functions.sort((a, b) => a.loc.line - b.loc.line || a.name.localeCompare(b.name)).map((node, id) => {
    const parameters = (node.inner ?? []).filter((item) => item.kind === "ParmVarDecl").map((item, position) => ({ position, name: item.name || `arg${position}`, type: normalizeType(item.type.qualType, enums, records) }));
    const result = normalizeType(resultSpelling(node), enums, records);
    const blockers = [...parameters.filter(({ type }) => !typeSupported(type)).map(({ position, type }) => `parameter-${position}:${type.kind}:${type.nativeType}`), ...(!typeSupported(result) ? [`result:${result.kind}:${result.nativeType}`] : [])];
    return { id, stableId: `${module}:${node.name}:${sha256(`${node.type.qualType}\0${node.loc.line}`).slice(0, 16)}`, symbol: node.name, line: node.loc.line, parameters, result, disposition: blockers.length ? "cataloged-needs-layout" : "generated-c-abi", blockers };
  });
  const referencedRecords = new Set(routes.flatMap((route) => [route.result, ...route.parameters.map(({ type }) => type)]).filter(({ kind }) => kind === "record").map(({ name }) => name));
  const referencedEnums = new Set(routes.flatMap((route) => [route.result, ...route.parameters.map(({ type }) => type)]).filter(({ kind }) => kind === "enum").map(({ name }) => name));
  return { schemaVersion: 1, module, header: path.basename(absolute), headerSha256: sha256(readFileSync(absolute)), enums: [...enums.values()].filter(({ name }) => referencedEnums.has(name)).sort((a, b) => a.name.localeCompare(b.name)), records: [...records.values()].filter(({ name }) => referencedRecords.has(name)).sort((a, b) => a.name.localeCompare(b.name)), routes };
}

function tag(type) { if (type.kind === "bool") return "DEHERM_DMSDK_UNIVERSAL_BOOL"; if (["f32", "f64"].includes(type.kind)) return "DEHERM_DMSDK_UNIVERSAL_F64"; if (["i8", "i16", "i32", "i64", "enum"].includes(type.kind)) return "DEHERM_DMSDK_UNIVERSAL_I64"; if (["u8", "u16", "u32", "u64"].includes(type.kind)) return "DEHERM_DMSDK_UNIVERSAL_U64"; if (type.kind === "cstring") return "DEHERM_DMSDK_UNIVERSAL_ADDRESS"; return null; }
function condition(type, index, ir) { const tagged = `arguments[${index}].tag==${tag(type)}`; if (type.kind === "bool") return `${tagged}&&arguments[${index}].payload<=1`; if (["u8", "u16", "u32"].includes(type.kind)) return `${tagged}&&arguments[${index}].payload<=UINT${type.kind.slice(1)}_MAX`; if (["i8", "i16", "i32"].includes(type.kind)) return `${tagged}&&deherm_ext_unpack_i64(arguments[${index}].payload)>=INT${type.kind.slice(1)}_MIN&&deherm_ext_unpack_i64(arguments[${index}].payload)<=INT${type.kind.slice(1)}_MAX`; if (type.kind === "enum") { const domain = ir.enums.find(({ name }) => name === type.name)?.values ?? []; return `${tagged}&&(${domain.map(({ value }) => `deherm_ext_unpack_i64(arguments[${index}].payload)==INT64_C(${value})`).join("||") || "false"})`; } if (type.kind === "cstring") return `${tagged}&&arguments[${index}].payload!=0`; return tagged; }
function decode(type, index) { if (type.kind === "bool") return `arguments[${index}].payload != 0`; if (type.kind === "f32") return `static_cast<float>(deherm_ext_unpack_f64(arguments[${index}].payload))`; if (type.kind === "f64") return `deherm_ext_unpack_f64(arguments[${index}].payload)`; if (["i8", "i16", "i32", "i64", "enum"].includes(type.kind)) return `static_cast<${type.nativeType}>(deherm_ext_unpack_i64(arguments[${index}].payload))`; if (["u8", "u16", "u32", "u64"].includes(type.kind)) return `static_cast<${type.nativeType}>(arguments[${index}].payload)`; if (type.kind === "cstring") return `reinterpret_cast<const char*>(static_cast<uintptr_t>(arguments[${index}].payload))`; }
function encodeResult(type, call) { if (type.kind === "void") return `${call}; result->tag=DEHERM_DMSDK_UNIVERSAL_VOID;`;
  if (type.kind === "bool") return `auto value=${call};result->tag=DEHERM_DMSDK_UNIVERSAL_BOOL;result->payload=value?1:0;`;
  if (["f32", "f64"].includes(type.kind)) return `double value=static_cast<double>(${call});result->tag=DEHERM_DMSDK_UNIVERSAL_F64;memcpy(&result->payload,&value,sizeof(value));`;
  if (["i8", "i16", "i32", "i64", "enum"].includes(type.kind)) return `auto value=${call};result->tag=DEHERM_DMSDK_UNIVERSAL_I64;result->payload=static_cast<uint64_t>(static_cast<int64_t>(value));`;
  if (["u8", "u16", "u32", "u64"].includes(type.kind)) return `auto value=${call};result->tag=DEHERM_DMSDK_UNIVERSAL_U64;result->payload=static_cast<uint64_t>(value);`;
  if (type.kind === "cstring") return `const char* value=${call};result->tag=DEHERM_DMSDK_UNIVERSAL_ADDRESS;result->payload=reinterpret_cast<uintptr_t>(value);result->auxiliary=value?strlen(value):0;`;
}

export function renderNativeExtensionBindings(ir, { headerInclude = path.basename(ir.header) } = {}) {
  const generated = ir.routes.filter((route) => route.disposition === "generated-c-abi");
  const enumLines = ir.enums.flatMap((item) => [`export const ${item.name}={${item.values.map((value) => `${value.name}:${value.value}`).join(",")}} as const;`, `export type ${item.name}=typeof ${item.name}[keyof typeof ${item.name}];`]);
  const recordLines = ir.records.map((item) => `export interface ${item.name}{${item.fields.map((field) => `readonly ${field.name}:number`).join(";")}}`);
  const functions = ir.routes.map((route) => route.disposition === "generated-c-abi" ? `  ${route.symbol.slice(ir.module.length + 1)}(${route.parameters.map((parameter) => `${parameter.name}:${parameter.type.ts}`).join(",")}):${route.result.ts};` : `  /** blocked: ${route.blockers.join(", ")} */ readonly ${route.symbol.slice(ir.module.length + 1)}:never;`);
  const typescript = `// Generated by @deherm/compiler native-extension-generator. Do not edit.\nexport type NativeAddress=bigint;\n${enumLines.join("\n")}\n${recordLines.join("\n")}\nexport interface ${ir.module[0].toUpperCase()+ir.module.slice(1)}NativeExtension {\n${functions.join("\n")}\n}\n`;
  const cases = generated.map((route) => { const checks = route.parameters.map((parameter) => condition(parameter.type, parameter.position, ir)); const call = `${route.symbol}(${route.parameters.map((parameter) => decode(parameter.type, parameter.position)).join(",")})`; return `case ${route.id}:{if(argument_count!=${route.parameters.length})return DEHERM_DMSDK_UNIVERSAL_WRONG_ARITY;${checks.length ? `if(!(${checks.join("&&")}))return DEHERM_DMSDK_UNIVERSAL_TYPE_MISMATCH;` : ""}${encodeResult(route.result, call)}return DEHERM_DMSDK_UNIVERSAL_OK;}`; }).join("\n");
  const source = `// Generated by @deherm/compiler native-extension-generator. Do not edit.\n#include <defold_hermes/generated_dmsdk_universal.h>\n#include <${headerInclude}>\n#include <stdint.h>\n#include <string.h>\nstatic int64_t deherm_ext_unpack_i64(uint64_t bits){int64_t value;memcpy(&value,&bits,sizeof(value));return value;}\nstatic double deherm_ext_unpack_f64(uint64_t bits){double value;memcpy(&value,&bits,sizeof(value));return value;}\nextern \"C\" DehermDmSdkUniversalStatus deherm_ext_${ir.module}_dispatch(uint32_t id,const DehermDmSdkUniversalValue* arguments,uint32_t argument_count,DehermDmSdkUniversalValue* result){if((argument_count&&!arguments)||!result)return DEHERM_DMSDK_UNIVERSAL_INVALID_STORAGE;switch(id){${cases}default:return DEHERM_DMSDK_UNIVERSAL_UNKNOWN_ID;}}\n`;
  return { ir, typescript, source, generatedRouteCount: generated.length, blockedRouteCount: ir.routes.length - generated.length };
}
