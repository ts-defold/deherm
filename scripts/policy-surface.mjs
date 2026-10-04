#!/usr/bin/env node

// One authority for the revision-derived files exchanged between policy jobs.

import { execFile } from "node:child_process";
import { lstat, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tarExecutable = process.env.DEHERM_TAR || "tar";
const policyTextExtensions = new Set([
  ".atlas",
  ".c",
  ".cc",
  ".collection",
  ".cpp",
  ".css",
  ".def",
  ".go",
  ".gui",
  ".gui_script",
  ".h",
  ".hpp",
  ".html",
  ".inc",
  ".input_binding",
  ".js",
  ".json",
  ".lock",
  ".log",
  ".lua",
  ".manifest",
  ".mjs",
  ".md",
  ".proto",
  ".project",
  ".py",
  ".render_script",
  ".script",
  ".script_api",
  ".sh",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".yaml",
  ".yml",
]);

async function runTar(arguments_, options = {}) {
  return execFileAsync(tarExecutable, arguments_, options);
}

export function canonicalizePolicySurfaceText(file, bytes) {
  if (path.basename(file) !== "upstream.lock" && !policyTextExtensions.has(path.extname(file))) return bytes;
  const canonical = Buffer.from(bytes.toString("utf8").replaceAll("\r\n", "\n"));
  return canonical.equals(bytes) ? bytes : canonical;
}

async function canonicalizeInstalledPath(target) {
  const metadata = await lstat(target);
  if (metadata.isSymbolicLink()) throw new Error(`Policy surface cannot install a symbolic link: ${target}`);
  if (metadata.isDirectory()) {
    for (const entry of await readdir(target)) await canonicalizeInstalledPath(path.join(target, entry));
    return;
  }
  if (!metadata.isFile()) return;
  const bytes = await readFile(target);
  const canonical = canonicalizePolicySurfaceText(target, bytes);
  if (canonical !== bytes) await writeFile(target, canonical);
}

export const policySurfaceArchivePaths = Object.freeze([
  "upstream.lock",
  "packages/toolchains/defold-bundle-targets.json",
  "packages/toolchains/defold-platform-pairs.json",
  "packages/bindings/generated",
  "packages/abi/src/generated",
  "packages/sdk/src/generated",
  "packages/static-hermes/src/generated",
  "packages/compiler/src/generated",
  "defold/defold_hermes/include/defold_hermes",
  "defold/defold_hermes/src",
  "defold/defold_hermes/lib/web",
  "examples/runtime-smoke/src/generated",
  "tests/fixtures",
  ".agents/docs/research",
]);

// Toolchain files are fingerprinted as one directory because derivation owns
// other generated manifests there in addition to the two transported files.
export const policySurfaceFingerprintRoots = Object.freeze([
  "upstream.lock",
  "packages/toolchains",
  ...policySurfaceArchivePaths.filter(
    (entry) => entry !== "upstream.lock" && !entry.startsWith("packages/toolchains/"),
  ),
]);

const transportedFiles = new Set([
  "upstream.lock",
  "packages/toolchains/defold-bundle-targets.json",
  "packages/toolchains/defold-platform-pairs.json",
]);
const replacementRoots = policySurfaceArchivePaths.filter((entry) => !transportedFiles.has(entry));

function parseArguments(argv) {
  const [command, ...rest] = argv;
  const options = { command, archive: null, selectedPath: null };
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (argument === "--archive") options.archive = rest[++index];
    else if (argument === "--path") options.selectedPath = rest[++index];
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!options.archive) throw new Error(`${command || "policy-surface"} requires --archive`);
  options.archive = path.resolve(options.archive);
  return options;
}

function normalizeArchiveEntry(entry) {
  const withoutPrefix = entry.startsWith("./") ? entry.slice(2) : entry;
  return withoutPrefix.endsWith("/") ? withoutPrefix.slice(0, -1) : withoutPrefix;
}

function isDeclaredEntry(entry) {
  return policySurfaceArchivePaths.some((declared) => entry === declared || entry.startsWith(`${declared}/`));
}

async function assertDeclaredInputs() {
  for (const entry of policySurfaceArchivePaths) {
    await stat(path.join(root, entry)).catch(() => {
      throw new Error(`Policy surface input is missing: ${entry}`);
    });
  }
}

async function listArchive(archive) {
  const { stdout } = await runTar(["-tzf", archive], {
    maxBuffer: 64 * 1024 * 1024,
  });
  const entries = stdout.split(/\r?\n/u).filter(Boolean).map(normalizeArchiveEntry);
  if (
    entries.length === 0 ||
    entries.some(
      (entry) =>
        !entry ||
        entry.includes("\\") ||
        entry.includes("\0") ||
        path.posix.isAbsolute(entry) ||
        path.posix.normalize(entry) !== entry ||
        entry === ".." ||
        entry.startsWith("../") ||
        !isDeclaredEntry(entry),
    )
  ) {
    throw new Error("Policy surface archive contains an undeclared or unsafe path");
  }
  return entries;
}

export async function packPolicySurface(archive) {
  await assertDeclaredInputs();
  await mkdir(path.dirname(archive), { recursive: true });
  await runTar(["-czf", archive, ...policySurfaceArchivePaths], {
    cwd: root,
    env: { ...process.env, COPYFILE_DISABLE: "1" },
    maxBuffer: 64 * 1024 * 1024,
  });
}

export async function installPolicySurface(archive) {
  await listArchive(archive);
  for (const entry of replacementRoots) await rm(path.join(root, entry), { recursive: true, force: true });
  await runTar(["-xzf", archive, "-C", root], {
    maxBuffer: 64 * 1024 * 1024,
  });
  for (const entry of policySurfaceArchivePaths) await canonicalizeInstalledPath(path.join(root, entry));
}

export async function extractPolicySurfacePath(archive, selectedPath) {
  if (!policySurfaceArchivePaths.includes(selectedPath)) {
    throw new Error(`Policy surface does not declare ${selectedPath}`);
  }
  const entries = await listArchive(archive);
  if (!entries.some((entry) => entry === selectedPath || entry.startsWith(`${selectedPath}/`))) {
    throw new Error(`Policy surface archive does not contain ${selectedPath}`);
  }
  await runTar(["-xzf", archive, "-C", root, selectedPath], {
    maxBuffer: 64 * 1024 * 1024,
  });
  await canonicalizeInstalledPath(path.join(root, selectedPath));
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (options.command === "pack") await packPolicySurface(options.archive);
  else if (options.command === "install") await installPolicySurface(options.archive);
  else if (options.command === "extract") {
    if (!options.selectedPath) throw new Error("extract requires --path");
    await extractPolicySurfacePath(options.archive, options.selectedPath);
  } else throw new Error(`Unknown policy-surface command: ${options.command ?? ""}`);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
