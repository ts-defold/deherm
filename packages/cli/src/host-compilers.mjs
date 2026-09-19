// Resolving the two host compilers déherm runs on the user's machine.
//
// hermesc (TypeScript/JavaScript to Hermes bytecode) and shermes (typed
// TypeScript to C) are indexed by the USER'S HOST, never by the Defold bundle
// target Bob is building for. They are pure compilers - text in, text out - so
// having them imposes no native toolchain requirement: shermes only emits C and
// Extender compiles it.
//
// They ship as optional per-host packages rather than inside the main package,
// because vendoring five hosts' LLVM-derived binaries would put hundreds of
// megabytes into every install to use one of them. The main package does not
// hard-depend on them, so a host with no published build can still install
// déherm and get a diagnostic naming exactly what is missing instead of a failed
// install. Every resolution is checked against the digest pinned in
// packages/toolchains/host-compilers.json, exactly like the target archives.

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

// One host's resolution, reported rather than thrown, so `deherm doctor` can
// describe every host and the build path can turn the current host's failure
// into an error with the same words.
export async function inspectHostCompilers(key, manifest) {
  const resolved = manifest ?? await readHostCompilerManifest();
  const record = resolved.hosts?.[key];
  if (!record) {
    return {
      host: key,
      ok: false,
      status: "unknown-host",
      detail: `déherm declares no hermesc/shermes build for ${key}; supported hosts are ${Object.keys(resolved.hosts ?? {}).join(", ")}`
    };
  }
  const base = {
    host: key,
    status: record.status,
    package: record.package,
    builder: record.builder ?? null,
    blocker: record.blocker ?? null
  };
  if (record.status === "blocked") {
    return { ...base, ok: false, detail: `${record.blocker?.code ?? "blocked"}: ${record.blocker?.reason ?? "no reason recorded"}` };
  }
  if (record.status !== "vendored") {
    return {
      ...base,
      ok: false,
      detail: `no published hermesc/shermes build for ${key} yet (${record.status}; builder ${record.builder ?? "none"})`
    };
  }
  // The published package is the shipping route; the in-tree directory is what a
  // CI staging step or a local Hermes build fills. Both carry the same pinned
  // digests, so neither can be substituted for the other unnoticed.
  // Both layouts use the same `bin/<tool>` relative path, so only the root
  // differs.
  const roots = [];
  const installed = resolvePackageDirectory(record.package);
  if (installed) roots.push({ source: "package", root: installed });
  roots.push({ source: "vendored", root: path.join(packageRoot, record.directory) });
  const attempts = [];
  for (const candidate of roots) {
    const binaries = {};
    let ok = true;
    for (const [tool, relative] of Object.entries(record.files)) {
      const pinned = record.binaries?.[tool]?.sha256;
      if (!pinned) {
        ok = false;
        attempts.push(`${candidate.source}: ${tool} carries no pinned digest in host-compilers.json`);
        break;
      }
      const result = await verifiedBinary(path.join(candidate.root, relative), pinned, `${key} ${tool}`);
      if (!result.ok) {
        ok = false;
        attempts.push(`${candidate.source}: ${result.detail}`);
        break;
      }
      binaries[tool] = result;
    }
    if (ok) return { ...base, ok: true, source: candidate.source, binaries, detail: Object.entries(binaries).map(([tool, value]) => `${tool} ${value.sha256.slice(0, 12)}`).join(", ") };
  }
  return {
    ...base,
    ok: false,
    detail: `${record.package} is not installed or does not match its pinned digests. Install it with: npm install --save-dev ${record.package}@${resolved.packageVersion}\n  ${attempts.join("\n  ")}`
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
  return { schemaVersion: 1, currentHost: current, packageVersion: resolved.packageVersion, hosts };
}

// Fail closed. A build that silently proceeds without hermesc produces a stale
// or absent bundle, which is exactly the "someone forgot to run déherm" failure
// the build seam exists to prevent.
export async function requireHostCompilers() {
  const key = hostCompilerKey();
  const result = await inspectHostCompilers(key);
  if (!result.ok) throw new Error(`déherm cannot compile on this host: ${result.detail}`);
  return result;
}
