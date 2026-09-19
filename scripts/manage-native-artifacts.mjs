#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { cp, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { allTargetNames, buildInputPath, deriveBundleTargets, readBundleTargets } from "./generate-defold-bundle-targets.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.join(root, "packages", "toolchains", "native-artifacts.json");
const inputs = [
  "upstream.lock",
  "packages/toolchains/defold-bundle-targets.json",
  "toolchains/hermes/Dockerfile.linux",
  "toolchains/hermes/Dockerfile.win32",
  "toolchains/hermes/Dockerfile.android",
  "toolchains/hermes/build-apple.sh",
  "toolchains/hermes/build-host-compilers.sh",
  "toolchains/hermes/package-posix.sh",
  "toolchains/hermes/package-msvc.sh",
  "toolchains/hermes/windows-msvc.cmake",
  "scripts/package-defold-extension.sh"
];

// A target whose artifact has to exist before a user can bundle for it. The
// remaining statuses are not "not done yet": `vendored-source` targets link
// generated JavaScript instead of a Hermes archive, and `retired-upstream`
// targets carry no Extender toolchain at all.
const missingStatuses = new Set(["required-missing", "blocked"]);
const knownStatuses = new Set(["vendored", "vendored-source", "required-missing", "blocked", "retired-upstream"]);

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

function expectedFile(target, artifact) {
  return target === "x86_64-win32" ? "hermes.lib" : path.basename(artifact.library);
}

function installable(artifact) {
  return artifact.status === "vendored" || artifact.status === "required-missing";
}

async function install(downloadRoot) {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const available = await filesBelow(path.resolve(downloadRoot));
  const installed = [];
  for (const [target, artifact] of Object.entries(manifest.targets)) {
    if (!installable(artifact)) continue;
    const name = expectedFile(target, artifact);
    const candidates = available.filter((file) => path.basename(file) === name && file.split(path.sep).includes(`hermes-${target}`));
    // A download that carries nothing for a target leaves that target alone, so
    // one platform's build failing in CI never silently unpins another's digest.
    if (candidates.length === 0) continue;
    if (candidates.length !== 1) throw new Error(`Expected one ${name} in hermes-${target}, found ${candidates.length}`);
    const destination = path.join(root, artifact.library);
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(candidates[0], destination);
    const bytes = await readFile(destination);
    if (bytes.byteLength < 1_000_000) throw new Error(`${target} artifact is implausibly small (${bytes.byteLength} bytes)`);
    artifact.status = "vendored";
    artifact.sha256 = digest(bytes);
    artifact.bytes = bytes.byteLength;
    installed.push(target);
  }
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return installed;
}

// The macOS host artifact is produced locally by
// scripts/package-defold-extension.sh, so the manifest must describe the
// archive that script just wrote. Recording it there keeps the pinned digest a
// statement about the artifact actually present instead of one that goes stale
// the moment Hermes is rebuilt, while `verify` still rejects a missing, foreign,
// or corrupted library.
async function record(target) {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const artifact = manifest.targets[target];
  if (!artifact) throw new Error(`Unknown native artifact target ${target}`);
  if (!installable(artifact)) throw new Error(`${target} is ${artifact.status} and carries no digest`);
  const bytes = await readFile(path.join(root, artifact.library));
  if (bytes.byteLength < 1_000_000) throw new Error(`${target} artifact is implausibly small (${bytes.byteLength} bytes)`);
  artifact.status = "vendored";
  artifact.sha256 = digest(bytes);
  artifact.bytes = bytes.byteLength;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return artifact.sha256;
}

// The matrix is derived from the pinned Defold sources rather than listed here,
// so a Defold release that adds a bundle platform fails this check instead of
// letting a user select a platform nothing in this package mentions.
async function expectedTargets() {
  const generated = await readBundleTargets();
  let derived = null;
  try {
    await stat(buildInputPath);
    derived = await deriveBundleTargets();
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (derived && derived.sourceSha256 !== generated.sourceSha256) {
    throw new Error("packages/toolchains/defold-bundle-targets.json is stale; run node scripts/generate-defold-bundle-targets.mjs");
  }
  return { generated, targets: allTargetNames(generated) };
}

async function report() {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const { generated, targets } = await expectedTargets();
  const declared = Object.keys(manifest.targets).sort();
  const missingFromManifest = targets.filter((target) => !declared.includes(target));
  const unknownInManifest = declared.filter((target) => !targets.includes(target));
  const rows = [];
  for (const [target, artifact] of Object.entries(manifest.targets)) {
    const row = {
      target,
      kind: generated.targets.find((entry) => entry.target === target)?.kind ?? "unknown",
      status: artifact.status,
      builder: artifact.builder ?? null,
      library: artifact.library ?? null,
      blocker: artifact.blocker ?? null,
      detail: ""
    };
    if (!knownStatuses.has(artifact.status)) {
      row.detail = `unknown status ${artifact.status}`;
      row.invalid = true;
    } else if (artifact.status === "vendored") {
      try {
        const bytes = await readFile(path.join(root, artifact.library));
        if (digest(bytes) !== artifact.sha256) {
          row.detail = "checksum mismatch";
          row.invalid = true;
        } else {
          row.detail = `${artifact.sha256.slice(0, 12)} (${bytes.byteLength} bytes)`;
        }
      } catch {
        row.detail = `missing ${artifact.library}`;
        row.invalid = true;
      }
    } else if (artifact.status === "vendored-source") {
      try {
        await stat(path.join(root, artifact.library));
        row.detail = artifact.library;
      } catch {
        row.detail = `missing ${artifact.library}`;
        row.invalid = true;
      }
    } else if (artifact.status === "required-missing") {
      if (!artifact.builder) {
        row.detail = "required-missing without a builder";
        row.invalid = true;
      } else row.detail = `build with ${artifact.builder}`;
    } else if (!artifact.blocker?.code || !artifact.blocker?.reason) {
      row.detail = `${artifact.status} without a machine-readable blocker`;
      row.invalid = true;
    } else row.detail = artifact.blocker.code;
    rows.push(row);
  }
  rows.sort((left, right) => left.target.localeCompare(right.target));
  return {
    schemaVersion: 1,
    defoldRevision: manifest.defoldRevision,
    hermesRevision: manifest.hermesRevision,
    source: generated.source,
    missingFromManifest,
    unknownInManifest,
    targets: rows
  };
}

async function verify(complete, json) {
  const result = await report();
  if (json) console.log(JSON.stringify(result, null, 2));
  const problems = [];
  for (const target of result.missingFromManifest) {
    problems.push(`${target}: declared by ${result.source} and absent from the native artifact manifest`);
  }
  for (const target of result.unknownInManifest) {
    problems.push(`${target}: declared by the native artifact manifest and unknown to ${result.source}`);
  }
  for (const row of result.targets) {
    if (row.invalid) problems.push(`${row.target}: ${row.detail}`);
    else if (complete && missingStatuses.has(row.status)) {
      problems.push(`${row.target}: ${row.status}${row.blocker ? ` (${row.blocker.code}: ${row.blocker.reason})` : ` (${row.detail})`}`);
    }
  }
  if (problems.length) {
    throw new Error(`Native artifact matrix (${complete ? "complete" : "declared"}) failed:\n${problems.map((problem) => `- ${problem}`).join("\n")}`);
  }
  if (!json) {
    for (const row of result.targets) console.log(`${row.status === "vendored" || row.status === "vendored-source" ? "ok" : "--"} ${row.target}: ${row.status} ${row.detail}`);
    console.log(`ok native artifact matrix (${complete ? "complete" : "declared"}): ${result.targets.length} target(s)`);
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
  console.log(`installed ${installed.length} native artifact(s): ${installed.join(", ") || "none"}`);
} else if (command === "record") {
  if (!args[0]) throw new Error("record requires a target, for example arm64-osx");
  console.log(`recorded ${args[0]} ${await record(args[0])}`);
} else if (command === "report") console.log(JSON.stringify(await report(), null, 2));
else if (command === "verify") await verify(args.includes("--complete"), args.includes("--json"));
else if (command === "pull") {
  const runIndex = args.indexOf("--run");
  const runId = runIndex >= 0 ? args[runIndex + 1] : undefined;
  if (!runId) throw new Error("pull requires --run <GitHub Actions run id>");
  const destination = path.join(root, "build", "native-artifact-downloads", runId);
  await mkdir(destination, { recursive: true });
  await run("gh", ["run", "download", runId, "--repo", "ts-defold/deherm", "--dir", destination]);
  const installed = await install(destination);
  console.log(`installed ${installed.length} native artifact(s): ${installed.join(", ") || "none"}`);
  await verify(!args.includes("--partial"), false);
} else {
  throw new Error("Usage: manage-native-artifacts.mjs {fingerprint|report|verify [--complete] [--json]|install <dir>|record <target>|pull --run <id> [--partial]}");
}
