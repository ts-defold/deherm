import { createHash } from "node:crypto";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";

import { unzipSync } from "fflate";
import { parse as parseYaml } from "yaml";
import { parseNativeModuleDescriptorJson } from "../../compiler/src/native-module-provider-generator.mjs";

const ignoredDirectories = new Set([".git", ".internal", "build", "node_modules"]);
const projectDiscoveryIgnoredDirectories = new Set([
  ...ignoredDirectories,
  ".agents",
  ".deherm",
  "dist",
  "upstream"
]);
const textDecoder = new TextDecoder();
export const NATIVE_EXTENSION_BINDING_SCHEMA = "defold-hermes.bindings.json";
export const PUBLIC_EXTENSION_ZIP_LIMITS = Object.freeze({
  archiveBytes: 64 * 1024 * 1024,
  entries: 10_000,
  selectedEntryBytes: 8 * 1024 * 1024,
  selectedTotalBytes: 32 * 1024 * 1024
});

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function portable(value) {
  return value.split(path.sep).join("/");
}

async function exists(value) {
  try {
    await readFile(value);
    return true;
  } catch {
    return false;
  }
}

async function nearestProjectRoot(start) {
  let current = path.resolve(start);
  if (path.basename(current) === "game.project") current = path.dirname(current);
  while (true) {
    if (await exists(path.join(current, "game.project"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export async function discoverProjectRoots(start = process.cwd(), options = {}) {
  const root = path.resolve(start);
  const maximumDepth = options.maximumDepth ?? 6;
  const matches = [];
  async function visit(directory, depth) {
    if (await exists(path.join(directory, "game.project"))) {
      matches.push(directory);
      return;
    }
    if (depth >= maximumDepth) return;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || projectDiscoveryIgnoredDirectories.has(entry.name)) continue;
      await visit(path.join(directory, entry.name), depth + 1);
    }
  }
  await visit(root, 0);
  return matches;
}

export async function findProjectRoot(start = process.cwd(), explicit, options = {}) {
  if (explicit) {
    const selected = await nearestProjectRoot(explicit);
    if (selected) return selected;
    throw new Error(`No game.project exists at or above explicit --project path ${path.resolve(explicit)}`);
  }
  const nearest = await nearestProjectRoot(start);
  if (nearest) return nearest;
  const matches = await discoverProjectRoots(start, options);
  if (matches.length === 1) return matches[0];
  if (matches.length > 1 && options.select) {
    const selected = await options.select(matches);
    if (matches.includes(selected)) return selected;
    throw new Error("Project selector returned a path outside the discovered project set");
  }
  if (matches.length > 1) {
    const choices = matches.map((match) => `  --project ${path.relative(path.resolve(start), match) || "."}`).join("\n");
    throw new Error(`Multiple Defold projects found below ${path.resolve(start)}. Select one explicitly:\n${choices}`);
  }
  throw new Error(`No game.project found from ${path.resolve(start)}. Run 'deherm create <directory>' or pass --project <path>.`);
}

export function parseGameProject(source) {
  const result = Object.create(null);
  let section = "";
  for (const original of source.split(/\r?\n/)) {
    const line = original.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const heading = /^\[([^\]]+)\]$/.exec(line);
    if (heading) {
      section = heading[1];
      result[section] ??= Object.create(null);
      continue;
    }
    const separator = line.indexOf("=");
    if (separator < 0) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    result[section] ??= Object.create(null);
    result[section][key] = value;
  }
  return result;
}

function commaValues(value) {
  return String(value ?? "").split(",").map((item) => item.trim()).filter(Boolean);
}

function appendDehermRuntimeDiagnostics(properties, diagnostics) {
  const missing = [];
  if (!commaValues(properties.project?.custom_resources).includes("/deherm")) missing.push("[project] custom_resources must include /deherm");
  if (properties.script?.shared_state !== "1") missing.push("[script] shared_state must be 1");
  if (!commaValues(properties.library?.include_dirs).includes("defold_hermes")) missing.push("[library] include_dirs must include defold_hermes");
  if (properties.defold_hermes?.app !== "/deherm/app.dehermc") missing.push("[defold_hermes] app must be /deherm/app.dehermc");
  for (const message of missing) diagnostics.push({ severity: "error", path: "game.project", message });
}

function dependencyUrls(properties) {
  const project = properties.project ?? {};
  return Object.entries(project)
    .filter(([key]) => key === "dependencies" || /^dependencies#\d+$/.test(key))
    .sort(([left], [right]) => left.localeCompare(right, undefined, { numeric: true }))
    .flatMap(([, value]) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean)
    .map(sanitizeDependencyUrl);
}

function sanitizeDependencyUrl(value) {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return value
      .replace(/:\/\/[^/@]+@/, "://")
      .replace(/[?#].*$/, "");
  }
}

async function walk(root, accept, includeIgnored = false, diagnostics = []) {
  const matches = [];
  const visited = new Set();
  async function visit(current) {
    const canonical = await realpath(current);
    if (visited.has(canonical)) return;
    visited.add(canonical);
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      let isDirectory = entry.isDirectory();
      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        try {
          const target = await stat(absolute);
          isDirectory = target.isDirectory();
          isFile = target.isFile();
        } catch (error) {
          diagnostics.push({ severity: "warning", path: portable(path.relative(root, absolute)), message: `Skipped unreadable symlink: ${error.message}` });
          continue;
        }
      }
      if (isDirectory) {
        if (includeIgnored || !ignoredDirectories.has(entry.name)) await visit(absolute);
      } else if (isFile && accept(absolute)) {
        matches.push(absolute);
      }
    }
  }
  await visit(root);
  return matches;
}

function apiDeclarations(source, sourcePath, diagnostics) {
  let parsed;
  try {
    parsed = parseYaml(source);
  } catch (error) {
    diagnostics.push({ severity: "error", path: sourcePath, message: error.message });
    return [];
  }
  if (!Array.isArray(parsed)) {
    diagnostics.push({ severity: "error", path: sourcePath, message: "Expected a top-level YAML array" });
    return [];
  }
  return parsed.filter((entry) => entry && typeof entry === "object");
}

function parseManifest(source, sourcePath, diagnostics) {
  try {
    const parsed = parseYaml(source) ?? {};
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Expected a YAML object");
    }
    return parsed;
  } catch (error) {
    diagnostics.push({ severity: "error", path: sourcePath, message: error.message });
    return {};
  }
}

function normalizeLibraryName(value) {
  return String(value)
    .trim()
    .replace(/\.lib$/i, "")
    .replace(/^lib(?=(?:box2d|Bullet|LinearMath))/i, "");
}

function stringSet(value) {
  return new Set((Array.isArray(value) ? value : []).map(normalizeLibraryName));
}

function includesAny(values, names) {
  return names.some((name) => values.has(name));
}

function assertEngineProfileSelection(selection) {
  if (!selection || typeof selection !== "object" || Array.isArray(selection) || selection.schemaVersion !== 1 ||
      typeof selection.defaultProfileId !== "string" || !selection.defaultProfileId ||
      !selection.axes || typeof selection.axes !== "object" || Array.isArray(selection.axes) ||
      !selection.profiles || typeof selection.profiles !== "object" || Array.isArray(selection.profiles)) {
    throw new Error("Defold policy has no valid engine-profile selection contract");
  }
  const box2d = selection.axes.box2d;
  const bullet3d = selection.axes.bullet3d;
  const nullPhysics = selection.axes.nullPhysics;
  if (!box2d || !bullet3d || !nullPhysics ||
      !Array.isArray(box2d.legacyLibraries) || !Array.isArray(box2d.v3Libraries) ||
      typeof box2d.legacyScriptLibrary !== "string" || typeof box2d.v3ScriptLibrary !== "string" ||
      typeof box2d.extensionSymbol !== "string" || !Array.isArray(bullet3d.libraries) ||
      !Array.isArray(bullet3d.disableWhenExcluded) || typeof bullet3d.extensionSymbol !== "string" ||
      !Array.isArray(nullPhysics.libraries) || !selection.profiles[selection.defaultProfileId]) {
    throw new Error("Defold policy has an incomplete engine-profile selection contract");
  }
  const validBox2d = new Set(["legacy", "v3", "disabled"]);
  const validBullet = new Set(["enabled", "disabled"]);
  for (const [profileId, profile] of Object.entries(selection.profiles)) {
    if (!profile || !validBox2d.has(profile.box2d) || !validBullet.has(profile.bullet3d)) {
      throw new Error(`Defold policy engine profile '${profileId}' has invalid classifier states`);
    }
  }
  return selection;
}

function profileForStates(selection, box2d, bullet3d) {
  const matches = Object.entries(selection.profiles)
    .filter(([, profile]) => profile.box2d === box2d && profile.bullet3d === bullet3d)
    .map(([profileId]) => profileId);
  if (matches.length !== 1) {
    throw new Error(`Defold policy engine-profile classifier has ${matches.length} matches for box2d=${box2d}, bullet3d=${bullet3d}`);
  }
  return matches[0];
}

function inferPlatformEngineProfile(platform, context = {}, selection) {
  assertEngineProfileSelection(selection);
  const libs = stringSet(context.libs);
  const excludes = stringSet(context.excludeLibs);
  const excludedSymbols = new Set(Array.isArray(context.excludeSymbols) ? context.excludeSymbols.map(String) : []);
  const { box2d, bullet3d, nullPhysics } = selection.axes;
  const includeV2 = includesAny(libs, box2d.legacyLibraries);
  const includeV3 = includesAny(libs, box2d.v3Libraries);
  const includeBullet = includesAny(libs, bullet3d.libraries);
  const nullPhysicsSelected = includesAny(libs, nullPhysics.libraries);

  if (includeV2 && includeV3) {
    throw new Error(`${platform}: app manifest includes both legacy Box2D and Box2D v3 libraries`);
  }
  if (nullPhysicsSelected && (includeV2 || includeV3 || includeBullet)) {
    throw new Error(`${platform}: app manifest includes null physics together with concrete physics libraries`);
  }

  const excludesV2Script = excludes.has(box2d.legacyScriptLibrary);
  const excludesV3Script = excludes.has(box2d.v3ScriptLibrary);
  const excludesBothBox2dScripts = excludesV2Script && excludesV3Script;
  const box2dDisabled = nullPhysicsSelected || excludesBothBox2dScripts || excludedSymbols.has(box2d.extensionSymbol);
  const bulletLibrariesDisabled = bullet3d.disableWhenExcluded.every((name) => excludes.has(name));
  const bulletDisabled = nullPhysicsSelected || bulletLibrariesDisabled || excludedSymbols.has(bullet3d.extensionSymbol);

  if (excludesBothBox2dScripts && (includeV2 || includeV3)) {
    throw new Error(`${platform}: app manifest both disables and includes Box2D`);
  }
  if (bulletLibrariesDisabled && includeBullet) {
    throw new Error(`${platform}: app manifest both disables and includes Bullet physics`);
  }
  if (includeV3 && !excludesV2Script) {
    throw new Error(`${platform}: Box2D v3 is linked without excluding the legacy script library`);
  }
  if (includeV2 && excludesV2Script && !box2dDisabled) {
    throw new Error(`${platform}: legacy Box2D is linked while its script library is excluded`);
  }
  if (includeV3 && excludesV3Script && !box2dDisabled) {
    throw new Error(`${platform}: Box2D v3 is linked while its script library is excluded`);
  }
  if (excludesV2Script && !includeV3 && !box2dDisabled) {
    throw new Error(`${platform}: legacy Box2D script library is excluded without selecting Box2D v3`);
  }

  const box2dState = box2dDisabled ? "disabled" : includeV3 ? "v3" : "legacy";
  const bulletState = bulletDisabled ? "disabled" : "enabled";
  return profileForStates(selection, box2dState, bulletState);
}

function projectRelativeResourcePath(projectRoot, configuredPath) {
  const portablePath = configuredPath.replaceAll("\\", "/").replace(/^\/+/, "");
  const absolute = path.resolve(projectRoot, portablePath);
  const relative = path.relative(projectRoot, absolute);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`native_extension.app_manifest must resolve to a file inside the Defold project: ${configuredPath}`);
  }
  return { absolute, relative: portable(relative) };
}

export async function resolveEngineProfiles(projectRoot, properties, profileSelection = null) {
  const selection = profileSelection ? assertEngineProfileSelection(profileSelection) : null;
  const configuredPath = properties.native_extension?.app_manifest?.trim();
  if (!configuredPath) {
    return {
      source: selection ? "defold-default" : "policy-required",
      manifest: null,
      manifestSha256: null,
      defaultProfileId: selection?.defaultProfileId ?? null,
      platforms: {}
    };
  }
  const resolved = projectRelativeResourcePath(projectRoot, configuredPath);
  const source = await readFile(resolved.absolute, "utf8");
  let parsed;
  try {
    parsed = parseYaml(source) ?? {};
  } catch (error) {
    throw new Error(`${resolved.relative}: invalid app manifest YAML: ${error.message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${resolved.relative}: expected the app manifest to contain a YAML object`);
  }
  const platformEntries = Object.entries(parsed.platforms ?? {});
  if (!platformEntries.length) {
    throw new Error(`${resolved.relative}: app manifest contains no platform contexts`);
  }
  const platforms = {};
  for (const [platform, value] of platformEntries.sort(([left], [right]) => left.localeCompare(right))) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`${resolved.relative}: ${platform} must contain a platform object`);
    }
    const context = value.context ?? {};
    if (!context || typeof context !== "object" || Array.isArray(context)) {
      throw new Error(`${resolved.relative}: ${platform}.context must be an object`);
    }
    platforms[platform] = selection ? inferPlatformEngineProfile(platform, context, selection) : null;
  }
  if (!selection) {
    return {
      source: "policy-required",
      manifest: resolved.relative,
      manifestSha256: sha256(source),
      defaultProfileId: null,
      platforms
    };
  }
  const selectedProfiles = new Set(Object.values(platforms));
  return {
    source: "app-manifest",
    manifest: resolved.relative,
    manifestSha256: sha256(source),
    defaultProfileId: selectedProfiles.size === 1 ? [...selectedProfiles][0] : selection.defaultProfileId,
    platforms
  };
}

export function assertSafeArchiveEntryName(value) {
  if (typeof value !== "string" || !value || value.includes("\\") || value.includes("\0")) {
    throw new Error(`Unsafe dependency archive entry: ${value}`);
  }
  const normalized = path.posix.normalize(value);
  if (value.startsWith("/") || normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`Unsafe dependency archive entry: ${value}`);
  }
  return normalized;
}

export function publicIncludeSuffix(relative) {
  const segments = String(relative).split("/");
  const index = segments.indexOf("include");
  return index >= 0 && index < segments.length - 1 ? segments.slice(index + 1).join("/") : null;
}

export function publicIncludeRoot(relative) {
  const segments = String(relative).split("/");
  const index = segments.indexOf("include");
  return index >= 0 ? segments.slice(0, index + 1).join("/") : null;
}

function isPublicHeader(relative) {
  const suffix = publicIncludeSuffix(relative);
  return suffix !== null && /\.(?:h|hh|hpp|hxx)$/i.test(suffix);
}

function isPublicIncludeFile(relative) {
  return publicIncludeSuffix(relative) !== null;
}

function fileSetSha256(files) {
  const hash = createHash("sha256");
  for (const { path: file, bytes } of files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)) {
    hash.update(`f\0${file}\0${bytes.byteLength}\0`);
    hash.update(bytes);
  }
  return hash.digest("hex");
}

function isNativeSource(relative) {
  return /(^|\/)(?:src|commonsrc)\/.*\.(?:c|cc|cpp|cxx|m|mm)$/i.test(relative);
}

function bindingStatus(scriptApis, publicHeaders, bindingSchema) {
  if (scriptApis.length && publicHeaders.length && bindingSchema?.document) return "script-api+native-schema";
  if (publicHeaders.length && bindingSchema?.document) return "native-schema";
  if (scriptApis.length && publicHeaders.length) return "script-api+native-schema-required";
  if (scriptApis.length) return "script-api";
  if (publicHeaders.length) return "native-schema-required";
  return "no-public-api-metadata";
}

export function normalizeNativeExtensionBindingSchema(document) {
  if (!document || Array.isArray(document) || typeof document !== "object") {
    throw new Error("the root must be a JSON object");
  }
  const unknownRootKeys = Object.keys(document).filter((key) => !["schemaVersion", "headers", "nativeModules", "typescriptFacades"].includes(key));
  if (unknownRootKeys.length) throw new Error(`unknown root field(s): ${unknownRootKeys.sort().join(", ")}`);
  if (document.schemaVersion !== 1) throw new Error("schemaVersion must be 1");
  if (!Array.isArray(document.headers)) throw new Error("headers must be an array");
  const seenHeaders = new Set();
  const headers = document.headers.map((entry, index) => {
    if (!entry || Array.isArray(entry) || typeof entry !== "object") {
      throw new Error(`headers[${index}] must be an object`);
    }
    const unknownHeaderKeys = Object.keys(entry).filter((key) => !["path", "language", "symbolPrefix", "symbols"].includes(key));
    if (unknownHeaderKeys.length) throw new Error(`headers[${index}] has unknown field(s): ${unknownHeaderKeys.sort().join(", ")}`);
    if (typeof entry.path !== "string" || !entry.path) {
      throw new Error(`headers[${index}].path must be a non-empty include-relative path`);
    }
    const header = assertSafeArchiveEntryName(entry.path);
    if (header !== entry.path || header.includes(":")) {
      throw new Error(`headers[${index}].path must be a canonical include-relative path`);
    }
    if (!/\.(?:h|hh|hpp|hxx)$/iu.test(header)) {
      throw new Error(`headers[${index}].path must name a C or C++ header`);
    }
    if (seenHeaders.has(header)) throw new Error(`duplicate header entry: ${header}`);
    seenHeaders.add(header);
    const language = entry.language ?? (/\.(?:hh|hpp|hxx)$/iu.test(header) ? "c++" : "c");
    if (language !== "c" && language !== "c++") {
      throw new Error(`headers[${index}].language must be c or c++`);
    }
    const symbolPrefix = entry.symbolPrefix === undefined ? null : entry.symbolPrefix;
    if (symbolPrefix !== null && (typeof symbolPrefix !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(symbolPrefix))) {
      throw new Error(`headers[${index}].symbolPrefix must be null or a C identifier prefix`);
    }
    const symbols = entry.symbols === undefined ? null : entry.symbols;
    if (symbols !== null && (!Array.isArray(symbols) || symbols.some((symbol) =>
      typeof symbol !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*(?:::[A-Za-z_][A-Za-z0-9_]*)*$/u.test(symbol)))) {
      throw new Error(`headers[${index}].symbols must be an array of C/C++ identifiers`);
    }
    if (symbols !== null && new Set(symbols).size !== symbols.length) {
      throw new Error(`headers[${index}].symbols must not contain duplicates`);
    }
    return {
      path: header,
      language,
      symbolPrefix,
      ...(symbols === null ? {} : { symbols: [...symbols].sort() })
    };
  }).sort((left, right) => left.path.localeCompare(right.path));
  const nativeModules = document.nativeModules === undefined ? [] : document.nativeModules;
  if (!Array.isArray(nativeModules)) throw new Error("nativeModules must be an array");
  const moduleNames = new Set();
  const normalizedModules = nativeModules.map((module, moduleIndex) => {
    if (!module || Array.isArray(module) || typeof module !== "object") {
      throw new Error(`nativeModules[${moduleIndex}] must be an object`);
    }
    const allowedModule = ["name", "abiVersion", "description", "constants", "cProvider", "methods"];
    const unknown = Object.keys(module).filter((key) => !allowedModule.includes(key));
    if (unknown.length) throw new Error(`nativeModules[${moduleIndex}] has unknown field(s): ${unknown.sort().join(", ")}`);
    if (typeof module.name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(module.name) || moduleNames.has(module.name)) {
      throw new Error(`nativeModules[${moduleIndex}].name must be a unique identifier`);
    }
    moduleNames.add(module.name);
    if (!Number.isInteger(module.abiVersion) || module.abiVersion < 1) {
      throw new Error(`nativeModules[${moduleIndex}].abiVersion must be a positive integer`);
    }
    if (!Array.isArray(module.methods) || !module.methods.length || module.methods.length > 32) {
      throw new Error(`nativeModules[${moduleIndex}].methods must contain 1..32 methods`);
    }
    const ids = new Set(), names = new Set();
    const methods = module.methods.map((method, methodIndex) => {
      if (!method || Array.isArray(method) || typeof method !== "object") {
        throw new Error(`nativeModules[${moduleIndex}].methods[${methodIndex}] must be an object`);
      }
      const unknownMethod = Object.keys(method).filter((key) => !["id", "name", "args", "returns"].includes(key));
      if (unknownMethod.length) throw new Error(`nativeModules[${moduleIndex}].methods[${methodIndex}] has unknown field(s): ${unknownMethod.sort().join(", ")}`);
      if (!Number.isInteger(method.id) || method.id < 1 || ids.has(method.id)) throw new Error(`native module method id must be unique and positive`);
      if (typeof method.name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(method.name) || names.has(method.name)) throw new Error(`native module method name must be unique and valid`);
      ids.add(method.id); names.add(method.name);
      if (!Array.isArray(method.args) || method.args.length > 8) throw new Error(`native module method args must contain at most 8 arguments`);
      const args = method.args.map((argument) => {
        if (!argument || typeof argument !== "object" || Array.isArray(argument) ||
            typeof argument.name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(argument.name) ||
            !["u32", "utf8", "bytes", "mutableBytes", "bool"].includes(argument.type)) {
          throw new Error(`native module arguments require a valid name and supported type`);
        }
        const unknownArgument = Object.keys(argument).filter((key) => !["name", "type", "copyBack"].includes(key));
        if (unknownArgument.length) throw new Error(`native module argument has unknown field(s): ${unknownArgument.sort().join(", ")}`);
        if (argument.copyBack === undefined) return { name: argument.name, type: argument.type };
        const copyBack = argument.copyBack;
        if (argument.type !== "mutableBytes" || !copyBack || typeof copyBack !== "object" || Array.isArray(copyBack) ||
            Object.keys(copyBack).some((key) => !["mode", "okStatus", "headerBytes", "payloadLengthOffset"].includes(key)) ||
            copyBack.mode !== "framedPayload" || !Number.isInteger(copyBack.okStatus) ||
            !Number.isInteger(copyBack.headerBytes) || copyBack.headerBytes < 1 ||
            !Number.isInteger(copyBack.payloadLengthOffset) || copyBack.payloadLengthOffset < 0 ||
            copyBack.payloadLengthOffset + 4 > copyBack.headerBytes) {
          throw new Error(`native mutableBytes copyBack requires a valid framedPayload recipe`);
        }
        return { name: argument.name, type: argument.type, copyBack: { ...copyBack } };
      });
      if (!["u32", "status"].includes(method.returns)) throw new Error(`native module result must be u32 or status`);
      return { id: method.id, name: method.name, args, returns: method.returns };
    });
    let cProvider;
    if (module.cProvider !== undefined) {
      if (!module.cProvider || Array.isArray(module.cProvider) || typeof module.cProvider !== "object") {
        throw new Error(`nativeModules[${moduleIndex}].cProvider must be an object`);
      }
      const unknownProvider = Object.keys(module.cProvider).filter((key) => !["header", "symbolPrefix", "argumentExpansion"].includes(key));
      if (unknownProvider.length) throw new Error(`nativeModules[${moduleIndex}].cProvider has unknown field(s): ${unknownProvider.sort().join(", ")}`);
      if (typeof module.cProvider.header !== "string" || !module.cProvider.header) {
        throw new Error(`nativeModules[${moduleIndex}].cProvider.header must be a canonical include-relative C header`);
      }
      const header = assertSafeArchiveEntryName(module.cProvider.header);
      if (header !== module.cProvider.header || header.includes(":") || !/\.h$/u.test(header)) {
        throw new Error(`nativeModules[${moduleIndex}].cProvider.header must be a canonical include-relative C header`);
      }
      if (typeof module.cProvider.symbolPrefix !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*_$/u.test(module.cProvider.symbolPrefix)) {
        throw new Error(`nativeModules[${moduleIndex}].cProvider.symbolPrefix must be a C identifier prefix ending in underscore`);
      }
      if (module.cProvider.argumentExpansion !== "pointer-length-v1") {
        throw new Error(`nativeModules[${moduleIndex}].cProvider.argumentExpansion must be pointer-length-v1`);
      }
      cProvider = { header, symbolPrefix: module.cProvider.symbolPrefix, argumentExpansion: module.cProvider.argumentExpansion };
    }
    return {
      name: module.name,
      abiVersion: module.abiVersion,
      ...(typeof module.description === "string" ? { description: module.description } : {}),
      ...(module.constants && typeof module.constants === "object" && !Array.isArray(module.constants) ? { constants: module.constants } : {}),
      ...(cProvider ? { cProvider } : {}),
      methods
    };
  });
  if (headers.length === 0 && normalizedModules.length === 0) {
    throw new Error("the schema must select at least one header or declare one native module");
  }
  const typescriptFacades = document.typescriptFacades === undefined ? [] : document.typescriptFacades;
  if (!Array.isArray(typescriptFacades)) throw new Error("typescriptFacades must be an array");
  const facadeNames = new Set();
  const normalizedFacades = typescriptFacades.map((facade, facadeIndex) => {
    if (!facade || Array.isArray(facade) || typeof facade !== "object") {
      throw new Error(`typescriptFacades[${facadeIndex}] must be an object`);
    }
    const unknown = Object.keys(facade).filter((key) => !["name", "source", "staticSource", "nativeModule"].includes(key));
    if (unknown.length) throw new Error(`typescriptFacades[${facadeIndex}] has unknown field(s): ${unknown.sort().join(", ")}`);
    if (typeof facade.name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(facade.name) || facadeNames.has(facade.name)) {
      throw new Error(`typescriptFacades[${facadeIndex}].name must be a unique identifier`);
    }
    facadeNames.add(facade.name);
    if (typeof facade.source !== "string" || !facade.source) {
      throw new Error(`typescriptFacades[${facadeIndex}].source must be a non-empty canonical relative TypeScript path`);
    }
    const source = assertSafeArchiveEntryName(facade.source);
    if (source !== facade.source || source.includes(":") || !source.endsWith(".ts")) {
      throw new Error(`typescriptFacades[${facadeIndex}].source must be a canonical relative .ts path`);
    }
    let staticSource;
    if (facade.staticSource !== undefined) {
      if (typeof facade.staticSource !== "string" || !facade.staticSource) {
        throw new Error(`typescriptFacades[${facadeIndex}].staticSource must be a canonical relative .ts path`);
      }
      staticSource = assertSafeArchiveEntryName(facade.staticSource);
      if (staticSource !== facade.staticSource || staticSource.includes(":") || !staticSource.endsWith(".ts") || staticSource === source) {
        throw new Error(`typescriptFacades[${facadeIndex}].staticSource must be a distinct canonical relative .ts path`);
      }
    }
    if (typeof facade.nativeModule !== "string" || !moduleNames.has(facade.nativeModule)) {
      throw new Error(`typescriptFacades[${facadeIndex}].nativeModule must reference a declared native module`);
    }
    return { name: facade.name, source, ...(staticSource ? { staticSource } : {}), nativeModule: facade.nativeModule };
  }).sort((left, right) => left.name.localeCompare(right.name));
  return {
    schemaVersion: 1,
    headers,
    ...(normalizedModules.length ? { nativeModules: normalizedModules } : {}),
    ...(normalizedFacades.length ? { typescriptFacades: normalizedFacades } : {})
  };
}

function parseBindingSchema(bytes, displayPath, diagnostics) {
  if (bytes.byteLength > PUBLIC_EXTENSION_ZIP_LIMITS.selectedEntryBytes) {
    diagnostics.push({
      severity: "error",
      path: displayPath,
      message: `Native binding schema exceeds ${PUBLIC_EXTENSION_ZIP_LIMITS.selectedEntryBytes} bytes`
    });
    return { path: displayPath, sha256: sha256(bytes), document: null };
  }
  try {
    const document = normalizeNativeExtensionBindingSchema(
      parseNativeModuleDescriptorJson(textDecoder.decode(bytes)));
    return { path: displayPath, sha256: sha256(bytes), document };
  } catch (error) {
    diagnostics.push({ severity: "error", path: displayPath, message: `Invalid native binding schema: ${error.message}` });
    return { path: displayPath, sha256: sha256(bytes), document: null };
  }
}

async function localExtension(projectRoot, manifestPath, diagnostics) {
  const root = path.dirname(manifestPath);
  const relativeRoot = portable(path.relative(projectRoot, root)) || ".";
  const manifestSource = await readFile(manifestPath, "utf8");
  const manifest = parseManifest(manifestSource, `${relativeRoot}/ext.manifest`, diagnostics);
  const files = await walk(root, (file) => file.endsWith(".script_api"), false, diagnostics);
  const nativeFiles = await walk(root, (file) => {
    const relative = portable(path.relative(root, file));
    return isPublicHeader(relative) || isNativeSource(relative);
  }, false, diagnostics);
  const includeFiles = await walk(root, (file) => isPublicIncludeFile(portable(path.relative(root, file))), false, diagnostics);
  const scriptApis = [];
  for (const file of files) {
    const relative = portable(path.relative(projectRoot, file));
    scriptApis.push({
      path: relative,
      declarations: apiDeclarations(await readFile(file, "utf8"), relative, diagnostics)
    });
  }
  const publicHeaders = [];
  const publicHeaderDetails = [];
  const sourceFiles = [];
  for (const file of nativeFiles) {
    const relativeToExtension = portable(path.relative(root, file));
    const relativeToProject = portable(path.relative(projectRoot, file));
    if (isPublicHeader(relativeToExtension)) {
      publicHeaders.push(relativeToProject);
      publicHeaderDetails.push({ path: relativeToProject, sha256: sha256(await readFile(file)) });
    }
    if (isNativeSource(relativeToExtension)) sourceFiles.push(relativeToProject);
  }
  const publicIncludeTreeSha256 = fileSetSha256(await Promise.all(includeFiles.map(async (file) => ({
    path: portable(path.relative(root, file)),
    bytes: await readFile(file)
  }))));
  const publicIncludeRoots = [...new Set(includeFiles.map((file) => publicIncludeRoot(portable(path.relative(root, file)))))].sort();
  const schemaPaths = await walk(root, (file) => path.basename(file) === NATIVE_EXTENSION_BINDING_SCHEMA, false, diagnostics);
  if (schemaPaths.length > 1) {
    diagnostics.push({ severity: "error", path: relativeRoot, message: "Extension declares multiple defold-hermes.bindings.json schemas" });
  }
  const schemaPath = schemaPaths.length === 1 ? schemaPaths[0] : null;
  const bindingSchema = schemaPath
    ? await readFile(schemaPath).then((bytes) => parseBindingSchema(bytes, portable(path.relative(projectRoot, schemaPath)), diagnostics))
    : null;
  const typescriptFacades = [];
  for (const facade of bindingSchema?.document?.typescriptFacades ?? []) {
    const sourceFile = path.join(root, ...facade.source.split("/"));
    const displayPath = portable(path.relative(projectRoot, sourceFile));
    try {
      const status = await stat(sourceFile);
      if (!status.isFile() || status.size > PUBLIC_EXTENSION_ZIP_LIMITS.selectedEntryBytes) {
        throw new Error("must be a regular TypeScript file within the selected-entry size limit");
      }
      const bytes = await readFile(sourceFile);
      let staticDetail = {};
      if (facade.staticSource) {
        const staticFile = path.join(root, ...facade.staticSource.split("/"));
        const staticDisplayPath = portable(path.relative(projectRoot, staticFile));
        const staticStatus = await stat(staticFile);
        if (!staticStatus.isFile() || staticStatus.size > PUBLIC_EXTENSION_ZIP_LIMITS.selectedEntryBytes) {
          throw new Error("static facade must be a regular TypeScript file within the selected-entry size limit");
        }
        staticDetail = { staticPath: staticDisplayPath, staticSha256: sha256(await readFile(staticFile)) };
      }
      typescriptFacades.push({ ...facade, path: displayPath, sha256: sha256(bytes), ...staticDetail });
    } catch (error) {
      diagnostics.push({ severity: "error", path: displayPath, message: `Declared TypeScript facade is unavailable: ${error.message}` });
    }
  }
  return {
    kind: "local",
    name: typeof manifest.name === "string" ? manifest.name : path.basename(root),
    root: relativeRoot,
    manifestPath: `${relativeRoot}/ext.manifest`,
    platforms: Object.keys(manifest.platforms ?? {}).sort(),
    scriptApis,
    publicHeaders,
    publicHeaderDetails,
    publicIncludeTreeSha256,
    publicIncludeRoots,
    sourceFiles,
    bindingSchema,
    typescriptFacades,
    bindingStatus: bindingStatus(scriptApis, publicHeaders, bindingSchema)
  };
}

function zipEntries(bytes) {
  // Discovery only decompresses the extension-defining files, but it keeps the
  // full entry listing so an archive that defines no extension can say what it
  // actually contained instead of yielding nothing.
  const listing = [];
  const seenNames = new Set();
  let entryCount = 0;
  let selectedBytes = 0;
  if (bytes.byteLength > PUBLIC_EXTENSION_ZIP_LIMITS.archiveBytes) {
    throw new Error(`Dependency archive exceeds ${PUBLIC_EXTENSION_ZIP_LIMITS.archiveBytes} bytes`);
  }
  const entries = unzipSync(new Uint8Array(bytes), {
    filter(file) {
      const name = assertSafeArchiveEntryName(file.name);
      if (seenNames.has(name)) throw new Error(`Dependency archive contains duplicate canonical entry: ${name}`);
      seenNames.add(name);
      entryCount += 1;
      if (entryCount > PUBLIC_EXTENSION_ZIP_LIMITS.entries) {
        throw new Error(`Dependency archive exceeds ${PUBLIC_EXTENSION_ZIP_LIMITS.entries} entries`);
      }
      listing.push(name);
      const selected = name.endsWith("/ext.manifest") || name === "ext.manifest" || name.endsWith(".script_api") ||
        path.posix.basename(name) === NATIVE_EXTENSION_BINDING_SCHEMA ||
        isPublicIncludeFile(name) || isNativeSource(name);
      if (!selected) return false;
      if (file.originalSize > PUBLIC_EXTENSION_ZIP_LIMITS.selectedEntryBytes) {
        throw new Error(`Dependency archive entry ${name} exceeds ${PUBLIC_EXTENSION_ZIP_LIMITS.selectedEntryBytes} bytes`);
      }
      selectedBytes += file.originalSize;
      if (selectedBytes > PUBLIC_EXTENSION_ZIP_LIMITS.selectedTotalBytes) {
        throw new Error(`Selected dependency archive entries exceed ${PUBLIC_EXTENSION_ZIP_LIMITS.selectedTotalBytes} bytes`);
      }
      return true;
    }
  });
  const canonicalEntries = Object.create(null);
  for (const [rawName, value] of Object.entries(entries)) {
    const name = assertSafeArchiveEntryName(rawName);
    if (Object.hasOwn(canonicalEntries, name)) throw new Error(`Dependency archive contains duplicate canonical entry: ${name}`);
    canonicalEntries[name] = value;
  }
  const facadeEntryNames = new Set();
  const manifestRoots = listing
    .filter((name) => path.posix.basename(name) === "ext.manifest")
    .map((name) => path.posix.dirname(name) === "." ? "" : path.posix.dirname(name));
  for (const [schemaName, value] of Object.entries(canonicalEntries)) {
    if (path.posix.basename(schemaName) !== NATIVE_EXTENSION_BINDING_SCHEMA) continue;
    try {
      const document = JSON.parse(textDecoder.decode(value));
      const root = manifestRoots
        .filter((candidate) => !candidate || schemaName.startsWith(`${candidate}/`))
        .sort((left, right) => right.length - left.length)[0] ?? "";
      for (const facade of document?.typescriptFacades ?? []) {
        if (typeof facade?.source !== "string") continue;
        for (const candidate of [facade.source, facade.staticSource].filter((value) => typeof value === "string")) {
          const source = assertSafeArchiveEntryName(candidate);
          if (source !== candidate || !source.endsWith(".ts")) continue;
          facadeEntryNames.add(root ? `${root}/${source}` : source);
        }
      }
    } catch { /* schema diagnostics are emitted by parseBindingSchema */ }
  }
  if (facadeEntryNames.size > 0) {
    const facadeEntries = unzipSync(new Uint8Array(bytes), {
      filter(file) {
        const name = assertSafeArchiveEntryName(file.name);
        if (!facadeEntryNames.has(name)) return false;
        if (file.originalSize > PUBLIC_EXTENSION_ZIP_LIMITS.selectedEntryBytes) {
          throw new Error(`Dependency archive entry ${name} exceeds ${PUBLIC_EXTENSION_ZIP_LIMITS.selectedEntryBytes} bytes`);
        }
        selectedBytes += file.originalSize;
        if (selectedBytes > PUBLIC_EXTENSION_ZIP_LIMITS.selectedTotalBytes) {
          throw new Error(`Selected dependency archive entries exceed ${PUBLIC_EXTENSION_ZIP_LIMITS.selectedTotalBytes} bytes`);
        }
        return true;
      }
    });
    for (const [rawName, value] of Object.entries(facadeEntries)) {
      const name = assertSafeArchiveEntryName(rawName);
      canonicalEntries[name] = value;
    }
  }
  return { entries: canonicalEntries, listing };
}

async function dependencyExtensions(projectRoot, diagnostics) {
  const libraryRoot = path.join(projectRoot, ".internal", "lib");
  let archives;
  try {
    archives = (await readdir(libraryRoot, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith(".zip"))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return { extensions: [], archivesWithoutManifest: [] };
  }

  const extensions = [];
  const archivesWithoutManifest = [];
  for (const archive of archives) {
    let entries;
    let listing;
    try {
      ({ entries, listing } = zipEntries(await readFile(path.join(libraryRoot, archive))));
    } catch (error) {
      diagnostics.push({ severity: "error", path: `.internal/lib/${archive}`, message: error.message });
      continue;
    }
    const names = Object.keys(entries).sort();
    const manifestPaths = names.filter((name) => path.posix.basename(name) === "ext.manifest");
    if (!manifestPaths.length) {
      // A resolved dependency that declares no native extension is invisible to
      // the rest of the pipeline. Report it rather than returning silence: most
      // published Defold libraries are pure Lua and land here.
      const files = listing.filter((name) => !name.endsWith("/"));
      const luaModules = files.filter((name) => name.endsWith(".lua")).length;
      archivesWithoutManifest.push({
        archive: `.internal/lib/${archive}`,
        files: files.length,
        luaModules
      });
      diagnostics.push({
        severity: "warning",
        path: `.internal/lib/${archive}`,
        message: `Resolved dependency archive declares no ext.manifest, so no extension was discovered from it (${files.length} files, ${luaModules} Lua modules). Lua-only Defold libraries have no ingestible binding surface today.`
      });
      continue;
    }
    for (const manifestPath of manifestPaths) {
      const root = path.posix.dirname(manifestPath) === "." ? "" : path.posix.dirname(manifestPath);
      const displayManifest = `${archive}:${manifestPath}`;
      const manifest = parseManifest(textDecoder.decode(entries[manifestPath]), displayManifest, diagnostics);
      const scriptApis = names
        .filter((name) => name.endsWith(".script_api") && (!root || name.startsWith(`${root}/`)))
        .map((name) => ({
          path: `${archive}:${name}`,
          declarations: apiDeclarations(textDecoder.decode(entries[name]), `${archive}:${name}`, diagnostics)
        }));
      const withinExtension = (name) => !root || name.startsWith(`${root}/`);
      const relativeToExtension = (name) => root ? name.slice(root.length + 1) : name;
      const publicHeaders = names
        .filter((name) => withinExtension(name) && isPublicHeader(relativeToExtension(name)))
        .map((name) => `${archive}:${name}`);
      const publicHeaderDetails = names
        .filter((name) => withinExtension(name) && isPublicHeader(relativeToExtension(name)))
        .map((name) => ({ path: `${archive}:${name}`, sha256: sha256(entries[name]) }));
      const publicIncludeTreeSha256 = fileSetSha256(names
        .filter((name) => withinExtension(name) && isPublicIncludeFile(relativeToExtension(name)) && !name.endsWith("/"))
        .map((name) => ({ path: relativeToExtension(name), bytes: entries[name] })));
      const publicIncludeRoots = [...new Set(names
        .filter((name) => withinExtension(name) && isPublicIncludeFile(relativeToExtension(name)))
        .map((name) => publicIncludeRoot(relativeToExtension(name))))].sort();
      const sourceFiles = names
        .filter((name) => withinExtension(name) && isNativeSource(relativeToExtension(name)))
        .map((name) => `${archive}:${name}`);
      const schemaCandidates = names.filter((name) =>
        withinExtension(name) && path.posix.basename(name) === NATIVE_EXTENSION_BINDING_SCHEMA);
      if (schemaCandidates.length > 1) {
        diagnostics.push({ severity: "error", path: displayManifest, message: "Extension declares multiple defold-hermes.bindings.json schemas" });
      }
      const schemaEntry = schemaCandidates.length === 1 ? schemaCandidates[0] : null;
      const bindingSchema = entries[schemaEntry]
        ? parseBindingSchema(entries[schemaEntry], `${archive}:${schemaEntry}`, diagnostics)
        : null;
      const typescriptFacades = [];
      for (const facade of bindingSchema?.document?.typescriptFacades ?? []) {
        const sourceEntry = root ? `${root}/${facade.source}` : facade.source;
        const displayPath = `${archive}:${sourceEntry}`;
        if (!entries[sourceEntry]) {
          diagnostics.push({ severity: "error", path: displayPath, message: "Declared TypeScript facade is absent from the dependency archive" });
          continue;
        }
        let staticDetail = {};
        if (facade.staticSource) {
          const staticEntry = root ? `${root}/${facade.staticSource}` : facade.staticSource;
          if (!entries[staticEntry]) {
            diagnostics.push({ severity: "error", path: `${archive}:${staticEntry}`, message: "Declared Static TypeScript facade is absent from the dependency archive" });
            continue;
          }
          staticDetail = { staticPath: `${archive}:${staticEntry}`, staticSha256: sha256(entries[staticEntry]) };
        }
        typescriptFacades.push({ ...facade, path: displayPath, sha256: sha256(entries[sourceEntry]), ...staticDetail });
      }
      extensions.push({
        kind: "dependency",
        name: typeof manifest.name === "string" ? manifest.name : path.posix.basename(root || archive),
        archive: `.internal/lib/${archive}`,
        root,
        manifestPath: displayManifest,
        platforms: Object.keys(manifest.platforms ?? {}).sort(),
        scriptApis,
        publicHeaders,
        publicHeaderDetails,
        publicIncludeTreeSha256,
        publicIncludeRoots,
        sourceFiles,
        bindingSchema,
        typescriptFacades,
        bindingStatus: bindingStatus(scriptApis, publicHeaders, bindingSchema)
      });
    }
  }
  return { extensions, archivesWithoutManifest };
}

export async function inspectDefoldProject(options = {}) {
  const projectRoot = await findProjectRoot(options.cwd, options.project, { select: options.selectProject });
  const properties = parseGameProject(await readFile(path.join(projectRoot, "game.project"), "utf8"));
  const engineProfiles = await resolveEngineProfiles(projectRoot, properties, options.engineProfileSelection);
  const diagnostics = [];
  if (options.requireDehermRuntime === true) appendDehermRuntimeDiagnostics(properties, diagnostics);
  const manifestPaths = await walk(projectRoot, (file) => path.basename(file) === "ext.manifest", false, diagnostics);
  const local = [];
  for (const manifestPath of manifestPaths) {
    // The CLI-managed déherm runtime is a compiler output, not a project API
    // input. Including it makes the first generate/install/generate cycle
    // change its own cache key and lets packaged build artifacts perturb SDK
    // generation. User-authored and dependency extensions remain inventoried.
    if (await exists(path.join(path.dirname(manifestPath), ".deherm-managed.json"))) continue;
    local.push(await localExtension(projectRoot, manifestPath, diagnostics));
  }
  const { extensions: dependencies, archivesWithoutManifest } = await dependencyExtensions(projectRoot, diagnostics);
  const extensions = [...local, ...dependencies]
    .sort((left, right) => left.name.localeCompare(right.name) || left.manifestPath.localeCompare(right.manifestPath));
  const scriptModuleCount = extensions.reduce((count, extension) =>
    count + extension.scriptApis.reduce((sum, api) => sum + api.declarations.length, 0), 0);
  return {
    schemaVersion: 1,
    projectRoot,
    projectFile: "game.project",
    dependencyUrls: dependencyUrls(properties),
    engineProfiles,
    extensions,
    summary: {
      localExtensions: local.length,
      dependencyExtensions: dependencies.length,
      scriptApiFiles: extensions.reduce((count, extension) => count + extension.scriptApis.length, 0),
      scriptModules: scriptModuleCount,
      publicHeaders: extensions.reduce((count, extension) => count + extension.publicHeaders.length, 0),
      extensionsRequiringNativeSchema: extensions.filter(({ publicHeaders }) => publicHeaders.length > 0).length,
      extensionsWithoutApiMetadata: extensions.filter(({ bindingStatus: status }) => status === "no-public-api-metadata").length,
      dependencyArchivesWithoutManifest: archivesWithoutManifest.length
    },
    dependencyArchivesWithoutManifest: archivesWithoutManifest,
    diagnostics
  };
}
