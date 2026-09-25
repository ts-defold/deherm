import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { unzipSync } from "fflate";

import {
  ingestNativeExtensionHeader,
  renderNativeExtensionBindings
} from "../../compiler/src/native-extension-generator.mjs";
import {
  renderNativeModuleProviderHeader,
  renderNativeModuleTypescript
} from "../../compiler/src/native-module-provider-generator.mjs";
import {
  PUBLIC_EXTENSION_ZIP_LIMITS,
  assertSafeArchiveEntryName,
  publicIncludeRoot,
  publicIncludeSuffix
} from "./project.mjs";

const ignoredIncludeDirectories = new Set([".git", ".internal", "build", "node_modules"]);
// These extensions implement déherm's transport itself. Their include trees are
// compiler/runtime implementation details, not user extension APIs to project
// back into TypeScript. Treat the names as reserved: a project cannot provide a
// second extension with either name without colliding with the runtime anyway.
const infrastructureExtensionNames = new Set([
  "defold_hermes",
  "defold_hermes_typed_native",
  "deherm_project_native_modules"
]);

export function isDehermInfrastructureExtension(extension) {
  return infrastructureExtensionNames.has(extension?.name);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function compare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function moduleName(value) {
  const separated = String(value).replace(/([a-z0-9])([A-Z])/g, "$1_$2");
  const normalized = separated.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "") || "extension";
  return /^[a-z_]/.test(normalized) ? normalized : `_${normalized}`;
}

function fileSlug(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "") || "header";
}

function headerInclude(relative) {
  const normalized = relative.split(path.sep).join("/");
  const include = publicIncludeSuffix(normalized);
  if (!include || /[<>"'\\\r\n]/u.test(include)) throw new Error("Public header path cannot be represented safely in a generated include");
  return include;
}

function safeArchiveEntry(value) {
  return assertSafeArchiveEntryName(value);
}

export function resolveNativeExtensionClang({ inventory, clang = process.env.CLANG ?? "clang", execFile = execFileSync }) {
  const required = inventory.extensions.some((extension) =>
    !isDehermInfrastructureExtension(extension) &&
    (extension.bindingSchema
      ? extension.bindingSchema.document.headers.length > 0
      : Boolean(extension.publicHeaders?.length)));
  if (!required) return { required: false };
  let version;
  try {
    version = execFile(clang, ["--version"], { encoding: "utf8", timeout: 10_000, maxBuffer: 1024 * 1024 });
  } catch (error) {
    throw new Error(`Project native extension generation requires an executable Clang tool (${clang} --version failed)`, { cause: error });
  }
  if (typeof version !== "string" || !version.trim()) {
    throw new Error(`Project native extension generation requires Clang to report a stable version identity (${clang})`);
  }
  return {
    required: true,
    command: clang,
    version: version.split(/\r?\n/u, 1)[0],
    versionSha256: sha256(version)
  };
}

function isExpectedClangParseFailure(error) {
  const stderr = typeof error?.stderr === "string" ? error.stderr : error?.stderr?.toString?.("utf8") ?? "";
  return Number.isInteger(error?.status) && error.status !== 0 && /(?:^|\n).*(?:fatal )?error:/u.test(stderr);
}

function fileSetSha256(files) {
  const hash = createHash("sha256");
  for (const { path: file, bytes } of files.sort((left, right) => compare(left.path, right.path))) {
    hash.update(`f\0${file}\0${bytes.byteLength}\0`);
    hash.update(bytes);
  }
  return hash.digest("hex");
}

async function localIncludeTree(extensionRoot) {
  const files = [];
  const visited = new Set();
  async function assertConfined(candidate) {
    const canonical = await realpath(candidate);
    const relative = path.relative(extensionRoot, canonical);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error("Public include tree resolves outside its extension root");
    }
    return canonical;
  }
  async function visit(directory, prefix = "") {
    const canonical = await assertConfined(directory);
    if (visited.has(canonical)) return;
    visited.add(canonical);
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => compare(left.name, right.name));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      let isDirectory = entry.isDirectory();
      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        await assertConfined(absolute);
        const target = await stat(absolute);
        isDirectory = target.isDirectory();
        isFile = target.isFile();
      }
      if (isDirectory && !ignoredIncludeDirectories.has(entry.name)) await visit(absolute, relative);
      else if (isFile && publicIncludeSuffix(relative) !== null) {
        files.push({ path: relative, bytes: await readFile(absolute) });
      }
    }
  }
  await visit(extensionRoot);
  return fileSetSha256(files);
}

async function directoryDigest(root) {
  const hash = createHash("sha256");
  async function visit(directory, prefix = "") {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => compare(left.name, right.name));
    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        hash.update(`d\0${relative}\0`);
        await visit(absolute, relative);
      }
      else if (entry.isFile()) {
        const bytes = await readFile(absolute);
        hash.update(`f\0${relative}\0${bytes.byteLength}\0`);
        hash.update(bytes);
      } else throw new Error(`Unsupported generated native-extension entry: ${relative}`);
    }
  }
  await visit(root);
  return hash.digest("hex");
}

async function localHeader(inventory, extension, detail) {
  const extensionRoot = await realpath(path.resolve(inventory.projectRoot, extension.root));
  const header = await realpath(path.resolve(inventory.projectRoot, detail.path));
  const relative = path.relative(extensionRoot, header);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Discovered public header resolves outside extension root: ${detail.path}`);
  }
  const bytes = await readFile(header);
  if (sha256(bytes) !== detail.sha256) throw new Error(`Public header changed after project discovery: ${detail.path}`);
  if (await localIncludeTree(extensionRoot) !== extension.publicIncludeTreeSha256) {
    throw new Error(`Public include tree changed after project discovery: ${extension.manifestPath}`);
  }
  const segments = relative.split(path.sep);
  const includeIndex = segments.indexOf("include");
  if (includeIndex < 0 || includeIndex === segments.length - 1) throw new Error(`Discovered public header is not below an exact include path segment: ${detail.path}`);
  const include = [];
  for (const root of extension.publicIncludeRoots ?? []) {
    if (root.split("/").at(-1) !== "include") throw new Error(`Invalid public include root: ${root}`);
    const resolved = await realpath(path.resolve(extensionRoot, ...root.split("/")));
    const relativeRoot = path.relative(extensionRoot, resolved);
    if (relativeRoot === ".." || relativeRoot.startsWith(`..${path.sep}`) || path.isAbsolute(relativeRoot)) {
      throw new Error(`Public include root resolves outside extension: ${root}`);
    }
    include.push(resolved);
  }
  if (!include.length) throw new Error(`Discovered extension has no public include roots: ${extension.manifestPath}`);
  return { header, include, headerInclude: headerInclude(relative), cleanup: async () => {} };
}

function boundedDependencyIncludeEntries(bytes, root) {
  if (bytes.byteLength > PUBLIC_EXTENSION_ZIP_LIMITS.archiveBytes) {
    throw new Error(`Dependency archive exceeds ${PUBLIC_EXTENSION_ZIP_LIMITS.archiveBytes} bytes`);
  }
  let entryCount = 0;
  let selectedBytes = 0;
  const seenNames = new Set();
  const entries = unzipSync(new Uint8Array(bytes), {
    filter(file) {
      const name = safeArchiveEntry(file.name);
      if (seenNames.has(name)) throw new Error(`Dependency archive contains duplicate canonical entry: ${name}`);
      seenNames.add(name);
      entryCount += 1;
      if (entryCount > PUBLIC_EXTENSION_ZIP_LIMITS.entries) {
        throw new Error(`Dependency archive exceeds ${PUBLIC_EXTENSION_ZIP_LIMITS.entries} entries`);
      }
      if (!name.startsWith(root)) return false;
      const relative = name.slice(root.length);
      if (publicIncludeSuffix(relative) === null || name.endsWith("/")) return false;
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
    const name = safeArchiveEntry(rawName);
    if (Object.hasOwn(canonicalEntries, name)) throw new Error(`Dependency archive contains duplicate canonical entry: ${name}`);
    canonicalEntries[name] = value;
  }
  return canonicalEntries;
}

async function dependencyHeader(inventory, extension, detail) {
  const separator = detail.path.indexOf(":");
  if (separator < 1) throw new Error(`Invalid dependency public header path: ${detail.path}`);
  const archiveName = detail.path.slice(0, separator);
  const entryName = safeArchiveEntry(detail.path.slice(separator + 1));
  if (path.posix.basename(extension.archive) !== archiveName) throw new Error(`Dependency header archive mismatch: ${detail.path}`);
  const libraryRoot = await realpath(path.join(inventory.projectRoot, ".internal", "lib"));
  const archive = await realpath(path.resolve(inventory.projectRoot, extension.archive));
  const archiveRelative = path.relative(libraryRoot, archive);
  if (!archiveRelative || archiveRelative === ".." || archiveRelative.startsWith(`..${path.sep}`) || path.isAbsolute(archiveRelative)) {
    throw new Error(`Dependency archive resolves outside .internal/lib: ${extension.archive}`);
  }
  const root = extension.root ? `${safeArchiveEntry(extension.root)}/` : "";
  if (!entryName.startsWith(root)) throw new Error(`Dependency public header is outside its extension root: ${detail.path}`);
  const entries = boundedDependencyIncludeEntries(await readFile(archive), root);
  if (!entries[entryName]) throw new Error(`Dependency archive is missing discovered public header: ${detail.path}`);
  if (sha256(entries[entryName]) !== detail.sha256) throw new Error(`Dependency public header changed after project discovery: ${detail.path}`);
  const includeTreeSha256 = fileSetSha256(Object.entries(entries)
    .map(([name, bytes]) => ({ path: name.slice(root.length), bytes })));
  if (includeTreeSha256 !== extension.publicIncludeTreeSha256) {
    throw new Error(`Dependency public include tree changed after project discovery: ${extension.manifestPath}`);
  }
  const temporary = await mkdtemp(path.join(tmpdir(), "deherm-extension-header-"));
  try {
    for (const [rawName, bytes] of Object.entries(entries).sort(([left], [right]) => compare(left, right))) {
      const name = safeArchiveEntry(rawName);
      if (!name.startsWith(root) || publicIncludeSuffix(name.slice(root.length)) === null || rawName.endsWith("/")) continue;
      const relative = name.slice(root.length);
      const destination = path.join(temporary, ...relative.split("/"));
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, bytes);
    }
    const relativeHeader = entryName.slice(root.length);
    const headerSegments = relativeHeader.split("/");
    if (publicIncludeRoot(relativeHeader) === null) throw new Error(`Dependency public header is not below an exact include path segment: ${detail.path}`);
    const include = (extension.publicIncludeRoots ?? []).map((includeRoot) => {
      const safeRoot = safeArchiveEntry(includeRoot);
      if (safeRoot.split("/").at(-1) !== "include") throw new Error(`Invalid dependency public include root: ${includeRoot}`);
      return path.join(temporary, ...safeRoot.split("/"));
    });
    if (!include.length) throw new Error(`Dependency extension has no public include roots: ${extension.manifestPath}`);
    return {
      header: path.join(temporary, ...headerSegments),
      include,
      headerInclude: headerInclude(relativeHeader),
      cleanup: () => rm(temporary, { recursive: true, force: true })
    };
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

async function resolvedHeader(inventory, extension, detail) {
  return extension.kind === "dependency"
    ? dependencyHeader(inventory, extension, detail)
    : localHeader(inventory, extension, detail);
}

export async function materializeProjectNativeExtensionApis({ inventory, outputRoot, defoldRevision, generationKey, clang }) {
  const ownerRoot = path.join(outputRoot, "generated", "native-extensions");
  const generatedRoot = path.dirname(ownerRoot);
  await mkdir(generatedRoot, { recursive: true });
  const stageRoot = await mkdtemp(path.join(generatedRoot, ".native-extensions-stage-"));
  const keyedRoot = path.join(stageRoot, defoldRevision, generationKey);
  try {
    await mkdir(keyedRoot, { recursive: true });
    const headers = [];
    const nativeModules = [];
    const ignoredHeaders = [];
    const ignoredExtensions = inventory.extensions
      .filter(isDehermInfrastructureExtension)
      .map(({ name, manifestPath, publicHeaders = [] }) => ({
        name,
        manifestPath,
        publicHeaderCount: publicHeaders.length,
        reason: "deherm-runtime-infrastructure"
      }));
    for (const [extensionIndex, extension] of inventory.extensions.entries()) {
      if (isDehermInfrastructureExtension(extension)) continue;
      for (const descriptor of extension.bindingSchema?.document?.nativeModules ?? []) {
        const relative = path.posix.join("native-modules", String(extensionIndex).padStart(3, "0"), descriptor.name);
        const destination = path.join(keyedRoot, ...relative.split("/"));
        await mkdir(destination, { recursive: true });
        await Promise.all([
          writeFile(path.join(destination, "provider.h"), renderNativeModuleProviderHeader(descriptor)),
          writeFile(path.join(destination, `${descriptor.name}.ts`), renderNativeModuleTypescript(descriptor))
        ]);
        nativeModules.push({
          extension: extension.name,
          schema: extension.bindingSchema.path,
          name: descriptor.name,
          abiVersion: descriptor.abiVersion,
          methodCount: descriptor.methods.length,
          output: path.posix.join(defoldRevision, generationKey, relative)
        });
      }
      const details = [...(extension.publicHeaderDetails ?? [])].sort((left, right) => compare(left.path, right.path));
      if (details.length !== (extension.publicHeaders ?? []).length ||
          details.some((detail, index) => detail.path !== [...extension.publicHeaders].sort(compare)[index])) {
        throw new Error(`Public header detail inventory is incomplete for ${extension.manifestPath}`);
      }
      const schemaHeaders = extension.bindingSchema?.document?.headers ?? null;
      const schemaByHeader = schemaHeaders
        ? new Map(schemaHeaders.map((entry) => [entry.path, entry]))
        : null;
      const detailsByInclude = new Map(details.map((detail, headerIndex) => {
        const includePath = publicIncludeSuffix(detail.path);
        if (!includePath) throw new Error(`Discovered public header has no include-relative path: ${detail.path}`);
        if (details.some((candidate) => candidate !== detail && publicIncludeSuffix(candidate.path) === includePath)) {
          throw new Error(`Extension exposes duplicate include-relative header path: ${includePath}`);
        }
        return [includePath, { detail, headerIndex }];
      }));
      if (schemaByHeader) {
        for (const schemaHeader of schemaHeaders) {
          if (detailsByInclude.has(schemaHeader.path)) continue;
          const blocker = { code: "schema-header-not-found", header: schemaHeader.path };
          headers.push({
            extension: extension.name,
            kind: extension.kind,
            input: `${extension.bindingSchema.path}#${schemaHeader.path}`,
            inputSha256: extension.bindingSchema.sha256,
            module: moduleName(extension.name),
            language: schemaHeader.language,
            schema: extension.bindingSchema.path,
            routeCount: 0,
            generatedRouteCount: 0,
            blockedRouteCount: 1,
            blockers: [blocker]
          });
        }
        for (const [includePath, { detail }] of detailsByInclude) {
          if (!schemaByHeader.has(includePath)) {
            ignoredHeaders.push({
              extension: extension.name,
              kind: extension.kind,
              input: detail.path,
              includePath,
              reason: "not-selected-by-binding-schema"
            });
          }
        }
      }
      const selectedDetails = schemaByHeader
        ? [...detailsByInclude].filter(([includePath]) => schemaByHeader.has(includePath)).map(([, value]) => value)
        : details.map((detail, headerIndex) => ({ detail, headerIndex }));
      for (const { detail, headerIndex } of selectedDetails) {
        const module = moduleName(extension.name);
        const leaf = `${String(extensionIndex).padStart(3, "0")}-${String(headerIndex).padStart(3, "0")}-${fileSlug(path.basename(detail.path))}-${detail.sha256.slice(0, 8)}`;
        const destination = path.join(keyedRoot, leaf);
        let resolved;
        try {
          resolved = await resolvedHeader(inventory, extension, detail);
          const schemaHeader = schemaByHeader?.get(resolved.headerInclude) ?? null;
          let ir;
          try {
            ir = ingestNativeExtensionHeader({
              header: resolved.header,
              moduleName: module,
              symbolPrefix: schemaHeader?.symbolPrefix ?? null,
              language: schemaHeader?.language ?? "c",
              symbols: schemaHeader?.symbols ?? null,
              include: resolved.include,
              clang
            });
          } catch (error) {
            if (!isExpectedClangParseFailure(error)) throw error;
            const languageLabel = (schemaHeader?.language ?? "c") === "c++" ? "C++" : "C";
            const blocker = { code: "header-parse-failed", message: `Clang rejected this discovered public ${languageLabel} header` };
            const failedIr = {
              schemaVersion: 1,
              module,
              language: schemaHeader?.language ?? "c",
              header: path.basename(detail.path),
              headerSha256: detail.sha256,
              enums: [],
              records: [],
              routes: [],
              blockers: [blocker]
            };
            await mkdir(destination, { recursive: true });
            await writeFile(path.join(destination, "extension.ir.json"), `${JSON.stringify(failedIr, null, 2)}\n`);
            headers.push({
              extension: extension.name,
              kind: extension.kind,
              input: detail.path,
              inputSha256: detail.sha256,
              module,
              language: failedIr.language,
              ...(extension.bindingSchema ? { schema: extension.bindingSchema.path } : {}),
              output: path.posix.join(defoldRevision, generationKey, leaf),
              routeCount: 0,
              generatedRouteCount: 0,
              blockedRouteCount: 1,
              blockers: [blocker]
            });
            continue;
          }
          const generatedNamespace = `${module}_${sha256(`${extension.manifestPath}\0${detail.path}\0${detail.sha256}`).slice(0, 8)}`;
          const generated = renderNativeExtensionBindings(ir, { headerInclude: resolved.headerInclude, namespace: generatedNamespace });
          await mkdir(destination, { recursive: true });
          await Promise.all([
            writeFile(path.join(destination, "extension.ir.json"), `${JSON.stringify(ir, null, 2)}\n`),
            writeFile(path.join(destination, `${module}.ts`), generated.typescript),
            writeFile(path.join(destination, `${module}_glue.cpp`), generated.source),
            writeFile(path.join(destination, `${module}_glue.verify.cpp`), generated.verificationSource),
            writeFile(path.join(destination, `${module}_glue.verify.driver.cpp`), generated.verificationDriver),
            writeFile(path.join(destination, `${module}_glue.verify.json`), `${JSON.stringify(generated.verification, null, 2)}\n`)
          ]);
          const blockers = [
            ...(ir.blockers ?? []),
            ...ir.routes.flatMap((route) => route.blockers.map((code) => ({ stableId: route.stableId, code })))
          ];
          if (!ir.routes.length && !blockers.length) blockers.push({ code: "no-public-functions" });
          headers.push({
            extension: extension.name,
            kind: extension.kind,
            input: detail.path,
            inputSha256: detail.sha256,
            module,
            language: ir.language ?? "c",
            ...(extension.bindingSchema ? { schema: extension.bindingSchema.path } : {}),
            generatedNamespace,
            output: path.posix.join(defoldRevision, generationKey, leaf),
            routeCount: ir.routes.length,
            generatedRouteCount: generated.generatedRouteCount,
            blockedRouteCount: generated.blockedRouteCount + (ir.blockers?.length ?? 0) + (!ir.routes.length && !(ir.blockers?.length) ? 1 : 0),
            blockers,
            verificationManifestSha256: generated.verification.manifestSha256
          });
        } finally {
          await resolved?.cleanup();
        }
      }
    }
    const report = {
      schemaVersion: 1,
      source: "deherm-project-native-extension-headers",
      defoldRevision,
      projectGenerationKey: generationKey,
      headerCount: headers.length,
      generatedRouteCount: headers.reduce((sum, item) => sum + item.generatedRouteCount, 0),
      blockedRouteCount: headers.reduce((sum, item) => sum + item.blockedRouteCount, 0),
      ignoredExtensionCount: ignoredExtensions.length,
      ignoredExtensions,
      ignoredHeaderCount: ignoredHeaders.length,
      ignoredHeaders,
      nativeModuleCount: nativeModules.length,
      nativeModules,
      headers
    };
    await writeFile(path.join(keyedRoot, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
    const treeSha256 = await directoryDigest(keyedRoot);
    const index = { ...report, keyedOutput: path.posix.join(defoldRevision, generationKey), treeSha256 };
    await writeFile(path.join(stageRoot, "index.json"), `${JSON.stringify(index, null, 2)}\n`);
    await rm(ownerRoot, { recursive: true, force: true });
    await rename(stageRoot, ownerRoot);
    return { root: path.join(ownerRoot, defoldRevision, generationKey), index, treeSha256 };
  } catch (error) {
    await rm(stageRoot, { recursive: true, force: true });
    throw error;
  }
}
