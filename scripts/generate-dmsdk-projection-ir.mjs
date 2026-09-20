import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "..");
const defaultIrPath = resolve(repositoryRoot, "packages/bindings/generated/defold-sdk-ir.json");
const defaultClassificationPath = resolve(repositoryRoot, "packages/bindings/generated/defold-dmsdk-binding-patterns.json");
const defaultOutputPath = resolve(repositoryRoot, "packages/bindings/generated/defold-dmsdk-projection-ir.json");
const defaultSymbolEvidencePath = resolve(repositoryRoot, "packages/bindings/generated/defold-dmsdk-symbol-evidence.json");
const defaultTargetConditionalsPath = resolve(repositoryRoot, "packages/bindings/generated/defold-dmsdk-target-conditionals.json");

/**
 * The dmSDK headers that are the Lua transport itself rather than an API to
 * project.
 *
 * `defold/defold_hermes/include/defold_hermes/lua_bridge.hpp` includes
 * `<dmsdk/lua/lua.h>` and calls `lua_settop`, `lua_gettop`, `lua_rawgeti` and
 * `luaL_ref` directly, from C++ that Extender compiles - that is how the bridge
 * works today. Projecting the same raw stack manipulation into TypeScript would
 * be meaningless and unsafe, so these declarations are accounted for as
 * `separate-module` - the disposition the script surface already uses for an
 * API a separate module owns - rather than sitting in the census as bindings
 * nobody intends to emit.
 */
const TRANSPORT_INFRASTRUCTURE_HEADERS = /\/dmsdk\/lua\/(?:lua|lauxlib)\.h$/;
const loweringEvidencePaths = Object.freeze({
  scalar: "packages/bindings/generated/defold-dmsdk-scalar-thunks.json",
  enumValue: "packages/bindings/generated/defold-dmsdk-enum-value-bindings.json",
  namedScalar: "packages/bindings/generated/defold-dmsdk-named-scalar-bindings.json",
  fixedDigest: "packages/bindings/generated/defold-dmsdk-fixed-digest-bindings.json",
  base64Span: "packages/bindings/generated/defold-dmsdk-base64-span-bindings.json",
  astcProbe: "packages/bindings/generated/defold-dmsdk-astc-probe-bindings.json",
  xteaSpan: "packages/bindings/generated/defold-dmsdk-xtea-span-bindings.json",
  hashSpan: "packages/bindings/generated/defold-dmsdk-hash-span-bindings.json",
  arenaSpan: "packages/bindings/generated/defold-dmsdk-arena-span-blockers.json"
});

const PRIMITIVES = new Map([
  ["bool", "bool"], ["char", "i8"], ["signed char", "i8"], ["unsigned char", "u8"],
  ["short", "i16"], ["unsigned short", "u16"], ["int", "i32"], ["unsigned int", "u32"],
  ["long", "word-signed"], ["unsigned long", "word-unsigned"], ["long long", "i64"],
  ["unsigned long long", "u64"], ["int8_t", "i8"], ["uint8_t", "u8"],
  ["int16_t", "i16"], ["uint16_t", "u16"], ["int32_t", "i32"], ["uint32_t", "u32"],
  ["int64_t", "i64"], ["uint64_t", "u64"], ["float", "f32"], ["double", "f64"],
  ["size_t", "usize"], ["ssize_t", "isize"], ["intptr_t", "isize"],
  ["uintptr_t", "usize"], ["ptrdiff_t", "isize"], ["lua_Number", "f64"],
  ["lua_Integer", "word-signed"],
]);

const OUTPUT_NAME = /(?:^out(?:_|$)|(?:^|_)(?:out|output|result|destination|dst)(?:_|$))/i;
const OWNER_PRODUCER = /(?:^|::)(?:New|Create|Open|Acquire|Alloc|Clone)(?:$|[A-Z_])/;
const OWNER_CONSUMER = /(?:^|::)(?:Delete|Destroy|Close|Release|Free|Finalize)(?:$|[A-Z_])/;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function cleanType(type) {
  return String(type ?? "").replace(/\s+/g, " ").trim();
}

function stripCv(type) {
  return cleanType(type).replace(/\b(?:const|volatile|struct|class|enum)\b/g, " ").replace(/\s+/g, " ").trim();
}

function leafName(name) {
  return String(name ?? "").split("::").at(-1) ?? "";
}

function namespaceOf(name) {
  const pieces = String(name ?? "").split("::");
  return pieces.length > 1 ? pieces.slice(0, -1).join("::") : "";
}

function splitTopLevel(value, separator = ",") {
  const parts = [];
  let start = 0;
  let angle = 0;
  let paren = 0;
  let bracket = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === "<") angle += 1;
    else if (character === ">") angle = Math.max(0, angle - 1);
    else if (character === "(") paren += 1;
    else if (character === ")") paren = Math.max(0, paren - 1);
    else if (character === "[") bracket += 1;
    else if (character === "]") bracket = Math.max(0, bracket - 1);
    else if (character === separator && angle === 0 && paren === 0 && bracket === 0) {
      parts.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(value.slice(start).trim());
  return parts.filter(Boolean);
}

function parseOptions(argv) {
  const options = {
    ir: defaultIrPath,
    classification: defaultClassificationPath,
    symbolEvidence: defaultSymbolEvidencePath,
    targetConditionals: defaultTargetConditionalsPath,
    output: defaultOutputPath,
    check: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--check") options.check = true;
    else if (argument === "--ir") options.ir = resolve(argv[++index]);
    else if (argument === "--classification") options.classification = resolve(argv[++index]);
    else if (argument === "--symbol-evidence") options.symbolEvidence = resolve(argv[++index]);
    else if (argument === "--target-conditionals") options.targetConditionals = resolve(argv[++index]);
    else if (argument === "--output") options.output = resolve(argv[++index]);
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

function buildTypeIndex(declarations, opaqueTypes, targetConditionals = null) {
  const exact = new Map();
  const leaves = new Map();
  for (const declaration of declarations) {
    if (!declaration.name || !["enum", "record", "class-template", "type-alias"].includes(declaration.kind)) continue;
    if (!exact.has(declaration.name) || declaration.completeDefinition) exact.set(declaration.name, declaration);
    const leaf = leafName(declaration.name);
    const candidates = leaves.get(leaf) ?? [];
    candidates.push(declaration);
    leaves.set(leaf, candidates);
  }
  const platformSupplied = new Map((targetConditionals?.declarations ?? [])
    .filter((entry) => entry.kind === "type-alias" &&
      entry.absentDisposition === "platform-supplied" &&
      entry.respelledAs?.disposition === "platform-supplied")
    .map((entry) => [entry.name, entry]));
  return {
    exact,
    leaves,
    opaque: new Map((opaqueTypes ?? []).map((entry) => [entry.name, entry])),
    platformSupplied,
  };
}

function resolveDeclaration(type, owner, index) {
  const name = stripCv(type).replace(/[&*]+/g, " ").replace(/\[[^\]]*\]/g, " ").replace(/\s+/g, " ").trim();
  if (!name) return undefined;
  if (index.exact.has(name)) return index.exact.get(name);
  const scope = namespaceOf(owner).split("::").filter(Boolean);
  for (let length = scope.length; length > 0; length -= 1) {
    const qualified = `${scope.slice(0, length).join("::")}::${name}`;
    if (index.exact.has(qualified)) return index.exact.get(qualified);
  }
  const candidates = [...new Map((index.leaves.get(leafName(name)) ?? [])
    .map((candidate) => [`${candidate.kind}:${candidate.name}`, candidate])).values()];
  const complete = candidates.filter(({ completeDefinition }) => completeDefinition);
  if (complete.length === 1) return complete[0];
  return candidates.length === 1 ? candidates[0] : undefined;
}

function parseCallback(type, owner, index, state) {
  const match = cleanType(type).match(/^(.*?)\(\s*\*[^)]*\)\s*\((.*)\)(?:\s*(?:const|noexcept))*$/);
  if (!match) return undefined;
  const parameters = match[2].trim() === "" || match[2].trim() === "void"
    ? []
    : splitTopLevel(match[2]).map((parameter) => lowerType(parameter, owner, index, state));
  return {
    kind: "callback",
    result: lowerType(match[1], owner, index, state),
    parameters,
    callingConvention: "native-default",
  };
}

function parseTemplate(type, owner, index, state) {
  const clean = cleanType(type);
  const first = clean.indexOf("<");
  if (first < 1 || !clean.endsWith(">")) return undefined;
  return {
    kind: "template",
    name: clean.slice(0, first).trim(),
    arguments: splitTopLevel(clean.slice(first + 1, -1)).map((argument) => lowerType(argument, owner, index, state)),
  };
}

function lowerType(type, owner, index, state = { aliases: new Set() }) {
  const native = cleanType(type);
  if (!native) return { kind: "unknown", spelling: native, reason: "missing-type-spelling" };
  if (native === "void") return { kind: "void" };
  if (native === "...") return { kind: "variadic" };

  const callback = parseCallback(native, owner, index, state);
  if (callback) return callback;

  const arrayMatch = native.match(/^(.*?)\s*\[\s*([^\]]*)\s*\]$/);
  if (arrayMatch) {
    return {
      kind: "array",
      element: lowerType(arrayMatch[1], owner, index, state),
      extent: arrayMatch[2] || "unspecified",
    };
  }

  const pointerDepth = (native.match(/\*/g) ?? []).length;
  const referenceDepth = (native.match(/&/g) ?? []).length;
  if (pointerDepth > 0 || referenceDepth > 0) {
    const pointeeSpelling = native.replace(/[&*]+/g, " ").replace(/\s+/g, " ").trim();
    const pointeeBase = stripCv(pointeeSpelling);
    if (pointerDepth === 1 && pointeeBase === "char") {
      return {
        kind: "cstring",
        encoding: "utf8-or-byte-string-unspecified",
        mutable: !/^const\b/.test(pointeeSpelling),
        nullable: "unspecified",
      };
    }
    let node = lowerType(pointeeSpelling, owner, index, state);
    for (let depth = 0; depth < pointerDepth; depth += 1) {
      node = {
        kind: "pointer",
        to: node,
        constPointee: depth === 0 && /^const\b/.test(pointeeSpelling),
        nullable: "unspecified",
      };
    }
    for (let depth = 0; depth < referenceDepth; depth += 1) {
      node = { kind: "reference", to: node, constTarget: /^const\b/.test(pointeeSpelling) };
    }
    return node;
  }

  const base = stripCv(native);
  if (base === "void") return { kind: "void" };
  if (base === "va_list") return { kind: "variadic", nativeEncoding: "va_list" };
  if (PRIMITIVES.has(base)) return { kind: "scalar", name: PRIMITIVES.get(base) };

  const template = parseTemplate(base, owner, index, state);
  if (template) return template;
  if (/^(?:T|KEY|VALUE|U|V)$/.test(base)) return { kind: "type-parameter", name: base };
  const opaque = index.opaque.get(base);
  if (opaque) return { kind: "opaque", name: opaque.name, reason: opaque.reason, contexts: opaque.contexts ?? [] };

  const resolved = resolveDeclaration(base, owner, index);
  if (resolved?.kind === "enum") {
    return { kind: "enum", name: resolved.name, width: "unspecified", domain: "declared-values" };
  }
  if (resolved?.kind === "record") {
    return { kind: "record", name: resolved.name, complete: Boolean(resolved.completeDefinition) };
  }
  if (resolved?.kind === "class-template") {
    return { kind: "template-record", name: resolved.name, specialization: "unspecified" };
  }
  if (resolved?.kind === "type-alias") {
    if (state.aliases.has(resolved.id)) {
      return { kind: "unknown", spelling: base, reason: "recursive-alias", aliasId: resolved.id };
    }
    const nextState = { aliases: new Set(state.aliases).add(resolved.id) };
    const platformSupplied = index.platformSupplied.get(resolved.name);
    if (platformSupplied) {
      return {
        kind: "handle",
        name: resolved.name,
        representation: {
          kind: "opaque",
          name: resolved.name,
          reason: "target-platform-supplied",
          targetDependent: true,
          absentIn: [...platformSupplied.absentIn].sort(),
          liveIn: [...platformSupplied.liveIn].sort(),
          replacement: {
            include: platformSupplied.respelledAs.include,
            condition: platformSupplied.respelledAs.condition,
          },
        },
        nullable: "unspecified",
      };
    }
    const aliasTarget = cleanType(resolved.type);
    const callbackAlias = parseCallback(aliasTarget, resolved.name, index, nextState);
    if (callbackAlias) return { ...callbackAlias, name: resolved.name, aliasId: resolved.id };
    const loweredTarget = lowerType(aliasTarget, resolved.name, index, nextState);
    const targetTypes = Object.fromEntries(Object.entries(resolved.targetTypes ?? {}).sort());
    const targetSpellings = Object.values(targetTypes);
    const targetDependent = new Set(targetSpellings).size > 1;
    const targetIncludesPointer = targetSpellings.some((spelling) => /\*/.test(spelling));
    const representation = Object.keys(targetTypes).length
      ? { ...loweredTarget, targetTypes, targetDependent }
      : loweredTarget;
    if (/^H[A-Z]/.test(leafName(resolved.name)) || /Handle(?:$|[A-Z_])/.test(leafName(resolved.name)) ||
        ["pointer", "handle"].includes(loweredTarget.kind) || targetIncludesPointer) {
      return {
        kind: "handle",
        name: resolved.name,
        representation,
        nullable: "unspecified",
      };
    }
    return {
      kind: "named",
      name: resolved.name,
      target: representation,
    };
  }
  if (base === "id") return { kind: "opaque", name: "id", reason: "objective-c-object" };
  if (/^H[A-Z]/.test(leafName(base)) || /Handle(?:$|[A-Z_])/.test(leafName(base))) {
    return { kind: "handle", name: base, representation: { kind: "unknown", spelling: base, reason: "unresolved-handle-representation" }, nullable: "unspecified" };
  }
  return { kind: "unknown", spelling: base, reason: "unresolved-native-type" };
}

function walk(node, visit) {
  if (!node || typeof node !== "object") throw new Error("Malformed value-shape node");
  visit(node);
  if (node.to) walk(node.to, visit);
  if (node.target) walk(node.target, visit);
  if (node.representation) walk(node.representation, visit);
  if (node.element) walk(node.element, visit);
  if (node.result) walk(node.result, visit);
  for (const child of node.parameters ?? []) walk(child, visit);
  for (const child of node.arguments ?? []) walk(child, visit);
}

function nodesOf(signature) {
  const nodes = [];
  walk(signature.result, (node) => nodes.push(node));
  for (const parameter of signature.parameters) walk(parameter.type, (node) => nodes.push(node));
  return nodes;
}

function walkSurface(node, visit) {
  visit(node);
  if (node.kind === "handle") return;
  if (node.to) walkSurface(node.to, visit);
  if (node.target) walkSurface(node.target, visit);
  if (node.element) walkSurface(node.element, visit);
  if (node.result) walkSurface(node.result, visit);
  for (const child of node.parameters ?? []) walkSurface(child, visit);
  for (const child of node.arguments ?? []) walkSurface(child, visit);
}

function surfaceNodesOf(signature) {
  const nodes = [];
  walkSurface(signature.result, (node) => nodes.push(node));
  for (const parameter of signature.parameters) walkSurface(parameter.type, (node) => nodes.push(node));
  return nodes;
}

function directionOf(type, name) {
  const native = cleanType(type);
  if (!/[&*]/.test(native)) return "value";
  if (/^const\b/.test(native)) return "in";
  if (/\*\s*\*/.test(native) || OUTPUT_NAME.test(name ?? "")) return "out";
  return "inout";
}

function contextEffect(declaration) {
  if (declaration.kind === "method") return { kind: "receiver", receiver: "implicit", binding: "required" };
  if (declaration.kind === "constructor") return { kind: "receiver-construction", receiver: "implicit", binding: "required" };
  if (declaration.kind === "destructor") return { kind: "receiver-destruction", receiver: "implicit", binding: "required" };
  if (declaration.kind === "function-template") return { kind: "template-instantiation", specialization: "required" };
  return { kind: "global", binding: "none" };
}

function ownershipEffect(declaration, signature) {
  const resultNodes = [];
  walk(signature.result, (node) => resultNodes.push(node));
  const resourceResult = resultNodes.some(({ kind }) => ["handle", "pointer", "reference", "cstring"].includes(kind));
  let result = "not-resource";
  if (resourceResult && OWNER_PRODUCER.test(declaration.name ?? "")) result = "owned-candidate-requires-token";
  else if (resourceResult) result = "borrowed-or-owned-requires-token";
  const parameters = signature.parameters.map((parameter) => {
    const resource = [];
    walk(parameter.type, (node) => resource.push(node.kind));
    if (!resource.some((kind) => ["handle", "pointer", "reference", "cstring"].includes(kind))) return "not-resource";
    if (OWNER_CONSUMER.test(declaration.name ?? "")) return "consumed-candidate-requires-token";
    return "borrowed-or-transferred-requires-token";
  });
  return { result, parameters };
}

function collectIndices(signature, kinds) {
  const result = [];
  for (const parameter of signature.parameters) {
    let present = false;
    walkSurface(parameter.type, (node) => { if (kinds.has(node.kind)) present = true; });
    if (present) result.push(parameter.position);
  }
  return result;
}

function semanticTokens(declaration, binding, signature, effects) {
  const nodes = surfaceNodesOf(signature);
  const allNodes = nodesOf(signature);
  const tokens = new Set(["native-symbol-linkage"]);
  if (nodes.some(({ kind }) => kind === "unknown")) tokens.add("native-type-resolution");
  if (allNodes.some(({ kind }) => kind === "opaque")) tokens.add("opaque-type-abi-contract");
  if (nodes.some(({ kind }) => kind === "handle")) tokens.add("handle-ownership-nullability-lifetime");
  if (nodes.some(({ kind }) => ["pointer", "reference", "cstring"].includes(kind))) tokens.add("pointer-bounds-nullability-lifetime");
  if (nodes.some(({ kind }) => ["record", "template-record"].includes(kind))) tokens.add("record-layout-alignment-copy");
  if (nodes.some(({ kind }) => kind === "enum")) tokens.add("enum-width-domain-validation");
  if (nodes.some(({ kind }) => kind === "callback")) tokens.add("callback-thread-reentrancy-lifetime");
  if (nodes.some(({ kind }) => ["template", "template-record", "type-parameter"].includes(kind)) || declaration.kind === "function-template") tokens.add("template-specialization-set");
  if (signature.variadic || nodes.some(({ kind }) => kind === "variadic")) {
    tokens.add("typed-nonvariadic-facade");
  }
  if (effects.spans.present) tokens.add("span-pairing-element-unit-copy");
  tokens.add("call-thread-affinity");
  // Availability is a dimension every native declaration has, not a suspicion
  // some of them attract. The token is therefore always accounted for, and
  // `effects.availability` carries the measurement a policy resolves it with;
  // emitting it only for the ones that looked doubtful is what let 1361 units
  // share one unexamined answer.
  tokens.add("target-feature-symbol-matrix");
  if (signature.parameters.some(({ direction }) => direction === "out" || direction === "inout")) tokens.add("out-storage-initialization-failure");
  if (effects.context.kind !== "global") tokens.add("receiver-provenance-lifetime");
  if (binding.families.includes("callback")) tokens.add("callback-registration-unregistration");
  return [...tokens].sort();
}

function loweringEvidenceIndex(reports) {
  const result = new Map();
  const add = (id, entry) => {
    if (result.has(id)) throw new Error(`dmSDK lowering evidence overlaps at ${id}`);
    result.set(id, entry);
  };
  for (const [family, report] of Object.entries(reports)) {
    for (const row of report.declarations ?? []) {
      const emitted = row.emitted === true || (row.wrapper && row.disposition !== "blocked" && row.stages?.generated !== "not-applicable");
      const blocked = row.disposition === "blocked" || row.emitted === false;
      if (!emitted && !blocked) continue;
      add(row.id, {
        state: emitted ? "generated-adapter" : "policy-blocked",
        family,
        wrapper: emitted ? row.wrapper ?? null : null,
        policy: emitted ? null : row.policy?.id ?? row.blocker ?? row.blockers ?? "reviewed-policy-blocked",
        stages: row.stages ?? null
      });
    }
  }
  return result;
}

function countNodes(rows) {
  const counts = new Map();
  for (const row of rows) for (const node of nodesOf(row.signature)) counts.set(node.kind, (counts.get(node.kind) ?? 0) + 1);
  return Object.fromEntries([...counts].sort(([left], [right]) => left.localeCompare(right)));
}

function countValues(values) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return Object.fromEntries([...counts].sort(([left], [right]) => left.localeCompare(right)));
}

function buildRow(declaration, binding, typeIndex, defoldRevision, loweringEvidence, symbolEvidence) {
  const parameters = (declaration.parameters ?? []).map((parameter, position) => ({
    position,
    name: parameter.name || `arg${position}`,
    nativeType: cleanType(parameter.type),
    direction: directionOf(parameter.type, parameter.name),
    type: lowerType(parameter.type, declaration.name, typeIndex),
  }));
  const signature = {
    result: lowerType(declaration.returns ?? "void", declaration.name, typeIndex),
    parameters,
    variadic: parameters.some(({ type }) => type.kind === "variadic") ||
      /(?:^|[, (])\.\.\.(?:\)|$)/.test(declaration.type ?? ""),
  };
  const callbackParameters = collectIndices(signature, new Set(["callback"]));
  let resultHasCallback = false;
  walkSurface(signature.result, (node) => { if (node.kind === "callback") resultHasCallback = true; });
  const nestedOrOpaqueCallback = binding.families.includes("callback") && callbackParameters.length === 0 && !resultHasCallback;
  const hasCallback = callbackParameters.length > 0 || resultHasCallback || nestedOrOpaqueCallback;
  const recordParameters = collectIndices(signature, new Set(["record", "template-record"]));
  const templateParameters = collectIndices(signature, new Set(["template", "template-record", "type-parameter"]));
  const pointerParameters = collectIndices(signature, new Set(["pointer", "reference"]));
  const effects = {
    direction: {
      result: "return",
      parameters: parameters.map(({ position, direction }) => ({ position, direction })),
    },
    ownership: undefined,
    lifetime: {
      result: "value-or-static" ,
      policy: "resource-lifetimes-require-semantic-token",
    },
    context: contextEffect(declaration),
    thread: {
      call: "unspecified-requires-token",
      callbacks: hasCallback ? "unspecified-requires-token" : "not-applicable",
    },
    callbacks: {
      present: hasCallback,
      parameters: callbackParameters,
      result: resultHasCallback,
      nestedOrOpaque: nestedOrOpaqueCallback,
      registration: hasCallback ? "unspecified-requires-token" : "not-applicable",
      reentrancy: hasCallback ? "unspecified-requires-token" : "not-applicable",
    },
    records: {
      present: recordParameters.length > 0 || surfaceNodesOf(signature).some(({ kind }) => ["record", "template-record"].includes(kind)),
      parameters: recordParameters,
      layout: "source-declaration-only-not-abi-verified",
    },
    templates: {
      present: declaration.kind === "function-template" || templateParameters.length > 0 || surfaceNodesOf(signature).some(({ kind }) => ["template", "template-record", "type-parameter"].includes(kind)),
      parameters: templateParameters,
      specialization: "unspecified-requires-token",
    },
    spans: {
      present: binding.families.includes("pointer-span"),
      pointerCandidates: pointerParameters,
      pairing: binding.families.includes("pointer-span") ? "unspecified-requires-token" : "not-applicable",
    },
    // MEASURED, per bundle target and per build variant, against the archives
    // the pinned engine SDK says Extender links - see
    // `scripts/generate-dmsdk-symbol-evidence.mjs`. `unmeasured` is the honest
    // answer for a class-template member, which denotes no symbol until it is
    // instantiated; `partially-measured` is the honest answer when a
    // cross-target parse could not reach that platform's system headers and so
    // clang never named the symbol it would emit.
    availability: {
      kind: symbolEvidence?.availability ?? "unmeasured",
      linkage: symbolEvidence?.linkage ?? "unmeasured",
      platformGated: binding.families.includes("platform-gated"),
      profiles: symbolEvidence ? "measured-engine-archive-linkage" : "unspecified-requires-token",
      evidence: "packages/bindings/generated/defold-dmsdk-symbol-evidence.json",
    },
  };
  effects.ownership = ownershipEffect(declaration, signature);
  if (surfaceNodesOf(signature).some(({ kind }) => ["handle", "pointer", "reference", "cstring", "callback"].includes(kind))) {
    effects.lifetime.result = "unspecified-requires-token";
  }
  const tokens = semanticTokens(declaration, binding, signature, effects);
  const provenance = {
    sourceId: declaration.id,
    defoldRevision,
    header: declaration.header,
    line: declaration.line,
    declarationKind: declaration.kind,
    sourceDefined: declaration.sourceDefined === true,
    nativeSignature: binding.signature,
    primaryFamily: binding.primaryFamily,
    families: [...binding.families].sort(),
  };
  const projectionId = `dmsdk-projection:${sha256(JSON.stringify(provenance)).slice(0, 24)}`;
  const lowering = loweringEvidence ?? {
    state: "lowering-pending",
    family: null,
    wrapper: null,
    policy: null,
    stages: null
  };
  return {
    id: declaration.id,
    projectionId,
    symbol: declaration.name,
    accountingCategory: TRANSPORT_INFRASTRUCTURE_HEADERS.test(declaration.header ?? "")
      ? "separate-module"
      : "projected",
    provenance,
    projection: {
      state: "generated",
      deterministic: true,
    },
    signature,
    effects,
    semanticTokensNeeded: tokens,
    lowering,
    loweringState: lowering.state,
  };
}

export async function build(
  irContent,
  classificationContent,
  loweringEvidenceContents = {},
  symbolEvidenceContent = null,
  targetConditionalsContent = null,
) {
  const ir = JSON.parse(irContent);
  const classification = JSON.parse(classificationContent);
  const symbolEvidence = symbolEvidenceContent ? JSON.parse(symbolEvidenceContent) : null;
  const targetConditionals = targetConditionalsContent ? JSON.parse(targetConditionalsContent) : null;
  if (symbolEvidence && symbolEvidence.defoldRevision !== ir.defoldRevision) {
    throw new Error("dmSDK symbol evidence revision differs from dmSDK IR");
  }
  if (targetConditionals && targetConditionals.defoldRevision !== ir.defoldRevision) {
    throw new Error("dmSDK target conditionals revision differs from dmSDK IR");
  }
  const symbolEvidenceById = new Map(Object.entries(symbolEvidence?.declarations ?? {}));
  const loweringReports = Object.fromEntries(Object.entries(loweringEvidenceContents).map(([name, content]) => [name, JSON.parse(content)]));
  for (const [name, report] of Object.entries(loweringReports)) {
    if (report.defoldRevision && report.defoldRevision !== ir.defoldRevision) {
      throw new Error(`${name} lowering evidence revision differs from dmSDK IR`);
    }
  }
  const loweringById = loweringEvidenceIndex(loweringReports);
  if (!Array.isArray(ir.declarations)) throw new Error("dmSDK IR is missing declarations");
  if (!Array.isArray(classification.bindings)) throw new Error("dmSDK classification is missing bindings");
  const declarationsById = new Map(ir.declarations.map((declaration) => [declaration.id, declaration]));
  const typeIndex = buildTypeIndex(
    [...ir.declarations, ...(ir.typeSupportDeclarations ?? [])],
    ir.opaqueTypes,
    targetConditionals,
  );
  const seen = new Set();
  for (const id of loweringById.keys()) {
    if (!declarationsById.has(id)) throw new Error(`Lowering evidence names a declaration absent from source IR: ${id}`);
  }
  const rows = classification.bindings.map((binding) => {
    if (seen.has(binding.id)) throw new Error(`Duplicate classified declaration ${binding.id}`);
    seen.add(binding.id);
    const declaration = declarationsById.get(binding.id);
    if (!declaration) throw new Error(`Classified declaration does not exist in source IR: ${binding.id}`);
    return buildRow(declaration, binding, typeIndex, ir.defoldRevision, loweringById.get(binding.id),
      symbolEvidenceById.get(binding.id));
  }).sort((left, right) => left.id.localeCompare(right.id));

  const missingSemanticToken = [];
  for (const row of rows) {
    const unknowns = nodesOf(row.signature).filter(({ kind }) => kind === "unknown");
    if (unknowns.length > 0 && !row.semanticTokensNeeded.includes("native-type-resolution")) missingSemanticToken.push(row.id);
  }
  if (missingSemanticToken.length) throw new Error(`Unknown types silently escaped semantic-token accounting: ${missingSemanticToken.join(", ")}`);

  const projectionIds = new Set(rows.map(({ projectionId }) => projectionId));
  if (projectionIds.size !== rows.length) throw new Error("Projection ID collision");
  const constructorSummary = countNodes(rows);
  const semanticTokenSummary = countValues(rows.flatMap(({ semanticTokensNeeded }) => semanticTokensNeeded));
  const loweringStateSummary = countValues(rows.map(({ loweringState }) => loweringState));
  const effectSummary = {
    callbacks: rows.filter(({ effects }) => effects.callbacks.present).length,
    records: rows.filter(({ effects }) => effects.records.present).length,
    templates: rows.filter(({ effects }) => effects.templates.present).length,
    spans: rows.filter(({ effects }) => effects.spans.present).length,
    platformGated: rows.filter(({ effects }) => effects.availability.platformGated).length,
    receiverBound: rows.filter(({ effects }) => effects.context.kind !== "global").length,
  };
  const availabilitySummary = countValues(rows.map(({ effects }) => effects.availability.kind));
  const linkageSummary = countValues(rows.map(({ effects }) => effects.availability.linkage));
  const accountingSummary = countValues(rows.map(({ accountingCategory }) => accountingCategory));
  const loweringSummary = countValues(rows.map(({ lowering }) => lowering.state));
  const headerHashes = {};
  for (const header of [...new Set(rows.map(({ provenance }) => provenance.header))].sort()) {
    headerHashes[header] = sha256(await readFile(resolve(repositoryRoot, header)));
  }
  return {
    schemaVersion: 1,
    defoldRevision: ir.defoldRevision,
    algebra: {
      valueConstructors: ["void", "scalar", "enum", "cstring", "array", "pointer", "reference", "record", "template-record", "handle", "callback", "named", "template", "type-parameter", "variadic", "opaque", "unknown"],
      effectDimensions: ["direction", "ownership", "lifetime", "context", "thread", "callbacks", "records", "templates", "spans", "availability"],
      unknownPolicy: "Unknown native shapes and unresolved semantics are emitted explicitly and must have a matching semantic token. There is no permissive fallback.",
    },
    sources: {
      ir: "packages/bindings/generated/defold-sdk-ir.json",
      classification: "packages/bindings/generated/defold-dmsdk-binding-patterns.json",
      symbolEvidence: "packages/bindings/generated/defold-dmsdk-symbol-evidence.json",
      targetConditionals: "packages/bindings/generated/defold-dmsdk-target-conditionals.json",
      hashes: {
        ir: sha256(irContent),
        classification: sha256(classificationContent),
        symbolEvidence: symbolEvidenceContent ? sha256(symbolEvidenceContent) : null,
        targetConditionals: targetConditionalsContent ? sha256(targetConditionalsContent) : null,
        loweringEvidence: Object.fromEntries(Object.entries(loweringEvidenceContents).map(([name, content]) => [name, sha256(content)])),
        headers: headerHashes,
      },
    },
    coverage: {
      classifiedDeclarations: classification.bindings.length,
      projectedDeclarations: rows.length,
      mechanicallyProjected: rows.length,
      projectionGaps: classification.bindings.length - rows.length,
      uniqueSourceIds: seen.size,
      uniqueProjectionIds: projectionIds.size,
      unprojectedDeclarations: classification.bindings.length - rows.length,
      silentUnknowns: missingSemanticToken.length,
      generatedAdapters: loweringSummary["generated-adapter"] ?? 0,
      policyBlocked: loweringSummary["policy-blocked"] ?? 0,
      loweringPending: loweringSummary["lowering-pending"] ?? 0,
    },
    constructorSummary,
    effectSummary,
    availabilitySummary,
    linkageSummary,
    accountingSummary,
    loweringStateSummary,
    loweringSummary,
    semanticTokenSummary,
    rows,
  };
}

export async function run(argv = process.argv.slice(2)) {
  const options = parseOptions(argv);
  const irContent = await readFile(options.ir, "utf8");
  const classificationContent = await readFile(options.classification, "utf8");
  const loweringEvidenceContents = Object.fromEntries(await Promise.all(Object.entries(loweringEvidencePaths).map(async ([name, relative]) => [
    name,
    await readFile(resolve(repositoryRoot, relative), "utf8")
  ])));
  const symbolEvidenceContent = await readFile(options.symbolEvidence, "utf8");
  const targetConditionalsContent = await readFile(options.targetConditionals, "utf8");
  const report = await build(
    irContent,
    classificationContent,
    loweringEvidenceContents,
    symbolEvidenceContent,
    targetConditionalsContent,
  );
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (options.check) {
    if (await readFile(options.output, "utf8") !== serialized) throw new Error(`${options.output} is stale; regenerate dmSDK projection IR`);
  } else {
    await mkdir(dirname(options.output), { recursive: true });
    await writeFile(options.output, serialized);
  }
  process.stdout.write(`${options.check ? "Verified" : "Generated"} ${report.coverage.projectedDeclarations}/${report.coverage.classifiedDeclarations} dmSDK projection rows across ${Object.keys(report.constructorSummary).length} value constructors.\n`);
  return report;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await run();
