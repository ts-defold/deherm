// Resolving the three tools déherm runs on the user's machine.
//
// hermesc (TypeScript/JavaScript to Hermes bytecode), shermes (typed TypeScript
// to C) and dehermc (déherm's own TypeScript transforms) are indexed by the
// USER'S HOST, never by the Defold bundle target Bob is building for. None of
// them imposes a native toolchain requirement: hermesc and shermes are pure
// compilers - text in, text out - shermes only emits C and Extender compiles it,
// and dehermc emits transformed TypeScript and a JSON manifest.
//
// dehermc is here for the same reason the other two are. ttsc builds a
// plugin's Go source into a sidecar on demand and accepts source only; its own
// `ITtscPlugin.source` documentation states it "does not accept a prebuilt
// binary path", and its plugin cache key hashes the SHA-256 of the user's `go`
// binary and its `go version` output, so a release cannot seed that cache
// either. Left to ttsc, every user's first build compiled the typescript-go
// compiler from source - observed at 40 seconds, and ttsc's own message warns it
// "can take several minutes on a cold Go cache" - against whatever unpinned Go
// happened to be reachable. Shipping the binary is what makes "the user compiles
// nothing natively" true rather than aspirational.
//
// They ship as optional per-host packages rather than inside the main package,
// because vendoring five hosts' LLVM-derived binaries would put hundreds of
// megabytes into every install to use one of them. The main package does not
// hard-depend on them, so a host with no published build can still install
// déherm and get a diagnostic naming exactly what is missing instead of a failed
// install. Every resolution is checked against the digest pinned in
// packages/toolchains/host-compilers.json, exactly like the target archives.
//
// Status is recorded per tool, not per host. The three come from different
// builders on different schedules - dehermc cross-compiles to all five hosts
// from one job, while hermesc and shermes must each be built on a runner of
// their own architecture - so a host-wide status would either hide a published
// tool behind an unpublished one or claim a host is ready when it is not.

import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const packageRoot = path.resolve(import.meta.dirname, "../../..");
const manifestPath = path.join(packageRoot, "packages", "toolchains", "host-compilers.json");

export function hostCompilerKey(platform = process.platform, architecture = process.arch) {
  return `${platform}-${architecture}`;
}

export async function readHostCompilerManifest() {
  return JSON.parse(await readFile(manifestPath, "utf8"));
}

function resolvePackageDirectory(name) {
  try {
    const require = createRequire(import.meta.url);
    return path.dirname(require.resolve(`${name}/package.json`));
  } catch {
    return null;
  }
}

async function verifiedBinary(file, pinned, description) {
  let bytes;
  try {
    bytes = await readFile(file);
  } catch {
    return { ok: false, file, detail: `${description} is missing at ${file}` };
  }
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== pinned) {
    return { ok: false, file, sha256, detail: `${description} does not match its pinned digest (${pinned.slice(0, 12)} expected, ${sha256.slice(0, 12)} found)` };
  }
  return { ok: true, file, sha256, bytes: bytes.byteLength };
}

// One tool on one host, reported rather than thrown. The published package is
// the shipping route; the in-tree directory is what a CI staging step or a local
// build fills. Both carry the same pinned digest, so neither can be substituted
// for the other unnoticed, and both use the same `bin/<tool>` relative path so
// only the root differs.
async function inspectHostTool(key, tool, record, roots) {
  const base = {
    host: key,
    tool,
    status: record.status,
    builder: record.builder ?? null,
    blocker: record.blocker ?? null,
    file: record.file ?? null
  };
  if (record.status === "blocked") {
    return { ...base, ok: false, detail: `${record.blocker?.code ?? "blocked"}: ${record.blocker?.reason ?? "no reason recorded"}` };
  }
  if (record.status !== "vendored") {
    return {
      ...base,
      ok: false,
      detail: `no published ${tool} build for ${key} yet (${record.status}; builder ${record.builder ?? "none"})`
    };
  }
  if (!/^[a-f0-9]{64}$/.test(record.sha256 ?? "")) {
    return { ...base, ok: false, detail: `${tool} is recorded vendored for ${key} and carries no pinned digest` };
  }
  const attempts = [];
  for (const candidate of roots) {
    // Release archives are flat - one directory of tools, no `bin/` - because
    // the archive IS the unit and nesting the build tree's layout inside it
    // would publish this machine's directory shape. The manifest's `file` is
    // the VENDORED layout, so the cache root matches on basename instead.
    const relative = candidate.flat ? path.basename(record.file) : record.file;
    const result = await verifiedBinary(path.join(candidate.root, relative), record.sha256, `${key} ${tool}`);
    if (result.ok) {
      return { ...base, ok: true, source: candidate.source, sha256: result.sha256, bytes: result.bytes, path: result.file, detail: `${result.sha256.slice(0, 12)} (${candidate.source})` };
    }
    attempts.push(`${candidate.source}: ${result.detail}`);
  }
  return { ...base, ok: false, detail: attempts.join("; ") };
}

// One host's resolution, reported rather than thrown, so `deherm doctor` can
// describe every host and every tool, and the build path can turn the current
// host's failure into an error with the same words.
// Where ensure-host-tool.mjs extracts archives for this host. Resolved lazily
// and tolerantly: a missing cache is the ordinary state of a fresh install, not
// an error. Both host families are returned because a host needs tools from
// each, and they extract into separate tag directories.
function findProjectRoot(from = process.cwd()) {
  let directory = path.resolve(from);
  for (;;) {
    for (const marker of ["deherm.lock", "game.project", "package.json", ".git"]) {
      if (existsSync(path.join(directory, marker))) return directory;
    }
    const parent = path.dirname(directory);
    if (parent === directory) return path.resolve(from);
    directory = parent;
  }
}

function cachedFamilyRoots(key) {
  const found = [];
  try {
    // Project-local, matching ensure-host-tool.mjs: a fetched toolchain belongs
    // beside the project that uses it, where it can be committed, rather than
    // in machine state no teammate or CI runner shares.
    const base = process.env.DEHERM_TOOL_CACHE
      ? path.resolve(process.env.DEHERM_TOOL_CACHE)
      : path.join(findProjectRoot(), ".deherm", "cache", "toolchains");
    const tags = JSON.parse(readFileSync(
      path.join(packageRoot, "packages", "toolchains", "release-tags.json"), "utf8"));
    for (const family of ["hermes-host", "dehermc"]) {
      const tag = tags.families?.[family]?.tag;
      if (!tag) continue;
      const candidate = path.join(base, tag, key);
      if (existsSync(candidate)) found.push(candidate);
    }
  } catch {
    // No release-tags.json, no home directory, unreadable cache: all mean "not
    // cached", which a missing root already expresses.
  }
  return found;
}

export async function inspectHostCompilers(key, manifest) {
  const resolved = manifest ?? await readHostCompilerManifest();
  const record = resolved.hosts?.[key];
  if (!record) {
    return {
      host: key,
      ok: false,
      status: "unknown-host",
      tools: {},
      detail: `déherm declares no hermesc/shermes/dehermc build for ${key}; supported hosts are ${Object.keys(resolved.hosts ?? {}).join(", ")}`
    };
  }
  const roots = [];
  const installed = resolvePackageDirectory(record.package);
  if (installed) roots.push({ source: "package", root: installed });
  roots.push({ source: "vendored", root: path.join(packageRoot, record.directory) });
  // The fetch cache, last: a vendored tree or an explicitly installed per-host
  // package is a deliberate choice by whoever set this checkout up and should
  // win over something downloaded automatically.
  for (const cached of cachedFamilyRoots(key)) roots.push({ source: "cache", root: cached, flat: true });

  const tools = {};
  for (const [tool, toolRecord] of Object.entries(record.tools ?? {})) {
    tools[tool] = await inspectHostTool(key, tool, toolRecord, roots);
  }
  const names = Object.keys(tools);
  const missing = names.filter((tool) => !tools[tool].ok);
  const ok = names.length > 0 && missing.length === 0;
  // The rolled-up status is derived, never stored: a host is only as ready as
  // its least ready tool, and naming which tool is missing is the whole point.
  const status = ok
    ? "vendored"
    : names.every((tool) => tools[tool].status === "blocked")
      ? "blocked"
      : "required-missing";
  const detail = ok
    ? names.map((tool) => `${tool} ${tools[tool].sha256.slice(0, 12)}`).join(", ")
    : `${missing.join(", ")} unavailable for ${key}\n  ${missing.map((tool) => `${tool}: ${tools[tool].detail}`).join("\n  ")}\n  Install the published build with: npm install --save-dev ${record.package}@${resolved.packageVersion}`;
  return {
    host: key,
    ok,
    status,
    package: record.package,
    tools,
    missing,
    // Retained for callers that only want the digests of what resolved.
    binaries: Object.fromEntries(names.filter((tool) => tools[tool].ok).map((tool) => [tool, tools[tool]])),
    detail
  };
}

export async function hostCompilerReport(manifest) {
  const resolved = manifest ?? await readHostCompilerManifest();
  const current = hostCompilerKey();
  const hosts = [];
  for (const key of Object.keys(resolved.hosts ?? {})) {
    hosts.push({ ...await inspectHostCompilers(key, resolved), current: key === current });
  }
  if (!resolved.hosts?.[current]) {
    hosts.push({ ...await inspectHostCompilers(current, resolved), current: true });
  }
  hosts.sort((left, right) => left.host.localeCompare(right.host));
  return {
    schemaVersion: 2,
    currentHost: current,
    packageVersion: resolved.packageVersion,
    ttscVersion: resolved.ttscVersion ?? null,
    tools: Object.keys(resolved.tools ?? {}),
    hosts
  };
}

// Fail closed. A build that silently proceeds without hermesc produces a stale
// or absent bundle, which is exactly the "someone forgot to run déherm" failure
// the build seam exists to prevent; one that proceeds without dehermc emits a
// program whose DefoldHash literals were never lowered and whose reachability
// manifest was never written, which fails later and further from the cause.
export async function requireHostCompilers() {
  const key = hostCompilerKey();
  const result = await inspectHostCompilers(key);
  if (!result.ok) throw new Error(`déherm cannot compile on this host: ${result.detail}`);
  return result;
}

// One tool, for a caller that needs only that tool. Naming it keeps the
// diagnostic specific: a project that only runs the transforms should not be
// told that hermesc is missing, and a release build that needs shermes should
// not be told the transforms are fine.
// Which release family publishes a tool. Kept beside the resolver rather than
// read from release-tags.json, because a tool the package does not know about
// is a packaging bug, not something to discover at runtime.
function familyForTool(tool) {
  if (tool === "hermesc" || tool === "shermes") return "hermes-host";
  if (tool === "dehermc") return "dehermc";
  return null;
}

export async function requireHostTool(tool, options = {}) {
  const key = hostCompilerKey();
  let result = await inspectHostCompilers(key);
  // A miss is the NORMAL state of a fresh install: the tools are published as
  // release archives rather than shipped in the package, so nothing has put
  // them on disk yet. Fetch the one archive this host needs before deciding the
  // tool is unavailable - failing closed here would be correct and useless,
  // since no other code path was ever going to populate it.
  if (result.tools?.[tool] && !result.tools[tool].ok && options.fetch !== false) {
    const family = familyForTool(tool);
    if (family) {
      const { ensureHostFamily } = await import("./ensure-host-tool.mjs");
      await ensureHostFamily(family, key, { onProgress: options.onProgress });
      result = await inspectHostCompilers(key);
    }
  }
  const resolvedTool = result.tools?.[tool];
  if (!resolvedTool) {
    throw new Error(`déherm declares no ${tool} for ${key}; declared tools are ${Object.keys(result.tools ?? {}).join(", ") || "none"}`);
  }
  if (!resolvedTool.ok) {
    throw new Error(`déherm cannot run ${tool} on this host: ${resolvedTool.detail}`);
  }
  return resolvedTool;
}
