// Driving dehermc, déherm's precompiled TypeScript transform compiler.
//
// This is the call site that exists so ttsc's does not. Left to ttsc, reaching
// these transforms means `loadProjectPlugins` → `buildSourcePlugin` → `go build`
// on the user's machine, because ttsc accepts a Go source path and explicitly
// not a prebuilt binary (`ITtscPlugin.source`), and its plugin cache key hashes
// the SHA-256 of the user's own `go` binary, so a release cannot seed the cache
// either. The binary déherm ships is the same program ttsc would have built; it
// just already exists, and this module hands it the arguments we defined rather
// than the ones ttsc happens to use this release.
//
// Two details about the protocol are not obvious and cost real time to find:
//
//   * `--plugins-json` is required for the transforms to run at all. Without it
//     the host loads an empty rule configuration and returns the project
//     unchanged with exit 0 - an answer indistinguishable from "this project
//     declares no transforms". A silent no-op is the worst possible failure for
//     a pass whose whole job is lowering literals.
//   * ttsc "pairs registrations with linked manifest entries by build order, not
//     by package name" (`driver/plugins.go`). dehermc links exactly one
//     registered plugin, so the manifest is exactly one entry and its `name` is
//     a label for diagnostics, not a routing key.

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { requireHostTool } from "./host-compilers.mjs";

const run = promisify(execFile);

// The single linked plugin. `config` is what the transforms read for their own
// options - `resourceSymbols` points the resource-name pass at the generated
// symbol table, and without it that pass stays silent by design, because a
// project with no table has nothing to check names against.
export function dehermPluginManifest(config = {}) {
  return JSON.stringify([{ name: "@ts-defold/deherm/ttsc", stage: "transform", config }]);
}

// stdout carries a JSON envelope that can run to several megabytes for a real
// project, so the buffer ceiling is raised rather than left at Node's 1 MB
// default - a truncated envelope would surface as a parse error naming nothing.
const MAX_OUTPUT_BYTES = 256 * 1024 * 1024;

const pluginLoaderKeys = new Set(["enabled", "name", "stage", "transform"]);

function isDehermTransform(plugin) {
  if (!plugin || plugin.enabled === false || typeof plugin.transform !== "string") return false;
  return plugin.transform === "@ts-defold/deherm/ttsc" ||
    plugin.transform.endsWith("/packages/compiler/ttsc.mjs") ||
    plugin.transform.endsWith("/compiler/ttsc.mjs") ||
    plugin.transform.endsWith("packages/compiler/ttsc.mjs");
}

async function readConfigChain(configPath, seen = new Set()) {
  const absolute = path.resolve(configPath);
  if (seen.has(absolute)) {
    throw new Error(`Generated TypeScript config inheritance contains a cycle at ${absolute}`);
  }
  seen.add(absolute);
  const document = JSON.parse(await readFile(absolute, "utf8"));
  const inherited = [];
  if (typeof document.extends === "string") {
    if (!document.extends.startsWith(".")) {
      throw new Error(`Generated TypeScript config ${absolute} extends unsupported package config '${document.extends}'`);
    }
    const candidate = path.resolve(path.dirname(absolute), document.extends);
    const parent = path.extname(candidate) ? candidate : `${candidate}.json`;
    inherited.push(...await readConfigChain(parent, seen));
  }
  inherited.push(...(document.compilerOptions?.plugins ?? []));
  return inherited;
}

/** Read the one generated déherm transform configuration dehermc must run. */
export async function loadDehermPluginConfig(tsconfig) {
  const plugins = (await readConfigChain(tsconfig)).filter(isDehermTransform);
  if (plugins.length !== 1) {
    throw new Error(`Expected exactly one enabled @ts-defold/deherm/ttsc transform in ${path.resolve(tsconfig)}, found ${plugins.length}`);
  }
  return Object.fromEntries(
    Object.entries(plugins[0]).filter(([key]) => !pluginLoaderKeys.has(key))
  );
}

async function invoke(command, { tsconfig, cwd, config, outDir }) {
  const tool = await requireHostTool("dehermc");
  const args = [command, "--tsconfig", tsconfig, "--plugins-json", dehermPluginManifest(config)];
  if (cwd) args.push("--cwd", cwd);
  if (outDir) args.push("--outdir", outDir);
  try {
    const { stdout, stderr } = await run(tool.path, args, { maxBuffer: MAX_OUTPUT_BYTES, cwd });
    return { ok: true, status: 0, signal: null, stdout, stderr, tool };
  } catch (error) {
    // A non-zero exit is a compiler answer, not a crash: check reports resource
    // name blockers this way. Hand back what it said rather than a wrapped
    // Error whose message is "Command failed".
    if (typeof error?.code === "number") {
      return { ok: false, status: error.code, signal: error.signal ?? null, stdout: error.stdout ?? "", stderr: error.stderr ?? "", tool };
    }
    if (error?.signal) {
      return { ok: false, status: null, signal: error.signal, stdout: error.stdout ?? "", stderr: error.stderr ?? "", tool };
    }
    throw error;
  }
}

/**
 * Transform a whole project and return the printed TypeScript per file.
 *
 * The envelope also carries `diagnostics`, the host-owned reference `graph`,
 * and the `hostInputs` the transforms read outside the TypeScript reference
 * graph - everything a caller needs to know which files can invalidate a
 * transformed module, which is why the bundler integration wants the envelope
 * and not just the text.
 */
export async function transformProject(options) {
  const result = await invoke("transform", options);
  if (!result.ok) {
    throw new Error(`dehermc transform failed (exit ${result.status}):\n${result.stderr || result.stdout}`);
  }
  return JSON.parse(result.stdout);
}

/**
 * Run the diagnostics-only pass.
 *
 * Returns the diagnostics rather than throwing, because resource-name blockers
 * are the expected output of this command and a caller decides whether they are
 * fatal for the build it is running.
 */
export async function checkProject(options) {
  const result = await invoke("check", options);
  return {
    ok: result.ok,
    status: result.status,
    signal: result.signal,
    stdout: result.stdout,
    stderr: result.stderr,
    diagnostics: `${result.stdout}${result.stderr}`.trimEnd(),
    compiler: result.tool.path,
    compilerSha256: result.tool.sha256
  };
}

/** The binary's own identity, for `deherm doctor` and for build provenance. */
export async function transformCompilerIdentity() {
  const tool = await requireHostTool("dehermc");
  const { stdout } = await run(tool.path, ["version"], { maxBuffer: 1024 * 1024 });
  return { ...JSON.parse(stdout), sha256: tool.sha256, path: tool.path };
}
