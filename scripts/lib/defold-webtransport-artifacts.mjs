import { createHash } from "node:crypto";
import { cp, lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { unzipSync, zipSync } from "fflate";
import { parse as parseYaml } from "yaml";
import { nativeArtifactAbiSha256 } from "../../packages/cli/src/webtransport-artifacts.mjs";

export const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const extensionSourceRoot = path.join(repositoryRoot, "extensions", "defold-webtransport");
export const extensionDirectory = "defold_webtransport";
export const nativeArtifactSchemaVersion = 1;
export const nativeArtifactTagDigestLength = 12;

const manifestRelative = "extensions/defold-webtransport/defold_webtransport/ext.manifest";
const fixedZipTime = new Date(1980, 0, 1, 0, 0, 0);
const regularFileMode = 0o100644 << 16;
const systemLibraries = Object.freeze({ "x86_64-win32": new Set(["ws2_32", "bcrypt"]) });
const webTargets = new Set(["wasm-web", "wasm_pthread-web"]);

const executors = Object.freeze({
  "x86_64-linux": { lane: "linux", runner: "ubuntu-24.04", slot: 0 },
  "arm64-linux": { lane: "linux", runner: "ubuntu-24.04-arm", slot: 1 },
  "x86_64-win32": { lane: "windows", runner: "windows-2025", slot: 0 },
  "armv7-android": { lane: "android", runner: "ubuntu-24.04", abi: "armeabi-v7a", slot: 0 },
  "arm64-android": { lane: "android", runner: "ubuntu-24.04", abi: "arm64-v8a", slot: 1 },
  "x86_64-android": { lane: "android", runner: "ubuntu-24.04", abi: "x86_64", slot: 2 },
  "arm64-osx": { lane: "apple", runner: "macos-15", slot: 0 },
  "x86_64-osx": { lane: "apple", runner: "macos-15", slot: 1 },
  "arm64-ios": { lane: "apple", runner: "macos-15", slot: 2 },
  "arm64_sim-ios": { lane: "apple", runner: "macos-15", slot: 3 }
});

function compare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function fail(message) {
  throw new Error(`defold-webtransport native artifact: ${message}`);
}

function libraryFilename(target, library) {
  return target.endsWith("-win32") ? `${library}.lib` : `lib${library}.a`;
}

async function filesBelow(directory, prefix = "") {
  const result = [];
  const current = path.join(directory, ...prefix.split("/").filter(Boolean));
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => compare(left.name, right.name))) {
    const relative = prefix ? path.posix.join(prefix, entry.name) : entry.name;
    const absolute = path.join(directory, ...relative.split("/"));
    const status = await lstat(absolute);
    if (status.isSymbolicLink()) fail(`symbolic links are not artifact inputs: ${absolute}`);
    if (status.isDirectory()) result.push(...await filesBelow(directory, relative));
    else if (status.isFile()) result.push(relative);
  }
  return result;
}

export async function readNativeArtifactRows({ root = repositoryRoot } = {}) {
  const manifestFile = path.join(root, manifestRelative);
  let manifest;
  try {
    manifest = parseYaml(await readFile(manifestFile, "utf8"));
  } catch (error) {
    fail(`cannot parse ${manifestRelative}: ${error.message}`);
  }
  const platforms = manifest?.platforms;
  if (!platforms || Array.isArray(platforms) || typeof platforms !== "object") {
    fail(`${manifestRelative} platforms must be a mapping`);
  }
  const rows = [];
  for (const [target, definition] of Object.entries(platforms)) {
    if (webTargets.has(target)) continue;
    const executor = executors[target];
    if (!executor) fail(`no build executor is declared for manifest target ${target}`);
    const declared = definition?.context?.libs;
    if (!Array.isArray(declared) || declared.some((name) => typeof name !== "string" || !name)) {
      fail(`${target} context.libs must be a non-empty string array`);
    }
    const system = systemLibraries[target] ?? new Set();
    const libraries = declared.filter((name) => !system.has(name));
    if (libraries.length === 0) fail(`${target} declares no bundled native libraries`);
    rows.push({
      target,
      libraries,
      files: libraries.map((name) => libraryFilename(target, name)),
      asset: `defold-webtransport-native-${target}.zip`,
      ...executor
    });
  }
  return rows.sort((left, right) => compare(left.target, right.target));
}

const fingerprintFiles = Object.freeze([
  manifestRelative,
  "scripts/lib/defold-webtransport-artifacts.mjs",
  "scripts/manage-defold-webtransport-artifacts.mjs",
  ".github/workflows/defold-webtransport-native-artifacts.yml"
]);

const nativeToolchainFile = "packages/toolchains/defold-bundle-targets.json";
const nativeToolchainKeys = Object.freeze([
  "androidNdkVersion",
  "androidNdkApiVersion",
  "android64NdkApiVersion",
  "iphoneosVersionMin",
  "macosxVersionMin"
]);

const fingerprintTrees = Object.freeze([
  "native/webtransport-cpp/cmake",
  "native/webtransport-cpp/include",
  "native/webtransport-cpp/patches",
  "native/webtransport-cpp/src",
  "extensions/defold-webtransport/defold_webtransport/include"
]);

export async function fingerprintNativeArtifacts({ root = repositoryRoot } = {}) {
  const hash = createHash("sha256");
  hash.update("deherm.defold-webtransport-native-artifacts.v2\0");
  const relatives = [...fingerprintFiles, "native/webtransport-cpp/CMakeLists.txt"];
  for (const tree of fingerprintTrees) {
    for (const relative of await filesBelow(path.join(root, tree))) relatives.push(path.posix.join(tree, relative));
  }
  for (const relative of [...new Set(relatives)].sort(compare)) {
    const bytes = await readFile(path.join(root, ...relative.split("/")));
    hash.update(`${relative}\0${bytes.byteLength}\0`);
    hash.update(bytes);
  }
  const toolchains = JSON.parse(await readFile(path.join(root, nativeToolchainFile), "utf8"));
  const projection = Object.fromEntries(nativeToolchainKeys.map((key) => {
    const value = toolchains?.sdk?.[key];
    if (typeof value !== "string" || value.length === 0) fail(`${nativeToolchainFile} sdk.${key} is required`);
    return [key, value];
  }));
  hash.update(`${nativeToolchainFile}#native-sdk\0`);
  hash.update(JSON.stringify(projection));
  return hash.digest("hex");
}

export async function nativeArtifactRelease(options = {}) {
  const fingerprint = await fingerprintNativeArtifacts(options);
  const short = fingerprint.slice(0, nativeArtifactTagDigestLength);
  return {
    tag: `defold-webtransport-native-${short}`,
    fingerprint,
    title: `Defold WebTransport native archives ${short}`,
    notes: [
      "Pinned native WebTransport libraries, one immutable archive per Defold target.",
      "",
      `Input fingerprint (SHA-256): \`${fingerprint}\``,
      "",
      "The tag is content-addressed from the pinned picoquic/picotls/Mbed TLS build graph, " +
        "the Defold SDK target inputs, the extension ABI, and the deterministic archive recipe."
    ].join("\n")
  };
}

export async function nativeArtifactIndex({ root = repositoryRoot } = {}) {
  const release = await nativeArtifactRelease({ root });
  const rows = await readNativeArtifactRows({ root });
  const extensionRoot = path.join(root, "extensions", "defold-webtransport", extensionDirectory);
  return {
    schemaVersion: 1,
    repository: "ts-defold/deherm",
    tag: release.tag,
    fingerprint: release.fingerprint,
    abiSha256: await nativeArtifactAbiSha256(extensionRoot),
    assets: rows.map(({ target, asset }) => ({ target, asset }))
  };
}

export async function writeNativeArtifactIndex({ root = repositoryRoot, check = false } = {}) {
  const index = await nativeArtifactIndex({ root });
  const destination = path.join(root, "extensions", "defold-webtransport", extensionDirectory, "webtransport", "native-artifacts.json");
  const rendered = `${JSON.stringify(index, null, 2)}\n`;
  if (check) {
    let current;
    try { current = await readFile(destination, "utf8"); }
    catch (error) { if (error?.code !== "ENOENT") throw error; }
    if (current !== rendered) fail(`generated native artifact index is stale: ${destination}`);
  } else {
    await writeFile(destination, rendered);
  }
  return { destination, index };
}

export async function planNativeArtifactBuilds(present = [], options = {}) {
  const known = new Set(present);
  const rows = await readNativeArtifactRows(options);
  const missing = rows.filter((row) => !known.has(row.asset));
  const lanes = { linux: [], windows: [], android: [], apple: [] };
  for (const row of missing) lanes[row.lane].push(row);
  return {
    rows,
    missing,
    lanes,
    expectedAssets: rows.map((row) => row.asset),
    complete: missing.length === 0
  };
}

function encodeZip(entries) {
  const input = {};
  for (const [name, bytes] of [...entries].sort(([left], [right]) => compare(left, right))) {
    input[name] = [bytes, { attrs: regularFileMode, mtime: fixedZipTime, os: 3 }];
  }
  return zipSync(input, { level: 9 });
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function locateLibraries(inputRoot, row) {
  const available = await filesBelow(inputRoot);
  const selected = new Map();
  for (const filename of row.files) {
    const matches = available.filter((relative) => path.posix.basename(relative) === filename);
    if (matches.length !== 1) {
      fail(`${row.target} requires exactly one ${filename} below ${inputRoot}; found ${matches.length}`);
    }
    selected.set(filename, new Uint8Array(await readFile(path.join(inputRoot, ...matches[0].split("/")))));
  }
  return selected;
}

export async function packageNativeArtifact({ target, inputRoot, outputRoot, root = repositoryRoot }) {
  const row = (await readNativeArtifactRows({ root })).find((candidate) => candidate.target === target);
  if (!row) fail(`unknown native target ${target}`);
  const release = await nativeArtifactRelease({ root });
  const libraries = await locateLibraries(path.resolve(inputRoot), row);
  const fileRecords = row.files.map((name) => ({ name, sha256: sha256(libraries.get(name)), bytes: libraries.get(name).byteLength }));
  const metadata = {
    schemaVersion: nativeArtifactSchemaVersion,
    target,
    fingerprint: release.fingerprint,
    files: fileRecords
  };
  const entries = new Map([["artifact.json", Buffer.from(`${JSON.stringify(metadata, null, 2)}\n`)]]);
  for (const [name, bytes] of libraries) entries.set(`lib/${target}/${name}`, bytes);
  const archive = encodeZip(entries);
  await mkdir(outputRoot, { recursive: true });
  const archivePath = path.join(outputRoot, row.asset);
  await writeFile(archivePath, archive);
  await verifyNativeArtifact({ target, archivePath, root });
  return { ...row, archivePath, fingerprint: release.fingerprint, sha256: sha256(archive) };
}

export async function verifyNativeArtifact({ target, archivePath, root = repositoryRoot }) {
  const row = (await readNativeArtifactRows({ root })).find((candidate) => candidate.target === target);
  if (!row) fail(`unknown native target ${target}`);
  const archive = unzipSync(await readFile(archivePath));
  const expectedMembers = ["artifact.json", ...row.files.map((name) => `lib/${target}/${name}`)].sort(compare);
  const observed = Object.keys(archive).sort(compare);
  if (observed.length !== expectedMembers.length || observed.some((name, index) => name !== expectedMembers[index])) {
    fail(`${target} archive members differ; expected ${expectedMembers.join(", ")}, observed ${observed.join(", ")}`);
  }
  let metadata;
  try { metadata = JSON.parse(Buffer.from(archive["artifact.json"]).toString("utf8")); }
  catch (error) { fail(`${target} artifact.json is invalid: ${error.message}`); }
  const release = await nativeArtifactRelease({ root });
  if (metadata.schemaVersion !== nativeArtifactSchemaVersion || metadata.target !== target) {
    fail(`${target} artifact metadata identity is invalid`);
  }
  if (metadata.fingerprint !== release.fingerprint) fail(`${target} artifact fingerprint is stale`);
  if (!Array.isArray(metadata.files) || metadata.files.length !== row.files.length) fail(`${target} artifact file inventory is invalid`);
  for (const name of row.files) {
    const record = metadata.files.find((candidate) => candidate?.name === name);
    const bytes = archive[`lib/${target}/${name}`];
    if (!record || record.bytes !== bytes.byteLength || record.sha256 !== sha256(bytes)) {
      fail(`${target} ${name} digest or byte count does not match artifact.json`);
    }
  }
  return { row, metadata, archive, sha256: sha256(await readFile(archivePath)) };
}

export async function assembleNativeArtifacts({ sourceRoot = extensionSourceRoot, archiveRoot, outputRoot, root = repositoryRoot }) {
  const rows = await readNativeArtifactRows({ root });
  await rm(outputRoot, { recursive: true, force: true });
  await mkdir(outputRoot, { recursive: true });
  await cp(sourceRoot, outputRoot, { recursive: true, force: false, errorOnExist: false });
  const extensionRoot = path.join(outputRoot, extensionDirectory);
  for (const row of rows) await rm(path.join(extensionRoot, "lib", row.target), { recursive: true, force: true });
  const artifacts = [];
  for (const row of rows) {
    const archivePath = path.join(archiveRoot, row.asset);
    const verified = await verifyNativeArtifact({ target: row.target, archivePath, root });
    for (const name of row.files) {
      const destination = path.join(extensionRoot, "lib", row.target, name);
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, verified.archive[`lib/${row.target}/${name}`]);
    }
    artifacts.push({ target: row.target, asset: row.asset, sha256: verified.sha256, files: verified.metadata.files });
  }
  const release = await nativeArtifactRelease({ root });
  const manifest = {
    schemaVersion: 1,
    tag: release.tag,
    fingerprint: release.fingerprint,
    abiSha256: await nativeArtifactAbiSha256(path.join(outputRoot, extensionDirectory)),
    artifacts
  };
  await writeFile(path.join(outputRoot, ".defold-webtransport-native-artifacts.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return { outputRoot: path.resolve(outputRoot), ...manifest };
}

export async function stageNativeArtifactOverlay({ target, archivePath, outputRoot, root = repositoryRoot }) {
  const verified = await verifyNativeArtifact({ target, archivePath, root });
  await rm(outputRoot, { recursive: true, force: true });
  for (const name of verified.row.files) {
    const destination = path.join(outputRoot, "lib", target, name);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, verified.archive[`lib/${target}/${name}`]);
  }
  const release = await nativeArtifactRelease({ root });
  const manifest = {
    schemaVersion: 1,
    tag: release.tag,
    fingerprint: release.fingerprint,
    abiSha256: await nativeArtifactAbiSha256(path.join(root, "extensions", "defold-webtransport", extensionDirectory)),
    artifacts: [{ target, asset: verified.row.asset, sha256: verified.sha256, files: verified.metadata.files }]
  };
  await writeFile(path.join(outputRoot, ".defold-webtransport-native-artifacts.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return { outputRoot: path.resolve(outputRoot), ...manifest };
}

export async function auditNativeArtifactDirectory({ archiveRoot, partial = false, root = repositoryRoot }) {
  const rows = await readNativeArtifactRows({ root });
  const release = await nativeArtifactRelease({ root });
  let names = [];
  try { names = (await readdir(archiveRoot)).filter((name) => name.endsWith(".zip")).sort(compare); }
  catch (error) { if (error?.code !== "ENOENT") throw error; }
  const expected = new Set(rows.map(({ asset }) => asset));
  const unexpected = names.filter((name) => !expected.has(name));
  if (unexpected.length) fail(`release directory contains unexpected assets: ${unexpected.join(", ")}`);
  if (!partial) {
    const missing = rows.map(({ asset }) => asset).filter((asset) => !names.includes(asset));
    if (missing.length) fail(`release ${release.tag} is incomplete; missing ${missing.join(", ")}`);
  }
  const verified = [];
  for (const row of rows.filter(({ asset }) => names.includes(asset))) {
    const archivePath = path.join(archiveRoot, row.asset);
    try {
      const result = await verifyNativeArtifact({ target: row.target, archivePath, root });
      verified.push({ target: row.target, asset: row.asset, sha256: result.sha256 });
    } catch (error) {
      fail(`${release.tag}/${row.asset} is corrupt or foreign: ${error.message}. This content-addressed asset is immutable; quarantine/delete the bad release asset or rotate a real fingerprint input before republishing.`);
    }
  }
  return { tag: release.tag, fingerprint: release.fingerprint, complete: names.length === rows.length, verified };
}
