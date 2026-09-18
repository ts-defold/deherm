import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { access, cp, lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { API as TypeScriptApi } from "typescript/unstable/sync";

import {
  assertUniquePublicScriptRoots,
  publicScriptModulePath
} from "../../compiler/src/script-public-api-policy.mjs";
import { safeParameterIdentifier } from "./names.mjs";
import { defoldToolchain } from "./toolchains.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const require = createRequire(import.meta.url);
const generatedContextExportNames = new Set(["projectExtensions"]);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function directoryDigest(root, options = {}) {
  const hash = createHash("sha256");
  async function visit(directory, prefix = "") {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => compareCodeUnits(left.name, right.name));
    for (const entry of entries) {
      if (options.ignore?.has(entry.name)) continue;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
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

async function projectGenerationIdentity({ inventory, outputDirectory, core, engineProfiles }) {
  const projectGeneratorSha256 = sha256(await readFile(fileURLToPath(import.meta.url)));
  const cacheKey = sha256(JSON.stringify({
    schemaVersion: 1,
    projectGeneratorSha256,
    outputDirectory: outputDirectory.split(path.sep).join("/"),
    packageVersion: core.packageVersion,
    coreInputs: core.inputs,
    engineProfiles,
    inventory
  }));
  return { schemaVersion: 1, projectGeneratorSha256, cacheKey };
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

function normalizeType(value) {
  const raw = typeof value?.type === "string" ? value.type : typeof value === "string" ? value : "any";
  if (raw.includes("|")) {
    let types = raw.split("|").map((part) => normalizeType(part.trim()));
    if (types.some(({ kind }) => kind === "url") && types.some(({ kind }) => kind === "string")) {
      types = types.map((type) => type.kind === "string" ? { kind: "address-literal", raw: type.raw } : type);
    }
    const unique = [...new Map(types.map((type) => [JSON.stringify(type), type])).values()];
    return unique.length === 1 ? unique[0] : { kind: "union", types: unique, raw };
  }
  if (raw.toLowerCase() === "table" && Array.isArray(value?.parameters)) {
    return {
      kind: "record",
      fields: value.parameters.map((field, index) => ({
        name: typeof field?.name === "string" ? field.name : `field${index + 1}`,
        optional: field?.optional === true,
        type: normalizeType(field)
      })),
      raw
    };
  }
  switch (raw.trim().toLowerCase()) {
    case "bool":
    case "boolean": return { kind: "boolean", raw };
    case "number":
    case "float":
    case "int":
    case "integer":
    case "constant": return { kind: "number", raw };
    case "string": return { kind: "string", raw };
    case "hash": return { kind: "hash", raw };
    case "url": return { kind: "url", raw };
    case "nil": return { kind: "null", raw };
    case "table": return { kind: "record", fields: [], raw };
    case "function": return { kind: "function", raw };
    case "object":
    case "userdata":
    case "any": return { kind: "unknown", raw };
    default: return { kind: "named", name: raw.trim(), raw };
  }
}

function renderType(type) {
  switch (type.kind) {
    case "void": return "void";
    case "boolean": return "boolean";
    case "number": return "number";
    case "string": return "string";
    case "hash": return "DefoldHash";
    case "url": return "DefoldUrl";
    case "address-literal": return "DefoldAddressLiteral | DefoldRelativeAddress";
    case "null": return "null";
    case "record": return type.fields.length
      ? `Readonly<{ ${type.fields.map((field) => `${property(field.name)}${field.optional ? "?" : ""}: ${renderType(field.type)}`).join("; ")} }>`
      : "Readonly<Record<string, unknown>>";
    case "function": return "(...args: unknown[]) => unknown";
    case "union": return type.types.map(renderType).join(" | ");
    case "tuple": return `[${type.types.map(renderType).join(", ")}]`;
    case "named":
    case "unknown": return "unknown";
    default: throw new Error(`Unknown binding IR type: ${type.kind}`);
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

function normalizeMember(moduleName, member) {
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
  if (member.type !== "function") return { ...common, kind: "value", type: normalizeType(member.type) };
  const parameters = (Array.isArray(member.parameters) ? member.parameters : []).map((parameter, index) => {
    const rawParameterName = typeof parameter?.name === "string" ? parameter.name : `arg${index + 1}`;
    return {
      rawName: rawParameterName,
      jsName: safeParameterIdentifier(memberIdentifier(rawParameterName), index),
      optional: parameter?.optional === true,
      type: normalizeType(parameter)
    };
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
      ? { kind: "tuple", types: result.map(normalizeType) }
      : normalizeType(result);
  return { ...common, kind: "function", parameters, returns };
}

export function buildProjectBindingIr(inventory) {
  const baseModules = collectModules(inventory).map((module) => {
    const members = [];
    const rawNames = new Set();
    const jsNames = new Map();
    for (const member of module.members) {
      if (!member || typeof member.name !== "string" || rawNames.has(member.name)) continue;
      rawNames.add(member.name);
      const normalized = normalizeMember(module.name, member);
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
  return {
    schemaVersion: 1,
    abiVersion: 1,
    source: "defold-project-extensions",
    modules
  };
}

function generatedModuleSource(module) {
  const interfaceName = module.typeName;
  const exportName = module.jsName;
  const lines = [
    "// Generated by deherm. Do not edit.",
    `import type { ${interfaceName}, DefoldAddressLiteral, DefoldRelativeAddress, DefoldHash, DefoldUrl } from "../../extensions.js";`,
    'import { callExtension, getExtensionValue } from "../runtime.js";',
    "",
    `export const ${exportName}: ${interfaceName} = {`
  ];
  for (const member of module.members) {
    lines.push(...description(member.description, "  "));
    if (member.kind === "function") {
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
const authoredContexts = [
  { id: "shared", suffix: null, includes: ["**/*.ts"], excludes: ["**/*.script.ts", "**/*.gui.ts", "**/*.gui_script.ts", "**/*.render.ts", ...ignoredAuthoredGlobs] },
  { id: "game-object", suffix: ".script.ts", includes: ["**/*.ts"], excludes: ["**/*.gui.ts", "**/*.gui_script.ts", "**/*.render.ts", ...ignoredAuthoredGlobs] },
  { id: "gui", suffix: ".gui.ts", legacySuffixes: [".gui_script.ts"], includes: ["**/*.ts"], excludes: ["**/*.script.ts", "**/*.render.ts", ...ignoredAuthoredGlobs] },
  { id: "render", suffix: ".render.ts", includes: ["**/*.ts"], excludes: ["**/*.script.ts", "**/*.gui.ts", "**/*.gui_script.ts", ...ignoredAuthoredGlobs] }
];

function generatedOutputPaths() {
  return {
    output: ["script-contexts.json", ...authoredContexts.map(({ id }) => `sdk/contexts/${id}.ts`)],
    project: [
      "tsconfig.deherm.base.json",
      ...authoredContexts.map(({ id }) => `tsconfig.deherm.${id}.json`),
      "tsconfig.deherm.bundle.json",
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
  const scriptUnits = loweringPlan.units.filter(({ identity }) => identity.surface === "script");
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
    ...modules.map((module) => `import { ${module.jsName} as dehermExtension_${module.jsName} } from "../modules/${module.fileName}.js";`),
    "",
    "type DehermWithoutContextMembers<Api, Denied> = {",
    "  readonly [Key in keyof Api as Key extends keyof Denied ? Denied[Key] extends true ? never : Key : Key]:",
    "    Key extends keyof Denied ? DehermWithoutContextMembers<Api[Key], Denied[Key]> : Api[Key];",
    "};",
    "",
    'export * from "../address.js";',
    'export * from "../component.js";',
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
    lines.push(`export const ${namespace}: ${exposedType} = ScriptModules.${namespace};`);
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function projectBaseConfig(outputDirectory) {
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
        profile: "development"
      }]
    }
  };
}

function contextProjectConfig(outputDirectory, context) {
  const generated = outputDirectory.split(path.sep).join("/");
  const excludes = [...context.excludes, `${generated}/generated/components/registry.ts`];
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
    exclude: ignoredAuthoredGlobs
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

async function bundledCoreSdk(requestedRevision) {
  const sdkSourceRoot = path.join(packageRoot, "packages", "sdk", "src");
  const scriptIrPath = path.join(packageRoot, "packages", "bindings", "generated", "defold-script-api-ir.json");
  const dmsdkIrPath = path.join(packageRoot, "packages", "bindings", "generated", "defold-sdk-ir.json");
  const scriptDispatchPath = path.join(packageRoot, "packages", "bindings", "generated", "defold-script-scalar-dispatch.json");
  const scriptAccountingPath = path.join(packageRoot, "packages", "bindings", "generated", "defold-script-api-accounting.json");
  const scriptUniversalPath = path.join(packageRoot, "packages", "bindings", "generated", "defold-script-universal-value-bindings.json");
  const scriptProfilesPath = path.join(packageRoot, "packages", "bindings", "generated", "defold-script-route-availability-profiles.json");
  const loweringPlanPath = path.join(packageRoot, "packages", "bindings", "generated", "defold-binding-lowering-plan.json");
  const loweringPlanSentinelPath = path.join(packageRoot, "packages", "bindings", "generated", "defold-binding-lowering-plan.sentinel.json");
  const loweringPlanGeneratorPath = path.join(packageRoot, "packages", "compiler", "src", "generate-binding-lowering-plan.mjs");
  const dmsdkThunksPath = path.join(packageRoot, "packages", "bindings", "generated", "defold-dmsdk-scalar-thunks.json");
  const dmsdkUniversalPath = path.join(packageRoot, "packages", "bindings", "generated", "defold-dmsdk-universal-bindings.json");
  const [scriptSource, dmsdkSource, scriptDispatchSource, scriptAccountingSource, scriptUniversalSource, scriptProfilesSource, loweringPlanSource, loweringPlanSentinelSource, loweringPlanGeneratorSource, dmsdkThunksSource, dmsdkUniversalSource, packageSource] = await Promise.all([
    readFile(scriptIrPath),
    readFile(dmsdkIrPath),
    readFile(scriptDispatchPath),
    readFile(scriptAccountingPath),
    readFile(scriptUniversalPath),
    readFile(scriptProfilesPath),
    readFile(loweringPlanPath),
    readFile(loweringPlanSentinelPath),
    readFile(loweringPlanGeneratorPath),
    readFile(dmsdkThunksPath),
    readFile(dmsdkUniversalPath),
    readFile(path.join(packageRoot, "package.json"), "utf8")
  ]);
  const scriptIr = JSON.parse(scriptSource);
  const dmsdkIr = JSON.parse(dmsdkSource);
  const scriptDispatch = JSON.parse(scriptDispatchSource);
  const scriptAccounting = JSON.parse(scriptAccountingSource);
  const scriptUniversal = JSON.parse(scriptUniversalSource);
  const scriptProfiles = JSON.parse(scriptProfilesSource);
  const loweringPlan = JSON.parse(loweringPlanSource);
  const loweringPlanSentinel = JSON.parse(loweringPlanSentinelSource);
  const dmsdkThunks = JSON.parse(dmsdkThunksSource);
  const dmsdkUniversal = JSON.parse(dmsdkUniversalSource);
  const revisions = new Set([scriptIr, dmsdkIr, scriptDispatch, scriptAccounting, scriptUniversal, scriptProfiles, loweringPlan, dmsdkThunks, dmsdkUniversal].map(({ defoldRevision }) => defoldRevision));
  if (revisions.size !== 1) {
    throw new Error(`Packaged API inputs disagree: ${[...revisions].join(", ")}`);
  }
  if (requestedRevision && requestedRevision !== scriptIr.defoldRevision) {
    throw new Error(`This package contains Defold ${scriptIr.defoldRevision}, not requested ${requestedRevision}; version-resolved download generation is not available yet`);
  }
  const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
  if (loweringPlan.schemaVersion !== 2) {
    throw new Error(`Packaged canonical lowering plan must use schema v2, got ${loweringPlan.schemaVersion ?? "missing"}`);
  }
  const { planSha256, ...planBody } = loweringPlan;
  if (sha256(JSON.stringify(planBody)) !== planSha256) {
    throw new Error("Packaged canonical lowering plan has an invalid internal digest");
  }
  if (loweringPlanSentinel.schemaVersion !== 1 ||
      loweringPlanSentinel.generator !== "packages/compiler/src/generate-binding-lowering-plan.mjs" ||
      loweringPlanSentinel.generatorSha256 !== sha256(loweringPlanGeneratorSource) ||
      loweringPlanSentinel.outputSha256 !== sha256(loweringPlanSource) ||
      loweringPlanSentinel.outputBytes !== loweringPlanSource.byteLength ||
      loweringPlanSentinel.planSha256 !== planSha256 ||
      JSON.stringify(loweringPlanSentinel.inputHashes) !== JSON.stringify(loweringPlan.inputHashes)) {
    throw new Error("Packaged canonical lowering-plan sentinel is stale or invalid");
  }
  const sdkSourceSha256 = await directoryDigest(sdkSourceRoot);
  return {
    revision: scriptIr.defoldRevision,
    packageVersion: JSON.parse(packageSource).version,
    platform: dmsdkIr.platform,
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
    inputs: {
      scriptIrSha256: sha256(scriptSource),
      dmsdkIrSha256: sha256(dmsdkSource),
      scriptDispatchSha256: sha256(scriptDispatchSource),
      scriptAccountingSha256: sha256(scriptAccountingSource),
      scriptUniversalSha256: sha256(scriptUniversalSource),
      scriptProfilesSha256: sha256(scriptProfilesSource),
      loweringPlanSha256: sha256(loweringPlanSource),
      loweringPlanSentinelSha256: sha256(loweringPlanSentinelSource),
      dmsdkThunksSha256: sha256(dmsdkThunksSource),
      dmsdkUniversalSha256: sha256(dmsdkUniversalSource),
      sdkSourceSha256
    },
    paths: { scriptIrPath, dmsdkIrPath, scriptDispatchPath, scriptAccountingPath, scriptUniversalPath, scriptProfilesPath, loweringPlanPath, loweringPlanSentinelPath, dmsdkThunksPath, dmsdkUniversalPath }
  };
}

function loweringTargetMatrix(plan, surface) {
  const matrix = {};
  const units = plan.units.filter((unit) => unit.identity.surface === surface);
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

function validateEngineProfiles(engineProfiles, catalog) {
  if (!engineProfiles || typeof engineProfiles !== "object") {
    throw new Error("Project inventory has no Defold engine profile resolution");
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

export function generateExtensionTypes(inventory) {
  const modules = buildProjectBindingIr(inventory).modules;
  const lines = [
    "// Generated by deherm. Do not edit.",
    'import type { DefoldAddressLiteral, DefoldRelativeAddress, DefoldHash, DefoldUrl } from "./sdk/address.js";',
    'export type { DefoldAddressLiteral, DefoldRelativeAddress, DefoldHash, DefoldUrl } from "./sdk/address.js";',
    ""
  ];
  for (const module of modules) {
    lines.push(...description(module.description));
    lines.push(`export interface ${module.typeName} {`);
    for (const member of module.members) {
      lines.push(...description(member.description, "  "));
      if (member.kind === "function") {
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
  const source = path.resolve(options.source ?? path.join(packageRoot, "defold", "defold_hermes"));
  const destination = path.join(path.resolve(projectRoot), "defold_hermes");
  if (path.resolve(source) === path.resolve(destination)) {
    return { root: destination, installed: false, source: "workspace" };
  }
  try {
    const [resolvedSource, resolvedDestination] = await Promise.all([realpath(source), realpath(destination)]);
    if (resolvedSource === resolvedDestination) {
      return { root: destination, installed: false, source: "workspace-link" };
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  try {
    const destinationInformation = await lstat(destination);
    if (destinationInformation.isSymbolicLink()) {
      throw new Error(`Refusing to replace native-extension symlink that does not target this package: ${destination}`);
    }
    if (!destinationInformation.isDirectory()) {
      throw new Error(`Refusing to replace non-directory native extension at ${destination}`);
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const packageManifest = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
  const extensionManifest = await readFile(path.join(source, "ext.manifest"), "utf8");
  const extensionTreeSha256 = await directoryDigest(source, { ignore: new Set([".deherm-managed.json"]) });
  const identity = {
    schemaVersion: 2,
    package: packageManifest.name,
    version: packageManifest.version,
    extensionManifestSha256: sha256(extensionManifest),
    extensionTreeSha256
  };
  const sentinelName = ".deherm-managed.json";
  let current = null;
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
  if (options.force !== true && current && JSON.stringify(current) === JSON.stringify(identity)) {
    return { root: destination, installed: false, source: "package" };
  }
  const nonce = `${process.pid}-${randomBytes(8).toString("hex")}`;
  const stage = `${destination}.deherm-stage-${nonce}`;
  const backup = `${destination}.deherm-backup-${nonce}`;
  let movedCurrent = false;
  try {
    await cp(source, stage, { recursive: true, errorOnExist: true, force: false });
    await writeFile(path.join(stage, sentinelName), `${JSON.stringify(identity, null, 2)}\n`, { flag: "wx" });
    if (current) {
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
  return { root: destination, installed: true, source: "package" };
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
  const core = await bundledCoreSdk(options.defoldSdk);
  const toolchain = defoldToolchain(core.revision);
  const engineProfiles = validateEngineProfiles(inventory.engineProfiles, core.scriptProfiles);
  const portableInventory = { ...inventory, projectRoot: "." };
  const bindingIr = buildProjectBindingIr(inventory);
  const generation = await projectGenerationIdentity({
    inventory: portableInventory,
    outputDirectory: relativeRoot,
    core,
    engineProfiles
  });
  const generationKey = generation.cacheKey;
  if (options.force !== true) {
    try {
      const [manifestSource, lockSource] = await Promise.all([
        readConfinedFile(resolvedOutputRoot, "manifest.json", "Generated manifest"),
        readConfinedFile(resolvedProjectRoot, "deherm.lock", "deherm.lock")
      ]);
      const previousManifest = JSON.parse(manifestSource.toString("utf8"));
      const previousLock = JSON.parse(lockSource.toString("utf8"));
      if (previousManifest.generation?.cacheKey === generationKey &&
          previousLock.generation?.cacheKey === generationKey) {
        return {
          root,
          defoldRevision: core.revision,
          moduleCount: bindingIr.modules.length,
          typecheckProject: path.join(inventory.projectRoot, "tsconfig.deherm.json"),
          cached: true,
          generationKey,
          created: { tsconfig: false, vscodeExtensions: false, vscodeSettings: false },
          migrated: { tsconfig: false }
        };
      }
    } catch (error) {
      if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
  }
  await writeFile(path.join(root, "extensions.json"), `${JSON.stringify(portableInventory, null, 2)}\n`);
  await writeFile(path.join(root, "bindings.ir.json"), `${JSON.stringify(bindingIr, null, 2)}\n`);
  const irRoot = path.join(root, "ir");
  await mkdir(irRoot, { recursive: true });
  await cp(core.paths.scriptIrPath, path.join(irRoot, "script-api.json"));
  await cp(core.paths.dmsdkIrPath, path.join(irRoot, "dmsdk.json"));
  await cp(core.paths.scriptDispatchPath, path.join(irRoot, "script-scalar-dispatch.json"));
  await cp(core.paths.scriptAccountingPath, path.join(irRoot, "script-api-accounting.json"));
  await cp(core.paths.scriptUniversalPath, path.join(irRoot, "script-universal-value-bindings.json"));
  await cp(core.paths.scriptProfilesPath, path.join(irRoot, "script-route-profiles.json"));
  await cp(core.paths.loweringPlanPath, path.join(irRoot, "binding-lowering-plan.json"));
  await cp(core.paths.loweringPlanSentinelPath, path.join(irRoot, "binding-lowering-plan.sentinel.json"));
  await cp(core.paths.dmsdkThunksPath, path.join(irRoot, "dmsdk-scalar-thunks.json"));
  await cp(core.paths.dmsdkUniversalPath, path.join(irRoot, "dmsdk-universal-bindings.json"));
  await writeFile(path.join(root, "extensions.d.ts"), generateExtensionTypes(inventory));
  const modules = bindingIr.modules;
  const sdkRoot = path.join(root, "sdk");
  const modulesRoot = path.join(sdkRoot, "modules");
  const contextsRoot = path.join(sdkRoot, "contexts");
  await rm(modulesRoot, { recursive: true, force: true });
  await rm(path.join(sdkRoot, "generated"), { recursive: true, force: true });
  await rm(contextsRoot, { recursive: true, force: true });
  await mkdir(modulesRoot, { recursive: true });
  await mkdir(contextsRoot, { recursive: true });
  await cp(path.join(packageRoot, "packages", "sdk", "src", "address.ts"), path.join(sdkRoot, "address.ts"));
  await cp(path.join(packageRoot, "packages", "sdk", "src", "component.ts"), path.join(sdkRoot, "component.ts"));
  await cp(
    path.join(packageRoot, "packages", "sdk", "src", "generated", "script"),
    path.join(sdkRoot, "generated", "script"),
    { recursive: true }
  );
  await cp(
    path.join(packageRoot, "packages", "sdk", "src", "generated", "dmsdk"),
    path.join(sdkRoot, "generated", "dmsdk"),
    { recursive: true }
  );
  await writeFile(path.join(sdkRoot, "runtime.ts"), runtimeSource());
  const exports = [
    "// Generated by deherm. Do not edit.",
    'export * from "./address.js";',
    'export * from "./component.js";',
    'export * from "./generated/script/index.js";',
    'export * from "./generated/dmsdk/index.js";',
    'export * from "./generated/dmsdk/scalar.js";',
    'export * from "./runtime.js";'
  ];
  for (const module of modules) {
    const moduleFile = module.fileName;
    await writeFile(path.join(modulesRoot, `${moduleFile}.ts`), generatedModuleSource(module));
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
    "tsconfig.deherm.json": `${JSON.stringify(rootProjectConfig(), null, 2)}\n`
  };
  for (const [relative, source] of Object.entries(projectConfigSources)) {
    await writeFile(path.join(inventory.projectRoot, relative), source);
  }
  const generatedOutputs = {
    output: Object.fromEntries(Object.entries({
      "script-contexts.json": scriptContextsSource,
      ...contextSources
    }).map(([relative, source]) => [relative, sha256(source)])),
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
    generation,
    inputs: core.inputs,
    generatedOutputs,
    generatedSdkSha256,
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
        types: core.scriptIr.counts.classes + core.scriptIr.counts.aliases + core.scriptIr.counts.enums,
        typeSurfaceUnresolved: core.scriptIr.typeSurfaceUnresolvedCount,
        universalRecipes: core.scriptUniversal.candidateCount,
        universalExclusions: core.scriptUniversal.excludedCount,
        accounting: core.scriptAccounting.categoryCounts,
        targetMatrix: loweringTargetMatrix(core.loweringPlan, "script"),
        runtimeLanes: {
          generatedScalarDispatch: core.scriptDispatch.bindingCount,
          universalStableId: core.scriptUniversal.candidateCount
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
      }
    }
  }, null, 2)}\n`);
  await writeFile(path.join(inventory.projectRoot, "deherm.lock"), `${JSON.stringify({
    schemaVersion: 1,
    defoldRevision: core.revision,
    platform: core.platform,
    generator: { package: "@ts-defold/deherm", version: core.packageVersion },
    toolchain,
    generation,
    inputs: core.inputs,
    generatedOutputs,
    generatedSdkSha256,
    engineProfiles
  }, null, 2)}\n`);
  const tsconfigState = await migrateLegacyGeneratedTsconfig(
    path.join(inventory.projectRoot, "tsconfig.json"),
    projectConfigSources["tsconfig.deherm.json"]
  );
  const createdVscodeExtensions = await writeIfMissing(
    path.join(inventory.projectRoot, ".vscode", "extensions.json"),
    `${JSON.stringify({ recommendations: ["samchon.ttsc"] }, null, 2)}\n`
  );
  const createdVscodeSettings = await writeIfMissing(
    path.join(inventory.projectRoot, ".vscode", "settings.json"),
    `${JSON.stringify({
      "[typescript][typescriptreact]": {
        "editor.defaultFormatter": "samchon.ttsc"
      }
    }, null, 2)}\n`
  );
  return {
    root,
    defoldRevision: core.revision,
    moduleCount: modules.length,
    cached: false,
    generationKey,
    typecheckProject: path.join(inventory.projectRoot, "tsconfig.deherm.json"),
    created: {
      tsconfig: tsconfigState.created,
      vscodeExtensions: createdVscodeExtensions,
      vscodeSettings: createdVscodeSettings
    },
    migrated: {
      tsconfig: tsconfigState.migrated
    }
  };
}

export async function verifyGeneratedProject(projectRoot, outputDirectory = ".deherm") {
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
  const core = await bundledCoreSdk(manifest.defoldRevision);
  if (JSON.stringify(manifest.inputs) !== JSON.stringify(core.inputs)) {
    throw new Error("Generated manifest inputs do not match this installed deherm package");
  }
  if (manifest.generator?.package !== "@ts-defold/deherm" || manifest.generator?.version !== core.packageVersion) {
    throw new Error("Generated manifest names a different deherm generator package");
  }
  if (JSON.stringify(manifest.toolchain) !== JSON.stringify(defoldToolchain(core.revision))) {
    throw new Error("Generated manifest names a different or unverified Defold toolchain");
  }
  const expectedEngineProfiles = validateEngineProfiles(manifest.engineProfiles, core.scriptProfiles);
  if (JSON.stringify(manifest.engineProfiles) !== JSON.stringify(expectedEngineProfiles)) {
    throw new Error("Generated manifest engine-profile authority differs from the installed Defold catalog");
  }
  const inventorySource = await readConfinedFile(resolvedOutputRoot, "extensions.json", "Generated extension inventory");
  const inventory = JSON.parse(inventorySource.toString("utf8"));
  const expectedGeneration = await projectGenerationIdentity({
    inventory,
    outputDirectory: relativeRoot,
    core,
    engineProfiles: manifest.engineProfiles
  });
  if (JSON.stringify(manifest.generation) !== JSON.stringify(expectedGeneration)) {
    throw new Error("Generated manifest project-generation key is stale or invalid");
  }
  const files = {
    scriptIrSha256: "ir/script-api.json",
    dmsdkIrSha256: "ir/dmsdk.json",
    scriptDispatchSha256: "ir/script-scalar-dispatch.json",
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
  if (JSON.stringify(lock.generator) !== JSON.stringify(manifest.generator) ||
      JSON.stringify(lock.toolchain) !== JSON.stringify(manifest.toolchain) ||
      JSON.stringify(lock.generation) !== JSON.stringify(manifest.generation) ||
      JSON.stringify(lock.inputs) !== JSON.stringify(manifest.inputs) ||
      JSON.stringify(lock.generatedOutputs) !== JSON.stringify(manifest.generatedOutputs) ||
      lock.generatedSdkSha256 !== manifest.generatedSdkSha256 ||
      JSON.stringify(lock.engineProfiles) !== JSON.stringify(manifest.engineProfiles)) {
    throw new Error("deherm.lock does not match the generated manifest contract");
  }
  return {
    root,
    defoldRevision: manifest.defoldRevision,
    planSha256,
    checkedFiles: Object.keys(verified).length,
    verified
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

export async function typecheckGeneratedProject(projectRoot) {
  const root = path.resolve(projectRoot);
  const config = path.join(root, "tsconfig.deherm.json");
  try {
    const information = await lstat(config);
    if (!information.isFile() || information.isSymbolicLink()) throw new Error();
  } catch {
    throw new Error(`Generated TypeScript solution is missing at ${config}; run 'deherm generate' first`);
  }
  await verifyGeneratedProject(root);
  const typescriptPackage = require.resolve("typescript/package.json");
  const tsc = path.join(path.dirname(typescriptPackage), "bin", "tsc");
  const boundaryDiagnostics = await validateAuthoredImportBoundaries(root);
  if (boundaryDiagnostics.length) {
    return {
      schemaVersion: 1,
      project: root,
      config,
      compiler: tsc,
      passed: false,
      status: 1,
      signal: null,
      stdout: "",
      stderr: `${boundaryDiagnostics.join("\n")}\n`
    };
  }
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [tsc, "--build", config, "--pretty", "false"], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (status, signal) => resolve({
      schemaVersion: 1,
      project: root,
      config,
      compiler: tsc,
      passed: status === 0,
      status,
      signal,
      stdout,
      stderr
    }));
  });
}
