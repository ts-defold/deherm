import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { access, cp, lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import { API as TypeScriptApi } from "typescript/unstable/sync";

import {
  assertUniquePublicScriptRoots,
  publicScriptModulePath
} from "../../compiler/src/script-public-api-policy.mjs";
import {
  REVISION_OUTPUT_ROOTS,
  isRevisionOutput,
  isTargetNativeOutput
} from "../../compiler/src/revision-output-layout.mjs";
import { BINDING_LOWERING_RECIPE_EMITTER } from "../../compiler/src/binding-lowering-plan-recipe.mjs";
import { verifyProjectBuildArtifacts } from "./build-artifacts.mjs";
import {
  assertResolvedDefoldRevision,
  defoldResolutionRecord,
  resolveDefoldRevision
} from "./defold-revision.mjs";
import { parseGameProject, resolveEngineProfiles } from "./project.mjs";
import {
  assertResolvedDefoldSurface,
  buildGenerationMerkle,
  resolveDefoldSurface
} from "./defold-surface.mjs";
import { safeParameterIdentifier } from "./names.mjs";
import { hostDefoldPlatform } from "./toolchains.mjs";
import { checkProject, loadDehermPluginConfig } from "./transform-compiler.mjs";
import { materializeProjectNativeExtensionApis, resolveNativeExtensionClang } from "./native-extension-api.mjs";
import { reconcileBobProjectBoundary } from "./bob-project-boundary.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const require = createRequire(import.meta.url);
const generatedContextExportNames = new Set(["projectExtensions"]);

// These are the Static Hermes units that project generation owns below
// `.deherm/static-hermes/generated/`.  Keep the list next to the copy lane and
// cache identity: adding a copied unit without adding it to the identity would
// recreate the stale-project-source bug this registry prevents.
const projectStaticHermesOutputs = Object.freeze([
  "script-universal-value.ts",
  "script-typed-native-bridge.ts"
]);

const projectStaticHermesReports = Object.freeze([
  "packages/bindings/generated/defold-script-universal-value-bindings.json",
  "packages/bindings/generated/defold-typed-native-bridge.json"
]);

// `.script_api` names Defold's engine value types by their Lua spelling. The
// binding compiler already derives exact layouts for those types from the
// pinned dmSDK headers, so the extension lane joins to that generated evidence
// instead of degrading every vmath-shaped parameter to `unknown`. Value types
// that have a layout but no TypeScript projection fail this module at load
// time rather than silently losing their shape.
export function createDefoldValueTypeCatalog(layouts) {
  if (!layouts || layouts.schemaVersion !== 1 || !layouts.transparent || !layouts.opaque) {
    throw new Error("Resolved Defold surface has no supported value-layout catalog");
  }
  const transparent = new Map(Object.keys(layouts.transparent).sort(compareCodeUnits).map((name) => {
    const typeName = layouts.transparent[name]?.typescriptType;
    if (typeof typeName !== "string" || !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(typeName)) {
      throw new Error(`Transparent Defold value type '${name}' has no policy-defined TypeScript projection`);
    }
    return [name.toLowerCase(), typeName];
  }));
  return Object.freeze({
    transparent,
    opaque: new Set(Object.keys(layouts.opaque).map((name) => name.toLowerCase())),
    imports: [...new Set(transparent.values())]
      .filter((name) => name !== "DefoldHash" && name !== "DefoldUrl")
      .sort(compareCodeUnits)
  });
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function packageStaticHermesSourceRoot(defoldRevision) {
  // A published package may not carry revision-output snapshots, in which
  // case the authenticated surface repository remains the source.  A source
  // checkout does carry the package-generated units, but only use them when
  // both generator reports identify the requested revision.  This keeps a
  // project for another Defold revision on its revision-keyed surface while
  // still letting package output updates invalidate and refresh project-owned
  // Static Hermes sources.
  try {
    const reports = await Promise.all(projectStaticHermesReports.map(async (relative) =>
      JSON.parse(await readFile(path.join(packageRoot, relative), "utf8"))));
    if (reports.some((report) => report?.defoldRevision !== defoldRevision)) return null;
    await Promise.all(projectStaticHermesOutputs.map((name) =>
      access(path.join(packageRoot, "packages", "static-hermes", "src", "generated", name))));
    return path.join(packageRoot, "packages", "static-hermes", "src", "generated");
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

async function projectStaticHermesInputs({ core, defoldRevision }) {
  const packageSourceRoot = await packageStaticHermesSourceRoot(defoldRevision);
  const sourceRoot = packageSourceRoot ?? path.join(core.repositorySourceRoot, "packages", "static-hermes", "src", "generated");
  const outputSources = Object.fromEntries(await Promise.all(projectStaticHermesOutputs.map(async (name) => [
    name,
    sha256(await readFile(path.join(sourceRoot, name)))
  ])));
  return { sourceRoot, outputSources };
}

function assertPublishedNativeArtifacts(artifactPolicy, revision) {
  const family = artifactPolicy?.artifacts?.["native-artifacts"];
  if (!family) throw new Error(`Published Defold policy ${revision} has no native-artifacts mapping`);
  if (family.indexedBy !== "bundleTarget" ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(family.tag ?? "") ||
      !/^[0-9a-f]{64}$/u.test(family.fingerprint ?? "")) {
    throw new Error(`Published Defold policy ${revision} has an invalid native-artifacts mapping`);
  }
  return family;
}

export function generatedProjectCacheMatches({ manifest, lock, generationKey, generationMerkle, core }) {
  const expectedMerkle = {
    schemaVersion: generationMerkle.schemaVersion,
    engineRoot: generationMerkle.engineRoot,
    nativeRoot: generationMerkle.nativeRoot,
    root: generationMerkle.root
  };
  return manifest?.generation?.cacheKey === generationKey &&
    lock?.generation?.cacheKey === generationKey &&
    isDeepStrictEqual(manifest.generationMerkle, expectedMerkle) &&
    isDeepStrictEqual(lock.generationMerkle, expectedMerkle) &&
    isDeepStrictEqual(manifest.toolchain, core.toolchain) &&
    isDeepStrictEqual(lock.toolchain, core.toolchain) &&
    isDeepStrictEqual(manifest.artifacts ?? null, core.artifacts ?? null) &&
    isDeepStrictEqual(lock.artifacts ?? null, core.artifacts ?? null) &&
    manifest.defoldSurface?.layer === core.surfaceLayer &&
    lock.defoldSurface?.layer === core.surfaceLayer &&
    isDeepStrictEqual(manifest.inputs, core.inputs) &&
    isDeepStrictEqual(lock.inputs, core.inputs);
}

export function shouldResolvePublishedPolicy(surface, options = {}) {
  if (surface?.blocker) return true;
  if (options.requirePublishedArtifacts !== true) return false;
  const environment = options.env ?? process.env;
  // The artifact sibling is the deliberately replaceable part of publication:
  // online commands refresh it, while an explicit offline session reuses only
  // an already authenticated materialized copy.
  return environment.DEHERM_OFFLINE !== "1" || !surface.artifacts;
}

async function directoryDigest(root, options = {}) {
  const hash = createHash("sha256");
  async function visit(directory, prefix = "") {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => compareCodeUnits(left.name, right.name));
    for (const entry of entries) {
      if (options.ignore?.has(entry.name)) continue;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (options.exclude?.(relative, entry)) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Refusing to hash symlink in managed tree: ${relative}`);
      if (entry.isDirectory()) {
        hash.update(`d\0${relative}\0`);
        await visit(absolute, relative);
      } else if (entry.isFile()) {
        const bytes = await readFile(absolute);
        hash.update(`f\0${relative}\0${bytes.byteLength}\0`);
        hash.update(bytes);
      } else {
        throw new Error(`Refusing to hash unsupported managed-tree entry: ${relative}`);
      }
    }
  }
  await visit(path.resolve(root));
  return hash.digest("hex");
}

async function revisionOutputDigest(repositoryRoot) {
  const files = [];
  async function visit(directory, relativeRoot) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => compareCodeUnits(left.name, right.name));
    for (const entry of entries) {
      const relative = `${relativeRoot}/${entry.name}`;
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Refusing to hash symlink in revision output: ${relative}`);
      if (entry.isDirectory()) await visit(absolute, relative);
      else if (entry.isFile() && isRevisionOutput(relative)) files.push([relative, absolute]);
      else if (!entry.isFile()) throw new Error(`Refusing to hash unsupported revision-output entry: ${relative}`);
    }
  }
  for (const { root } of REVISION_OUTPUT_ROOTS) {
    await visit(path.join(repositoryRoot, root), root);
  }
  files.sort(([left], [right]) => compareCodeUnits(left, right));
  const hash = createHash("sha256");
  for (const [relative, absolute] of files) {
    const bytes = await readFile(absolute);
    hash.update(`f\0${relative}\0${bytes.byteLength}\0`);
    hash.update(bytes);
  }
  return hash.digest("hex");
}

async function projectGenerationIdentity({ inventory, outputDirectory, core, engineProfiles, nativeExtensionClang, staticHermesInputs }) {
  const projectGeneratorSha256 = sha256(await readFile(fileURLToPath(import.meta.url)));
  const nativeExtensionGeneratorSha256 = sha256(Buffer.concat(await Promise.all([
    readFile(path.join(packageRoot, "packages", "cli", "src", "native-extension-api.mjs")),
    readFile(path.join(packageRoot, "packages", "compiler", "src", "native-extension-generator.mjs"))
  ])));
  const cacheKey = sha256(JSON.stringify({
    schemaVersion: 1,
    projectGeneratorSha256,
    nativeExtensionGeneratorSha256,
    outputDirectory: outputDirectory.split(path.sep).join("/"),
    packageVersion: core.packageVersion,
    coreInputs: core.inputs,
    staticHermesInputs: { outputs: staticHermesInputs.outputSources },
    engineProfiles,
    nativeExtensionClang,
    inventory
  }));
  return {
    schemaVersion: 1,
    projectGeneratorSha256,
    nativeExtensionGeneratorSha256,
    nativeExtensionClang,
    staticHermesInputs: { outputs: staticHermesInputs.outputSources },
    cacheKey
  };
}

function compareCodeUnits(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function property(name) {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : JSON.stringify(name);
}

function identifier(name) {
  const words = String(name).split(/[^A-Za-z0-9$]+|_+/).filter(Boolean);
  const joined = words.map((word) => word[0].toUpperCase() + word.slice(1)).join("") || "Anonymous";
  return /^[A-Za-z_$]/.test(joined) ? joined : `_${joined}`;
}

function valueIdentifier(name) {
  const value = identifier(name);
  return safeParameterIdentifier(value[0].toLowerCase() + value.slice(1));
}

function memberIdentifier(name) {
  // Extension constants are conventionally SCREAMING_SNAKE. Camel-casing them
  // is lossy (`DIRECTION_FOUR` and `DIRECTIONFOUR` would collide) and disagrees
  // with the generated core SDK, which exports `go.EASING_LINEAR` verbatim.
  if (/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/.test(String(name))) return String(name);
  const words = String(name).split(/[^A-Za-z0-9$]+|_+/).filter(Boolean);
  if (!words.length) return "anonymous";
  const first = words[0][0].toLowerCase() + words[0].slice(1);
  const joined = first + words.slice(1)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join("");
  return /^[A-Za-z_$]/.test(joined) ? joined : `_${joined}`;
}

function fileName(name) {
  const value = String(name).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "");
  return (value || "anonymous").toLowerCase();
}

function unionType(types, raw) {
  let members = types;
  if (members.some((type) => type.kind === "defold-value" && type.name === "url") && members.some(({ kind }) => kind === "string")) {
    members = members.map((type) => type.kind === "string" ? { kind: "address-literal", raw: type.raw } : type);
  }
  const unique = [...new Map(members.map((type) => [JSON.stringify(type), type])).values()];
  return unique.length === 1 ? unique[0] : { kind: "union", types: unique, raw };
}

// A field or parameter may declare its nested table shape under either
// `parameters` or `members`. Defold's own editor resolves them in that order
// (editor/src/clj/editor/script_api.clj), so the generator does the same
// instead of dropping every `members:` table.
function nestedDeclarations(value) {
  if (Array.isArray(value?.parameters)) return value.parameters;
  if (Array.isArray(value?.members)) return value.members;
  return null;
}

/**
 * Splits a declared `.script_api` name into its projected name and optionality.
 *
 * Defold's editor treats a fully bracketed name as documentation sugar. Real
 * published extensions also append a bracketed `[optional]` marker. Any other
 * bracketed marker is unrepresentable and becomes a blocker rather than a
 * silently mangled identifier.
 */
function declaredName(rawName, fallback) {
  const value = typeof rawName === "string" ? rawName.trim() : "";
  if (!value) return { name: fallback, optional: false, spelling: "missing" };
  const wrapped = /^\[(.+)\]$/.exec(value);
  if (wrapped) return { name: wrapped[1].trim(), optional: true, spelling: "bracketed-name" };
  const marked = /^([^[\]]+)\[([^[\]]*)\]$/.exec(value);
  if (marked) {
    const marker = marked[2].trim().toLowerCase();
    if (marker === "optional") return { name: marked[1].trim(), optional: true, spelling: "trailing-optional-marker" };
    return { name: value, optional: false, spelling: "unrecognized-marker", blocker: `unrecognized-name-marker:${marked[2].trim()}` };
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    return { name: value, optional: false, spelling: "not-an-identifier", blocker: `name-is-not-a-lua-identifier:${value}` };
  }
  return { name: value, optional: false, spelling: "plain" };
}

function normalizeType(value, valueTypes) {
  if (Array.isArray(value?.type)) {
    // YAML sequence unions: `type: [vector3, vector4]`. The Defold editor joins
    // the same sequence with `|`, so it is an alternation, not a tuple.
    const raw = value.type.map((entry) => typeof entry === "string" ? entry.trim() : String(entry)).join("|");
    if (!value.type.length) return { kind: "unprojectable", code: "empty-type-union", raw };
    return unionType(value.type.map((entry) => normalizeType(typeof entry === "string" ? entry : { ...value, type: entry }, valueTypes)), raw);
  }
  if (typeof value === "string") return normalizeNamedType(value, value, valueTypes);
  if (typeof value?.type !== "string") {
    return { kind: "unprojectable", code: "missing-type", raw: null };
  }
  const raw = value.type;
  if (raw.includes("|")) {
    return unionType(raw.split("|").map((part) => normalizeType({ ...value, type: part.trim() }, valueTypes)), raw);
  }
  const nested = raw.trim().toLowerCase() === "table" ? nestedDeclarations(value) : null;
  if (nested) {
    return {
      kind: "record",
      fields: nested.map((field, index) => {
        const declared = declaredName(field?.name, `field${index + 1}`);
        const entry = {
          name: declared.name,
          optional: declared.optional || field?.optional === true,
          type: declared.blocker
            ? { kind: "unprojectable", code: declared.blocker, raw: typeof field?.name === "string" ? field.name : null }
            : normalizeType(field, valueTypes)
        };
        if (declared.spelling !== "plain") entry.nameSpelling = declared.spelling;
        return entry;
      }),
      raw
    };
  }
  return normalizeNamedType(raw, raw, valueTypes);
}

function normalizeNamedType(raw, original, valueTypes) {
  const name = raw.trim().toLowerCase();
  switch (name) {
    case "bool":
    case "boolean": return { kind: "boolean", raw: original };
    case "number":
    case "float":
    case "int":
    case "integer":
    case "constant": return { kind: "number", raw: original };
    case "string": return { kind: "string", raw: original };
    case "nil": return { kind: "null", raw: original };
    case "table": return { kind: "record", fields: [], raw: original };
    case "function": return { kind: "function", raw: original };
    case "object":
    case "userdata":
    case "any": return { kind: "unknown", raw: original };
    default: break;
  }
  const transparent = valueTypes.transparent.get(name);
  if (transparent) return { kind: "defold-value", name, ts: transparent, raw: original };
  if (valueTypes.opaque.has(name)) {
    return { kind: "unprojectable", code: `opaque-defold-value-type:${name}`, raw: original };
  }
  return { kind: "unprojectable", code: `unresolved-named-type:${raw.trim()}`, raw: original };
}

function renderType(type) {
  switch (type.kind) {
    case "void": return "void";
    case "boolean": return "boolean";
    case "number": return "number";
    case "string": return "string";
    case "address-literal": return "DefoldAddressLiteral | DefoldRelativeAddress";
    case "null": return "null";
    case "defold-value": return type.ts;
    case "record": return type.fields.length
      ? `Readonly<{ ${type.fields.map((field) => `${property(field.name)}${field.optional ? "?" : ""}: ${renderType(field.type)}`).join("; ")} }>`
      : "Readonly<Record<string, unknown>>";
    case "function": return "(...args: unknown[]) => unknown";
    case "union": return type.types.map(renderType).join(" | ");
    case "tuple": return `[${type.types.map(renderType).join(", ")}]`;
    // Fail closed: an unprojectable shape is uninhabited, never `any`.
    case "unprojectable": return "never";
    case "unknown": return "unknown";
    default: throw new Error(`Unknown binding IR type: ${type.kind}`);
  }
}

/** Walks a normalized type and reports every shape the lane cannot project. */
function typeBlockers(type, site) {
  switch (type.kind) {
    case "unprojectable": return [{ site, code: type.code, raw: type.raw }];
    case "union": return type.types.flatMap((member, index) => typeBlockers(member, `${site}.union[${index}]`));
    case "tuple": return type.types.flatMap((member, index) => typeBlockers(member, `${site}[${index}]`));
    case "record": return type.fields.flatMap((field) => typeBlockers(field.type, `${site}.${field.name}`));
    default: return [];
  }
}

function parameters(member) {
  return member.parameters.map((parameter, index) => {
    const canUseQuestion = parameter.optional && member.parameters.slice(index + 1).every((later) => later.optional);
    const type = `${renderType(parameter.type)}${parameter.optional && !canUseQuestion ? " | undefined" : ""}`;
    return `${parameter.jsName}${canUseQuestion ? "?" : ""}: ${type}`;
  }).join(", ");
}

function description(value, indent = "") {
  if (typeof value !== "string" || !value.trim()) return [];
  const clean = value.replaceAll("*/", "* /").split(/\r?\n/).map((line) => line.trim());
  return [`${indent}/**`, ...clean.map((line) => `${indent} * ${line}`), `${indent} */`];
}

function collectModules(inventory) {
  const modules = new Map();
  for (const extension of inventory.extensions) {
    for (const api of extension.scriptApis) {
      for (const declaration of api.declarations) {
        if (declaration.type !== "table" || typeof declaration.name !== "string") continue;
        const key = declaration.name;
        const module = modules.get(key) ?? { name: key, descriptions: [], members: [], sources: [] };
        if (declaration.desc) module.descriptions.push(declaration.desc);
        if (Array.isArray(declaration.members)) module.members.push(...declaration.members);
        module.sources.push({
          extension: extension.name,
          path: api.path,
          extensionBindingStatus: extension.bindingStatus
        });
        modules.set(key, module);
      }
    }
  }
  return [...modules.values()].sort((left, right) => compareCodeUnits(left.name, right.name));
}

function normalizeMember(moduleName, member, valueTypes) {
  const rawName = member.name;
  const jsName = memberIdentifier(rawName);
  const common = {
    id: `script:${moduleName}.${rawName}`,
    rawName,
    jsName,
    lowering: {
      development: "lua-compatibility",
      dynamicHermes: "lua-compatibility",
      staticHermes: "lua-compatibility",
      html5: "lua-compatibility",
      directNative: "schema-required"
    }
  };
  if (typeof member.desc === "string") common.description = member.desc;
  if (member.type !== "function") {
    // A declaration that carries a call signature but no `type: function` is
    // ambiguous at the source. Projecting it as a value would erase the call
    // signature without saying so, so it fails closed instead.
    if (Array.isArray(member.parameters) || Array.isArray(member.returns) || member.return) {
      return withBlockers({
        ...common,
        kind: "value",
        type: { kind: "unprojectable", code: "call-signature-without-function-type", raw: typeof member.type === "string" ? member.type : null }
      }, [{ site: "value", code: "call-signature-without-function-type", raw: typeof member.type === "string" ? member.type : null }]);
    }
    const type = normalizeType(member, valueTypes);
    return withBlockers({ ...common, kind: "value", type }, typeBlockers(type, "value"));
  }
  const blockers = [];
  const parameters = (Array.isArray(member.parameters) ? member.parameters : []).map((parameter, index) => {
    const declared = declaredName(parameter?.name, `arg${index + 1}`);
    const site = `parameter[${index}]:${declared.name}`;
    const type = declared.blocker
      ? { kind: "unprojectable", code: declared.blocker, raw: typeof parameter?.name === "string" ? parameter.name : null }
      : normalizeType(parameter, valueTypes);
    blockers.push(...typeBlockers(type, site));
    const entry = {
      rawName: declared.name,
      jsName: safeParameterIdentifier(memberIdentifier(declared.name), index),
      optional: declared.optional || parameter?.optional === true,
      type
    };
    if (declared.spelling !== "plain") entry.nameSpelling = declared.spelling;
    return entry;
  });
  const parameterNames = new Set();
  for (const parameter of parameters) {
    if (parameterNames.has(parameter.jsName)) {
      throw new Error(`${moduleName}.${rawName}: parameter names collide at ${parameter.jsName}`);
    }
    parameterNames.add(parameter.jsName);
  }
  const result = member.return ?? member.returns;
  const returns = !result
    ? { kind: "void" }
    : Array.isArray(result)
      // A one-entry `returns:` sequence is a single Lua return value, not a
      // one-element tuple.
      ? (result.length === 1 ? normalizeType(result[0], valueTypes) : { kind: "tuple", types: result.map((entry) => normalizeType(entry, valueTypes)) })
      : normalizeType(result, valueTypes);
  blockers.push(...typeBlockers(returns, "return"));
  return withBlockers({ ...common, kind: "function", parameters, returns }, blockers);
}

function withBlockers(normalized, blockers) {
  const unique = [...new Map(blockers.map((blocker) => [`${blocker.site}\0${blocker.code}`, blocker])).values()]
    .sort((left, right) => compareCodeUnits(left.site, right.site) || compareCodeUnits(left.code, right.code));
  if (!unique.length) return { ...normalized, disposition: "projected" };
  return {
    ...normalized,
    disposition: "blocked",
    blockers: unique.map((blocker) => ({
      id: `${normalized.id}#${blocker.site}`,
      site: blocker.site,
      code: blocker.code,
      ...(blocker.raw === null || blocker.raw === undefined ? {} : { declared: blocker.raw })
    }))
  };
}

export function buildProjectBindingIr(inventory, layouts) {
  const valueTypes = createDefoldValueTypeCatalog(layouts);
  const baseModules = collectModules(inventory).map((module) => {
    const members = [];
    const rawNames = new Set();
    const jsNames = new Map();
    for (const member of module.members) {
      if (!member || typeof member.name !== "string" || rawNames.has(member.name)) continue;
      rawNames.add(member.name);
      const normalized = normalizeMember(module.name, member, valueTypes);
      const collision = jsNames.get(normalized.jsName);
      if (collision) {
        throw new Error(`${module.name}: ${collision} and ${member.name} both map to TypeScript name ${normalized.jsName}`);
      }
      jsNames.set(normalized.jsName, member.name);
      members.push(normalized);
    }
    const normalizedModule = {
      id: `script:${module.name}`,
      runtimeName: module.name,
      jsName: valueIdentifier(module.name),
      typeName: `${identifier(module.name)}Extension`,
      fileName: fileName(module.name),
      sources: module.sources,
      members
    };
    if (module.descriptions[0]) normalizedModule.description = module.descriptions[0];
    return normalizedModule;
  });
  const collisions = new Set();
  for (const key of ["jsName", "typeName", "fileName"]) {
    const groups = new Map();
    for (const module of baseModules) {
      const group = groups.get(module[key]) ?? [];
      group.push(module);
      groups.set(module[key], group);
    }
    for (const group of groups.values()) {
      if (group.length > 1) for (const module of group) collisions.add(module.runtimeName);
    }
  }
  for (const module of baseModules) {
    if (generatedContextExportNames.has(module.jsName)) collisions.add(module.runtimeName);
  }
  const modules = baseModules.map((module) => {
    if (!collisions.has(module.runtimeName)) return module;
    const suffix = createHash("sha256").update(module.runtimeName).digest("hex").slice(0, 8);
    return {
      ...module,
      jsName: `${module.jsName}_${suffix}`,
      typeName: `${module.typeName}_${suffix}`,
      fileName: `${module.fileName}-${suffix}`
    };
  });
  const blocked = modules.flatMap((module) => module.members
    .filter(({ disposition }) => disposition === "blocked")
    .flatMap((member) => member.blockers.map((blocker) => ({
      module: module.runtimeName,
      member: member.rawName,
      ...blocker
    }))));
  const memberCount = modules.reduce((count, module) => count + module.members.length, 0);
  const blockedMembers = modules.reduce((count, module) =>
    count + module.members.filter(({ disposition }) => disposition === "blocked").length, 0);
  const codes = {};
  for (const blocker of blocked) codes[blocker.code] = (codes[blocker.code] ?? 0) + 1;
  return {
    schemaVersion: 2,
    abiVersion: 1,
    source: "defold-project-extensions",
    coverage: {
      modules: modules.length,
      members: memberCount,
      projected: memberCount - blockedMembers,
      blocked: blockedMembers,
      blockerCodes: Object.fromEntries(Object.entries(codes).sort(([left], [right]) => compareCodeUnits(left, right)))
    },
    blockers: blocked.sort((left, right) => compareCodeUnits(left.id, right.id)),
    modules
  };
}

function blockedMemberComment(member, indent = "") {
  return [
    `${indent}/** blocked: ${member.blockers.map(({ site, code }) => `${site}=${code}`).join(", ")} */`
  ];
}

function blockedMemberMessage(module, member) {
  return `deherm: ${module.runtimeName}.${member.rawName} is not projectable from .script_api (${member.blockers.map(({ site, code }) => `${site}=${code}`).join(", ")})`;
}

function generatedModuleSource(module, valueTypes) {
  const interfaceName = module.typeName;
  const exportName = module.jsName;
  const typeImports = [interfaceName, "DefoldAddressLiteral", "DefoldRelativeAddress", "DefoldHash", "DefoldUrl", ...valueTypes.imports];
  const lines = [
    "// Generated by deherm. Do not edit.",
    `import type { ${typeImports.join(", ")} } from "../../extensions.js";`,
    'import { callExtension, getExtensionValue } from "../runtime.js";',
    "",
    `export const ${exportName}: ${interfaceName} = {`
  ];
  for (const member of module.members) {
    lines.push(...description(member.description, "  "));
    if (member.disposition === "blocked") {
      lines.push(...blockedMemberComment(member, "  "));
      lines.push(`  get ${property(member.jsName)}(): never {`);
      lines.push(`    throw new Error(${JSON.stringify(blockedMemberMessage(module, member))});`);
      lines.push("  },");
    } else if (member.kind === "function") {
      const args = member.parameters.map((parameter) => parameter.jsName);
      lines.push(`  ${property(member.jsName)}(${parameters(member)}): ${renderType(member.returns)} {`);
      lines.push(`    return callExtension(${JSON.stringify(module.runtimeName)}, ${JSON.stringify(member.rawName)}, [${args.join(", ")}]) as ${renderType(member.returns)};`);
      lines.push("  },");
    } else {
      lines.push(`  get ${property(member.jsName)}(): ${renderType(member.type)} {`);
      lines.push(`    return getExtensionValue(${JSON.stringify(module.runtimeName)}, ${JSON.stringify(member.rawName)}) as ${renderType(member.type)};`);
      lines.push("  },");
    }
  }
  lines.push("};", "");
  return `${lines.join("\n")}\n`;
}

function scriptModuleNames(source) {
  const names = [...source.matchAll(/^export const ([A-Za-z_$][A-Za-z0-9_$]*): Types\./gmu)]
    .map((match) => match[1])
    .sort(compareCodeUnits);
  if (!names.includes("defold")) throw new Error("Resolved script SDK has no public defold namespace");
  return names;
}

function scriptModuleMembers(source, moduleName) {
  const marker = `export const ${moduleName}: Types.`;
  const markerOffset = source.indexOf(marker);
  if (markerOffset < 0) throw new Error(`Resolved script SDK has no ${moduleName} object`);
  const bodyOffset = source.indexOf("= {", markerOffset);
  if (bodyOffset < 0) throw new Error(`Resolved script SDK ${moduleName} object has no literal body`);
  const lines = source.slice(bodyOffset + 3).split(/\r?\n/u);
  const names = [];
  for (const line of lines) {
    if (line === "};") break;
    let match = /^  get ([A-Za-z_$][A-Za-z0-9_$]*)\(\)/u.exec(line);
    if (!match) match = /^  ([A-Za-z_$][A-Za-z0-9_$]*)\s*:/u.exec(line);
    if (!match) continue;
    names.push(match[1]);
  }
  if (!names.length) throw new Error(`Resolved script SDK ${moduleName} object has no enumerable members`);
  const unique = [...new Set(names)].sort(compareCodeUnits);
  if (unique.length !== names.length) throw new Error(`Resolved script SDK ${moduleName} object has duplicate members`);
  return unique;
}

function projectDefoldSource(members) {
  const hostMembers = new Set(["log", "now", "request", "runtime"]);
  const collision = members.find((member) => hostMembers.has(member));
  if (collision) throw new Error(`Defold source member collides with the deherm host facade: ${collision}`);
  return `${[
    "// Generated by deherm. Do not edit.",
    'import { hostLog, hostNow, hostRequest, hostRuntime, type DefoldRuntime } from "./host.js";',
    'import { defold as engineDefold } from "./generated/script/modules.js";',
    'import type { DefoldApi as EngineDefoldApi } from "./generated/script/types.js";',
    "",
    "export type DefoldApi = EngineDefoldApi & DefoldRuntime;",
    "export const defold: DefoldApi = {",
    "  log: hostLog,",
    "  now: hostNow,",
    "  request: hostRequest,",
    "  runtime: hostRuntime,",
    ...members.map((member) => `  ${property(member)}: engineDefold.${property(member)},`),
    "};",
    "",
  ].join("\n")}\n`;
}

function runtimeSource() {
  return `// Generated by deherm. Do not edit.
export interface DefoldExtensionBridge {
  call(moduleName: string, memberName: string, args: readonly unknown[]): unknown;
  get(moduleName: string, memberName: string): unknown;
}

let activeBridge: DefoldExtensionBridge | undefined;

export function installDefoldExtensionBridge(bridge: DefoldExtensionBridge): void {
  activeBridge = bridge;
}

function requireBridge(): DefoldExtensionBridge {
  if (!activeBridge) throw new Error("Defold extension bridge has not been installed");
  return activeBridge;
}

/** Development compatibility path. Release transforms replace eligible calls with direct generated bindings. */
export function callExtension(moduleName: string, memberName: string, args: readonly unknown[]): unknown {
  return requireBridge().call(moduleName, memberName, args);
}

/** Development compatibility path for extension constants and properties. */
export function getExtensionValue(moduleName: string, memberName: string): unknown {
  return requireBridge().get(moduleName, memberName);
}
`;
}

const ignoredAuthoredGlobs = ["node_modules/**", ".internal/**", "build/**", "dist/**"];
function generatedCompilerOnlyGlobs(generated) {
  return [...new Set([
    // Authenticated revision surfaces are materialized below the project
    // output root for offline reuse. Their compatibility sources are inputs
    // to native assembly, not authored TypeScript modules for ttsc.
    `${generated}/cache/**/*.ts`,
    `${generated}/static-hermes/**/*.ts`,
    // Typed-native assembly deliberately stages at this stable project path so
    // shermes source locations are reproducible, independent of --out-dir.
    ".deherm/build/generated/typed-native/**/*.ts"
  ])];
}
const authoredContexts = [
  { id: "shared", suffix: null, includes: ["**/*.ts"], excludes: ["**/*.script.ts", "**/*.gui.ts", "**/*.gui_script.ts", "**/*.render.ts", ...ignoredAuthoredGlobs] },
  { id: "game-object", suffix: ".script.ts", includes: ["**/*.ts"], excludes: ["**/*.gui.ts", "**/*.gui_script.ts", "**/*.render.ts", ...ignoredAuthoredGlobs] },
  { id: "gui", suffix: ".gui.ts", legacySuffixes: [".gui_script.ts"], includes: ["**/*.ts"], excludes: ["**/*.script.ts", "**/*.render.ts", ...ignoredAuthoredGlobs] },
  { id: "render", suffix: ".render.ts", includes: ["**/*.ts"], excludes: ["**/*.script.ts", "**/*.gui.ts", "**/*.gui_script.ts", ...ignoredAuthoredGlobs] }
];

function generatedOutputPaths() {
  return {
    output: [
      "script-contexts.json",
      "generated/native-extensions/index.json",
      ...authoredContexts.map(({ id }) => `sdk/contexts/${id}.ts`),
      ...projectStaticHermesOutputs.map((name) => `static-hermes/generated/${name}`)
    ],
    project: [
      "tsconfig.deherm.base.json",
      ...authoredContexts.map(({ id }) => `tsconfig.deherm.${id}.json`),
      "tsconfig.deherm.bundle.json",
      "tsconfig.deherm.release.json",
      "tsconfig.deherm.json"
    ]
  };
}

const routeContextClasses = new Map([
  ["active-go", "game-object"],
  ["game-object-instance", "game-object"],
  ["component-property-compiler", "game-object"],
  ["active-gui-scene", "gui"],
  ["gui-scene", "gui"],
  ["gui-script-instance", "gui"],
  ["captured-gui-script-instance", "gui"],
  ["render-script-instance", "render"],
  ["render-script-instance-and-graphics-context", "render"],
  ["captured-render-script-instance", "render"]
]);

const sharedContextTokens = new Set([
  "explicit-physics-handle",
  "global",
  "runtime-global"
]);

// These context tokens prove that the whole Lua namespace is attached to one
// Defold script kind. Other classified routes remain member-level restrictions.
const namespaceAttachmentTokens = new Set([
  "active-gui-scene",
  "gui-scene",
  "gui-script-instance",
  "captured-gui-script-instance",
  "render-script-instance",
  "render-script-instance-and-graphics-context",
  "captured-render-script-instance"
]);

function typeNameForScriptModule(name) {
  return `${identifier(name)}Api`;
}

function addDeniedPath(tree, pathParts) {
  let node = tree;
  for (const part of pathParts.slice(0, -1)) {
    if (node[part] === true) throw new Error(`Context mask path collides at ${pathParts.join(".")}`);
    node[part] ??= {};
    node = node[part];
  }
  node[pathParts.at(-1)] = true;
}

function renderMask(tree) {
  return `{ ${Object.entries(tree)
    .sort(([left], [right]) => compareCodeUnits(left, right))
    .map(([name, value]) => `${property(name)}: ${value === true ? "true" : renderMask(value)}`)
    .join("; ")} }`;
}

export function buildScriptContextCapabilities(scriptIr, loweringPlan) {
  if (loweringPlan?.schemaVersion !== 2) {
    throw new Error(`Context projection requires canonical lowering-plan schema v2, got ${loweringPlan?.schemaVersion ?? "missing"}`);
  }
  const { planSha256, ...planBody } = loweringPlan;
  if (typeof planSha256 !== "string" || sha256(JSON.stringify(planBody)) !== planSha256) {
    throw new Error("Context projection requires a lowering plan with a valid internal digest");
  }
  const functions = new Map(scriptIr.functions.map((item) => [item.id, item]));
  if (functions.size !== scriptIr.functions.length) throw new Error("Script API IR contains duplicate route ids");
  // Constant units are executable transport records, but their TypeScript
  // surface is emitted as literals and has no callable context projection.
  const scriptUnits = loweringPlan.units.filter(({ identity, sourceRef }) =>
    identity.surface === "script" && sourceRef?.input === "scriptProjection");
  const unitIds = new Set();
  for (const unit of scriptUnits) {
    if (unitIds.has(unit.identity.id)) throw new Error(`Lowering plan contains duplicate route id ${unit.identity.id}`);
    unitIds.add(unit.identity.id);
  }
  const missing = scriptIr.functions.map(({ id }) => id).filter((id) => !unitIds.has(id));
  const extra = [...unitIds].filter((id) => !functions.has(id));
  if (missing.length || extra.length) {
    throw new Error(`Lowering plan route ids must exactly match script API IR (missing: ${missing.join(", ") || "none"}; extra: ${extra.join(", ") || "none"})`);
  }
  const unknownContextTokens = new Set();
  const routes = scriptUnits
    .map((unit) => {
      const fn = functions.get(unit.identity.id);
      if (!fn) throw new Error(`Lowering plan route ${unit.identity.id} is missing from the script API IR`);
      const token = unit.contract?.context;
      const mappedContext = routeContextClasses.get(token);
      if (!mappedContext && token !== "context-policy-unresolved" && !sharedContextTokens.has(token)) {
        unknownContextTokens.add(token ?? "<missing>");
      }
      return {
        id: unit.identity.id,
        // Context projection is a TypeScript-surface concern, so it must use the
        // same public root names the generated SDK publishes. The raw Lua module
        // path stays authoritative for stable IDs and bridge lookup.
        modulePath: publicScriptModulePath(fn.modulePath),
        member: fn.jsName,
        token,
        directContext: mappedContext ?? (sharedContextTokens.has(token) ? "shared" : "unresolved")
      };
    });
  if (routes.length !== scriptIr.functions.length) {
    throw new Error(`Lowering plan covers ${routes.length} script routes, expected ${scriptIr.functions.length}`);
  }

  const namespaceSignals = new Map();
  for (const route of routes) {
    if (!namespaceAttachmentTokens.has(route.token)) continue;
    const namespace = route.modulePath[0];
    const signals = namespaceSignals.get(namespace) ?? new Set();
    signals.add(route.directContext);
    namespaceSignals.set(namespace, signals);
  }
  const namespaceContexts = new Map();
  for (const [namespace, signals] of namespaceSignals) {
    if (signals.size !== 1) {
      throw new Error(`Script namespace ${namespace} has conflicting attachment contexts: ${[...signals].sort().join(", ")}`);
    }
    namespaceContexts.set(namespace, [...signals][0]);
  }

  const classified = routes.map((route) => ({
    ...route,
    context: namespaceContexts.get(route.modulePath[0]) ?? route.directContext
  }));
  assertUniquePublicScriptRoots(scriptIr.functions.map(({ modulePath }) => modulePath[0]));
  const namespaces = [...new Set(classified.map(({ modulePath }) => modulePath[0]))].sort();
  const contexts = {};
  for (const context of authoredContexts) {
    const allowed = new Set(context.id === "shared" ? ["shared", "unresolved"] : ["shared", "unresolved", context.id]);
    const masks = {};
    const visibleNamespaces = [];
    for (const namespace of namespaces) {
      const namespaceRoutes = classified.filter((route) => route.modulePath[0] === namespace);
      const denied = namespaceRoutes.filter((route) => !allowed.has(route.context));
      if (denied.length === namespaceRoutes.length) continue;
      visibleNamespaces.push(namespace);
      if (denied.length) {
        const mask = {};
        for (const route of denied) addDeniedPath(mask, [...route.modulePath.slice(1), route.member]);
        masks[namespace] = mask;
      }
    }
    contexts[context.id] = {
      suffix: context.suffix,
      ...(context.legacySuffixes ? { legacySuffixes: context.legacySuffixes } : {}),
      include: context.includes,
      excludes: context.excludes,
      capabilities: [...allowed],
      namespaces: visibleNamespaces,
      deniedRouteCount: classified.filter((route) => !allowed.has(route.context)).length,
      masks
    };
  }
  const routeContextCounts = {};
  for (const route of classified) routeContextCounts[route.context] = (routeContextCounts[route.context] ?? 0) + 1;
  return {
    schemaVersion: 1,
    source: "defold-binding-lowering-plan.contract.context",
    defoldRevision: loweringPlan.defoldRevision,
    loweringPlanSha256: loweringPlan.planSha256,
    routeCount: classified.length,
    routeContextCounts,
    unknownContextTokens: [...unknownContextTokens].sort(),
    unresolvedPolicy: {
      routeCount: routeContextCounts.unresolved ?? 0,
      visibility: "provisionally-visible-in-all-authored-contexts",
      enforcement: "pending-context-contract-resolution"
    },
    namespaceContexts: Object.fromEntries([...namespaceContexts].sort(([left], [right]) => compareCodeUnits(left, right))),
    contexts
  };
}

function contextSdkSource(context, modules) {
  const lines = [
    "// Generated by deherm. Do not edit.",
    'import * as ScriptModules from "../generated/script/modules.js";',
    'import type * as ScriptTypes from "../generated/script/types.js";',
    'import { defold as projectDefold } from "../defold.js";',
    'import type { DefoldRuntime } from "../host.js";',
    ...modules.map((module) => `import { ${module.jsName} as dehermExtension_${module.jsName} } from "../modules/${module.fileName}.js";`),
    "",
    "type DehermWithoutContextMembers<Api, Denied> = {",
    "  readonly [Key in keyof Api as Key extends keyof Denied ? Denied[Key] extends true ? never : Key : Key]:",
    "    Key extends keyof Denied ? DehermWithoutContextMembers<Api[Key], Denied[Key]> : Api[Key];",
    "};",
    "",
    'export * from "../address.js";',
    'export * from "../component.js";',
    'export * from "../hmr-state.js";',
    'export type * from "../generated/script/types.js";',
    'export { installDefoldScriptBridge, type DefoldScriptBridge } from "../generated/script/runtime.js";',
    'export * from "../generated/dmsdk/index.js";',
    'export * from "../generated/dmsdk/scalar.js";',
    'export * from "../runtime.js";'
  ];
  for (const module of modules) {
    if (context.namespaces.includes(module.jsName)) continue;
    lines.push(`export { ${module.jsName} } from "../modules/${module.fileName}.js";`);
  }
  lines.push("export const projectExtensions = {");
  for (const module of modules) lines.push(`  ${property(module.jsName)}: dehermExtension_${module.jsName},`);
  lines.push("} as const;");
  lines.push("");
  for (const namespace of context.namespaces) {
    const apiType = `ScriptTypes.${typeNameForScriptModule(namespace)}`;
    const mask = context.masks[namespace];
    const exposedType = mask ? `DehermWithoutContextMembers<${apiType}, ${renderMask(mask)}>` : apiType;
    if (namespace === "defold") lines.push(`export const defold: ${exposedType} & DefoldRuntime = projectDefold;`);
    else lines.push(`export const ${namespace}: ${exposedType} = ScriptModules.${namespace};`);
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function projectBaseConfig(outputDirectory, profile = "development") {
  const generated = outputDirectory.split(path.sep).join("/");
  return {
    $schema: "https://json.schemastore.org/tsconfig",
    compilerOptions: {
      target: "ES2020",
      module: "ESNext",
      moduleResolution: "Bundler",
      strict: true,
      noEmit: true,
      lib: ["ES2020", "DOM"],
      skipLibCheck: true,
      verbatimModuleSyntax: true,
      plugins: [{
        transform: "@ts-defold/deherm/ttsc",
        enabled: true,
        inventory: `./${generated}/extensions.json`,
        resourceSymbols: `./${generated}/generated/resource-symbols.json`,
        routeSymbols: `./${generated}/generated/script-route-symbol-index.json`,
        apiUsage: `./${generated}/generated/defold-api-usage.json`,
        dmsdkSymbols: `./${generated}/generated/dmsdk-call-symbol-index.json`,
        dmsdkUsage: `./${generated}/generated/dmsdk-usage.json`,
        profile
      }]
    }
  };
}

function contextProjectConfig(outputDirectory, context) {
  const generated = outputDirectory.split(path.sep).join("/");
  const excludes = [
    ...context.excludes,
    `${generated}/generated/components/registry.ts`,
    ...generatedCompilerOnlyGlobs(generated)
  ];
  return {
    extends: "./tsconfig.deherm.base.json",
    compilerOptions: {
      composite: true,
      noEmit: true,
      tsBuildInfoFile: `./${generated}/cache/typescript/${context.id}.tsbuildinfo`,
      paths: {
        "@deherm/project": [`./${generated}/sdk/contexts/${context.id}.ts`]
      }
    },
    include: [...context.includes, `${generated}/**/*.ts`],
    exclude: excludes
  };
}

function bundleProjectConfig(outputDirectory) {
  const generated = outputDirectory.split(path.sep).join("/");
  return {
    extends: "./tsconfig.deherm.base.json",
    compilerOptions: {
      noEmit: true,
      paths: {
        "@deherm/project": [`./${generated}/sdk/index.ts`]
      }
    },
    include: ["**/*.ts", `${generated}/**/*.ts`],
    exclude: [...ignoredAuthoredGlobs, ...generatedCompilerOnlyGlobs(generated)]
  };
}

function releaseProjectConfig(outputDirectory) {
  const generated = outputDirectory.split(path.sep).join("/");
  const base = projectBaseConfig(outputDirectory, "release");
  return {
    ...base,
    compilerOptions: {
      ...base.compilerOptions,
      paths: {
        "@deherm/project": [`./${generated}/sdk/index.ts`]
      }
    },
    include: ["**/*.ts", `${generated}/**/*.ts`],
    exclude: [...ignoredAuthoredGlobs, ...generatedCompilerOnlyGlobs(generated)]
  };
}

function rootProjectConfig() {
  return {
    files: [],
    references: authoredContexts.map(({ id }) => ({ path: `./tsconfig.deherm.${id}.json` }))
  };
}

async function writeIfMissing(file, contents) {
  try {
    await access(file);
    return false;
  } catch {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, contents);
    return true;
  }
}

async function mergeVscodeRecommendations(file, recommendations) {
  let document;
  let existed = true;
  try {
    const source = await readFile(file, "utf8");
    document = JSON.parse(source);
    if (!document || typeof document !== "object" || Array.isArray(document)) return { created: false, updated: false };
  } catch (error) {
    if (error?.code !== "ENOENT") return { created: false, updated: false };
    existed = false;
    document = {};
  }
  const existing = Array.isArray(document.recommendations)
    ? [...document.recommendations]
    : [];
  const merged = [...existing];
  for (const recommendation of recommendations) if (!merged.includes(recommendation)) merged.push(recommendation);
  if (JSON.stringify(merged) === JSON.stringify(existing) && Array.isArray(document.recommendations)) {
    return { created: false, updated: false };
  }
  document.recommendations = merged;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(document, null, 2)}\n`);
  return { created: !existed, updated: existed };
}

async function migrateLegacyGeneratedTsconfig(file, contents) {
  let source;
  try {
    const information = await lstat(file);
    if (!information.isFile() || information.isSymbolicLink()) return { created: false, migrated: false };
    source = await readFile(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return { created: await writeIfMissing(file, contents), migrated: false };
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch {
    return { created: false, migrated: false };
  }
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed) &&
      Object.keys(parsed).length === 1 && parsed.extends === "./tsconfig.deherm.json") {
    await writeFile(file, contents);
    return { created: false, migrated: true };
  }
  return { created: false, migrated: false };
}

async function readConfinedFile(baseRoot, relative, label) {
  const target = path.resolve(baseRoot, relative);
  const lexicalRelative = path.relative(baseRoot, target);
  if (!lexicalRelative || lexicalRelative === ".." || lexicalRelative.startsWith(`..${path.sep}`) || path.isAbsolute(lexicalRelative)) {
    throw new Error(`${label} is outside its verified root`);
  }
  const information = await lstat(target);
  if (!information.isFile() || information.isSymbolicLink()) throw new Error(`${label} must be a regular file, not a symlink`);
  const resolvedTarget = await realpath(target);
  const resolvedRelative = path.relative(baseRoot, resolvedTarget);
  if (!resolvedRelative || resolvedRelative === ".." || resolvedRelative.startsWith(`..${path.sep}`) || path.isAbsolute(resolvedRelative)) {
    throw new Error(`${label} resolves outside its verified root`);
  }
  return readFile(resolvedTarget);
}

// Read the layer-0 API surface for one resolved Defold revision.
//
// The surface is addressed through `resolveDefoldSurface`, never through a
// packaged SDK. `requestedRevision` is the policy/cache key. An installed CLI
// populates a cache miss from the authenticated policy site; a source checkout
// may use its generated tree only as a contributor fallback.
async function coreSdkForRevision(requestedRevision, options = {}) {
  const surfaceOptions = {
    packageRoot,
    projectRoot: options.projectRoot,
    env: options.env
  };
  let unresolved = await resolveDefoldSurface(requestedRevision, surfaceOptions);
  if (shouldResolvePublishedPolicy(unresolved, options)) {
    const { readPolicyLocator, resolvePublishedPolicy } = await import("./policy-client.mjs");
    await resolvePublishedPolicy(requestedRevision, {
      index: await readPolicyLocator(),
      env: options.env
    });
    unresolved = await resolveDefoldSurface(requestedRevision, surfaceOptions);
  }
  const surface = assertResolvedDefoldSurface(unresolved);
  if (options.requirePublishedArtifacts === true) assertPublishedNativeArtifacts(surface.artifacts, requestedRevision);
  const sdkSourceRoot = surface.sdkRoot;
  const repositorySourceRoot = surface.repositoryRoot;
  const {
    valueLayoutsPath, componentContractPath, scriptIrPath, dmsdkIrPath, scriptDispatchPath, scriptPatternsPath, dmsdkPatternsPath,
    scriptProbesPath, scriptAccountingPath, scriptUniversalPath,
    scriptProfilesPath, loweringPlanPath, loweringPlanSentinelPath, dmsdkThunksPath, dmsdkUniversalPath,
    resourceSchemaPath, resourceNamespacesPath, toolchainPath
  } = surface.paths;
  // The lowering-plan generator is package code, not engine surface: it is the
  // program that produced the plan, and its digest authenticates the plan
  // whichever revision the plan describes.
  const sourcePlanGenerator = "packages/compiler/src/generate-binding-lowering-plan.mjs";
  const loweringPlanGeneratorPath = path.join(packageRoot, sourcePlanGenerator);
  const loweringPlanRecipeEmitterPath = path.join(packageRoot, BINDING_LOWERING_RECIPE_EMITTER);
  const toolchainSourcePromise = surface.toolchain
    ? Promise.resolve(Buffer.from(`${JSON.stringify(surface.toolchain, null, 2)}\n`))
    : readFile(toolchainPath);
  const [valueLayoutsSource, componentContractSource, scriptSource, dmsdkSource, scriptDispatchSource, scriptPatternsSource, dmsdkPatternsSource, scriptProbesSource, scriptAccountingSource, scriptUniversalSource, scriptProfilesSource, loweringPlanSource, loweringPlanSentinelSource, loweringPlanGeneratorSource, loweringPlanRecipeEmitterSource, dmsdkThunksSource, dmsdkUniversalSource, resourceSchemaSource, resourceNamespacesSource, toolchainSource, packageSource] = await Promise.all([
    readFile(valueLayoutsPath),
    readFile(componentContractPath),
    readFile(scriptIrPath),
    readFile(dmsdkIrPath),
    readFile(scriptDispatchPath),
    readFile(scriptPatternsPath),
    readFile(dmsdkPatternsPath),
    readFile(scriptProbesPath),
    readFile(scriptAccountingPath),
    readFile(scriptUniversalPath),
    readFile(scriptProfilesPath),
    readFile(loweringPlanPath),
    readFile(loweringPlanSentinelPath),
    readFile(loweringPlanGeneratorPath),
    readFile(loweringPlanRecipeEmitterPath),
    readFile(dmsdkThunksPath),
    readFile(dmsdkUniversalPath),
    readFile(resourceSchemaPath),
    readFile(resourceNamespacesPath),
    toolchainSourcePromise,
    readFile(path.join(packageRoot, "package.json"), "utf8")
  ]);
  const valueLayouts = JSON.parse(valueLayoutsSource);
  const componentContract = JSON.parse(componentContractSource);
  const scriptIr = JSON.parse(scriptSource);
  const dmsdkIr = JSON.parse(dmsdkSource);
  const scriptDispatch = JSON.parse(scriptDispatchSource);
  const scriptPatterns = JSON.parse(scriptPatternsSource);
  const dmsdkPatterns = JSON.parse(dmsdkPatternsSource);
  const scriptProbes = JSON.parse(scriptProbesSource);
  const scriptAccounting = JSON.parse(scriptAccountingSource);
  const scriptUniversal = JSON.parse(scriptUniversalSource);
  const scriptProfiles = JSON.parse(scriptProfilesSource);
  const loweringPlan = JSON.parse(loweringPlanSource);
  const loweringPlanSentinel = JSON.parse(loweringPlanSentinelSource);
  const dmsdkThunks = JSON.parse(dmsdkThunksSource);
  const dmsdkUniversal = JSON.parse(dmsdkUniversalSource);
  const toolchainPolicy = JSON.parse(toolchainSource);
  const revisions = new Set([valueLayouts, componentContract, scriptIr, dmsdkIr, scriptDispatch, scriptPatterns, dmsdkPatterns, scriptProbes, scriptAccounting, scriptUniversal, scriptProfiles, loweringPlan, dmsdkThunks, dmsdkUniversal].map(({ defoldRevision }) => defoldRevision));
  if (revisions.size !== 1) {
    throw new Error(`Packaged API inputs disagree: ${[...revisions].join(", ")}`);
  }
  if (scriptIr.defoldRevision !== requestedRevision) {
    throw new Error(`The ${surface.layer} Defold API surface at ${surface.irRoot} declares ${scriptIr.defoldRevision}, not the resolved revision ${requestedRevision}`);
  }
  const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
  if (loweringPlan.schemaVersion !== 2) {
    throw new Error(`Packaged canonical lowering plan must use schema v2, got ${loweringPlan.schemaVersion ?? "missing"}`);
  }
  const { planSha256, ...planBody } = loweringPlan;
  if (sha256(JSON.stringify(planBody)) !== planSha256) {
    throw new Error("Packaged canonical lowering plan has an invalid internal digest");
  }
  const loweringPlanGeneratorSources = new Map([
    [sourcePlanGenerator, loweringPlanGeneratorSource],
    [BINDING_LOWERING_RECIPE_EMITTER, loweringPlanRecipeEmitterSource]
  ]);
  const loweringPlanAuthenticatingSource = loweringPlanGeneratorSources.get(loweringPlanSentinel.generator);
  if (loweringPlanSentinel.schemaVersion !== 1 || !loweringPlanAuthenticatingSource ||
      loweringPlanSentinel.generatorSha256 !== sha256(loweringPlanAuthenticatingSource) ||
      loweringPlanSentinel.outputSha256 !== sha256(loweringPlanSource) ||
      loweringPlanSentinel.outputBytes !== loweringPlanSource.byteLength ||
      loweringPlanSentinel.planSha256 !== planSha256 ||
      JSON.stringify(loweringPlanSentinel.inputHashes) !== JSON.stringify(loweringPlan.inputHashes)) {
    throw new Error("Packaged canonical lowering-plan sentinel is stale or invalid");
  }
  const bob = toolchainPolicy.bob;
  if (toolchainPolicy.kind !== "deherm.policy.toolchain" ||
      typeof bob?.urlTemplate !== "string" || !bob.urlTemplate.includes("{defoldRevision}") ||
      !/^[0-9a-f]{64}$/u.test(bob.sha256 ?? "")) {
    throw new Error("Authenticated Defold toolchain policy has no verified Bob artifact");
  }
  const toolchain = {
    pins: toolchainPolicy.pins,
    targetMatrix: toolchainPolicy.targetMatrix,
    bob: {
      url: bob.urlTemplate.replace("{defoldRevision}", requestedRevision),
      sha256: bob.sha256
    }
  };
  const sdkSourceSha256 = surface.descriptor?.sdkTreeSha256 ??
    await directoryDigest(path.join(sdkSourceRoot, "generated"));
  const repositorySourceSha256 = surface.descriptor?.outputTreeSha256 ??
    await revisionOutputDigest(repositorySourceRoot);
  return {
    revision: scriptIr.defoldRevision,
    surfaceLayer: surface.layer,
    sdkSourceRoot,
    repositorySourceRoot,
    // Revision-invariant authoring/runtime templates ship with the compiler.
    // A materialized policy surface only owns revision-specific generated code.
    sdkTemplateRoot: path.join(packageRoot, "packages", "sdk", "src"),
    packageVersion: JSON.parse(packageSource).version,
    // The dmSDK declaration IR is deliberately platform-neutral and therefore
    // carries parseEnvironment, not a fake host platform. This field names the
    // host on which the generated project will run conformance/development.
    platform: hostDefoldPlatform(),
    valueLayouts,
    componentContract,
    valueTypes: createDefoldValueTypeCatalog(valueLayouts),
    scriptIr,
    dmsdkIr,
    scriptDispatch,
    scriptAccounting,
    scriptUniversal,
    scriptProfiles,
    loweringPlan,
    loweringPlanSentinel,
    dmsdkThunks,
    dmsdkUniversal,
    toolchain,
    artifacts: surface.artifacts ?? null,
    inputs: {
      valueLayoutsSha256: sha256(valueLayoutsSource),
      componentContractSha256: sha256(componentContractSource),
      scriptIrSha256: sha256(scriptSource),
      dmsdkIrSha256: sha256(dmsdkSource),
      scriptDispatchSha256: sha256(scriptDispatchSource),
      scriptPatternsSha256: sha256(scriptPatternsSource),
      dmsdkPatternsSha256: sha256(dmsdkPatternsSource),
      scriptProbesSha256: sha256(scriptProbesSource),
      scriptAccountingSha256: sha256(scriptAccountingSource),
      scriptUniversalSha256: sha256(scriptUniversalSource),
      scriptProfilesSha256: sha256(scriptProfilesSource),
      loweringPlanSha256: sha256(loweringPlanSource),
      loweringPlanSentinelSha256: sha256(loweringPlanSentinelSource),
      dmsdkThunksSha256: sha256(dmsdkThunksSource),
      dmsdkUniversalSha256: sha256(dmsdkUniversalSource),
      resourceSchemaSha256: sha256(resourceSchemaSource),
      resourceNamespacesSha256: sha256(resourceNamespacesSource),
      toolchainSha256: sha256(toolchainSource),
      sdkSourceSha256,
      repositorySourceSha256
    },
    paths: { valueLayoutsPath, componentContractPath, scriptIrPath, dmsdkIrPath, scriptDispatchPath, scriptPatternsPath, dmsdkPatternsPath, scriptProbesPath, scriptAccountingPath, scriptUniversalPath, scriptProfilesPath, loweringPlanPath, loweringPlanSentinelPath, dmsdkThunksPath, dmsdkUniversalPath, resourceSchemaPath, resourceNamespacesPath, toolchainPath }
  };
}

function loweringTargetMatrix(plan, surface, loweringFamily) {
  const matrix = {};
  const units = plan.units.filter((unit) => unit.identity.surface === surface && (
    loweringFamily === undefined ||
    (loweringFamily === "script-functions"
      ? unit.sourceState?.loweringFamily !== "script-constant"
      : unit.sourceState?.loweringFamily === loweringFamily)
  ));
  for (const target of plan.targetOrder) {
    const selections = {};
    for (const unit of units) {
      const selection = unit.backends[target].selection;
      selections[selection] = (selections[selection] ?? 0) + 1;
    }
    matrix[target] = selections;
  }
  return matrix;
}

function scriptUniversalCoverage(report) {
  const bindings = report.bindings ?? [];
  const constants = bindings.filter(({ loweringFamily }) => loweringFamily === "script-constant");
  const functions = bindings.filter(({ loweringFamily }) => loweringFamily !== "script-constant");
  return { functions, constants };
}

function validateEngineProfiles(engineProfiles, catalog) {
  if (!engineProfiles || typeof engineProfiles !== "object") {
    throw new Error("Project inventory has no Defold engine profile resolution");
  }
  if (typeof engineProfiles.defaultProfileId !== "string" || !engineProfiles.defaultProfileId) {
    throw new Error("Project engine-profile resolution requires an authenticated Defold policy");
  }
  const selection = catalog?.engineProfileSelection;
  if (!selection || typeof selection.defaultProfileId !== "string" || !selection.profiles?.[selection.defaultProfileId]) {
    throw new Error("Defold policy has no authenticated engine-profile selection contract");
  }
  const known = new Set(Object.keys(catalog.profiles ?? {}));
  const selected = new Set([
    engineProfiles.defaultProfileId,
    ...Object.values(engineProfiles.platforms ?? {})
  ].filter(Boolean));
  for (const profileId of selected) {
    if (!known.has(profileId)) throw new Error(`Defold project resolved unknown engine profile '${profileId}'`);
  }
  return {
    ...engineProfiles,
    catalogSha256: catalog.catalogSha256,
    handshakeSchema: catalog.handshakeContract?.schema ?? null
  };
}

export function generateExtensionTypes(inventory, layouts) {
  const valueTypes = createDefoldValueTypeCatalog(layouts);
  const modules = buildProjectBindingIr(inventory, layouts).modules;
  const lines = [
    "// Generated by deherm. Do not edit.",
    'import type { DefoldAddressLiteral, DefoldRelativeAddress, DefoldHash, DefoldUrl } from "./sdk/address.js";',
    'export type { DefoldAddressLiteral, DefoldRelativeAddress, DefoldHash, DefoldUrl } from "./sdk/address.js";',
    ...(valueTypes.imports.length ? [
      `import type { ${valueTypes.imports.join(", ")} } from "./sdk/generated/script/types.js";`,
      `export type { ${valueTypes.imports.join(", ")} } from "./sdk/generated/script/types.js";`
    ] : []),
    ""
  ];
  for (const module of modules) {
    lines.push(...description(module.description));
    lines.push(`export interface ${module.typeName} {`);
    for (const member of module.members) {
      lines.push(...description(member.description, "  "));
      if (member.disposition === "blocked") {
        lines.push(...blockedMemberComment(member, "  "));
        lines.push(`  readonly ${property(member.jsName)}: never;`);
      } else if (member.kind === "function") {
        lines.push(`  ${property(member.jsName)}(${parameters(member)}): ${renderType(member.returns)};`);
      } else {
        lines.push(`  readonly ${property(member.jsName)}: ${renderType(member.type)};`);
      }
    }
    lines.push("}", "");
  }
  lines.push("export interface DefoldExtensionModules {");
  for (const module of modules) lines.push(`  readonly ${property(module.jsName)}: ${module.typeName};`);
  lines.push("}", "");
  return `${lines.join("\n")}\n`;
}

export async function installNativeExtension(projectRoot, options = {}) {
  await reconcileBobProjectBoundary({ projectRoot });
  const source = path.resolve(options.source ?? path.join(packageRoot, "defold", "defold_hermes"));
  const surfaceSource = options.surfaceRepositoryRoot
    ? path.join(path.resolve(options.surfaceRepositoryRoot), "defold", "defold_hermes")
    : null;
  const destination = path.join(path.resolve(projectRoot), "defold_hermes");
  if (path.resolve(source) === path.resolve(destination)) {
    return { root: destination, installed: false, source: "workspace" };
  }
  let workspaceLink = false;
  try {
    const [resolvedSource, resolvedDestination] = await Promise.all([realpath(source), realpath(destination)]);
    if (resolvedSource === resolvedDestination) {
      workspaceLink = (await lstat(destination)).isSymbolicLink();
      if (!workspaceLink) return { root: destination, installed: false, source: "workspace" };
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  try {
    const destinationInformation = await lstat(destination);
    if (destinationInformation.isSymbolicLink()) {
      if (!workspaceLink) {
        throw new Error(`Refusing to replace native-extension symlink that does not target this package: ${destination}`);
      }
    } else if (!destinationInformation.isDirectory()) {
      throw new Error(`Refusing to replace non-directory native extension at ${destination}`);
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const packageManifest = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
  const extensionManifest = await readFile(path.join(source, "ext.manifest"), "utf8");
  const extensionRelative = (relative) => `defold/defold_hermes/${relative.replaceAll(path.sep, "/")}`;
  const excludeTargetArtifact = (relative) => isTargetNativeOutput(extensionRelative(relative));
  const excludeManagedOutput = (relative) => {
    const repositoryRelative = extensionRelative(relative);
    return isRevisionOutput(repositoryRelative) || isTargetNativeOutput(repositoryRelative);
  };
  const extensionTreeSha256 = await directoryDigest(source, {
    ignore: new Set([".deherm-managed.json"]),
    exclude: excludeManagedOutput
  });
  const surfaceTreeSha256 = surfaceSource ? await directoryDigest(surfaceSource) : null;
  const identity = {
    schemaVersion: 3,
    package: packageManifest.name,
    version: packageManifest.version,
    extensionManifestSha256: sha256(extensionManifest),
    extensionTreeSha256,
    surfaceTreeSha256
  };
  const sentinelName = ".deherm-managed.json";
  let current = null;
  if (!workspaceLink) {
    try {
      current = JSON.parse(await readFile(path.join(destination, sentinelName), "utf8"));
    } catch (error) {
      if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
      try {
        await lstat(destination);
        throw new Error(`Refusing to replace unmanaged native extension at ${destination}`);
      } catch (destinationError) {
        if (destinationError?.code !== "ENOENT") throw destinationError;
      }
    }
  }
  if (options.force !== true && current && JSON.stringify(current) === JSON.stringify(identity)) {
    return { root: destination, installed: false, source: "package" };
  }
  const nonce = `${process.pid}-${randomBytes(8).toString("hex")}`;
  const stage = `${destination}.deherm-stage-${nonce}`;
  const backup = `${destination}.deherm-backup-${nonce}`;
  let movedCurrent = false;
  try {
    await cp(source, stage, {
      recursive: true,
      errorOnExist: true,
      force: false,
      filter: (candidate) => {
        const relative = path.relative(source, candidate);
        return !relative || !excludeManagedOutput(relative);
      }
    });
    if (surfaceSource) {
      await cp(surfaceSource, stage, {
        recursive: true,
        force: true,
        filter: (candidate) => {
          const relative = path.relative(surfaceSource, candidate);
          return !relative || !excludeTargetArtifact(relative);
        }
      });
    }
    await writeFile(path.join(stage, sentinelName), `${JSON.stringify(identity, null, 2)}\n`, { flag: "wx" });
    if (current || workspaceLink) {
      await rename(destination, backup);
      movedCurrent = true;
    }
    await rename(stage, destination);
    if (movedCurrent) await rm(backup, { recursive: true, force: true });
  } catch (error) {
    await rm(stage, { recursive: true, force: true });
    if (movedCurrent) {
      try {
        await lstat(destination);
      } catch (destinationError) {
        if (destinationError?.code === "ENOENT") await rename(backup, destination);
      }
    }
    throw error;
  } finally {
    await rm(stage, { recursive: true, force: true });
    await rm(backup, { recursive: true, force: true });
  }
  return { root: destination, installed: true, source: surfaceSource ? "package+policy-surface" : "package" };
}

export async function writeGeneratedProject(inventory, outputDirectory = ".deherm", options = {}) {
  if (typeof outputDirectory !== "string" || !outputDirectory || path.isAbsolute(outputDirectory)) {
    throw new Error("Generated output must be a relative subdirectory of the Defold project");
  }
  const root = path.resolve(inventory.projectRoot, outputDirectory);
  const relativeRoot = path.relative(path.resolve(inventory.projectRoot), root);
  if (!relativeRoot || relativeRoot === ".." || relativeRoot.startsWith(`..${path.sep}`) || path.isAbsolute(relativeRoot)) {
    throw new Error("Generated output must be a subdirectory of the Defold project");
  }
  await mkdir(root, { recursive: true });
  const [resolvedProjectRoot, resolvedOutputRoot] = await Promise.all([
    realpath(inventory.projectRoot),
    realpath(root)
  ]);
  const resolvedRelativeRoot = path.relative(resolvedProjectRoot, resolvedOutputRoot);
  if (!resolvedRelativeRoot || resolvedRelativeRoot === ".." || resolvedRelativeRoot.startsWith(`..${path.sep}`) || path.isAbsolute(resolvedRelativeRoot)) {
    throw new Error("Generated output resolves outside the Defold project");
  }
  // Generation is a valid public entry point independent of the CLI command.
  // Establish Bob's minimal project view here as well as in the scaffold and
  // pre-build paths so no valid caller can accidentally expose package tooling
  // or raw TypeScript authoring inputs to resource/extension discovery.
  await reconcileBobProjectBoundary({ projectRoot: inventory.projectRoot });
  // Which Defold revision does this project build against? Answered from the
  // project's own evidence before anything version-specific is read, and a
  // blocker rather than an assumption when it cannot be answered.
  const revisionResolution = options.defoldRevisionResolution ?? await resolveDefoldRevision({
    projectRoot: inventory.projectRoot,
    explicit: options.defoldSdk,
    bob: options.bob,
    env: options.env
  });
  const defoldRevision = assertResolvedDefoldRevision(revisionResolution);
  const core = await coreSdkForRevision(defoldRevision, {
    projectRoot: inventory.projectRoot,
    env: options.env,
    requirePublishedArtifacts: options.requirePublishedArtifacts
  });
  const toolchain = core.toolchain;
  inventory.engineProfiles = await resolveEngineProfiles(
    inventory.projectRoot,
    parseGameProject(await readFile(path.join(inventory.projectRoot, "game.project"), "utf8")),
    core.scriptProfiles.engineProfileSelection
  );
  const engineProfiles = validateEngineProfiles(inventory.engineProfiles, core.scriptProfiles);
  const nativeExtensionClang = resolveNativeExtensionClang({ inventory, clang: options.clang });
  const portableInventory = { ...inventory, projectRoot: "." };
  const bindingIr = buildProjectBindingIr(inventory, core.valueLayouts);
  const staticHermesInputs = await projectStaticHermesInputs({ core, defoldRevision: core.revision });
  const generation = await projectGenerationIdentity({
    inventory: portableInventory,
    outputDirectory: relativeRoot,
    core,
    engineProfiles,
    nativeExtensionClang,
    staticHermesInputs
  });
  const generationKey = generation.cacheKey;
  // The Defold revision and the native input set are independent cache keys.
  // The Merkle root carries both, so a root mismatch resolves down to whichever
  // subtree actually moved instead of reporting that "something changed".
  const merkle = buildGenerationMerkle({
    defoldRevision: core.revision,
    surface: { layer: core.surfaceLayer, inputs: core.inputs },
    extensions: inventory.extensions,
    engineProfiles,
    generator: { package: "@ts-defold/deherm", version: core.packageVersion, projectGeneratorSha256: generation.projectGeneratorSha256 }
  });
  if (options.force !== true) {
    try {
      const [manifestSource, lockSource, nativeIndexSource] = await Promise.all([
        readConfinedFile(resolvedOutputRoot, "manifest.json", "Generated manifest"),
        readConfinedFile(resolvedProjectRoot, "deherm.lock", "deherm.lock"),
        readConfinedFile(resolvedOutputRoot, "generated/native-extensions/index.json", "Generated native-extension index")
      ]);
      const previousManifest = JSON.parse(manifestSource.toString("utf8"));
      const previousLock = JSON.parse(lockSource.toString("utf8"));
      if (generatedProjectCacheMatches({
        manifest: previousManifest,
        lock: previousLock,
        generationKey,
        generationMerkle: merkle,
        core
      }) &&
          previousManifest.generatedOutputs?.output?.["generated/native-extensions/index.json"] === sha256(nativeIndexSource)) {
        const nativeIndex = JSON.parse(nativeIndexSource.toString("utf8"));
        if (nativeIndex.keyedOutput !== path.posix.join(core.revision, generationKey)) throw new Error("Cached native-extension index has a stale generation key");
        await readConfinedFile(
          resolvedOutputRoot,
          path.posix.join("generated/native-extensions", nativeIndex.keyedOutput, "report.json"),
          "Cached native-extension report"
        );
        return {
          root,
          defoldRevision: core.revision,
          defoldResolution: defoldResolutionRecord(revisionResolution),
          defoldSurfaceLayer: core.surfaceLayer,
          surfaceRepositoryRoot: core.repositorySourceRoot,
          componentPolicy: core.componentContract,
          generationMerkle: { engineRoot: merkle.engineRoot, nativeRoot: merkle.nativeRoot, root: merkle.root },
          revisionDiagnostics: revisionResolution.diagnostics ?? [],
          moduleCount: bindingIr.modules.length,
          projection: bindingIr.coverage,
          typecheckProject: path.join(inventory.projectRoot, "tsconfig.deherm.json"),
          cached: true,
          generationKey,
          nativeExtensions: previousManifest.nativeExtensions,
          created: { tsconfig: false, vscodeExtensions: false, vscodeSettings: false },
          migrated: { tsconfig: false }
        };
      }
    } catch (error) {
      if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
  }
  const nativeExtensions = await materializeProjectNativeExtensionApis({
    inventory,
    outputRoot: root,
    defoldRevision: core.revision,
    generationKey,
    clang: nativeExtensionClang.command
  });
  const nativeExtensionsIndexSource = await readFile(path.join(root, "generated", "native-extensions", "index.json"), "utf8");
  await writeFile(path.join(root, "extensions.json"), `${JSON.stringify(portableInventory, null, 2)}\n`);
  await writeFile(path.join(root, "bindings.ir.json"), `${JSON.stringify(bindingIr, null, 2)}\n`);
  const irRoot = path.join(root, "ir");
  await mkdir(irRoot, { recursive: true });
  await cp(core.paths.valueLayoutsPath, path.join(irRoot, "defold-value-layouts.json"));
  await cp(core.paths.componentContractPath, path.join(irRoot, "defold-component-proxy-contract.json"));
  await cp(core.paths.scriptIrPath, path.join(irRoot, "script-api.json"));
  await cp(core.paths.dmsdkIrPath, path.join(irRoot, "dmsdk.json"));
  await cp(core.paths.scriptDispatchPath, path.join(irRoot, "script-scalar-dispatch.json"));
  await cp(core.paths.scriptPatternsPath, path.join(irRoot, "script-binding-patterns.json"));
  await cp(core.paths.dmsdkPatternsPath, path.join(irRoot, "dmsdk-binding-patterns.json"));
  await cp(core.paths.scriptProbesPath, path.join(irRoot, "script-real-engine-probes.json"));
  await cp(core.paths.scriptAccountingPath, path.join(irRoot, "script-api-accounting.json"));
  await cp(core.paths.scriptUniversalPath, path.join(irRoot, "script-universal-value-bindings.json"));
  await cp(core.paths.scriptProfilesPath, path.join(irRoot, "script-route-profiles.json"));
  await cp(core.paths.loweringPlanPath, path.join(irRoot, "binding-lowering-plan.json"));
  await cp(core.paths.loweringPlanSentinelPath, path.join(irRoot, "binding-lowering-plan.sentinel.json"));
  await cp(core.paths.dmsdkThunksPath, path.join(irRoot, "dmsdk-scalar-thunks.json"));
  await cp(core.paths.dmsdkUniversalPath, path.join(irRoot, "dmsdk-universal-bindings.json"));
  await cp(core.paths.resourceSchemaPath, path.join(irRoot, "defold-resource-declaration-schema.json"));
  await cp(core.paths.resourceNamespacesPath, path.join(irRoot, "defold-script-resource-namespaces.json"));
  await writeFile(path.join(root, "extensions.d.ts"), generateExtensionTypes(inventory, core.valueLayouts));
  const modules = bindingIr.modules;
  const sdkRoot = path.join(root, "sdk");
  const modulesRoot = path.join(sdkRoot, "modules");
  const contextsRoot = path.join(sdkRoot, "contexts");
  await rm(modulesRoot, { recursive: true, force: true });
  await rm(path.join(sdkRoot, "generated"), { recursive: true, force: true });
  await rm(contextsRoot, { recursive: true, force: true });
  await mkdir(modulesRoot, { recursive: true });
  await mkdir(contextsRoot, { recursive: true });
  await cp(path.join(core.sdkTemplateRoot, "address.ts"), path.join(sdkRoot, "address.ts"));
  await cp(path.join(core.sdkTemplateRoot, "component.ts"), path.join(sdkRoot, "component.ts"));
  await cp(path.join(core.sdkTemplateRoot, "host.ts"), path.join(sdkRoot, "host.ts"));
  await cp(path.join(core.sdkTemplateRoot, "hmr-state.ts"), path.join(sdkRoot, "hmr-state.ts"));
  await cp(
    path.join(core.sdkSourceRoot, "generated", "script"),
    path.join(sdkRoot, "generated", "script"),
    { recursive: true }
  );
  await cp(
    path.join(core.sdkSourceRoot, "generated", "dmsdk"),
    path.join(sdkRoot, "generated", "dmsdk"),
    { recursive: true }
  );
  const scriptModulesSource = await readFile(path.join(sdkRoot, "generated", "script", "modules.ts"), "utf8");
  const scriptNamespaces = scriptModuleNames(scriptModulesSource);
  const defoldSource = projectDefoldSource(scriptModuleMembers(scriptModulesSource, "defold"));
  await writeFile(path.join(sdkRoot, "defold.ts"), defoldSource);
  const staticHermesRoot = path.join(root, "static-hermes", "generated");
  await rm(staticHermesRoot, { recursive: true, force: true });
  await mkdir(staticHermesRoot, { recursive: true });
  for (const name of projectStaticHermesOutputs) {
    await cp(
      path.join(staticHermesInputs.sourceRoot, name),
      path.join(staticHermesRoot, name)
    );
  }
  await writeFile(path.join(sdkRoot, "runtime.ts"), runtimeSource());
  const extensionNamespaceNames = new Set(modules.map((module) => module.jsName));
  const exports = [
    "// Generated by deherm. Do not edit.",
    'export * from "./address.js";',
    'export * from "./component.js";',
    'export * from "./hmr-state.js";',
    'export { installDefoldScriptBridge, type DefoldScriptBridge } from "./generated/script/runtime.js";',
    'export * from "./generated/script/handle-lowering.js";',
    'export type * from "./generated/script/types.js";',
    `export { ${scriptNamespaces.filter((name) => name !== "defold" && !extensionNamespaceNames.has(name)).join(", ")} } from "./generated/script/modules.js";`,
    'export { defold, type DefoldApi } from "./defold.js";',
    'export * from "./generated/dmsdk/index.js";',
    'export * from "./generated/dmsdk/scalar.js";',
    'export * from "./runtime.js";'
  ];
  for (const module of modules) {
    const moduleFile = module.fileName;
    await writeFile(path.join(modulesRoot, `${moduleFile}.ts`), generatedModuleSource(module, core.valueTypes));
    exports.push(`export { ${module.jsName} } from "./modules/${moduleFile}.js";`);
  }
  exports.push("");
  await writeFile(path.join(sdkRoot, "index.ts"), `${exports.join("\n")}\n`);
  const scriptContexts = buildScriptContextCapabilities(core.scriptIr, core.loweringPlan);
  const scriptContextsSource = `${JSON.stringify(scriptContexts, null, 2)}\n`;
  await writeFile(path.join(root, "script-contexts.json"), scriptContextsSource);
  const contextSources = {};
  for (const context of authoredContexts) {
    const source = contextSdkSource(scriptContexts.contexts[context.id], modules);
    contextSources[`sdk/contexts/${context.id}.ts`] = source;
    await writeFile(
      path.join(contextsRoot, `${context.id}.ts`),
      source
    );
  }
  const relativeOutput = path.relative(inventory.projectRoot, root) || ".deherm";
  const projectConfigSources = {
    "tsconfig.deherm.base.json": `${JSON.stringify(projectBaseConfig(relativeOutput), null, 2)}\n`,
    ...Object.fromEntries(authoredContexts.map((context) => [
      `tsconfig.deherm.${context.id}.json`,
      `${JSON.stringify(contextProjectConfig(relativeOutput, context), null, 2)}\n`
    ])),
    "tsconfig.deherm.bundle.json": `${JSON.stringify(bundleProjectConfig(relativeOutput), null, 2)}\n`,
    "tsconfig.deherm.release.json": `${JSON.stringify(releaseProjectConfig(relativeOutput), null, 2)}\n`,
    "tsconfig.deherm.json": `${JSON.stringify(rootProjectConfig(), null, 2)}\n`
  };
  for (const [relative, source] of Object.entries(projectConfigSources)) {
    await writeFile(path.join(inventory.projectRoot, relative), source);
  }
  const generatedOutputs = {
    output: {
      ...Object.fromEntries(Object.entries({
        "script-contexts.json": scriptContextsSource,
        "generated/native-extensions/index.json": nativeExtensionsIndexSource,
        ...contextSources
      }).map(([relative, source]) => [relative, sha256(source)])),
      ...Object.fromEntries(projectStaticHermesOutputs.map((name) => [
        `static-hermes/generated/${name}`,
        staticHermesInputs.outputSources[name]
      ]))
    },
    project: Object.fromEntries(Object.entries(projectConfigSources).map(([relative, source]) => [relative, sha256(source)]))
  };
  const generatedSdkSha256 = await directoryDigest(sdkRoot);
  const generatedDmSdkThunkIds = new Set(core.dmsdkThunks.declarations.filter(({ emitted }) => emitted).map(({ id }) => id));
  await writeFile(path.join(root, "manifest.json"), `${JSON.stringify({
    schemaVersion: 1,
    defoldRevision: core.revision,
    platform: core.platform,
    generator: { package: "@ts-defold/deherm", version: core.packageVersion },
    toolchain,
    artifacts: core.artifacts,
    generation,
    // How the Defold revision above was decided, and from which layer-0 surface
    // its API was read. Recorded so a regeneration, a teammate, or CI can see
    // that it was resolved from evidence rather than assumed, and so a later run
    // can reuse the answer without re-deriving it.
    defoldResolution: defoldResolutionRecord(revisionResolution),
    defoldSurface: { layer: core.surfaceLayer },
    generationMerkle: { schemaVersion: merkle.schemaVersion, engineRoot: merkle.engineRoot, nativeRoot: merkle.nativeRoot, root: merkle.root },
    inputs: core.inputs,
    generatedOutputs,
    generatedSdkSha256,
    nativeExtensions: {
      headerCount: nativeExtensions.index.headerCount,
      generatedRouteCount: nativeExtensions.index.generatedRouteCount,
      blockedRouteCount: nativeExtensions.index.blockedRouteCount,
      keyedOutput: nativeExtensions.index.keyedOutput,
      treeSha256: nativeExtensions.treeSha256
    },
    engineProfiles,
    loweringPlan: {
      sha256: core.loweringPlan.planSha256,
      units: core.loweringPlan.coverage.units,
      backendRecords: core.loweringPlan.coverage.backendRecords
    },
    scriptContexts: {
      source: scriptContexts.source,
      loweringPlanSha256: scriptContexts.loweringPlanSha256,
      routeCount: scriptContexts.routeCount,
      routeContextCounts: scriptContexts.routeContextCounts,
      unknownContextTokens: scriptContexts.unknownContextTokens,
      suffixes: Object.fromEntries(authoredContexts.map(({ id, suffix }) => [id, suffix]))
    },
    coverage: {
      script: {
        functions: core.scriptIr.counts.functions,
        constants: scriptUniversalCoverage(core.scriptUniversal).constants.length,
        types: core.scriptIr.counts.classes + core.scriptIr.counts.aliases + core.scriptIr.counts.enums,
        typeSurfaceUnresolved: core.scriptIr.typeSurfaceUnresolvedCount,
        universalRecipes: scriptUniversalCoverage(core.scriptUniversal).functions.length,
        constantUniversalRecipes: scriptUniversalCoverage(core.scriptUniversal).constants.length,
        universalRecipeTotal: core.scriptUniversal.candidateCount,
        universalExclusions: core.scriptUniversal.excludedCount,
        accounting: core.scriptAccounting.categoryCounts,
        targetMatrix: loweringTargetMatrix(core.loweringPlan, "script", "script-functions"),
        constantTargetMatrix: loweringTargetMatrix(core.loweringPlan, "script", "script-constant"),
        runtimeLanes: {
          generatedScalarDispatch: core.scriptDispatch.bindingCount,
          universalStableId: scriptUniversalCoverage(core.scriptUniversal).functions.length,
          constantStableId: scriptUniversalCoverage(core.scriptUniversal).constants.length
        }
      },
      dmsdk: {
        headers: core.dmsdkIr.headerCount,
        parsedHeaders: core.dmsdkIr.parsedHeaderCount,
        diagnosticHeaders: core.dmsdkIr.diagnosticHeaderCount,
        declarations: core.dmsdkIr.declarationCount,
        runtimeDeclarations: core.dmsdkUniversal.coverage.declarations,
        typeSurfaceUnresolved: core.dmsdkIr.typeSurfaceUnresolvedCount,
        universalRecipes: core.dmsdkUniversal.coverage.recipes,
        silentlyOmitted: core.dmsdkUniversal.coverage.silentlyOmitted,
        targetMatrix: loweringTargetMatrix(core.loweringPlan, "dmsdk"),
        runtimeLanes: {
          generatedScalarThunks: generatedDmSdkThunkIds.size,
          preferredSpecialized: core.dmsdkUniversal.coverage.preferredSpecialized,
          usageMaterializedFallback: core.dmsdkUniversal.coverage.usageMaterializedFallback,
          projectMaterialized: 0
        }
      },
      // Third-party `.script_api` projection is measured, not assumed: every
      // shape the lane cannot represent is counted here and enumerated in
      // bindings.ir.json.
      projectExtensions: bindingIr.coverage
    }
  }, null, 2)}\n`);
  // Regenerating the SDK does not rebuild the application bundle, so the
  // artifact-to-source binding survives this write untouched. It is not
  // rewritten either: the generated SDK is one of the bundle's own inputs, so a
  // regeneration that changes it makes the carried-forward binding report the
  // bundle as stale - which is exactly what it then is.
  const previousBuildArtifacts = await readExistingBuildArtifacts(resolvedProjectRoot);
  await writeFile(path.join(inventory.projectRoot, "deherm.lock"), `${JSON.stringify({
    schemaVersion: 1,
    defoldRevision: core.revision,
    platform: core.platform,
    generator: { package: "@ts-defold/deherm", version: core.packageVersion },
    toolchain,
    artifacts: core.artifacts,
    generation,
    defoldResolution: defoldResolutionRecord(revisionResolution),
    defoldSurface: { layer: core.surfaceLayer },
    generationMerkle: { schemaVersion: merkle.schemaVersion, engineRoot: merkle.engineRoot, nativeRoot: merkle.nativeRoot, root: merkle.root },
    inputs: core.inputs,
    generatedOutputs,
    generatedSdkSha256,
    nativeExtensions: {
      headerCount: nativeExtensions.index.headerCount,
      generatedRouteCount: nativeExtensions.index.generatedRouteCount,
      blockedRouteCount: nativeExtensions.index.blockedRouteCount,
      keyedOutput: nativeExtensions.index.keyedOutput,
      treeSha256: nativeExtensions.treeSha256
    },
    engineProfiles,
    ...(previousBuildArtifacts ? { buildArtifacts: previousBuildArtifacts } : {})
  }, null, 2)}\n`);
  const tsconfigState = await migrateLegacyGeneratedTsconfig(
    path.join(inventory.projectRoot, "tsconfig.json"),
    projectConfigSources["tsconfig.deherm.json"]
  );
  const vscodeExtensions = await mergeVscodeRecommendations(
    path.join(inventory.projectRoot, ".vscode", "extensions.json"),
    ["oxc.oxc-vscode", "samchon.ttsc", "ts-defold.deherm"]
  );
  const createdVscodeSettings = await writeIfMissing(
    path.join(inventory.projectRoot, ".vscode", "settings.json"),
    `${JSON.stringify({
      "[javascript][javascriptreact][typescript][typescriptreact]": {
        "editor.defaultFormatter": "oxc.oxc-vscode"
      }
    }, null, 2)}\n`
  );
  const createdVscodeLaunch = await writeIfMissing(
    path.join(inventory.projectRoot, ".vscode", "launch.json"),
    `${JSON.stringify({
      version: "0.2.0",
      configurations: [{
        type: "deherm",
        request: "attach",
        name: "déherm: Attach",
        project: "\${workspaceFolder}"
      }]
    }, null, 2)}\n`
  );
  return {
    root,
    defoldRevision: core.revision,
    defoldResolution: defoldResolutionRecord(revisionResolution),
    defoldSurfaceLayer: core.surfaceLayer,
    surfaceRepositoryRoot: core.repositorySourceRoot,
    componentPolicy: core.componentContract,
    generationMerkle: { engineRoot: merkle.engineRoot, nativeRoot: merkle.nativeRoot, root: merkle.root },
    revisionDiagnostics: revisionResolution.diagnostics ?? [],
    moduleCount: modules.length,
    projection: bindingIr.coverage,
    cached: false,
    generationKey,
    nativeExtensions: nativeExtensions.index,
    typecheckProject: path.join(inventory.projectRoot, "tsconfig.deherm.json"),
    created: {
      tsconfig: tsconfigState.created,
      vscodeExtensions: vscodeExtensions.created,
      vscodeExtensionsUpdated: vscodeExtensions.updated,
      vscodeSettings: createdVscodeSettings,
      vscodeLaunch: createdVscodeLaunch
    },
    migrated: {
      tsconfig: tsconfigState.migrated
    }
  };
}

async function readExistingBuildArtifacts(resolvedProjectRoot) {
  try {
    const lock = JSON.parse((await readConfinedFile(resolvedProjectRoot, "deherm.lock", "deherm.lock")).toString("utf8"));
    return lock.buildArtifacts ?? null;
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

export async function verifyGeneratedProject(projectRoot, outputDirectory = ".deherm", options = {}) {
  if (typeof outputDirectory !== "string" || !outputDirectory || path.isAbsolute(outputDirectory)) {
    throw new Error("Generated output must be a relative subdirectory of the Defold project");
  }
  const root = path.resolve(projectRoot, outputDirectory);
  const relativeRoot = path.relative(path.resolve(projectRoot), root);
  if (!relativeRoot || relativeRoot === ".." || relativeRoot.startsWith(`..${path.sep}`) || path.isAbsolute(relativeRoot)) {
    throw new Error("Generated output must be a subdirectory of the Defold project");
  }
  const [resolvedProjectRoot, resolvedOutputRoot] = await Promise.all([
    realpath(projectRoot),
    realpath(root)
  ]);
  const resolvedRelativeRoot = path.relative(resolvedProjectRoot, resolvedOutputRoot);
  if (!resolvedRelativeRoot || resolvedRelativeRoot === ".." || resolvedRelativeRoot.startsWith(`..${path.sep}`) || path.isAbsolute(resolvedRelativeRoot)) {
    throw new Error("Generated output resolves outside the Defold project");
  }
  const [manifestBytes, lockBytes] = await Promise.all([
    readConfinedFile(resolvedOutputRoot, "manifest.json", "Generated manifest"),
    readConfinedFile(resolvedProjectRoot, "deherm.lock", "deherm.lock")
  ]);
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const lock = JSON.parse(lockBytes.toString("utf8"));
  const core = await coreSdkForRevision(manifest.defoldRevision, {
    projectRoot,
    env: options.env
  });
  if (JSON.stringify(manifest.inputs) !== JSON.stringify(core.inputs)) {
    throw new Error("Generated manifest inputs do not match this installed deherm package");
  }
  if (manifest.generator?.package !== "@ts-defold/deherm" || manifest.generator?.version !== core.packageVersion) {
    throw new Error("Generated manifest names a different deherm generator package");
  }
  if (JSON.stringify(manifest.toolchain) !== JSON.stringify(core.toolchain)) {
    throw new Error("Generated manifest names a different or unverified Defold toolchain");
  }
  if (JSON.stringify(manifest.artifacts ?? null) !== JSON.stringify(core.artifacts ?? null)) {
    throw new Error("Generated manifest names a different Defold artifact release mapping");
  }
  const currentEngineProfiles = await resolveEngineProfiles(
    resolvedProjectRoot,
    parseGameProject(await readFile(path.join(resolvedProjectRoot, "game.project"), "utf8")),
    core.scriptProfiles.engineProfileSelection
  );
  const expectedEngineProfiles = validateEngineProfiles(currentEngineProfiles, core.scriptProfiles);
  if (JSON.stringify(manifest.engineProfiles) !== JSON.stringify(expectedEngineProfiles)) {
    throw new Error("Generated manifest engine-profile authority differs from the current project and installed Defold catalog");
  }
  const inventorySource = await readConfinedFile(resolvedOutputRoot, "extensions.json", "Generated extension inventory");
  const inventory = JSON.parse(inventorySource.toString("utf8"));
  const nativeExtensionClang = resolveNativeExtensionClang({
    inventory,
    clang: manifest.generation?.nativeExtensionClang?.command
  });
  const staticHermesInputs = await projectStaticHermesInputs({ core, defoldRevision: core.revision });
  const expectedGeneration = await projectGenerationIdentity({
    inventory,
    outputDirectory: relativeRoot,
    core,
    engineProfiles: manifest.engineProfiles,
    nativeExtensionClang,
    staticHermesInputs
  });
  if (JSON.stringify(manifest.generation) !== JSON.stringify(expectedGeneration)) {
    throw new Error("Generated manifest project-generation key is stale or invalid");
  }
  const files = {
    scriptIrSha256: "ir/script-api.json",
    dmsdkIrSha256: "ir/dmsdk.json",
    scriptDispatchSha256: "ir/script-scalar-dispatch.json",
    scriptPatternsSha256: "ir/script-binding-patterns.json",
    dmsdkPatternsSha256: "ir/dmsdk-binding-patterns.json",
    scriptProbesSha256: "ir/script-real-engine-probes.json",
    scriptAccountingSha256: "ir/script-api-accounting.json",
    scriptUniversalSha256: "ir/script-universal-value-bindings.json",
    scriptProfilesSha256: "ir/script-route-profiles.json",
    loweringPlanSha256: "ir/binding-lowering-plan.json",
    loweringPlanSentinelSha256: "ir/binding-lowering-plan.sentinel.json",
    dmsdkThunksSha256: "ir/dmsdk-scalar-thunks.json",
    dmsdkUniversalSha256: "ir/dmsdk-universal-bindings.json"
  };
  const verified = {};
  verified["extensions.json"] = sha256(inventorySource);
  const verifiedSources = {};
  for (const [key, relative] of Object.entries(files)) {
    const source = await readConfinedFile(resolvedOutputRoot, relative, relative);
    const actual = createHash("sha256").update(source).digest("hex");
    if (manifest.inputs?.[key] !== actual) throw new Error(`${relative} does not match generated manifest input ${key}`);
    verified[relative] = actual;
    verifiedSources[relative] = source;
  }
  const expectedOutputPaths = generatedOutputPaths();
  for (const rootName of ["output", "project"]) {
    const expected = [...expectedOutputPaths[rootName]].sort();
    const declared = Object.keys(manifest.generatedOutputs?.[rootName] ?? {}).sort();
    if (JSON.stringify(declared) !== JSON.stringify(expected)) {
      throw new Error(`Generated manifest ${rootName} output sentinels are incomplete or contain unknown paths`);
    }
    const base = rootName === "output" ? resolvedOutputRoot : resolvedProjectRoot;
    for (const relative of expected) {
      const source = await readConfinedFile(base, relative, `Generated ${rootName} output ${relative}`);
      const actual = sha256(source);
      if (manifest.generatedOutputs[rootName][relative] !== actual) {
        throw new Error(`${relative} does not match generated output sentinel`);
      }
      verified[`${rootName}:${relative}`] = actual;
    }
  }
  const nativeIndex = JSON.parse((await readConfinedFile(
    resolvedOutputRoot,
    "generated/native-extensions/index.json",
    "Generated native-extension index"
  )).toString("utf8"));
  const expectedNativeOutput = path.posix.join(manifest.defoldRevision, manifest.generation.cacheKey);
  if (nativeIndex.defoldRevision !== manifest.defoldRevision ||
      nativeIndex.projectGenerationKey !== manifest.generation.cacheKey ||
      nativeIndex.keyedOutput !== expectedNativeOutput) {
    throw new Error("Generated native-extension index is not keyed to this project generation and Defold revision");
  }
  const nativeOwnerRoot = path.join(resolvedOutputRoot, "generated", "native-extensions");
  const ownerEntries = await readdir(nativeOwnerRoot, { withFileTypes: true });
  const ownerShape = ownerEntries.map((entry) => `${entry.isDirectory() ? "d" : entry.isFile() ? "f" : "x"}:${entry.name}`).sort();
  const expectedOwnerShape = [`d:${manifest.defoldRevision}`, "f:index.json"].sort();
  if (JSON.stringify(ownerShape) !== JSON.stringify(expectedOwnerShape)) {
    throw new Error("Generated native-extension owner root contains stale or unsupported files");
  }
  const revisionEntries = await readdir(path.join(nativeOwnerRoot, manifest.defoldRevision), { withFileTypes: true });
  const revisionShape = revisionEntries.map((entry) => `${entry.isDirectory() ? "d" : "x"}:${entry.name}`).sort();
  if (JSON.stringify(revisionShape) !== JSON.stringify([`d:${manifest.generation.cacheKey}`])) {
    throw new Error("Generated native-extension revision root contains stale project generations");
  }
  const nativeTreeSha256 = await directoryDigest(path.join(
    nativeOwnerRoot,
    ...nativeIndex.keyedOutput.split("/")
  ));
  if (nativeTreeSha256 !== nativeIndex.treeSha256 || nativeTreeSha256 !== manifest.nativeExtensions?.treeSha256) {
    throw new Error("Generated native-extension tree does not match its output sentinel; regenerate the project");
  }
  const generatedSdkSha256 = await directoryDigest(path.join(resolvedOutputRoot, "sdk"));
  if (manifest.generatedSdkSha256 !== generatedSdkSha256) {
    throw new Error("Generated SDK tree does not match its output sentinel; regenerate the project");
  }
  const loweringPlan = JSON.parse(verifiedSources[files.loweringPlanSha256].toString("utf8"));
  const loweringPlanSentinel = JSON.parse(verifiedSources[files.loweringPlanSentinelSha256].toString("utf8"));
  if (loweringPlan.schemaVersion !== 2) throw new Error("ir/binding-lowering-plan.json must use schema v2");
  const { planSha256, ...planBody } = loweringPlan;
  const calculatedPlanSha256 = createHash("sha256").update(JSON.stringify(planBody)).digest("hex");
  if (planSha256 !== calculatedPlanSha256) throw new Error("ir/binding-lowering-plan.json has an invalid internal plan digest");
  if (manifest.loweringPlan?.sha256 !== planSha256) throw new Error("Generated manifest names a different lowering plan");
  if (core.loweringPlan.planSha256 !== planSha256) throw new Error("Generated lowering plan differs from this installed deherm package");
  if (loweringPlanSentinel.outputSha256 !== manifest.inputs.loweringPlanSha256 ||
      loweringPlanSentinel.planSha256 !== planSha256 ||
      loweringPlanSentinel.generatorSha256 !== core.loweringPlanSentinel.generatorSha256) {
    throw new Error("Generated lowering-plan sentinel does not authenticate the copied plan and generator");
  }
  if (manifest.loweringPlan?.units !== loweringPlan.coverage?.units ||
      manifest.loweringPlan?.backendRecords !== loweringPlan.coverage?.backendRecords) {
    throw new Error("Generated manifest lowering-plan census differs from the verified plan");
  }
  for (const key of ["schemaVersion", "defoldRevision", "platform"]) {
    if (lock[key] !== manifest[key]) throw new Error(`deherm.lock ${key} differs from generated manifest`);
  }
  // The recorded revision must be the one the resolution decided, and the
  // generation's Merkle root must still be a function of the engine surface and
  // the native input set that were actually used.
  if (manifest.defoldResolution?.revision !== manifest.defoldRevision) {
    throw new Error("Generated manifest does not record how its Defold revision was resolved");
  }
  const expectedMerkle = buildGenerationMerkle({
    defoldRevision: core.revision,
    surface: { layer: core.surfaceLayer, inputs: core.inputs },
    extensions: inventory.extensions,
    engineProfiles: manifest.engineProfiles,
    generator: { package: "@ts-defold/deherm", version: core.packageVersion, projectGeneratorSha256: expectedGeneration.projectGeneratorSha256 }
  });
  if (manifest.generationMerkle?.engineRoot !== expectedMerkle.engineRoot ||
      manifest.generationMerkle?.nativeRoot !== expectedMerkle.nativeRoot ||
      manifest.generationMerkle?.root !== expectedMerkle.root) {
    throw new Error("Generated manifest generation Merkle root is stale or invalid");
  }
  if (JSON.stringify(lock.generator) !== JSON.stringify(manifest.generator) ||
      JSON.stringify(lock.toolchain) !== JSON.stringify(manifest.toolchain) ||
      JSON.stringify(lock.artifacts ?? null) !== JSON.stringify(manifest.artifacts ?? null) ||
      JSON.stringify(lock.generation) !== JSON.stringify(manifest.generation) ||
      JSON.stringify(lock.defoldResolution) !== JSON.stringify(manifest.defoldResolution) ||
      JSON.stringify(lock.defoldSurface) !== JSON.stringify(manifest.defoldSurface) ||
      JSON.stringify(lock.generationMerkle) !== JSON.stringify(manifest.generationMerkle) ||
      JSON.stringify(lock.inputs) !== JSON.stringify(manifest.inputs) ||
      JSON.stringify(lock.generatedOutputs) !== JSON.stringify(manifest.generatedOutputs) ||
      lock.generatedSdkSha256 !== manifest.generatedSdkSha256 ||
      JSON.stringify(lock.nativeExtensions) !== JSON.stringify(manifest.nativeExtensions) ||
      JSON.stringify(lock.engineProfiles) !== JSON.stringify(manifest.engineProfiles)) {
    throw new Error("deherm.lock does not match the generated manifest contract");
  }
  // Generated state being current says nothing about the application bundle
  // Bob will archive, which is produced by a different step and can be older
  // than every file verified above. The freshness binding is checked here so a
  // single `verify-generated` covers both, and reported rather than thrown so
  // the caller can print both fingerprints.
  const buildArtifacts = await verifyProjectBuildArtifacts(resolvedProjectRoot, { requireTransforms: true });
  return {
    root,
    defoldRevision: manifest.defoldRevision,
    defoldResolution: manifest.defoldResolution,
    generationMerkle: manifest.generationMerkle,
    planSha256,
    checkedFiles: Object.keys(verified).length,
    verified,
    buildArtifacts
  };
}

function isWithinPath(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function isInstalledPackageSdkTarget(packageSdkRoot, candidate) {
  if (isWithinPath(packageSdkRoot, candidate)) return true;
  const portableTarget = candidate.split(path.sep).join("/");
  return portableTarget.includes("/node_modules/@ts-defold/deherm/packages/sdk/") ||
    portableTarget.includes("/node_modules/@ts-defold/deherm/packages/sdk/src/");
}

function authoredContextForFile(file) {
  const normalized = path.normalize(file);
  if (normalized.endsWith(".d.ts")) return null;
  if (normalized.endsWith(".script.ts")) return "game-object";
  if (normalized.endsWith(".gui.ts") || normalized.endsWith(".gui_script.ts")) return "gui";
  if (normalized.endsWith(".render.ts")) return "render";
  return normalized.endsWith(".ts") ? "shared" : null;
}

async function validateAuthoredImportBoundaries(root) {
  const sourceRoot = await realpath(root);
  const packageSdkRoot = await realpath(path.join(packageRoot, "packages", "sdk", "src"));
  const generatedRoots = new Set();
  const configPaths = authoredContexts.map(({ id }) => path.join(root, `tsconfig.deherm.${id}.json`));
  for (const context of authoredContexts) {
    const configPath = path.join(root, `tsconfig.deherm.${context.id}.json`);
    const config = JSON.parse(await readFile(configPath, "utf8"));
    const projectTarget = config.compilerOptions?.paths?.["@deherm/project"]?.[0];
    if (projectTarget) {
      const contextEntry = path.resolve(root, projectTarget);
      generatedRoots.add(await realpath(path.resolve(path.dirname(contextEntry), "../..")));
    }
  }

  const diagnostics = [];
  const api = new TypeScriptApi({ cwd: root });
  try {
    const snapshot = api.updateSnapshot({ openProjects: configPaths });
    for (const project of snapshot.getProjects()) {
      const projectContext = authoredContexts.find(({ id }) => project.configFileName === path.join(root, `tsconfig.deherm.${id}.json`));
      if (!projectContext) continue;
      for (const file of project.program.getSourceFileNames()) {
        const programFile = path.resolve(file);
        const absolute = await realpath(programFile);
        if (!isWithinPath(sourceRoot, absolute) ||
            [...generatedRoots].some((generatedRoot) => isWithinPath(generatedRoot, absolute)) ||
            authoredContextForFile(absolute) !== projectContext.id) continue;
        const sourceFile = project.program.getSourceFile(programFile);
        if (!sourceFile) continue;
        for (const literal of sourceFile.imports) {
          const specifier = literal.text;
          const position = sourceFile.getLineAndCharacterOfPosition(literal.getStart(sourceFile));
          const location = `${path.relative(sourceRoot, absolute).split(path.sep).join("/")}:${position.line + 1}:${position.character + 1}`;
          if (specifier.startsWith("@deherm/project/")) {
            diagnostics.push(`${location} deherm context boundary: import '${specifier}' is a private deep import; use '@deherm/project'`);
            continue;
          }
          if (specifier === "@ts-defold/deherm" || specifier.startsWith("@ts-defold/deherm/") ||
              specifier === "@deherm/sdk" || specifier.startsWith("@deherm/sdk/")) {
            diagnostics.push(`${location} deherm context boundary: import '${specifier}' bypasses the context-filtered '@deherm/project' SDK`);
            continue;
          }
          const symbol = project.checker.getSymbolAtLocation(literal);
          const declaration = symbol?.declarations?.[0]?.resolve(project);
          let target = declaration?.fileName ? path.resolve(declaration.fileName) : null;
          if (!target) continue;
          try { target = await realpath(target); } catch {}
          if (specifier !== "@deherm/project" && [...generatedRoots].some((generatedRoot) => isWithinPath(generatedRoot, target))) {
            diagnostics.push(`${location} deherm context boundary: import '${specifier}' bypasses '@deherm/project' and reaches generated SDK internals`);
            continue;
          }
          if (specifier !== "@deherm/project" && isInstalledPackageSdkTarget(packageSdkRoot, target)) {
            diagnostics.push(`${location} deherm context boundary: import '${specifier}' reaches the unfiltered package SDK; use '@deherm/project'`);
            continue;
          }
          if (!isWithinPath(sourceRoot, target)) continue;
          const targetContext = authoredContextForFile(target);
          if (targetContext && targetContext !== projectContext.id && targetContext !== "shared") {
            diagnostics.push(`${location} deherm context boundary: ${projectContext.id} source cannot import ${targetContext} source '${specifier}'; only plain shared .ts imports may cross contexts`);
          }
        }
      }
    }
  } finally {
    api.close();
  }
  return diagnostics.sort(compareCodeUnits);
}

export async function typecheckGeneratedProject(projectRoot, options = {}) {
  const root = path.resolve(projectRoot);
  const release = options.release === true;
  const config = path.join(root, release ? "tsconfig.deherm.release.json" : "tsconfig.deherm.json");
  const contextConfig = path.join(root, "tsconfig.deherm.json");
  for (const required of new Set([config, contextConfig])) {
    try {
      const information = await lstat(required);
      if (!information.isFile() || information.isSymbolicLink()) throw new Error();
    } catch {
      throw new Error(`Generated TypeScript solution is missing at ${required}; run 'deherm generate' first`);
    }
  }
  await verifyGeneratedProject(root, ".deherm", { env: options.env });
  const typescriptPackage = require.resolve("typescript/package.json");
  const contextCompiler = path.join(path.dirname(typescriptPackage), "bin", "tsc");
  const compiler = contextCompiler;
  const boundaryDiagnostics = await validateAuthoredImportBoundaries(root);
  if (boundaryDiagnostics.length) {
    return {
      schemaVersion: 1,
      project: root,
      config,
      compiler,
      profile: release ? "release" : "development",
      phase: "authored-boundaries",
      passed: false,
      status: 1,
      signal: null,
      stdout: "",
      stderr: `${boundaryDiagnostics.join("\n")}\n`
    };
  }
  const runCompiler = (executable, arguments_, environment = process.env) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [executable, ...arguments_], {
      cwd: root,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (status, signal) => resolve({ status, signal, stdout, stderr }));
  });
  let contextResult = null;
  if (release) {
    contextResult = await runCompiler(contextCompiler, ["--build", contextConfig, "--pretty", "false"]);
    if (contextResult.status !== 0) {
      return {
        schemaVersion: 1,
        project: root,
        config,
        compiler,
        contextConfig,
        contextCompiler,
        profile: "release",
        phase: "context-typecheck",
        passed: false,
        ...contextResult
      };
    }
  }
  const result = release
    ? await checkProject({
        tsconfig: config,
        cwd: root,
        config: await loadDehermPluginConfig(config)
      })
    : await runCompiler(compiler, ["--build", config, "--pretty", "false"]);
  return {
    schemaVersion: 1,
    project: root,
    config,
    compiler: result.compiler ?? compiler,
    ...(result.compilerSha256 ? { compilerSha256: result.compilerSha256 } : {}),
    contextConfig,
    contextCompiler,
    profile: release ? "release" : "development",
    phase: release ? "release-reachability" : "context-typecheck",
    passed: result.status === 0,
    ...result,
    context: contextResult
  };
}
