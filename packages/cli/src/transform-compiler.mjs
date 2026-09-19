// Driving deherm-tsc, déherm's precompiled TypeScript transform compiler.
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
//     by package name" (`driver/plugins.go`). deherm-tsc links exactly one
//     registered plugin, so the manifest is exactly one entry and its `name` is
//     a label for diagnostics, not a routing key.

import { execFile } from "node:child_process";
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

async function invoke(command, { tsconfig, cwd, config, outDir }) {
  const tool = await requireHostTool("deherm-tsc");
  const args = [command, "--tsconfig", tsconfig, "--plugins-json", dehermPluginManifest(config)];
  if (cwd) args.push("--cwd", cwd);
  if (outDir) args.push("--outdir", outDir);
  try {
    const { stdout, stderr } = await run(tool.path, args, { maxBuffer: MAX_OUTPUT_BYTES, cwd });
    return { ok: true, stdout, stderr };
  } catch (error) {
    // A non-zero exit is a compiler answer, not a crash: check reports resource
    // name blockers this way. Hand back what it said rather than a wrapped
    // Error whose message is "Command failed".
    if (typeof error?.code === "number") {
      return { ok: false, status: error.code, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
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
    throw new Error(`deherm-tsc transform failed (exit ${result.status}):\n${result.stderr || result.stdout}`);
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
    diagnostics: `${result.stdout}${result.stderr}`.trimEnd()
  };
}

/** The binary's own identity, for `deherm doctor` and for build provenance. */
export async function transformCompilerIdentity() {
  const tool = await requireHostTool("deherm-tsc");
  const { stdout } = await run(tool.path, ["version"], { maxBuffer: 1024 * 1024 });
  return { ...JSON.parse(stdout), sha256: tool.sha256, path: tool.path };
}
