#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { emitDmSdkUniversalStaticFrame } from "../packages/compiler/src/dmsdk-universal-static-frame.mjs";
import { renderBuildConfig } from "./assemble-typed-native-extension.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// These exceptions are exact files whose bytes are owned by package machinery,
// not by a Defold revision. A generated-looking prefix is never sufficient.
// Each exception names the package-side input provenance that makes it stable.
export const stableGeneratedExceptions = Object.freeze({
  "defold/defold_hermes/include/defold_hermes/generated_build_config.h": Object.freeze({
    group: "project-build-skeleton",
    provenance: "empty package skeleton documented in-file; project assembly owns any populated replacement"
  }),
  "defold/defold_hermes/include/defold_hermes/generated_component_proxy_capability.hpp": Object.freeze({
    group: "compiler-runtime-capability",
    provenance: "scripts/generate-component-proxy-runtime-capability.mjs reads only compiler/runtime/provider/harness sources"
  }),
  "defold/defold_hermes/include/defold_hermes/generated_dmsdk_universal_static_frame.h": Object.freeze({
    group: "compiler-owned-static-frame",
    provenance: "packages/compiler/src/dmsdk-universal-static-frame.mjs package ABI constants"
  }),
  "defold/defold_hermes/src/generated_dmsdk_universal_static_frame.cpp": Object.freeze({
    group: "compiler-owned-static-frame",
    provenance: "packages/compiler/src/dmsdk-universal-static-frame.mjs package ABI constants"
  }),
  "packages/static-hermes/src/generated/dmsdk-universal.ts": Object.freeze({
    group: "compiler-owned-static-frame",
    provenance: "packages/compiler/src/dmsdk-universal-static-frame.mjs package ABI constants"
  })
});

const forbiddenRules = Object.freeze([
  ["target-native-config", (file) => file === "defold/defold_hermes/include/libhermesvm-config.h"],
  ["bundled-policy", (file) =>
    file === "packages/bindings/generated/defold-policy-index.json" ||
    file.startsWith("packages/bindings/generated/policy/")],
  ["revision-binding-surface", (file) => file.startsWith("packages/bindings/generated/")],
  ["legacy-fixed-binding-declarations", (file) =>
    file === "packages/bindings/modules.json" || file === "packages/bindings/lua-compat.json"],
  ["revision-policy-overrides", (file) => file.startsWith("packages/bindings/overrides/")],
  ["revision-evidence-probes", (file) => file.startsWith("packages/bindings/probes/")],
  ["revision-sdk-output", (file) => file.startsWith("packages/sdk/src/generated/")],
  ["revision-abi-output", (file) => file.startsWith("packages/abi/src/generated/")],
  ["revision-static-hermes-output", (file) => file.startsWith("packages/static-hermes/src/generated/")],
  ["revision-compiler-catalog", (file) => file.startsWith("packages/compiler/src/generated/")],
  ["revision-toolchain-surface", (file) => [
    "packages/toolchains/defold-bundle-targets.json",
    "packages/toolchains/defold-platform-pairs.json",
    "packages/toolchains/native-artifacts.json"
  ].includes(file)],
  ["revision-native-header-output", (file) =>
    file.startsWith("defold/defold_hermes/include/defold_hermes/generated_")],
  ["revision-native-source-output", (file) =>
    file.startsWith("defold/defold_hermes/src/generated_")],
  ["revision-web-output", (file) =>
    file.startsWith("defold/defold_hermes/lib/web/generated_")]
]);

const stableRules = Object.freeze([
  ["compiler-realizer", (file) => file.startsWith("packages/compiler/")],
  ["cli-cache", (file) => file.startsWith("packages/cli/")],
  ["toolchain-artifact", (file) => [
    "packages/toolchains/package.json",
    "packages/toolchains/host-compilers.json",
    "packages/toolchains/release-tags.json"
  ].includes(file)],
  ["policy-publication-locator", (file) => file === "packages/bindings/policy-site.json"],
  ["binding-target-schema", (file) =>
    file === "packages/bindings/profiles.json" || file.startsWith("packages/bindings/targets/")],
  ["typed-native-emitter", (file) => file === "scripts/assemble-typed-native-extension.mjs"],
  ["portable-runtime", (file) =>
    file.startsWith("packages/web-adapter/") || file.startsWith("packages/polyfills/") ||
    file.startsWith("packages/telemetry/")],
  ["typescript-runtime-template", (file) =>
    file.startsWith("packages/sdk/src/") || file.startsWith("packages/static-hermes/src/")],
  ["native-runtime-template", (file) => file.startsWith("defold/defold_hermes/")]
]);

function normalizeInventoryPath(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  let normalized = value.replaceAll("\\", "/");
  while (normalized.startsWith("./")) normalized = normalized.slice(2);
  if (normalized.startsWith("package/")) normalized = normalized.slice("package/".length);
  return normalized;
}

function isUnsafeInventoryPath(file) {
  const segments = file.split("/");
  return file.length === 0 || path.posix.isAbsolute(file) ||
    segments.some((segment) => segment.length === 0 || segment === "." || segment === "..");
}

/** Accept npm's `pack --json` result, one package record, or a string fixture. */
export function packageInventoryPaths(inventory) {
  let files;
  if (Array.isArray(inventory) && inventory.every((entry) => typeof entry === "string")) {
    files = inventory;
  } else if (Array.isArray(inventory)) {
    files = inventory.flatMap((entry) => Array.isArray(entry?.files) ? entry.files : []);
  } else if (Array.isArray(inventory?.files)) {
    files = inventory.files;
  } else {
    throw new TypeError("Package inventory must be npm pack JSON, a package record, or an array of paths");
  }
  const normalized = files.map((entry) => normalizeInventoryPath(typeof entry === "string" ? entry : entry?.path));
  if (normalized.some((entry) => entry === null)) {
    throw new TypeError("Package inventory contains a file without a non-empty path");
  }
  return [...new Set(normalized)].sort();
}

function append(grouped, group, value) {
  (grouped[group] ??= []).push(value);
}

export function classifyPackageInventory(inventory, options = {}) {
  const files = packageInventoryPaths(inventory);
  const forbidden = {};
  const allowed = {};
  const provenExceptions = [];
  const unclassified = [];

  for (const file of files) {
    if (isUnsafeInventoryPath(file)) {
      append(forbidden, "invalid-inventory-path", file);
      continue;
    }
    const exception = stableGeneratedExceptions[file];
    if (exception) {
      append(allowed, exception.group, file);
      provenExceptions.push({ path: file, ...exception });
      continue;
    }
    const forbiddenRule = forbiddenRules.find(([, matches]) => matches(file));
    if (forbiddenRule) {
      append(forbidden, forbiddenRule[0], file);
      continue;
    }
    const stableRule = stableRules.find(([, matches]) => matches(file));
    if (stableRule) append(allowed, stableRule[0], file);
    else unclassified.push(file);
  }

  const forbiddenFileCount = Object.values(forbidden).reduce((sum, paths) => sum + paths.length, 0);
  return {
    schemaVersion: 1,
    kind: "deherm.package-revision-boundary-report",
    ok: forbiddenFileCount === 0,
    source: options.source ?? { kind: "injected-inventory" },
    summary: {
      inventoryFileCount: files.length,
      forbiddenGroupCount: Object.keys(forbidden).length,
      forbiddenFileCount,
      allowedStableFileCount: Object.values(allowed).reduce((sum, paths) => sum + paths.length, 0),
      provenExceptionCount: provenExceptions.length,
      unclassifiedFileCount: unclassified.length
    },
    forbidden,
    allowed: {
      groups: allowed,
      provenExceptions
    },
    unclassified
  };
}

export async function npmPackDryRunInventory(cwd = repositoryRoot) {
  const cache = await mkdtemp(path.join(tmpdir(), "deherm-package-boundary-npm-"));
  const command = ["pack", "--dry-run", "--json", "--ignore-scripts", "--cache", cache];
  try {
    const result = spawnSync("npm", command, {
      cwd,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024
    });
    if (result.error || result.status !== 0) {
      const error = new Error(`npm ${command.join(" ")} failed with status ${result.status ?? "unknown"}`);
      error.code = "DEHERM_PACKAGE_INVENTORY_FAILED";
      error.stdout = result.stdout;
      error.stderr = result.stderr;
      throw error;
    }
    return {
      inventory: JSON.parse(result.stdout),
      source: { kind: "npm-pack-dry-run", cwd: path.resolve(cwd), command: ["npm", ...command.slice(0, 4), "--cache", "<temporary>"] }
    };
  } finally {
    await rm(cache, { recursive: true, force: true });
  }
}

export async function verifyStableGeneratedExceptionBytes(root = repositoryRoot) {
  const emitted = emitDmSdkUniversalStaticFrame();
  const expected = new Map([
    ["defold/defold_hermes/include/defold_hermes/generated_build_config.h", renderBuildConfig(false)],
    ["defold/defold_hermes/include/defold_hermes/generated_dmsdk_universal_static_frame.h", emitted.header],
    ["defold/defold_hermes/src/generated_dmsdk_universal_static_frame.cpp", emitted.source],
    ["packages/static-hermes/src/generated/dmsdk-universal.ts", emitted.staticHermes]
  ]);
  for (const [relative, source] of expected) {
    if (await readFile(path.join(root, relative), "utf8") !== source) {
      throw new Error(`${relative} does not match its package-owned emitter`);
    }
  }
  const component = spawnSync(process.execPath, [
    path.join(root, "scripts", "generate-component-proxy-runtime-capability.mjs"),
    "--check"
  ], { cwd: root, encoding: "utf8" });
  if (component.error || component.status !== 0) {
    throw new Error(
      "generated_component_proxy_capability.hpp does not match its package-owned emitter" +
      (component.stderr?.trim() ? `: ${component.stderr.trim()}` : "")
    );
  }
  return { checked: [...expected.keys(), "defold/defold_hermes/include/defold_hermes/generated_component_proxy_capability.hpp"] };
}

function parseArguments(argv) {
  const options = { inventory: null, cwd: repositoryRoot, pretty: false, quiet: false };
  for (let index = 2; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--pretty") { options.pretty = true; continue; }
    if (argument === "--quiet") { options.quiet = true; continue; }
    if (argument === "--inventory" || argument === "--cwd") {
      const value = argv[++index];
      if (!value) throw new Error(`${argument} requires a path`);
      options[argument.slice(2)] = path.resolve(value);
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

export async function main(argv = process.argv) {
  const options = parseArguments(argv);
  await verifyStableGeneratedExceptionBytes(options.cwd);
  const loaded = options.inventory
    ? {
        inventory: JSON.parse(await readFile(options.inventory, "utf8")),
        source: { kind: "injected-inventory", path: options.inventory }
      }
    : await npmPackDryRunInventory(options.cwd);
  const report = classifyPackageInventory(loaded.inventory, { source: loaded.source });
  if (!options.quiet || !report.ok) {
    process.stdout.write(`${JSON.stringify(report, null, options.pretty ? 2 : 0)}\n`);
  }
  return report.ok ? 0 : 1;
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  try {
    process.exitCode = await main();
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      schemaVersion: 1,
      kind: "deherm.package-revision-boundary-error",
      ok: false,
      code: error?.code ?? "DEHERM_PACKAGE_BOUNDARY_ERROR",
      message: error?.message ?? String(error)
    })}\n`);
    process.exitCode = 2;
  }
}
