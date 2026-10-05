import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

import { parse as parseYaml } from "yaml";

import {
  analyzeNativeModuleCompatibility,
  assertNativeModuleCatalog,
} from "../../compiler/src/native-module-compatibility.mjs";
import { parseNativeModuleDescriptorJson } from "../../compiler/src/native-module-provider-generator.mjs";
import { normalizeNativeExtensionBindingSchema } from "./project.mjs";

const ignoredDirectories = new Set([".git", ".deherm", "build", "dist", "node_modules"]);
const maximumFiles = 10_000;
const maximumSelectedBytes = 32 * 1024 * 1024;
const maximumFileBytes = 2 * 1024 * 1024;
const sourcePattern = /\.(?:c|cc|cpp|cxx|h|hh|hpp|hxx|m|mm|swift|java|kt|js|jsx|ts|tsx)$/iu;
const buildMetadataPattern =
  /(?:^|\/)(?:CMakeLists\.txt|react-native\.config\.js|nitro\.json)$|\.(?:podspec|gradle|vcxproj)$/iu;

function portable(value) {
  return value.split(path.sep).join("/");
}

function hashFiles(files) {
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(`f\0${file.relative}\0${file.bytes.byteLength}\0`);
    hash.update(file.bytes);
  }
  return hash.digest("hex");
}

async function resolveModuleInput(input, cwd = process.cwd()) {
  const candidate = path.resolve(cwd, input);
  try {
    await stat(candidate);
    return candidate;
  } catch (error) {
    if (path.isAbsolute(input) || input.startsWith(".") || error?.code !== "ENOENT") throw error;
  }
  const require = createRequire(path.join(cwd, "package.json"));
  let entry;
  try {
    entry = require.resolve(input);
  } catch (error) {
    throw new Error(`Module is neither a local path nor an installed package: ${input}`, { cause: error });
  }
  let current = path.dirname(entry);
  while (true) {
    try {
      const document = JSON.parse(await readFile(path.join(current, "package.json"), "utf8"));
      if (document.name === input || input.startsWith(`${document.name}/`)) return current;
    } catch {}
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error(`Resolved ${input}, but could not locate its package root`);
}

async function selectedFiles(input) {
  const root = await resolveModuleInput(input);
  const rootStat = await stat(root);
  const base = rootStat.isDirectory() ? root : path.dirname(root);
  const selected = [];
  let visited = 0;
  let selectedBytes = 0;
  async function visit(current) {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (++visited > maximumFiles) throw new Error(`Module inspection exceeds ${maximumFiles} files`);
      const absolute = path.join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!ignoredDirectories.has(entry.name)) await visit(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      const relative = portable(path.relative(base, absolute));
      const basename = path.basename(relative);
      const relevant =
        basename === "package.json" ||
        basename === "ext.manifest" ||
        basename === "defold-hermes.bindings.json" ||
        relative.endsWith(".script_api") ||
        sourcePattern.test(relative) ||
        buildMetadataPattern.test(relative);
      if (!relevant || (rootStat.isFile() && absolute !== root)) continue;
      const detail = await stat(absolute);
      if (detail.size > maximumFileBytes) continue;
      selectedBytes += detail.size;
      if (selectedBytes > maximumSelectedBytes) {
        throw new Error(`Module inspection exceeds ${maximumSelectedBytes} selected bytes`);
      }
      selected.push({ absolute, relative, bytes: await readFile(absolute) });
    }
  }
  if (rootStat.isDirectory()) await visit(root);
  else {
    const bytes = await readFile(root);
    if (bytes.byteLength > maximumFileBytes) throw new Error(`Module input exceeds ${maximumFileBytes} bytes`);
    selected.push({ absolute: root, relative: path.basename(root), bytes });
  }
  selected.sort((left, right) => left.relative.localeCompare(right.relative));
  return { root, base, files: selected };
}

function dependencyNames(packageDocuments) {
  return [
    ...new Set(
      packageDocuments.flatMap((document) =>
        ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"].flatMap((key) =>
          Object.keys(document[key] ?? {}),
        ),
      ),
    ),
  ].sort();
}

function detectFrameworks(files, dependencies, packageDocuments) {
  const source = files
    .filter(({ relative }) => sourcePattern.test(relative))
    .map(({ bytes }) => bytes.toString("utf8"))
    .join("\n");
  const frontends = [];
  const frameworkDependencies = [];
  const hasTurbo =
    packageDocuments.some((document) => document.codegenConfig) ||
    /\bTurboModuleRegistry\b|\bextends\s+TurboModule\b/u.test(source);
  const hasNitro =
    dependencies.includes("react-native-nitro-modules") ||
    files.some(({ relative }) => relative.endsWith(".nitro.ts")) ||
    /\bHybridObject\b/u.test(source);
  const hasJsi = /(?:[<"]jsi\/jsi\.h[>"])|\bfacebook::jsi\b/u.test(source);
  if (hasTurbo) frontends.push("turbo-module-spec");
  if (hasNitro) frontends.push("nitro-module-spec");
  if (hasJsi) frontends.push("plain-jsi");
  for (const dependency of dependencies) {
    if (
      dependency === "react" ||
      dependency === "react-native" ||
      dependency === "react-native-nitro-modules" ||
      dependency.startsWith("@react-native/")
    ) {
      frameworkDependencies.push(dependency);
    }
  }
  return { frontends, frameworkDependencies };
}

function platformEvidence(files, packageDocuments, frameworkSource) {
  const paths = files.map(({ relative }) => relative);
  const facts = [];
  const add = (fact) => {
    const key = JSON.stringify(fact);
    if (!facts.some((candidate) => JSON.stringify(candidate) === key)) facts.push(fact);
  };
  const has = (pattern) => paths.some((value) => pattern.test(value));
  const dependencies = dependencyNames(packageDocuments);
  for (const document of packageDocuments) {
    if (["modules", "all"].includes(document.codegenConfig?.type)) {
      add({
        groups: ["android", "ios"],
        kind: "react-native-codegen-spec",
        source: "package.json#codegenConfig.type",
      });
    }
    if (document.codegenConfig?.android) {
      add({ groups: ["android"], kind: "react-native-codegen", source: "package.json#codegenConfig.android" });
    }
    if (document.codegenConfig?.ios) {
      add({ groups: ["ios"], kind: "react-native-codegen", source: "package.json#codegenConfig.ios" });
    }
    for (const platform of Object.keys(document.codegenConfig?.outputDir ?? {})) {
      if (platform === "android" || platform === "ios") {
        add({
          groups: [platform],
          kind: "react-native-codegen",
          source: `package.json#codegenConfig.outputDir.${platform}`,
        });
      }
    }
  }
  if (has(/(?:^|\/)android(?:\/|$)|\.(?:java|kt)$/iu)) {
    add({ groups: ["android"], kind: "implementation-source", source: "android source set" });
  }
  if (has(/(?:^|\/)ios(?:\/|$)|\.(?:m|mm|swift|podspec)$/iu)) {
    add({ groups: ["ios"], kind: "implementation-source", source: "iOS source set" });
  }
  if (has(/(?:^|\/)windows(?:\/|$)|\.vcxproj$/iu) || dependencies.includes("react-native-windows")) {
    add({ groups: ["win32"], kind: "implementation-source", source: "React Native Windows source set" });
  }
  if (has(/(?:^|\/)macos(?:\/|$)/iu) || dependencies.includes("react-native-macos")) {
    add({ groups: ["osx"], kind: "implementation-source", source: "React Native macOS source set" });
  }
  if (has(/\.web\.(?:js|jsx|ts|tsx)$/iu)) {
    add({ groups: ["web"], kind: "javascript-implementation", source: "platform-specific .web source" });
  }
  if (has(/(?:^|\/)(?:cpp|common|shared)(?:\/|$).*\.(?:c|cc|cpp|cxx|h|hh|hpp|hxx)$/iu)) {
    add({ portability: "native-cpp", kind: "portable-core", source: "shared C/C++ source set" });
  }
  if (/\bHybridObject\s*<\s*\{[^}]*\bios\s*:/su.test(frameworkSource)) {
    add({ groups: ["ios"], kind: "nitro-platform-spec", source: "HybridObject PlatformSpec.ios" });
  }
  if (/\bHybridObject\s*<\s*\{[^}]*\bandroid\s*:/su.test(frameworkSource)) {
    add({ groups: ["android"], kind: "nitro-platform-spec", source: "HybridObject PlatformSpec.android" });
  }
  if (/\b(?:__EMSCRIPTEN__|wasm32|WASI)\b|emscripten\//iu.test(frameworkSource)) {
    add({ portability: "wasm-candidate", kind: "wasm-source", source: "explicit Emscripten/WASI source" });
  }
  return facts.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

function platformExclusions(files) {
  const groups = new Set();
  const group = { android: "android", ios: "ios", windows: "win32", macos: "osx", web: "web" };
  for (const file of files.filter(({ relative }) => path.basename(relative) === "react-native.config.js")) {
    const source = file.bytes.toString("utf8");
    for (const match of source.matchAll(/["']?(android|ios|windows|macos|web)["']?\s*:\s*null/giu)) {
      groups.add(group[match[1].toLowerCase()]);
    }
  }
  return [...groups].sort();
}

function catalogMatch(catalog, { nativeModuleNames, packageName, root }) {
  return (
    catalog.modules.find(
      (entry) =>
        entry.packageNames?.includes(packageName) ||
        entry.moduleNames?.some((name) => nativeModuleNames.includes(name)) ||
        portable(root).endsWith(entry.repositoryPath ?? "\0"),
    ) ?? null
  );
}

export async function loadNativeModuleCompatibilityAuthorities(packageRoot) {
  const [targetMatrix, catalog] = await Promise.all([
    readFile(path.join(packageRoot, "packages/toolchains/defold-bundle-targets.json"), "utf8").then(JSON.parse),
    readFile(path.join(packageRoot, "packages/compiler/data/native-module-catalog.json"), "utf8").then(JSON.parse),
  ]);
  assertNativeModuleCatalog(catalog, targetMatrix);
  return { targetMatrix, catalog };
}

export async function inspectNativeModuleCompatibility(input, { packageRoot } = {}) {
  const resolvedPackageRoot = packageRoot ?? path.resolve(import.meta.dirname, "../../..");
  const [{ targetMatrix, catalog }, selection] = await Promise.all([
    loadNativeModuleCompatibilityAuthorities(resolvedPackageRoot),
    selectedFiles(input),
  ]);
  const blockers = [];
  const manifests = [];
  const descriptors = [];
  const packageDocuments = [];
  let scriptApiModules = 0;
  for (const file of selection.files) {
    const basename = path.basename(file.relative);
    try {
      if (basename === "package.json") packageDocuments.push(JSON.parse(file.bytes.toString("utf8")));
      else if (basename === "ext.manifest") manifests.push(parseYaml(file.bytes.toString("utf8")) ?? {});
      else if (basename === "defold-hermes.bindings.json") {
        descriptors.push(
          normalizeNativeExtensionBindingSchema(parseNativeModuleDescriptorJson(file.bytes.toString("utf8"))),
        );
      } else if (file.relative.endsWith(".script_api")) {
        const parsed = parseYaml(file.bytes.toString("utf8"));
        if (Array.isArray(parsed)) scriptApiModules += parsed.length;
      }
    } catch (error) {
      blockers.push({ code: "invalid-module-metadata", path: file.relative, detail: error.message });
    }
  }
  const dependencies = dependencyNames(packageDocuments);
  const framework = detectFrameworks(selection.files, dependencies, packageDocuments);
  const frameworkSource = selection.files
    .filter(({ relative }) => sourcePattern.test(relative) || buildMetadataPattern.test(relative))
    .map(({ bytes }) => bytes.toString("utf8"))
    .join("\n");
  const nativeModules = descriptors.flatMap((descriptor) => descriptor.nativeModules ?? []);
  const headers = descriptors.flatMap((descriptor) => descriptor.headers ?? []);
  const publicHeaders = selection.files.filter(({ relative }) =>
    /(?:^|\/)include\/.*\.(?:h|hh|hpp|hxx)$/iu.test(relative),
  );
  const frontends = [...framework.frontends];
  if (scriptApiModules) frontends.push("defold-script-api");
  if (headers.length || publicHeaders.length) frontends.push("defold-c-header");
  if (nativeModules.length) frontends.push("deherm-native-provider");
  const packageDocument = packageDocuments[0] ?? {};
  const nativeModuleNames = nativeModules.map(({ name }) => name);
  const known = catalogMatch(catalog, {
    nativeModuleNames,
    packageName: packageDocument.name,
    root: selection.root,
  });
  const name =
    known?.name ??
    manifests.find((manifest) => typeof manifest.name === "string")?.name ??
    packageDocument.name ??
    path.basename(selection.root);
  const module = {
    schemaVersion: 1,
    name,
    ...(typeof packageDocument.version === "string" ? { version: packageDocument.version } : {}),
    sourceKind: manifests.length ? "defold-extension" : packageDocuments.length ? "package" : "source-tree",
    sourceDigest: hashFiles(selection.files),
    frontends,
    declaredPlatformContexts: manifests.flatMap((manifest) => Object.keys(manifest.platforms ?? {})),
    frameworkDependencies: framework.frameworkDependencies,
    platformEvidence: platformEvidence(selection.files, packageDocuments, frameworkSource),
    platformExclusions: platformExclusions(selection.files),
    blockers,
    capabilities: {
      scriptApiModules,
      publicHeaders: publicHeaders.length,
      nativeProviders: nativeModules.length,
      nativeMethods: nativeModules.reduce((count, nativeModule) => count + nativeModule.methods.length, 0),
    },
  };
  return {
    input: selection.root,
    knownCatalogId: known?.id ?? null,
    selectedFileCount: selection.files.length,
    report: analyzeNativeModuleCompatibility(module, targetMatrix, known),
  };
}

export async function listKnownNativeModules({ packageRoot } = {}) {
  const resolvedPackageRoot = packageRoot ?? path.resolve(import.meta.dirname, "../../..");
  const { targetMatrix, catalog } = await loadNativeModuleCompatibilityAuthorities(resolvedPackageRoot);
  return catalog.modules.map((entry) => ({
    ...entry,
    report: analyzeNativeModuleCompatibility(
      {
        schemaVersion: 1,
        name: entry.name,
        sourceKind: "catalog",
        sourceDigest: null,
        frontends: entry.frontends,
      },
      targetMatrix,
      entry,
    ),
  }));
}

export function formatNativeModuleCompatibility(result) {
  const { report } = result;
  const lines = [
    `${report.module.name}${report.module.version ? ` ${report.module.version}` : ""}`,
    `  source: ${result.input}`,
    `  digest: ${report.module.sourceDigest ?? "catalog"}`,
    `  frontends: ${report.frontends.join(", ") || "none"}`,
    `  known catalog: ${result.knownCatalogId ?? "no"}`,
  ];
  if (report.declaredPlatformContexts.length) {
    lines.push(
      `  manifest contexts: ${report.declaredPlatformContexts.join(", ")} (context overrides, not an allowlist)`,
    );
  }
  if (report.frameworkDependencies.length)
    lines.push(`  framework dependencies: ${report.frameworkDependencies.join(", ")}`);
  if (report.platformEvidence.length) {
    lines.push("  package platform evidence:");
    for (const fact of report.platformEvidence) {
      lines.push(
        `    - ${(fact.targets ?? fact.groups ?? [fact.portability]).join(", ")}: ${fact.kind} (${fact.source})`,
      );
    }
  }
  if (report.platformExclusions.length) {
    lines.push(`  package exclusions: ${report.platformExclusions.join(", ")}`);
  }
  if (report.blockers.length) {
    lines.push("  blockers:");
    for (const blocker of report.blockers) lines.push(`    - ${blocker.code}: ${blocker.detail}`);
  }
  lines.push("", "  target                         status                  route");
  for (const row of report.platforms) {
    lines.push(`  ${row.target.padEnd(30)} ${row.status.padEnd(23)} ${row.route ?? "-"}`);
  }
  lines.push(
    "",
    "Evidence stages are not interchangeable: generation-supported means déherm can emit the route; compile/runtime verification is reported only when recorded independently.",
  );
  return lines.join("\n");
}
