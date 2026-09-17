import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { unzipSync } from "fflate";
import { parse as parseYaml } from "yaml";

const ignoredDirectories = new Set([".git", ".internal", "build", "node_modules"]);
const textDecoder = new TextDecoder();

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

export async function findProjectRoot(start = process.cwd(), explicit) {
  let current = path.resolve(explicit ?? start);
  if (path.basename(current) === "game.project") current = path.dirname(current);
  while (true) {
    if (await exists(path.join(current, "game.project"))) return current;
    const parent = path.dirname(current);
    if (parent === current || explicit) break;
    current = parent;
  }
  throw new Error(`Unable to find game.project from ${path.resolve(explicit ?? start)}`);
}

export function parseGameProject(source) {
  const result = {};
  let section = "";
  for (const original of source.split(/\r?\n/)) {
    const line = original.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const heading = /^\[([^\]]+)\]$/.exec(line);
    if (heading) {
      section = heading[1];
      result[section] ??= {};
      continue;
    }
    const separator = line.indexOf("=");
    if (separator < 0) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    result[section] ??= {};
    result[section][key] = value;
  }
  return result;
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

async function walk(root, accept, includeIgnored = false) {
  const matches = [];
  async function visit(current) {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (includeIgnored || !ignoredDirectories.has(entry.name)) await visit(absolute);
      } else if (entry.isFile() && accept(absolute)) {
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

function isPublicHeader(relative) {
  return /(^|\/)include\/.*\.(?:h|hh|hpp|hxx)$/i.test(relative);
}

function isNativeSource(relative) {
  return /(^|\/)(?:src|commonsrc)\/.*\.(?:c|cc|cpp|cxx|m|mm)$/i.test(relative);
}

function bindingStatus(scriptApis, publicHeaders) {
  if (scriptApis.length && publicHeaders.length) return "script-api+native-schema-required";
  if (scriptApis.length) return "script-api";
  if (publicHeaders.length) return "native-schema-required";
  return "no-public-api-metadata";
}

async function localExtension(projectRoot, manifestPath, diagnostics) {
  const root = path.dirname(manifestPath);
  const relativeRoot = portable(path.relative(projectRoot, root)) || ".";
  const manifestSource = await readFile(manifestPath, "utf8");
  const manifest = parseManifest(manifestSource, `${relativeRoot}/ext.manifest`, diagnostics);
  const files = await walk(root, (file) => file.endsWith(".script_api"));
  const nativeFiles = await walk(root, (file) => {
    const relative = portable(path.relative(root, file));
    return isPublicHeader(relative) || isNativeSource(relative);
  });
  const scriptApis = [];
  for (const file of files) {
    const relative = portable(path.relative(projectRoot, file));
    scriptApis.push({
      path: relative,
      declarations: apiDeclarations(await readFile(file, "utf8"), relative, diagnostics)
    });
  }
  const publicHeaders = [];
  const sourceFiles = [];
  for (const file of nativeFiles) {
    const relativeToExtension = portable(path.relative(root, file));
    const relativeToProject = portable(path.relative(projectRoot, file));
    if (isPublicHeader(relativeToExtension)) publicHeaders.push(relativeToProject);
    if (isNativeSource(relativeToExtension)) sourceFiles.push(relativeToProject);
  }
  return {
    kind: "local",
    name: typeof manifest.name === "string" ? manifest.name : path.basename(root),
    root: relativeRoot,
    manifestPath: `${relativeRoot}/ext.manifest`,
    platforms: Object.keys(manifest.platforms ?? {}).sort(),
    scriptApis,
    publicHeaders,
    sourceFiles,
    bindingStatus: bindingStatus(scriptApis, publicHeaders)
  };
}

function zipEntries(bytes) {
  return unzipSync(new Uint8Array(bytes), {
    filter(file) {
      return file.name.endsWith("/ext.manifest") || file.name === "ext.manifest" || file.name.endsWith(".script_api") ||
        isPublicHeader(file.name) || isNativeSource(file.name);
    }
  });
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
    return [];
  }

  const extensions = [];
  for (const archive of archives) {
    let entries;
    try {
      entries = zipEntries(await readFile(path.join(libraryRoot, archive)));
    } catch (error) {
      diagnostics.push({ severity: "error", path: `.internal/lib/${archive}`, message: error.message });
      continue;
    }
    const names = Object.keys(entries).sort();
    for (const manifestPath of names.filter((name) => path.posix.basename(name) === "ext.manifest")) {
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
      const sourceFiles = names
        .filter((name) => withinExtension(name) && isNativeSource(relativeToExtension(name)))
        .map((name) => `${archive}:${name}`);
      extensions.push({
        kind: "dependency",
        name: typeof manifest.name === "string" ? manifest.name : path.posix.basename(root || archive),
        archive: `.internal/lib/${archive}`,
        root,
        manifestPath: displayManifest,
        platforms: Object.keys(manifest.platforms ?? {}).sort(),
        scriptApis,
        publicHeaders,
        sourceFiles,
        bindingStatus: bindingStatus(scriptApis, publicHeaders)
      });
    }
  }
  return extensions;
}

export async function inspectDefoldProject(options = {}) {
  const projectRoot = await findProjectRoot(options.cwd, options.project);
  const properties = parseGameProject(await readFile(path.join(projectRoot, "game.project"), "utf8"));
  const diagnostics = [];
  const manifestPaths = await walk(projectRoot, (file) => path.basename(file) === "ext.manifest");
  const local = [];
  for (const manifestPath of manifestPaths) {
    local.push(await localExtension(projectRoot, manifestPath, diagnostics));
  }
  const dependencies = await dependencyExtensions(projectRoot, diagnostics);
  const extensions = [...local, ...dependencies]
    .sort((left, right) => left.name.localeCompare(right.name) || left.manifestPath.localeCompare(right.manifestPath));
  const scriptModuleCount = extensions.reduce((count, extension) =>
    count + extension.scriptApis.reduce((sum, api) => sum + api.declarations.length, 0), 0);
  return {
    schemaVersion: 1,
    projectRoot,
    projectFile: "game.project",
    dependencyUrls: dependencyUrls(properties),
    extensions,
    summary: {
      localExtensions: local.length,
      dependencyExtensions: dependencies.length,
      scriptApiFiles: extensions.reduce((count, extension) => count + extension.scriptApis.length, 0),
      scriptModules: scriptModuleCount,
      publicHeaders: extensions.reduce((count, extension) => count + extension.publicHeaders.length, 0),
      extensionsRequiringNativeSchema: extensions.filter(({ publicHeaders }) => publicHeaders.length > 0).length,
      extensionsWithoutApiMetadata: extensions.filter(({ bindingStatus: status }) => status === "no-public-api-metadata").length
    },
    diagnostics
  };
}
