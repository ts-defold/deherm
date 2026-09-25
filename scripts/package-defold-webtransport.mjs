#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { unzipSync, zipSync } from "fflate";
import { parse as parseYaml } from "yaml";
import { readExpectedWebTransportArtifactRelease } from "../packages/cli/src/webtransport-artifacts.mjs";

export const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const defaultSourceRoot = path.join(repositoryRoot, "extensions/defold-webtransport");
export const defaultOutputRoot = path.join(repositoryRoot, "build/releases");
export const extensionDirectory = "defold_webtransport";

const fixedZipTime = new Date(1980, 0, 1, 0, 0, 0);
const regularFileMode = 0o100644 << 16;
const versionPattern = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

function compare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function fail(message) {
  throw new Error(`defold-webtransport package: ${message}`);
}

function normalizeVersion(value, label) {
  const version = value.trim();
  if (!versionPattern.test(version)) fail(`${label} must be a SemVer version, received ${JSON.stringify(version)}`);
  return version;
}

async function assertRegularFile(file, label) {
  let status;
  try {
    status = await lstat(file);
  } catch (error) {
    if (error?.code === "ENOENT") fail(`missing ${label}: ${file}`);
    throw error;
  }
  if (!status.isFile() || status.isSymbolicLink()) fail(`${label} must be a regular file: ${file}`);
}

async function collectFiles(root, relative = "") {
  const directory = path.join(root, relative);
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => compare(left.name, right.name))) {
    const childRelative = relative ? path.posix.join(relative, entry.name) : entry.name;
    const child = path.join(root, ...childRelative.split("/"));
    const status = await lstat(child);
    if (status.isSymbolicLink()) fail(`symbolic links are not release inputs: ${childRelative}`);
    if (status.isDirectory()) files.push(...await collectFiles(root, childRelative));
    else if (status.isFile()) files.push(childRelative);
    else fail(`unsupported release input: ${childRelative}`);
  }
  return files;
}

function validateMembers(members) {
  if (!members.includes("game.project")) fail("archive has no root game.project");
  const unexpected = members.filter((member) =>
    member !== "game.project" && !member.startsWith(`${extensionDirectory}/`));
  if (unexpected.length > 0) fail(`archive has unexpected root members: ${unexpected.join(", ")}`);
  if (!members.includes(`${extensionDirectory}/ext.manifest`)) fail("extension has no ext.manifest");
  if (!members.includes(`${extensionDirectory}/script/defold_webtransport.script_api`)) {
    fail("extension has no script/defold_webtransport.script_api documentation");
  }
  if (!members.includes(`${extensionDirectory}/webtransport/defold-hermes.bindings.json`)) {
    fail("extension has no additive webtransport/defold-hermes.bindings.json descriptor");
  }
  if (!members.includes(`${extensionDirectory}/webtransport/public-api-compatibility.json`)) {
    fail("extension has no webtransport/public-api-compatibility.json contract");
  }
  if (!members.includes(`${extensionDirectory}/webtransport/native-artifacts.json`)) {
    fail("extension has no webtransport/native-artifacts.json release index");
  }
  if (!members.some((member) =>
    member.startsWith(`${extensionDirectory}/include/defold_webtransport/`) && member.endsWith(".h"))) {
    fail("extension has no public C ABI header under include/defold_webtransport");
  }
}

function validateRuntimeArtifacts(members, manifestSource) {
  let manifest;
  try { manifest = parseYaml(manifestSource); }
  catch (error) { fail(`invalid ext.manifest: ${error.message}`); }
  const platforms = manifest?.platforms;
  if (platforms !== undefined && (!platforms || Array.isArray(platforms) || typeof platforms !== "object")) {
    fail("ext.manifest platforms must be a mapping");
  }
  const memberSet = new Set(members);
  const webBackend = `${extensionDirectory}/lib/web/library_defold_webtransport.js`;
  if (!memberSet.has(webBackend)) fail(`extension has no functional HTML5 backend: ${webBackend}`);
  const systemLibraries = new Map([["x86_64-win32", new Set(["ws2_32", "bcrypt"])] ]);
  for (const [platform, definition] of Object.entries(platforms ?? {})) {
    if (platform === "wasm-web" || platform === "wasm_pthread-web") continue;
    const libraries = definition?.context?.libs ?? [];
    if (!Array.isArray(libraries) || libraries.some((library) => typeof library !== "string" || !library)) {
      fail(`ext.manifest ${platform} context.libs must be an array of library names`);
    }
    const system = systemLibraries.get(platform) ?? new Set();
    for (const library of libraries) {
      if (system.has(library)) continue;
      const filename = platform.endsWith("-win32") ? `${library}.lib` : `lib${library}.a`;
      const member = `${extensionDirectory}/lib/${platform}/${filename}`;
      if (!memberSet.has(member)) fail(`declared ${platform} library is absent from the release: ${member}`);
    }
  }
}

export async function describeDefoldWebtransportPackage({
  sourceRoot = defaultSourceRoot,
  requestedVersion
} = {}) {
  const versionFile = path.join(sourceRoot, "VERSION");
  await assertRegularFile(versionFile, "VERSION");
  const version = normalizeVersion(await readFile(versionFile, "utf8"), "VERSION");
  if (requestedVersion !== undefined && normalizeVersion(requestedVersion, "--version") !== version) {
    fail(`requested version ${requestedVersion} does not match VERSION ${version}`);
  }

  const gameProjectFile = path.join(sourceRoot, "game.project");
  await assertRegularFile(gameProjectFile, "root game.project");
  const gameProject = await readFile(gameProjectFile, "utf8");
  const projectVersion = /^version\s*=\s*([^\s#]+)\s*$/mu.exec(gameProject)?.[1];
  if (projectVersion !== version) {
    fail(`game.project version ${projectVersion ?? "<missing>"} does not match VERSION ${version}`);
  }
  const extensionRoot = path.join(sourceRoot, extensionDirectory);
  let extensionStatus;
  try {
    extensionStatus = await lstat(extensionRoot);
  } catch (error) {
    if (error?.code === "ENOENT") fail(`missing extension directory: ${extensionRoot}`);
    throw error;
  }
  if (!extensionStatus.isDirectory() || extensionStatus.isSymbolicLink()) {
    fail(`extension root must be a directory: ${extensionRoot}`);
  }

  const members = [
    "game.project",
    ...(await collectFiles(extensionRoot)).map((file) => path.posix.join(extensionDirectory, file))
  ].sort(compare);
  validateMembers(members);
  validateRuntimeArtifacts(members, await readFile(path.join(extensionRoot, "ext.manifest"), "utf8"));
  await readExpectedWebTransportArtifactRelease(extensionRoot);
  const publicContractFile = path.join(extensionRoot, "webtransport/public-api-compatibility.json");
  let publicContract;
  try {
    publicContract = JSON.parse(await readFile(publicContractFile, "utf8"));
  } catch (error) {
    fail(`invalid public API compatibility contract ${publicContractFile}: ${error.message}`);
  }
  if (publicContract?.schemaVersion !== 1) fail("public API compatibility schemaVersion must be 1");
  if (publicContract?.contractVersion !== version) {
    fail(`public API contract version ${publicContract?.contractVersion ?? "<missing>"} does not match VERSION ${version}`);
  }
  return {
    version,
    assetName: `defold-webtransport-${version}.zip`,
    sourceRoot: path.resolve(sourceRoot),
    members
  };
}

async function readMembers(description) {
  const entries = new Map();
  for (const member of description.members) {
    const source = member === "game.project"
      ? path.join(description.sourceRoot, member)
      : path.join(description.sourceRoot, ...member.split("/"));
    await assertRegularFile(source, `archive member ${member}`);
    entries.set(member, new Uint8Array(await readFile(source)));
  }
  return entries;
}

function encodeArchive(entries) {
  const input = {};
  for (const [member, bytes] of entries) {
    input[member] = [bytes, { attrs: regularFileMode, mtime: fixedZipTime, os: 3 }];
  }
  return zipSync(input, { level: 9 });
}

function verifyArchive(bytes, expectedMembers) {
  const decoded = unzipSync(bytes);
  const observedMembers = Object.keys(decoded).sort(compare);
  assertSameMembers(observedMembers, expectedMembers);
  validateMembers(observedMembers);
}

function assertSameMembers(observed, expected) {
  if (observed.length !== expected.length || observed.some((member, index) => member !== expected[index])) {
    fail(`archive members differ from staged inputs; expected ${expected.join(", ")}, observed ${observed.join(", ")}`);
  }
}

async function stageMembers(entries, stageRoot) {
  await rm(stageRoot, { recursive: true, force: true });
  for (const [member, bytes] of entries) {
    const destination = path.join(stageRoot, ...member.split("/"));
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, bytes, { mode: 0o644 });
  }
}

export async function packageDefoldWebtransport({
  sourceRoot = defaultSourceRoot,
  outputRoot = defaultOutputRoot,
  stageRoot,
  requestedVersion
} = {}) {
  const description = await describeDefoldWebtransportPackage({ sourceRoot, requestedVersion });
  const entries = await readMembers(description);
  const archive = encodeArchive(entries);
  verifyArchive(archive, description.members);

  await mkdir(outputRoot, { recursive: true });
  const archivePath = path.join(outputRoot, description.assetName);
  await writeFile(archivePath, archive);
  if (stageRoot) await stageMembers(entries, stageRoot);

  return {
    ...description,
    archivePath,
    stageRoot: stageRoot ? path.resolve(stageRoot) : undefined,
    sha256: createHash("sha256").update(archive).digest("hex")
  };
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (!next || next.startsWith("--")) fail(`${argument} requires a value`);
      index += 1;
      return next;
    };
    if (argument === "--source") options.sourceRoot = path.resolve(value());
    else if (argument === "--output") options.outputRoot = path.resolve(value());
    else if (argument === "--stage") options.stageRoot = path.resolve(value());
    else if (argument === "--version") options.requestedVersion = value();
    else fail(`unknown argument ${argument}`);
  }
  return options;
}

export async function run(argv = process.argv.slice(2)) {
  const result = await packageDefoldWebtransport(parseArguments(argv));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await run();
}
