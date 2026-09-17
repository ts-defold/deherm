import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

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
  return value[0].toLowerCase() + value.slice(1);
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
    const types = raw.split("|").map((part) => normalizeType(part.trim()));
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
      jsName: memberIdentifier(rawParameterName),
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
  const modules = collectModules(inventory).map((module) => {
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
      sources: module.sources,
      members
    };
    if (module.descriptions[0]) normalizedModule.description = module.descriptions[0];
    return normalizedModule;
  });
  return {
    schemaVersion: 1,
    abiVersion: 1,
    source: "defold-project-extensions",
    modules
  };
}

function generatedModuleSource(module) {
  const interfaceName = `${identifier(module.runtimeName)}Extension`;
  const exportName = module.jsName;
  const lines = [
    "// Generated by defold-hermes. Do not edit.",
    `import type { ${interfaceName} } from "../../extensions.js";`,
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

export function generateExtensionTypes(inventory) {
  const modules = buildProjectBindingIr(inventory).modules;
  const lines = [
    "// Generated by defold-hermes. Do not edit.",
    "export type DefoldHash = number & { readonly __defoldHash: unique symbol };",
    "export interface DefoldUrl { readonly socket: number; readonly path: number; readonly fragment: number; }",
    ""
  ];
  for (const module of modules) {
    lines.push(...description(module.description));
    lines.push(`export interface ${identifier(module.runtimeName)}Extension {`);
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
  for (const module of modules) lines.push(`  readonly ${property(module.jsName)}: ${identifier(module.runtimeName)}Extension;`);
  lines.push("}", "");
  return `${lines.join("\n")}\n`;
}

export async function writeGeneratedProject(inventory, outputDirectory = ".defold-hermes") {
  const root = path.resolve(inventory.projectRoot, outputDirectory);
  await mkdir(root, { recursive: true });
  const portableInventory = { ...inventory, projectRoot: "." };
  await writeFile(path.join(root, "extensions.json"), `${JSON.stringify(portableInventory, null, 2)}\n`);
  const bindingIr = buildProjectBindingIr(inventory);
  await writeFile(path.join(root, "bindings.ir.json"), `${JSON.stringify(bindingIr, null, 2)}\n`);
  await writeFile(path.join(root, "extensions.d.ts"), generateExtensionTypes(inventory));
  const modules = bindingIr.modules;
  const sdkRoot = path.join(root, "sdk");
  const modulesRoot = path.join(sdkRoot, "modules");
  await mkdir(modulesRoot, { recursive: true });
  await writeFile(path.join(sdkRoot, "runtime.ts"), runtimeSource());
  const exports = [
    "// Generated by defold-hermes. Do not edit.",
    'export * from "./runtime.js";'
  ];
  for (const module of modules) {
    const moduleFile = fileName(module.runtimeName);
    await writeFile(path.join(modulesRoot, `${moduleFile}.ts`), generatedModuleSource(module));
    exports.push(`export { ${module.jsName} } from "./modules/${moduleFile}.js";`);
  }
  exports.push("");
  await writeFile(path.join(sdkRoot, "index.ts"), `${exports.join("\n")}\n`);

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
    moduleCount: modules.length,
    created: {
      tsconfig: createdTsconfig,
      vscodeExtensions: createdVscodeExtensions,
      vscodeSettings: createdVscodeSettings
    }
  };
}
