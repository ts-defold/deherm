import { createHash } from "node:crypto";
import { access, cp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { safeParameterIdentifier } from "./names.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

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
  return [...modules.values()].sort((left, right) => left.name.localeCompare(right.name));
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
    "// Generated by defold-hermes. Do not edit.",
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
  return `// Generated by defold-hermes. Do not edit.
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

function projectConfig(outputDirectory) {
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
      paths: {
        "@defold-hermes/project": [`./${generated}/sdk/index.ts`],
        "@defold-hermes/project/*": [`./${generated}/sdk/*`]
      },
      plugins: [{
        transform: "@ts-defold/hermes/ttsc",
        enabled: false,
        inventory: `./${generated}/extensions.json`,
        profile: "development"
      }]
    },
    include: ["src/**/*.ts", `${generated}/**/*.ts`]
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

async function bundledCoreSdk(requestedRevision) {
  const scriptIrPath = path.join(packageRoot, "bindings", "generated", "defold-script-api-ir.json");
  const dmsdkIrPath = path.join(packageRoot, "bindings", "generated", "defold-sdk-ir.json");
  const [scriptSource, dmsdkSource, packageSource] = await Promise.all([
    readFile(scriptIrPath),
    readFile(dmsdkIrPath),
    readFile(path.join(packageRoot, "package.json"), "utf8")
  ]);
  const scriptIr = JSON.parse(scriptSource);
  const dmsdkIr = JSON.parse(dmsdkSource);
  if (scriptIr.defoldRevision !== dmsdkIr.defoldRevision) {
    throw new Error(`Packaged API inputs disagree: script ${scriptIr.defoldRevision}, dmSDK ${dmsdkIr.defoldRevision}`);
  }
  if (requestedRevision && requestedRevision !== scriptIr.defoldRevision) {
    throw new Error(`This package contains Defold ${scriptIr.defoldRevision}, not requested ${requestedRevision}; version-resolved download generation is not available yet`);
  }
  const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
  return {
    revision: scriptIr.defoldRevision,
    packageVersion: JSON.parse(packageSource).version,
    platform: dmsdkIr.platform,
    scriptIr,
    dmsdkIr,
    inputs: {
      scriptIrSha256: sha256(scriptSource),
      dmsdkIrSha256: sha256(dmsdkSource)
    },
    paths: { scriptIrPath, dmsdkIrPath }
  };
}

export function generateExtensionTypes(inventory) {
  const modules = buildProjectBindingIr(inventory).modules;
  const lines = [
    "// Generated by defold-hermes. Do not edit.",
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

export async function writeGeneratedProject(inventory, outputDirectory = ".defold-hermes", options = {}) {
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
  const portableInventory = { ...inventory, projectRoot: "." };
  await writeFile(path.join(root, "extensions.json"), `${JSON.stringify(portableInventory, null, 2)}\n`);
  const bindingIr = buildProjectBindingIr(inventory);
  await writeFile(path.join(root, "bindings.ir.json"), `${JSON.stringify(bindingIr, null, 2)}\n`);
  const irRoot = path.join(root, "ir");
  await mkdir(irRoot, { recursive: true });
  await cp(core.paths.scriptIrPath, path.join(irRoot, "script-api.json"));
  await cp(core.paths.dmsdkIrPath, path.join(irRoot, "dmsdk.json"));
  await writeFile(path.join(root, "extensions.d.ts"), generateExtensionTypes(inventory));
  const modules = bindingIr.modules;
  const sdkRoot = path.join(root, "sdk");
  const modulesRoot = path.join(sdkRoot, "modules");
  await rm(modulesRoot, { recursive: true, force: true });
  await rm(path.join(sdkRoot, "generated"), { recursive: true, force: true });
  await mkdir(modulesRoot, { recursive: true });
  await cp(path.join(packageRoot, "packages", "sdk", "src", "address.ts"), path.join(sdkRoot, "address.ts"));
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
    "// Generated by defold-hermes. Do not edit.",
    'export * from "./address.js";',
    'export * from "./generated/script/index.js";',
    'export * from "./generated/dmsdk/index.js";',
    'export * from "./runtime.js";'
  ];
  for (const module of modules) {
    const moduleFile = module.fileName;
    await writeFile(path.join(modulesRoot, `${moduleFile}.ts`), generatedModuleSource(module));
    exports.push(`export { ${module.jsName} } from "./modules/${moduleFile}.js";`);
  }
  exports.push("");
  await writeFile(path.join(sdkRoot, "index.ts"), `${exports.join("\n")}\n`);
  await writeFile(path.join(root, "manifest.json"), `${JSON.stringify({
    schemaVersion: 1,
    defoldRevision: core.revision,
    platform: core.platform,
    generator: { package: "@ts-defold/hermes", version: core.packageVersion },
    inputs: core.inputs,
    coverage: {
      script: {
        functions: core.scriptIr.counts.functions,
        types: core.scriptIr.counts.classes + core.scriptIr.counts.aliases + core.scriptIr.counts.enums,
        typeSurfaceUnresolved: core.scriptIr.typeSurfaceUnresolvedCount,
        runtimeImplemented: core.scriptIr.runtimeImplementedCount,
        runtimePending: core.scriptIr.runtimeUnimplementedCount
      },
      dmsdk: {
        headers: core.dmsdkIr.headerCount,
        parsedHeaders: core.dmsdkIr.parsedHeaderCount,
        diagnosticHeaders: core.dmsdkIr.diagnosticHeaderCount,
        declarations: core.dmsdkIr.declarationCount,
        typeSurfaceUnresolved: core.dmsdkIr.typeSurfaceUnresolvedCount,
        runtimeImplemented: core.dmsdkIr.runtimeImplementedCount,
        runtimePending: core.dmsdkIr.runtimeUnimplementedCount
      }
    }
  }, null, 2)}\n`);
  await writeFile(path.join(inventory.projectRoot, "defold-hermes.lock"), `${JSON.stringify({
    schemaVersion: 1,
    defoldRevision: core.revision,
    platform: core.platform,
    generator: { package: "@ts-defold/hermes", version: core.packageVersion },
    inputs: core.inputs
  }, null, 2)}\n`);

  const relativeOutput = path.relative(inventory.projectRoot, root) || ".defold-hermes";
  await writeFile(
    path.join(inventory.projectRoot, "tsconfig.defold-hermes.json"),
    `${JSON.stringify(projectConfig(relativeOutput), null, 2)}\n`
  );
  const createdTsconfig = await writeIfMissing(
    path.join(inventory.projectRoot, "tsconfig.json"),
    `${JSON.stringify({ extends: "./tsconfig.defold-hermes.json" }, null, 2)}\n`
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
    created: {
      tsconfig: createdTsconfig,
      vscodeExtensions: createdVscodeExtensions,
      vscodeSettings: createdVscodeSettings
    }
  };
}
