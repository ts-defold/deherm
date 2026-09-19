#!/usr/bin/env node

// The host half of the toolchain, kept deliberately separate from
// manage-native-artifacts.mjs because the two matrices are sized independently:
// `libhermes.a` is indexed by the Defold BUNDLE TARGET Bob uploads to Extender,
// while hermesc and shermes are indexed by the USER'S HOST. A user on macOS
// bundling for Android needs the macOS compilers and the Android archive, and
// neither matrix implies the other.

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, cp, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.join(root, "packages", "toolchains", "host-compilers.json");
const inputs = [
  "upstream.lock",
  "toolchains/hermes/build-host-compilers.sh"
];

const missingStatuses = new Set(["required-missing", "blocked"]);
const knownStatuses = new Set(["vendored", "required-missing", "blocked"]);

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function fingerprint() {
  const hash = createHash("sha256");
  for (const relative of inputs) {
    const bytes = await readFile(path.join(root, relative));
    hash.update(`${relative}\0${bytes.byteLength}\0`);
    hash.update(bytes);
  }
  return hash.digest("hex");
}

async function readManifest() {
  return JSON.parse(await readFile(manifestPath, "utf8"));
}

async function writeManifest(manifest) {
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function filesBelow(directory) {
  const files = [];
  async function visit(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) files.push(absolute);
    }
  }
  await visit(directory);
  return files;
}

async function recordHost(manifest, key) {
  const record = manifest.hosts[key];
  if (!record) throw new Error(`Unknown host compiler key ${key}`);
  const binaries = {};
  for (const [tool, relative] of Object.entries(record.files)) {
    const file = path.join(root, record.directory, relative);
    const bytes = await readFile(file);
    // hermesc and shermes are multi-megabyte LLVM-derived binaries. Anything
    // small enough to be a wrapper script or a Git LFS pointer is not the
    // artifact, and pinning its digest would make the lie permanent.
    if (bytes.byteLength < 1_000_000) {
      throw new Error(`${key} ${tool} is implausibly small (${bytes.byteLength} bytes)`);
    }
    binaries[tool] = { file: relative, sha256: digest(bytes), bytes: bytes.byteLength };
  }
  record.status = "vendored";
  record.binaries = binaries;
  return binaries;
}

async function install(downloadRoot) {
  const manifest = await readManifest();
  const available = await filesBelow(path.resolve(downloadRoot));
  const installed = [];
  for (const [key, record] of Object.entries(manifest.hosts)) {
    if (record.status === "blocked") continue;
    const found = [];
    for (const [tool, relative] of Object.entries(record.files)) {
      const name = path.basename(relative);
      const candidates = available.filter((file) => path.basename(file) === name && file.split(path.sep).includes(`host-compilers-${key}`));
      if (candidates.length > 1) throw new Error(`Expected one ${name} in host-compilers-${key}, found ${candidates.length}`);
      if (candidates.length === 1) found.push([relative, candidates[0]]);
      else if (found.length) throw new Error(`host-compilers-${key} carries only part of its compiler pair; ${tool} is missing`);
    }
    // A download that carries nothing for a host leaves that host alone, so one
    // runner failing never silently unpins another host's digests.
    if (!found.length) continue;
    for (const [relative, source] of found) {
      const destination = path.join(root, record.directory, relative);
      await mkdir(path.dirname(destination), { recursive: true });
      await cp(source, destination);
      // Artifact download loses the executable bit; a compiler that cannot be
      // executed is not installed, it is merely present.
      if (!relative.endsWith(".exe")) await chmod(destination, 0o755);
    }
    await recordHost(manifest, key);
    installed.push(key);
  }
  await writeManifest(manifest);
  return installed;
}

async function report() {
  const manifest = await readManifest();
  const rows = [];
  for (const [key, record] of Object.entries(manifest.hosts)) {
    const row = {
      host: key,
      platform: record.host.platform,
      architecture: record.host.architecture,
      package: record.package,
      builder: record.builder ?? null,
      status: record.status,
      blocker: record.blocker ?? null,
      binaries: {},
      detail: ""
    };
    if (!knownStatuses.has(record.status)) {
      row.detail = `unknown status ${record.status}`;
      row.invalid = true;
    } else if (record.status === "vendored") {
      const problems = [];
      for (const [tool, relative] of Object.entries(record.files)) {
        const pinned = record.binaries?.[tool];
        if (!pinned?.sha256) {
          problems.push(`${tool} carries no pinned digest`);
          continue;
        }
        try {
          const bytes = await readFile(path.join(root, record.directory, relative));
          if (digest(bytes) !== pinned.sha256) problems.push(`${tool} checksum mismatch`);
          else row.binaries[tool] = { sha256: pinned.sha256, bytes: bytes.byteLength };
        } catch {
          problems.push(`${tool} missing at ${record.directory}/${relative}`);
        }
      }
      if (problems.length) {
        row.detail = problems.join("; ");
        row.invalid = true;
      } else row.detail = Object.entries(row.binaries).map(([tool, value]) => `${tool} ${value.sha256.slice(0, 12)}`).join(", ");
    } else if (record.status === "required-missing") {
      if (!record.builder) {
        row.detail = "required-missing without a builder";
        row.invalid = true;
      } else row.detail = `build with ${record.builder}`;
    } else if (!record.blocker?.code || !record.blocker?.reason) {
      row.detail = "blocked without a machine-readable blocker";
      row.invalid = true;
    } else row.detail = record.blocker.code;
    rows.push(row);
  }
  rows.sort((left, right) => left.host.localeCompare(right.host));
  return { schemaVersion: 1, hermesRevision: manifest.hermesRevision, packageVersion: manifest.packageVersion, hosts: rows };
}

async function verify(complete, json) {
  const result = await report();
  if (json) console.log(JSON.stringify(result, null, 2));
  const problems = [];
  for (const row of result.hosts) {
    if (row.invalid) problems.push(`${row.host}: ${row.detail}`);
    else if (complete && missingStatuses.has(row.status)) {
      problems.push(`${row.host}: ${row.status}${row.blocker ? ` (${row.blocker.code}: ${row.blocker.reason})` : ` (${row.detail})`}`);
    }
  }
  if (problems.length) {
    throw new Error(`Host compiler matrix (${complete ? "complete" : "declared"}) failed:\n${problems.map((problem) => `- ${problem}`).join("\n")}`);
  }
  if (!json) {
    for (const row of result.hosts) console.log(`${row.status === "vendored" ? "ok" : "--"} ${row.host}: ${row.status} ${row.detail}`);
    console.log(`ok host compiler matrix (${complete ? "complete" : "declared"}): ${result.hosts.length} host(s)`);
  }
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(`${command} exited ${code ?? signal}`)));
  });
}

const [command, ...args] = process.argv.slice(2);
if (command === "fingerprint") console.log(await fingerprint());
else if (command === "install") {
  if (!args[0]) throw new Error("install requires a downloaded artifact directory");
  const installed = await install(args[0]);
  console.log(`installed ${installed.length} host compiler pair(s): ${installed.join(", ") || "none"}`);
} else if (command === "record") {
  if (!args[0]) throw new Error("record requires a host key, for example darwin-arm64");
  const manifest = await readManifest();
  const binaries = await recordHost(manifest, args[0]);
  await writeManifest(manifest);
  console.log(`recorded ${args[0]} ${Object.entries(binaries).map(([tool, value]) => `${tool}=${value.sha256}`).join(" ")}`);
} else if (command === "report") console.log(JSON.stringify(await report(), null, 2));
else if (command === "verify") await verify(args.includes("--complete"), args.includes("--json"));
else if (command === "pull") {
  const runIndex = args.indexOf("--run");
  const runId = runIndex >= 0 ? args[runIndex + 1] : undefined;
  if (!runId) throw new Error("pull requires --run <GitHub Actions run id>");
  const destination = path.join(root, "build", "host-compiler-downloads", runId);
  await mkdir(destination, { recursive: true });
  await run("gh", ["run", "download", runId, "--repo", "ts-defold/deherm", "--dir", destination]);
  const installed = await install(destination);
  console.log(`installed ${installed.length} host compiler pair(s): ${installed.join(", ") || "none"}`);
  await verify(!args.includes("--partial"), false);
} else if (command === "stage") {
  // Copy this host's freshly built compilers out of a local CMake build, so the
  // same record/verify path works without a CI round trip.
  const [key, buildDir] = args;
  if (!key || !buildDir) throw new Error("stage requires <host key> <cmake build directory>");
  const manifest = await readManifest();
  const record = manifest.hosts[key];
  if (!record) throw new Error(`Unknown host compiler key ${key}`);
  for (const [tool, relative] of Object.entries(record.files)) {
    const name = path.basename(relative);
    const source = path.resolve(buildDir, "bin", name);
    await stat(source).catch(() => {
      throw new Error(`${tool} was not built at ${source}; run cmake --build <dir> --target ${tool}`);
    });
    const destination = path.join(root, record.directory, relative);
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(source, destination);
    if (!relative.endsWith(".exe")) await chmod(destination, 0o755);
  }
  const binaries = await recordHost(manifest, key);
  await writeManifest(manifest);
  console.log(`staged ${key} ${Object.keys(binaries).join(", ")}`);
} else {
  throw new Error("Usage: manage-host-compilers.mjs {fingerprint|report|verify [--complete] [--json]|install <dir>|record <host>|stage <host> <build dir>|pull --run <id> [--partial]}");
}
