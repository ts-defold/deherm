import { createHash } from "node:crypto";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";

import { unzipSync } from "fflate";
import { parse as parseYaml } from "yaml";

const ignoredDirectories = new Set([".git", ".internal", "build", "node_modules"]);
const projectDiscoveryIgnoredDirectories = new Set([
  ...ignoredDirectories,
  ".agents",
  ".deherm",
  "dist",
  "upstream"
]);
const textDecoder = new TextDecoder();
const defaultEngineProfileId = "default-legacy-bullet";

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

function inferPlatformEngineProfile(platform, context = {}) {
  const libs = stringSet(context.libs);
  const excludes = stringSet(context.excludeLibs);
  const excludedSymbols = new Set(Array.isArray(context.excludeSymbols) ? context.excludeSymbols.map(String) : []);
  const v2Libraries = ["box2d_defold", "script_box2d_defold", "physics_2d_defold"];
  const v3Libraries = ["box2d", "script_box2d", "physics_2d"];
  const bulletLibraries = ["BulletDynamics", "BulletCollision", "LinearMath", "physics_3d"];
  const includeV2 = includesAny(libs, v2Libraries);
  const includeV3 = includesAny(libs, v3Libraries);
  const includeBullet = includesAny(libs, bulletLibraries);
  const nullPhysics = libs.has("physics_null");

  if (includeV2 && includeV3) {
    throw new Error(`${platform}: app manifest includes both legacy Box2D and Box2D v3 libraries`);
  }
  if (nullPhysics && (includeV2 || includeV3 || includeBullet)) {
    throw new Error(`${platform}: app manifest includes physics_null together with concrete physics libraries`);
  }

  const excludesV2Script = excludes.has("script_box2d_defold");
  const excludesV3Script = excludes.has("script_box2d");
  const excludesBothBox2dScripts = excludesV2Script && excludesV3Script;
  const box2dDisabled = nullPhysics || excludesBothBox2dScripts || excludedSymbols.has("ScriptBox2DExt");
  const bulletLibrariesDisabled = excludes.has("BulletDynamics") && excludes.has("BulletCollision");
  const bulletDisabled = nullPhysics || bulletLibrariesDisabled || excludedSymbols.has("ScriptBullet3DExt");

  if (excludesBothBox2dScripts && (includeV2 || includeV3)) {
    throw new Error(`${platform}: app manifest both disables and includes Box2D`);
  }
  if (bulletLibrariesDisabled && includeBullet) {
    throw new Error(`${platform}: app manifest both disables and includes Bullet physics`);
  }
  if (includeV3 && !excludesV2Script) {
    throw new Error(`${platform}: Box2D v3 is linked without excluding the legacy script_box2d_defold library`);
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

  if (box2dDisabled && bulletDisabled) return "no-physics";
  if (box2dDisabled) return "bullet-only";
  const box2d = includeV3 ? "v3" : "legacy";
  if (box2d === "v3") return bulletDisabled ? "v3-no-bullet" : "v3-bullet";
  return bulletDisabled ? "legacy-no-bullet" : defaultEngineProfileId;
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

export async function resolveEngineProfiles(projectRoot, properties) {
  const configuredPath = properties.native_extension?.app_manifest?.trim();
  if (!configuredPath) {
    return {
      source: "defold-default",
      manifest: null,
      manifestSha256: null,
      defaultProfileId: defaultEngineProfileId,
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
    platforms[platform] = inferPlatformEngineProfile(platform, context);
  }
  const selectedProfiles = new Set(Object.values(platforms));
  return {
    source: "app-manifest",
    manifest: resolved.relative,
    manifestSha256: sha256(source),
    defaultProfileId: selectedProfiles.size === 1 ? [...selectedProfiles][0] : defaultEngineProfileId,
    platforms
  };
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
  const files = await walk(root, (file) => file.endsWith(".script_api"), false, diagnostics);
  const nativeFiles = await walk(root, (file) => {
    const relative = portable(path.relative(root, file));
    return isPublicHeader(relative) || isNativeSource(relative);
  }, false, diagnostics);
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
  // Discovery only decompresses the extension-defining files, but it keeps the
  // full entry listing so an archive that defines no extension can say what it
  // actually contained instead of yielding nothing.
  const listing = [];
  const entries = unzipSync(new Uint8Array(bytes), {
    filter(file) {
      listing.push(file.name);
      return file.name.endsWith("/ext.manifest") || file.name === "ext.manifest" || file.name.endsWith(".script_api") ||
        isPublicHeader(file.name) || isNativeSource(file.name);
    }
  });
  return { entries, listing };
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
  return { extensions, archivesWithoutManifest };
}

export async function inspectDefoldProject(options = {}) {
  const projectRoot = await findProjectRoot(options.cwd, options.project, { select: options.selectProject });
  const properties = parseGameProject(await readFile(path.join(projectRoot, "game.project"), "utf8"));
  const engineProfiles = await resolveEngineProfiles(projectRoot, properties);
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
