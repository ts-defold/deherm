import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "..");

export const FAMILY_CATALOG = Object.freeze({
  "scalar-direct": {
    description: "Only ABI scalar values are passed or returned.",
    adapter: "fixed-arity C ABI thunk",
    blocker: "native symbol adapter is not generated or linked",
  },
  "enum-handle": {
    description: "Uses an enum, named integer, or opaque handle representation.",
    adapter: "representation-checked scalar or handle thunk",
    blocker: "enum width, handle ownership, and nullability need ABI policy",
  },
  pointer: {
    description: "Uses a native pointer without a detected length companion.",
    adapter: "borrowed/owned pointer thunk",
    blocker: "pointee lifetime, mutability, alignment, and nullability need policy",
  },
  "pointer-span": {
    description: "A pointer is paired with an explicit size, count, or capacity.",
    adapter: "arena-backed pointer/length span thunk",
    blocker: "element unit, bounds, direction, and copy-vs-borrow policy need verification",
  },
  "out-param": {
    description: "Contains a pointer-to-pointer, mutable reference, or explicitly named output pointer.",
    adapter: "scratch-frame out-parameter thunk",
    blocker: "output initialization, ownership transfer, and failure semantics need policy",
  },
  "record-reference": {
    description: "Passes or returns a C++ record/reference value.",
    adapter: "layout-verified record view or value thunk",
    blocker: "record size, alignment, field layout, and reference lifetime need verification",
  },
  callback: {
    description: "Accepts or returns a function pointer/callback alias.",
    adapter: "stable callback registry thunk",
    blocker: "callback lifetime, thread affinity, reentrancy, and finalization need policy",
  },
  variadic: {
    description: "Uses C/C++ varargs or va_list.",
    adapter: "typed non-variadic facade per supported call shape",
    blocker: "a generic TypeScript-to-native varargs ABI is not safe or portable",
  },
  "template-opaque": {
    description: "Depends on a template declaration, specialization, or template parameter.",
    adapter: "explicit concrete specialization thunk",
    blocker: "the finite supported specialization set must be selected and instantiated",
  },
  constructor: {
    description: "Constructs native C++ storage.",
    adapter: "arena/owned-handle placement-construction thunk",
    blocker: "storage layout, allocation arena, ownership, and failure policy need implementation",
  },
  destructor: {
    description: "Destroys native C++ storage.",
    adapter: "idempotent owned-handle finalizer thunk",
    blocker: "ownership provenance and exactly-once finalization need implementation",
  },
  method: {
    description: "Requires an implicit native C++ this object.",
    adapter: "opaque-this handle thunk",
    blocker: "receiver type, lifetime, constness, and dynamic type need verification",
  },
  "platform-gated": {
    description: "Names a platform- or graphics-backend-specific native API.",
    adapter: "compile-time feature-gated thunk",
    blocker: "availability and symbol linkage must be verified for every target platform",
  },
});

const FAMILY_PRIORITY = Object.freeze([
  "platform-gated",
  "variadic",
  "template-opaque",
  "destructor",
  "constructor",
  "method",
  "callback",
  "out-param",
  "pointer-span",
  "record-reference",
  "pointer",
  "enum-handle",
  "scalar-direct",
]);

const PRIMITIVE_TYPE = /^(?:void|bool|char|signed char|unsigned char|short|unsigned short|int|unsigned int|long|unsigned long|long long|unsigned long long|float|double|int\d+_t|uint\d+_t|size_t|ssize_t|intptr_t|uintptr_t|ptrdiff_t)$/;
const OUTPUT_NAME = /(?:^out(?:_|$)|(?:^|_)(?:out|output|result|result_out|destination|dst)(?:_|$))/i;
const HANDLE_NAME = /(?:^|::)H[A-Z][A-Za-z0-9_]*$|Handle(?:$|[A-Z_])/;
const PLATFORM_NAME = /(?:RegisteriOS|UnregisteriOS|GetNative(?:Android|OSX|iOS|X11)|::(?:OpenGL|Vulkan|WebGPU)|ToMetal)/;

function cleanType(type) {
  return String(type ?? "")
    .replace(/\b(?:const|volatile|struct|class|enum)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function baseType(type) {
  return cleanType(type)
    .replace(/\[[^\]]*\]/g, "")
    .replace(/[&*]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function leafName(name) {
  return String(name ?? "").split("::").at(-1) ?? "";
}

function createTypeIndex(declarations) {
  const exact = new Map();
  const leaves = new Map();
  for (const declaration of declarations) {
    if (!declaration.name) continue;
    exact.set(declaration.name, declaration);
    const leaf = leafName(declaration.name);
    const matches = leaves.get(leaf) ?? [];
    matches.push(declaration);
    leaves.set(leaf, matches);
  }
  return { exact, leaves };
}

function resolveType(type, index) {
  const name = baseType(type);
  if (!name) return undefined;
  const exact = index.exact.get(name);
  if (exact) return exact;
  const matches = index.leaves.get(leafName(name));
  return matches?.length === 1 ? matches[0] : undefined;
}

function isCallbackType(type, index, seen = new Set()) {
  const cleaned = cleanType(type);
  if (/\(\s*\*[^)]*\)\s*\(/.test(cleaned)) return true;
  const resolved = resolveType(cleaned, index);
  if (!resolved || seen.has(resolved.name)) return false;
  seen.add(resolved.name);
  if (resolved.kind === "type-alias") return isCallbackType(resolved.type, index, seen);
  if (resolved.kind === "record") {
    return (resolved.members ?? []).some((member) => isCallbackType(member.type, index, seen));
  }
  return false;
}

function isRecordType(type, index) {
  if (/[\*]/.test(type ?? "")) return false;
  const resolved = resolveType(type, index);
  return resolved?.kind === "record" || resolved?.kind === "class-template";
}

function isEnumOrHandleType(type, index, seen = new Set()) {
  const name = baseType(type);
  if (!name || PRIMITIVE_TYPE.test(name)) return false;
  if (HANDLE_NAME.test(name)) return true;
  const resolved = resolveType(name, index);
  if (!resolved) return !/[<(]/.test(name) && name !== "T" && name !== "KEY";
  if (resolved.kind === "enum") return true;
  if (resolved.kind !== "type-alias" || seen.has(resolved.name)) return false;
  seen.add(resolved.name);
  if (isCallbackType(resolved.type, index)) return false;
  const aliasBase = baseType(resolved.type);
  return HANDLE_NAME.test(resolved.name) || PRIMITIVE_TYPE.test(aliasBase) || isEnumOrHandleType(resolved.type, index, seen);
}

function lengthRoot(name) {
  const normalized = String(name ?? "").replace(/^num_?/, "").replace(/^n_/, "");
  const match = normalized.match(/^(.*?)(?:_?(?:byte_?count|buffer_?size|data_?size|length|len|size|count|capacity|bytes|width|height|stride))$/i);
  return match ? match[1].replace(/_+$/, "").toLowerCase() : undefined;
}

function pointerRoot(name) {
  const normalized = String(name ?? "")
    .replace(/^(?:out|in|src|dst)_/, "")
    .toLowerCase();
  return normalized
    .replace(/_(?:ptr|pointer|data|buffer|array|bytes|values|items|decls?)$/i, "")
    .replace(/_+$/, "");
}

function hasLengthCompanion(parameters) {
  const pointers = parameters.filter((parameter) => /\*/.test(parameter.type ?? ""));
  if (pointers.length === 0) return false;
  for (const parameter of parameters) {
    const root = lengthRoot(parameter.name);
    if (root === undefined) continue;
    if (root === "") {
      if (pointers.length === 1) return true;
      const description = String(parameter.description ?? "").toLowerCase();
      if (pointers.some((pointer) => description.includes(String(pointer.name ?? "").toLowerCase()))) return true;
      continue;
    }
    if (pointers.some((pointer) => {
      const candidate = pointerRoot(pointer.name);
      return candidate === root || candidate.startsWith(root) || root.startsWith(candidate);
    })) return true;
  }
  return false;
}

function isOutParameter(parameter) {
  const type = String(parameter.type ?? "");
  if (/\*\s*\*/.test(type)) return true;
  if (/&/.test(type) && !/^\s*const\b/.test(type)) return true;
  return /\*/.test(type) && !/^\s*const\b/.test(type) && (
    OUTPUT_NAME.test(parameter.name ?? "") || /\b(?:out|output|destination)\b/i.test(parameter.description ?? "")
  );
}

function isPlatformGated(declaration) {
  return PLATFORM_NAME.test(declaration.name ?? "");
}

function signatureOf(declaration) {
  const parameters = (declaration.parameters ?? []).map((parameter) => parameter.type ?? "?").join(", ");
  return `${declaration.name}(${parameters}) -> ${declaration.returns ?? "void"}`;
}

export function classifyDeclaration(declaration, typeIndex) {
  const parameters = declaration.parameters ?? [];
  const types = [declaration.returns ?? "void", ...parameters.map((parameter) => parameter.type ?? "")];
  const families = new Set();

  if (declaration.status === "direct-candidate" || (
    declaration.kind === "function" &&
    types.every((type) => !/[&*]/.test(type) && PRIMITIVE_TYPE.test(baseType(type)))
  )) {
    families.add("scalar-direct");
  }
  if (types.some((type) => isEnumOrHandleType(type, typeIndex))) families.add("enum-handle");
  if (types.some((type) => /\*/.test(type))) families.add("pointer");
  if (hasLengthCompanion(parameters)) families.add("pointer-span");
  if (parameters.some(isOutParameter)) families.add("out-param");
  if (types.some((type) => /&/.test(type) || isRecordType(type, typeIndex))) families.add("record-reference");
  if (types.some((type) => isCallbackType(type, typeIndex))) families.add("callback");
  if (types.some((type) => /\.\.\.|\bva_list\b/.test(type)) || /\.\.\.|\bva_list\b/.test(declaration.type ?? "")) {
    families.add("variadic");
  }
  if (
    declaration.kind === "function-template" ||
    (declaration.abiStrategies ?? []).includes("template-specialization-adapter") ||
    types.some((type) => /<[^>]+>|\b(?:T|KEY)\b/.test(type))
  ) {
    families.add("template-opaque");
  }
  if (declaration.kind === "constructor") families.add("constructor");
  if (declaration.kind === "destructor") families.add("destructor");
  if (declaration.kind === "method") families.add("method");
  if (isPlatformGated(declaration)) families.add("platform-gated");

  if (families.size === 0) families.add("enum-handle");
  const orderedFamilies = FAMILY_PRIORITY.filter((family) => families.has(family));
  const primaryFamily = orderedFamilies[0];
  const blockers = [...new Set([
    "native symbol adapter is not generated or linked",
    ...orderedFamilies.map((family) => FAMILY_CATALOG[family].blocker),
  ])];

  return {
    id: declaration.id,
    symbol: declaration.name,
    signature: signatureOf(declaration),
    kind: declaration.kind,
    header: declaration.header,
    line: declaration.line,
    primaryFamily,
    families: orderedFamilies,
    blockers,
  };
}

function summarizeFamilies(bindings, property) {
  const summary = {};
  for (const family of Object.keys(FAMILY_CATALOG).sort()) {
    const members = bindings.filter((binding) => property === "primaryFamily"
      ? binding.primaryFamily === family
      : binding.families.includes(family));
    summary[family] = {
      count: members.length,
      representativeSymbols: [...new Set(members.map((binding) => binding.symbol))].slice(0, 5),
    };
  }
  return summary;
}

export function buildClassification(ir) {
  const pending = ir.declarations
    .filter((declaration) => declaration.disposition === "generated-raw-call")
    .sort((left, right) => left.id.localeCompare(right.id));
  const typeIndex = createTypeIndex(ir.declarations);
  const bindings = pending.map((declaration) => classifyDeclaration(declaration, typeIndex));

  return {
    schemaVersion: 1,
    defoldRevision: ir.defoldRevision,
    ...(ir.platform ? { sourcePlatform: ir.platform } : {}),
    sourceIr: "packages/bindings/generated/defold-sdk-ir.json",
    runtimePendingDefinition: "declarations whose disposition is generated-raw-call",
    coverage: {
      runtimePendingCount: pending.length,
      classifiedCount: bindings.length,
      nativeAdapterGeneratedCount: ir.runtimeImplementedCount,
      compiledCount: 0,
      linkedCount: 0,
      conformantCount: 0,
      note: "Classification is code-generation planning metadata. It is not evidence that a binding adapter was generated, compiled, linked, executed, or conformance-tested.",
    },
    provenanceCaveats: {
      diagnosticHeaderCount: ir.diagnosticHeaderCount,
      note: "The source IR reports diagnostics only as a header count, so individual declarations cannot yet be marked diagnostic-derived here.",
    },
    familyCatalog: FAMILY_CATALOG,
    primaryFamilySummary: summarizeFamilies(bindings, "primaryFamily"),
    traitFamilySummary: summarizeFamilies(bindings, "families"),
    bindings,
  };
}

function parseArguments(argv) {
  const options = {
    input: resolve(repositoryRoot, "packages/bindings/generated/defold-sdk-ir.json"),
    output: resolve(repositoryRoot, "packages/bindings/generated/defold-dmsdk-binding-patterns.json"),
    check: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--check") options.check = true;
    else if (argument === "--input") options.input = resolve(argv[++index]);
    else if (argument === "--output") options.output = resolve(argv[++index]);
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

export async function run(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  const ir = JSON.parse(await readFile(options.input, "utf8"));
  const classification = buildClassification(ir);
  const serialized = `${JSON.stringify(classification, null, 2)}\n`;

  if (options.check) {
    const existing = await readFile(options.output, "utf8");
    if (existing !== serialized) throw new Error(`${options.output} is stale; regenerate dmSDK binding patterns`);
  } else {
    await mkdir(dirname(options.output), { recursive: true });
    await writeFile(options.output, serialized);
  }
  process.stdout.write(
    `${options.check ? "Verified" : "Classified"} ${classification.coverage.classifiedCount} dmSDK runtime-pending bindings across ${Object.keys(FAMILY_CATALOG).length} ABI traits.\n`,
  );
  return classification;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await run();
}
