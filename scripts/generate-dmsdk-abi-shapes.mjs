import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "..");
const defaultIrPath = resolve(repositoryRoot, "packages/bindings/generated/defold-sdk-ir.json");
const defaultClassificationPath = resolve(repositoryRoot, "packages/bindings/generated/defold-dmsdk-binding-patterns.json");
const defaultOutputPath = resolve(repositoryRoot, "packages/bindings/generated/defold-dmsdk-abi-shapes.json");

const PRIMITIVES = new Map([
  ["void", "void"], ["bool", "bool"], ["char", "i8"], ["signed char", "i8"],
  ["unsigned char", "u8"], ["short", "i16"], ["unsigned short", "u16"],
  ["int", "i32"], ["unsigned int", "u32"], ["long", "word-signed"],
  ["unsigned long", "word-unsigned"], ["long long", "i64"], ["unsigned long long", "u64"],
  ["int8_t", "i8"], ["uint8_t", "u8"], ["int16_t", "i16"], ["uint16_t", "u16"],
  ["int32_t", "i32"], ["uint32_t", "u32"], ["int64_t", "i64"], ["uint64_t", "u64"],
  ["float", "f32"], ["double", "f64"], ["size_t", "usize"], ["ssize_t", "isize"],
  ["intptr_t", "isize"], ["uintptr_t", "usize"], ["ptrdiff_t", "isize"],
]);
const OUTPUT_NAME = /(?:^out(?:_|$)|(?:^|_)(?:out|output|result|destination|dst)(?:_|$))/i;
const CONSTRUCTOR_NAME = /(?:^|::)(?:New|Create|Open|Acquire|Alloc|Clone|Load)(?:$|[A-Z_])/;
const DESTRUCTOR_NAME = /(?:^|::)(?:Delete|Destroy|Close|Release|Free|Finalize)(?:$|[A-Z_])/;

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function parseArguments(argv) {
  const options = { ir: defaultIrPath, classification: defaultClassificationPath, output: defaultOutputPath, check: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--check") options.check = true;
    else if (argument === "--ir") options.ir = resolve(argv[++index]);
    else if (argument === "--classification") options.classification = resolve(argv[++index]);
    else if (argument === "--output") options.output = resolve(argv[++index]);
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

function cleanType(type) {
  return String(type ?? "").replace(/\s+/g, " ").trim();
}

function baseType(type) {
  return cleanType(type)
    .replace(/\b(?:const|volatile|struct|class|enum)\b/g, " ")
    .replace(/\[[^\]]*\]/g, "")
    .replace(/[&*]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function leafName(name) {
  return String(name ?? "").split("::").at(-1) ?? "";
}

function namespaceOf(symbol) {
  const parts = String(symbol ?? "").split("::");
  return parts.length > 1 ? parts.slice(0, -1).join("::") : "";
}

function buildTypeIndex(declarations) {
  const exact = new Map();
  const leaves = new Map();
  for (const declaration of declarations) {
    if (!declaration.name || !["enum", "record", "class-template", "type-alias"].includes(declaration.kind)) continue;
    if (!exact.has(declaration.name) || declaration.completeDefinition) exact.set(declaration.name, declaration);
    const leaf = leafName(declaration.name);
    const values = leaves.get(leaf) ?? [];
    values.push(declaration);
    leaves.set(leaf, values);
  }
  return { exact, leaves };
}

function resolveType(type, symbol, index) {
  const base = baseType(type);
  if (!base) return undefined;
  if (index.exact.has(base)) return index.exact.get(base);
  const namespace = namespaceOf(symbol);
  if (namespace && index.exact.has(`${namespace}::${base}`)) return index.exact.get(`${namespace}::${base}`);
  const matches = index.leaves.get(leafName(base)) ?? [];
  const complete = matches.filter((candidate) => candidate.completeDefinition);
  if (complete.length === 1) return complete[0];
  return matches.length === 1 ? matches[0] : undefined;
}

function callbackLike(type, symbol, index, seen = new Set()) {
  const clean = cleanType(type);
  if (/\(\s*\*[^)]*\)\s*\(/.test(clean)) return true;
  const resolved = resolveType(clean, symbol, index);
  if (!resolved || seen.has(resolved.id)) return false;
  seen.add(resolved.id);
  return resolved.kind === "type-alias" && callbackLike(resolved.type, resolved.name, index, seen);
}

function underlyingPrimitive(type, symbol, index, seen = new Set()) {
  if (/[&*]/.test(String(type ?? ""))) return undefined;
  const base = baseType(type);
  if (PRIMITIVES.has(base)) return PRIMITIVES.get(base);
  const resolved = resolveType(base, symbol, index);
  if (!resolved || resolved.kind !== "type-alias" || seen.has(resolved.id)) return undefined;
  seen.add(resolved.id);
  return underlyingPrimitive(resolved.type, resolved.name, index, seen);
}

function isHandleName(name) {
  const leaf = leafName(name);
  return /^H[A-Z]/.test(leaf) || /Handle(?:$|[A-Z_])/.test(leaf) || /^(?:Socket|Connection|Context)$/.test(leaf);
}

function directionOf(type, name) {
  const clean = cleanType(type);
  if (!/[&*]/.test(clean)) return "value";
  if (/^const\b/.test(clean)) return "in";
  if (/\*\s*\*/.test(clean) || OUTPUT_NAME.test(name ?? "")) return "out";
  return "inout";
}

function roleOf(type, symbol, parameterName, index) {
  const clean = cleanType(type);
  const base = baseType(clean);
  const direction = directionOf(clean, parameterName);
  if (/\.\.\.|\bva_list\b/.test(clean)) return { role: "variadic", direction, nativeType: clean };
  if (callbackLike(clean, symbol, index)) return { role: "callback", direction, nativeType: clean };
  const pointerDepth = (clean.match(/\*/g) ?? []).length;
  const isReference = /&/.test(clean);
  if (pointerDepth > 0) {
    const pointee = underlyingPrimitive(base, symbol, index);
    if (base === "char" && pointerDepth === 1) return { role: direction === "in" ? "cstring-in" : "cstring-mutable", direction, nativeType: clean };
    if (base === "void") return { role: pointerDepth > 1 ? "opaque-pointer-out" : "opaque-pointer", direction, nativeType: clean };
    const resolved = resolveType(base, symbol, index);
    const target = resolved?.kind === "record" ? `record:${resolved.name}`
      : resolved?.kind === "enum" ? `enum:${resolved.name}`
        : pointee ? `scalar:${pointee}` : `unknown:${base}`;
    return { role: pointerDepth > 1 ? `pointer-out:${target}` : `pointer:${target}`, direction, nativeType: clean };
  }
  const resolved = resolveType(base, symbol, index);
  if (resolved?.kind === "type-alias" && isHandleName(resolved.name)) {
    return { role: `handle:${resolved.name}:${underlyingPrimitive(resolved.type, resolved.name, index) ?? "opaque"}`, direction, nativeType: clean };
  }
  if (resolved?.kind === "type-alias" && /[&*]/.test(resolved.type ?? "")) {
    const lowered = roleOf(resolved.type, resolved.name, parameterName, index);
    return { ...lowered, nativeType: clean, alias: resolved.name };
  }
  const primitive = underlyingPrimitive(base, symbol, index);
  if (resolved?.kind === "enum") return { role: `enum:${resolved.name}`, direction, nativeType: clean };
  if (resolved?.kind === "record" || resolved?.kind === "class-template") {
    return { role: `${isReference ? "record-ref" : "record-value"}:${resolved.name}`, direction, nativeType: clean };
  }
  if (primitive) return { role: `scalar:${primitive}`, direction, nativeType: clean };
  if (isHandleName(base)) return { role: `handle:${base}:opaque`, direction, nativeType: clean };
  if (/<[^>]+>|\b(?:T|KEY)\b/.test(base)) return { role: `template:${base}`, direction, nativeType: clean };
  return { role: `unknown:${base || "empty"}`, direction, nativeType: clean };
}

function shapeBlockers(binding, result, parameters) {
  const roles = [result.role, ...parameters.map(({ role }) => role)];
  const blockers = new Set(["native-symbol-linkage-unverified"]);
  if (roles.some((role) => role === "callback")) blockers.add("callback-thread-reentrancy-lifetime-policy");
  if (roles.some((role) => role === "variadic")) blockers.add("typed-nonvariadic-facade-required");
  if (roles.some((role) => role.startsWith("handle:"))) blockers.add("handle-provenance-ownership-nullability-policy");
  if (roles.some((role) => /^(?:pointer|opaque-pointer|cstring-mutable)/.test(role))) blockers.add("pointer-bounds-direction-lifetime-policy");
  if (roles.some((role) => role.startsWith("record-"))) blockers.add("record-layout-alignment-copy-policy");
  if (roles.some((role) => role.startsWith("enum:"))) blockers.add("enum-width-domain-validation-policy");
  if (roles.some((role) => role.startsWith("template:") || role.startsWith("unknown:"))) blockers.add("type-lowering-unresolved");
  if (binding.families.includes("platform-gated")) blockers.add("per-target-feature-and-symbol-matrix");
  if (binding.families.includes("out-param")) blockers.add("out-storage-initialization-and-failure-policy");
  if (binding.families.includes("pointer-span")) blockers.add("span-element-unit-and-copy-policy");
  return [...blockers].sort();
}

function trancheOf(declaration, binding, result, parameters) {
  const roles = [result.role, ...parameters.map(({ role }) => role)];
  if (binding.primaryFamily === "scalar-direct") return "implemented-scalar-frontier";
  if (declaration.kind === "function" && roles.every((role) => role.startsWith("scalar:") || role.startsWith("enum:") || role === "void") && roles.some((role) => role.startsWith("enum:"))) {
    return "next-enum-value-direct";
  }
  if (declaration.kind === "function" && roles.every((role) => role.startsWith("scalar:") || role === "void")) {
    return "next-named-scalar-direct";
  }
  if (binding.families.includes("variadic") || roles.some((role) => role === "variadic")) return "typed-variadic-facades";
  if (binding.families.includes("callback") || roles.some((role) => role === "callback")) return "callback-registry";
  if (roles.some((role) => role.startsWith("record-"))) return "layout-verified-records";
  if (binding.families.includes("pointer-span")) return "arena-backed-spans";
  if (binding.families.includes("out-param")) return "scratch-out-parameters";
  if (roles.some((role) => role.startsWith("cstring-"))) return "string-codecs";
  if (roles.some((role) => role.startsWith("handle:"))) {
    if (CONSTRUCTOR_NAME.test(declaration.name ?? "") || result.role.startsWith("handle:")) return "owned-handle-producers";
    if (DESTRUCTOR_NAME.test(declaration.name ?? "")) return "owned-handle-finalizers";
    return "borrowed-handle-consumers";
  }
  if (roles.some((role) => /^(?:pointer|opaque-pointer)/.test(role))) return "pointer-lifetime-adapters";
  if (binding.families.includes("template-opaque")) return "template-specializations";
  return "manual-triage-required";
}

function summarize(rows, key) {
  const counts = new Map();
  for (const row of rows) counts.set(row[key], (counts.get(row[key]) ?? 0) + 1);
  return Object.fromEntries([...counts].sort(([leftKey, leftCount], [rightKey, rightCount]) => rightCount - leftCount || leftKey.localeCompare(rightKey)));
}

export async function build(irContent, classificationContent) {
  const ir = JSON.parse(irContent);
  const classification = JSON.parse(classificationContent);
  const declarationsById = new Map(ir.declarations.map((declaration) => [declaration.id, declaration]));
  const typeIndex = buildTypeIndex(ir.declarations);
  const rows = classification.bindings.map((binding) => {
    const declaration = declarationsById.get(binding.id);
    if (!declaration) throw new Error(`Classification references missing declaration ${binding.id}`);
    const result = roleOf(declaration.returns ?? "void", declaration.name, "return", typeIndex);
    const parameters = (declaration.parameters ?? []).map((parameter, position) => ({
      position,
      name: parameter.name,
      ...roleOf(parameter.type, declaration.name, parameter.name, typeIndex),
    }));
    const shape = `${result.role}(${parameters.map(({ role, direction }) => `${direction}:${role}`).join(",")})`;
    return {
      id: binding.id,
      symbol: declaration.name,
      kind: declaration.kind,
      header: declaration.header,
      line: declaration.line,
      primaryFamily: binding.primaryFamily,
      families: binding.families,
      shape,
      result,
      parameters,
      tranche: trancheOf(declaration, binding, result, parameters),
      blockers: shapeBlockers(binding, result, parameters),
    };
  });
  rows.sort((left, right) => left.id.localeCompare(right.id));

  const headerHashes = {};
  for (const header of [...new Set(rows.map(({ header }) => header))].sort()) {
    headerHashes[header] = sha256(await readFile(resolve(repositoryRoot, header)));
  }
  const shapeSummary = summarize(rows, "shape");
  const trancheSummary = summarize(rows, "tranche");
  return {
    schemaVersion: 1,
    defoldRevision: ir.defoldRevision,
    sourceIr: "packages/bindings/generated/defold-sdk-ir.json",
    sourceClassification: "packages/bindings/generated/defold-dmsdk-binding-patterns.json",
    sourceHashes: { ir: sha256(irContent), classification: sha256(classificationContent), headers: headerHashes },
    policy: {
      classificationOnly: true,
      note: "A tranche or shape is a mechanical generation plan, not evidence of generated, compiled, linked, executed, conformant, allocation-free, or lifetime-safe code.",
      nextFamilies: ["next-enum-value-direct", "next-named-scalar-direct"],
      nextFamilyRationale: "Only resolved scalar or enum values cross these ABIs. Emit fixed-width integers plus generated enum-domain checks before handle, pointer, callback, record, or ownership work.",
    },
    coverage: {
      runtimePending: rows.length,
      shaped: rows.length,
      uniqueShapes: Object.keys(shapeSummary).length,
      tranches: Object.keys(trancheSummary).length,
      unshaped: 0,
    },
    primaryFamilySummary: summarize(rows, "primaryFamily"),
    trancheSummary,
    shapeSummary,
    rows,
  };
}

export async function run(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  const irContent = await readFile(options.ir, "utf8");
  const classificationContent = await readFile(options.classification, "utf8");
  const report = await build(irContent, classificationContent);
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (options.check) {
    if (await readFile(options.output, "utf8") !== serialized) throw new Error(`${options.output} is stale; regenerate dmSDK ABI shapes`);
  } else {
    await mkdir(dirname(options.output), { recursive: true });
    await writeFile(options.output, serialized);
  }
  process.stdout.write(`${options.check ? "Verified" : "Generated"} ${report.coverage.shaped} dmSDK declarations across ${report.coverage.uniqueShapes} ABI shapes and ${report.coverage.tranches} tranches.\n`);
  return report;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await run();
