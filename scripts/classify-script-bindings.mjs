import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const FAMILY_ORDER = [
  "dynamic-values",
  "callback-lifecycle",
  "overload-dispatch",
  "multi-result",
  "lua-table",
  "borrowed-handle",
  "defold-value",
  "scalar"
];

const FAMILY_DESCRIPTIONS = {
  "dynamic-values": "Runtime-tagged any values, Lua varargs, or variable result lists.",
  "callback-lifecycle": "Hermes functions retained behind Lua closures with explicit release/lifetime policy.",
  "overload-dispatch": "Arity or runtime-tag dispatch selected from documented overloads or generic constraints.",
  "multi-result": "A fixed Lua result tuple decoded positionally into a TypeScript tuple.",
  "lua-table": "Lua arrays/tables recursively encoded or decoded from generated record metadata.",
  "borrowed-handle": "Opaque Lua userdata or numeric handles represented by checked, generation-aware host handles.",
  "defold-value": "Defold value userdata such as hashes, URLs, vectors, quaternions, and matrices.",
  scalar: "Booleans, numbers, strings, nil, and numeric Defold enums."
};

const SCALARS = new Set(["boolean", "integer", "number", "string", "nil"]);
const VALUES = new Set(["hash", "url", "vector", "vector3", "vector4", "quaternion", "matrix4"]);
const EXTERNAL_HANDLES = new Set([
  "script_instance",
  "socket_master",
  "socket_client",
  "socket_server",
  "socket_connected",
  "socket_unconnected"
]);

function splitTopLevel(source, delimiter = "|") {
  const parts = [];
  let start = 0;
  let angle = 0;
  let brace = 0;
  let bracket = 0;
  let paren = 0;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === "<") angle += 1;
    else if (character === ">") angle -= 1;
    else if (character === "{") brace += 1;
    else if (character === "}") brace -= 1;
    else if (character === "[") bracket += 1;
    else if (character === "]") bracket -= 1;
    else if (character === "(") paren += 1;
    else if (character === ")") paren -= 1;
    else if (character === delimiter && angle === 0 && brace === 0 && bracket === 0 && paren === 0) {
      parts.push(source.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(source.slice(start).trim());
  return parts;
}

function typeRegistry(ir) {
  return new Map(ir.types.map((type) => [type.name, type]));
}

function unwrapParentheses(source) {
  let value = source;
  while (value.startsWith("(") && value.endsWith(")")) {
    let depth = 0;
    let enclosesWholeValue = true;
    for (let index = 0; index < value.length; index += 1) {
      if (value[index] === "(") depth += 1;
      else if (value[index] === ")") depth -= 1;
      if (depth === 0 && index < value.length - 1) {
        enclosesWholeValue = false;
        break;
      }
    }
    if (!enclosesWholeValue) break;
    value = value.slice(1, -1).trim();
  }
  return value;
}

function mergeCodecs(parts, rawType) {
  const codecs = [...new Set(parts.flatMap((part) => part.codecs))].sort();
  const unresolved = [...new Set(parts.flatMap((part) => part.unresolved))].sort();
  const flags = [...new Set(parts.flatMap((part) => part.flags))].sort();
  const nonNil = parts.filter((part) => !part.codecs.includes("nil"));
  const nonNilCodecs = new Set(nonNil.flatMap((part) => part.codecs));
  if (nonNilCodecs.size > 1) flags.push(`heterogeneous-union:${rawType}`);
  return { codecs, unresolved, flags: [...new Set(flags)].sort() };
}

function classifyType(rawType, registry, seen = new Set()) {
  const source = unwrapParentheses(String(rawType).trim());
  if (source === "...") return { codecs: ["dynamic"], unresolved: [], flags: ["variable-results"] };
  if (source === "any") return { codecs: ["dynamic"], unresolved: [], flags: ["dynamic-any"] };
  if (source === "T") return { codecs: ["polymorphic"], unresolved: [], flags: ["generic-runtime-tag"] };
  if (source.startsWith("fun(")) return { codecs: ["callback"], unresolved: [], flags: ["callback-lifetime"] };

  const union = splitTopLevel(source);
  if (union.length > 1) return mergeCodecs(union.map((part) => classifyType(part, registry, seen)), source);

  if (source.endsWith("[]")) {
    const element = classifyType(source.slice(0, -2), registry, seen);
    return {
      codecs: ["table", ...element.codecs].filter((value, index, all) => all.indexOf(value) === index).sort(),
      unresolved: element.unresolved,
      flags: element.flags
    };
  }
  if (source.startsWith("table<") || source.startsWith("{") || source === "{}") {
    return { codecs: ["table"], unresolved: [], flags: [] };
  }
  if (SCALARS.has(source)) return { codecs: [source === "nil" ? "nil" : "scalar"], unresolved: [], flags: [] };
  if (VALUES.has(source)) return { codecs: ["value"], unresolved: [], flags: [] };
  if (EXTERNAL_HANDLES.has(source)) return { codecs: ["handle"], unresolved: [], flags: [] };

  const definition = registry.get(source);
  if (!definition) return { codecs: ["unknown"], unresolved: [source], flags: [`unregistered-type:${source}`] };
  if (definition.kind === "enum") return { codecs: ["scalar"], unresolved: [], flags: [] };
  if (definition.kind === "class") return { codecs: ["table"], unresolved: [], flags: [] };
  if (definition.kind === "alias") {
    if (seen.has(source)) return { codecs: ["unknown"], unresolved: [source], flags: [`recursive-alias:${source}`] };
    if (definition.rawType === "userdata") {
      return { codecs: [VALUES.has(source) ? "value" : "handle"], unresolved: [], flags: [] };
    }
    if (/^defold_enum\./.test(definition.rawType)) return { codecs: ["scalar"], unresolved: [], flags: [] };
    if (definition.description?.toLowerCase().includes("opaque") && /^(integer|number)$/.test(definition.rawType)) {
      return { codecs: ["handle"], unresolved: [], flags: [] };
    }
    return classifyType(definition.rawType, registry, new Set([...seen, source]));
  }
  return { codecs: ["unknown"], unresolved: [source], flags: [`unclassified-definition:${source}`] };
}

function selectFamily(functionEntry, parameterCodecs, returnCodecs) {
  const codecs = new Set([...parameterCodecs, ...returnCodecs]);
  if (codecs.has("dynamic") || functionEntry.parameters.some((parameter) => parameter.rawName === "...")) return "dynamic-values";
  if (codecs.has("callback")) return "callback-lifecycle";
  if (functionEntry.overloads.length > 0 || functionEntry.generics.length > 0 || codecs.has("polymorphic")) return "overload-dispatch";
  if (functionEntry.returns.length > 1) return "multi-result";
  if (codecs.has("table")) return "lua-table";
  if (codecs.has("handle") || codecs.has("unknown")) return "borrowed-handle";
  if (codecs.has("value")) return "defold-value";
  return "scalar";
}

function classifyFunction(functionEntry, registry) {
  const parameters = functionEntry.parameters.map((parameter) => ({
    name: parameter.rawName,
    rawType: parameter.rawType,
    optional: parameter.optional,
    ...classifyType(parameter.rawType, registry)
  }));
  const returns = functionEntry.returns.map((rawType, index) => ({
    index,
    rawType,
    ...classifyType(rawType, registry)
  }));
  const parameterCodecs = parameters.flatMap((parameter) => parameter.codecs);
  const returnCodecs = returns.flatMap((result) => result.codecs);
  const flags = new Set([...parameters, ...returns].flatMap((item) => item.flags));
  if (functionEntry.parameters.some((parameter) => parameter.rawName === "...")) flags.add("variable-arguments");
  if (functionEntry.overloads.length > 0) flags.add("documented-overload-conformance");
  if (functionEntry.generics.length > 0) flags.add("generic-runtime-dispatch");
  if (functionEntry.returns.length > 1) flags.add("fixed-multi-result");
  const unresolvedTypes = [...new Set([...parameters, ...returns].flatMap((item) => item.unresolved))].sort();
  return {
    id: functionEntry.id,
    rawName: functionEntry.rawName,
    source: functionEntry.source,
    line: functionEntry.line,
    loweringFamily: selectFamily(functionEntry, parameterCodecs, returnCodecs),
    parameterCodecs: parameters.map(({ name, rawType, optional, codecs }) => ({ name, rawType, optional, codecs })),
    returnCodecs: returns.map(({ index, rawType, codecs }) => ({ index, rawType, codecs })),
    traits: [...flags].sort(),
    unresolvedTypes,
    runtimeStatus: "classified-not-implemented"
  };
}

export function classifyScriptBindings(ir, sourceText = `${JSON.stringify(ir)}\n`) {
  const pending = ir.functions
    .filter((entry) => entry.runtimeStatus === "requires-universal-lua-bridge")
    .sort((left, right) => left.id.localeCompare(right.id));
  const registry = typeRegistry(ir);
  const bindings = pending.map((entry) => classifyFunction(entry, registry));
  const families = FAMILY_ORDER.map((name) => {
    const members = bindings.filter((binding) => binding.loweringFamily === name);
    return {
      name,
      count: members.length,
      description: FAMILY_DESCRIPTIONS[name],
      representativeIds: members.slice(0, 3).map((binding) => binding.id)
    };
  });
  const unresolvedTypes = [...new Set(bindings.flatMap((binding) => binding.unresolvedTypes))].sort();
  const ambiguousBindings = bindings.filter((binding) => binding.traits.length > 0 || binding.unresolvedTypes.length > 0);
  return {
    schemaVersion: 1,
    defoldRevision: ir.defoldRevision,
    sourceSha256: createHash("sha256").update(sourceText).digest("hex"),
    scope: "runtime-pending Defold script functions only",
    coverageClaim: "classification only; no executable binding coverage is claimed",
    pendingFunctionCount: pending.length,
    classifiedFunctionCount: bindings.length,
    unresolvedTypeCount: unresolvedTypes.length,
    unresolvedTypes,
    ambiguousBindingCount: ambiguousBindings.length,
    families,
    ambiguityEvidence: ambiguousBindings.map(({ id, rawName, source, line, traits, unresolvedTypes }) => ({
      id,
      rawName,
      source,
      line,
      traits,
      unresolvedTypes
    })),
    bindings
  };
}

async function main(argv = process.argv.slice(2)) {
  const unknown = argv.filter((argument) => argument !== "--check");
  if (unknown.length > 0) throw new Error(`Unknown argument: ${unknown[0]}`);
  const check = argv.includes("--check");
  const root = new URL("../", import.meta.url);
  const inputUrl = new URL("packages/bindings/generated/defold-script-api-ir.json", root);
  const outputUrl = new URL("packages/bindings/generated/defold-script-binding-patterns.json", root);
  const sourceText = await readFile(inputUrl, "utf8");
  const report = classifyScriptBindings(JSON.parse(sourceText), sourceText);
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (check) {
    const existing = await readFile(outputUrl, "utf8");
    if (existing !== serialized) throw new Error(`${outputUrl.pathname} is stale; regenerate script binding patterns`);
  } else {
    await writeFile(outputUrl, serialized);
  }
  const counts = report.families.map(({ name, count }) => `${name}=${count}`).join(", ");
  console.log(`${check ? "Verified" : "Classified"} ${report.classifiedFunctionCount} pending script bindings: ${counts}`);
  console.log(`Unresolved type tokens: ${report.unresolvedTypeCount}; policy-sensitive bindings: ${report.ambiguousBindingCount}`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await main();
