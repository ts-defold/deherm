// Resolving the three tools déherm runs on the user's machine.
//
// hermesc (TypeScript/JavaScript to Hermes bytecode), shermes (typed TypeScript
// to C) and deherm-tsc (déherm's own TypeScript transforms) are indexed by the
// USER'S HOST, never by the Defold bundle target Bob is building for. None of
// them imposes a native toolchain requirement: hermesc and shermes are pure
// compilers - text in, text out - shermes only emits C and Extender compiles it,
// and deherm-tsc emits transformed TypeScript and a JSON manifest.
//
// deherm-tsc is here for the same reason the other two are. ttsc builds a
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
// builders on different schedules - deherm-tsc cross-compiles to all five hosts
// from one job, while hermesc and shermes must each be built on a runner of
// their own architecture - so a host-wide status would either hide a published
// tool behind an unpublished one or claim a host is ready when it is not.

import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
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
    const result = await verifiedBinary(path.join(candidate.root, record.file), record.sha256, `${key} ${tool}`);
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
export async function inspectHostCompilers(key, manifest) {
  const resolved = manifest ?? await readHostCompilerManifest();
  const record = resolved.hosts?.[key];
  if (!record) {
    return {
      host: key,
      ok: false,
      status: "unknown-host",
      tools: {},
      detail: `déherm declares no hermesc/shermes/deherm-tsc build for ${key}; supported hosts are ${Object.keys(resolved.hosts ?? {}).join(", ")}`
    };
  }
  const roots = [];
  const installed = resolvePackageDirectory(record.package);
  if (installed) roots.push({ source: "package", root: installed });
  roots.push({ source: "vendored", root: path.join(packageRoot, record.directory) });

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
// the build seam exists to prevent; one that proceeds without deherm-tsc emits a
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
export async function requireHostTool(tool) {
  const key = hostCompilerKey();
  const result = await inspectHostCompilers(key);
  const resolvedTool = result.tools?.[tool];
  if (!resolvedTool) {
    throw new Error(`déherm declares no ${tool} for ${key}; declared tools are ${Object.keys(result.tools ?? {}).join(", ") || "none"}`);
  }
  if (!resolvedTool.ok) {
    throw new Error(`déherm cannot run ${tool} on this host: ${resolvedTool.detail}`);
  }
  return resolvedTool;
}
