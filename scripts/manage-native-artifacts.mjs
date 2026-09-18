#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { cp, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.join(root, "packages", "toolchains", "native-artifacts.json");
const inputs = [
  "upstream.lock",
  "toolchains/hermes/Dockerfile.linux",
  "toolchains/hermes/Dockerfile.win32",
  "toolchains/hermes/package-posix.sh",
  "toolchains/hermes/windows-msvc.cmake",
  "scripts/package-defold-extension.sh"
];

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

async function install(downloadRoot) {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const available = await filesBelow(path.resolve(downloadRoot));
  for (const [target, artifact] of Object.entries(manifest.targets)) {
    if (artifact.status === "vendored-source") continue;
    const name = expectedFile(target, artifact);
    const candidates = available.filter((file) => path.basename(file) === name && file.split(path.sep).includes(`hermes-${target}`));
    if (candidates.length !== 1) throw new Error(`Expected one ${name} in hermes-${target}, found ${candidates.length}`);
    const destination = path.join(root, artifact.library);
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(candidates[0], destination);
    const bytes = await readFile(destination);
    if (bytes.byteLength < 1_000_000) throw new Error(`${target} artifact is implausibly small (${bytes.byteLength} bytes)`);
    artifact.status = "vendored";
    artifact.sha256 = digest(bytes);
    artifact.bytes = bytes.byteLength;
  }
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function verify(complete) {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const required = ["arm64-osx", "x86_64-osx", "x86_64-linux", "arm64-linux", "x86_64-win32", "wasm-web"];
  if (JSON.stringify(Object.keys(manifest.targets).sort()) !== JSON.stringify([...required].sort())) {
    throw new Error("Native artifact manifest target matrix is incomplete or contains unknown targets");
  }
  for (const [target, artifact] of Object.entries(manifest.targets)) {
    if (artifact.status === "vendored-source") {
      await stat(path.join(root, artifact.library));
      continue;
    }
    if (artifact.status !== "vendored") {
      if (complete) throw new Error(`${target} is ${artifact.status}`);
      continue;
    }
    const bytes = await readFile(path.join(root, artifact.library));
    if (digest(bytes) !== artifact.sha256) throw new Error(`${target} artifact checksum mismatch`);
  }
  console.log(`ok native artifact matrix (${complete ? "complete" : "declared"}): ${required.join(", ")}`);
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
  await install(args[0]);
} else if (command === "verify") await verify(args.includes("--complete"));
else if (command === "pull") {
  const runIndex = args.indexOf("--run");
  const runId = runIndex >= 0 ? args[runIndex + 1] : undefined;
  if (!runId) throw new Error("pull requires --run <GitHub Actions run id>");
  const destination = path.join(root, "build", "native-artifact-downloads", runId);
  await mkdir(destination, { recursive: true });
  await run("gh", ["run", "download", runId, "--repo", "ts-defold/deherm", "--dir", destination]);
  await install(destination);
  await verify(true);
} else {
  throw new Error("Usage: manage-native-artifacts.mjs {fingerprint|verify [--complete]|install <dir>|pull --run <id>}");
}
