import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { unzipSync } from "fflate";
import { parse as parseYaml } from "yaml";

const INDEX = "webtransport/native-artifacts.json";
const OVERLAY_MANIFEST = ".defold-webtransport-native-artifacts.json";
const SYSTEM_LIBRARIES = Object.freeze({ "x86_64-win32": new Set(["ws2_32", "bcrypt"]) });
const WEB_TARGETS = new Set(["wasm-web", "wasm_pthread-web"]);
const MAXIMUM_ARCHIVE_BYTES = 128 * 1024 * 1024;
const MAXIMUM_EXPANDED_BYTES = 256 * 1024 * 1024;
const MAXIMUM_ARCHIVE_MEMBERS = 64;

export function resolveWebTransportArtifactRoot({ environmentValue, projectValue, cwd = process.cwd(), projectRoot }) {
  if (environmentValue) return path.resolve(cwd, environmentValue);
  if (projectValue) return path.resolve(projectRoot, projectValue);
  return null;
}

export function hostWebTransportArtifactTarget(platform = process.platform, architecture = process.arch) {
  const target = {
    "darwin:arm64": "arm64-osx",
    "darwin:x64": "x86_64-osx",
    "linux:arm64": "arm64-linux",
    "linux:x64": "x86_64-linux",
    "win32:x64": "x86_64-win32"
  }[`${platform}:${architecture}`];
  if (!target) fail(`no native artifact target exists for host ${platform}/${architecture}; set artifact_target=web for a web-only project`);
  return target;
}

export function selectWebTransportArtifactTarget({
  configuredTarget,
  hasSource,
  hasArtifactRoot,
  platform = process.platform,
  architecture = process.arch
}) {
  if (configuredTarget === "web" || configuredTarget === "none") return null;
  if (configuredTarget) return configuredTarget;
  return hasSource && !hasArtifactRoot ? hostWebTransportArtifactTarget(platform, architecture) : null;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function fail(message) {
  throw new Error(`Defold WebTransport artifact: ${message}`);
}

async function regularFile(file, label) {
  let status;
  try { status = await lstat(file); }
  catch (error) {
    if (error?.code === "ENOENT") fail(`${label} is missing: ${file}`);
    throw error;
  }
  if (!status.isFile() || status.isSymbolicLink()) fail(`${label} must be a regular file: ${file}`);
}

async function filesBelow(root, prefix = "") {
  const current = path.join(root, ...prefix.split("/").filter(Boolean));
  const entries = await readdir(current, { withFileTypes: true });
  const result = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) fail(`symbolic links are not accepted: ${relative}`);
    if (entry.isDirectory()) result.push(...await filesBelow(root, relative));
    else if (entry.isFile()) result.push(relative);
    else fail(`unsupported artifact input: ${relative}`);
  }
  return result;
}

function libraryFilename(target, library) {
  return target.endsWith("-win32") ? `${library}.lib` : `lib${library}.a`;
}

export async function nativeArtifactAbiSha256(extensionSource) {
  const root = path.resolve(extensionSource);
  const manifest = await readFile(path.join(root, "ext.manifest"));
  const includeRoot = path.join(root, "include");
  const headers = await filesBelow(includeRoot);
  const hash = createHash("sha256");
  hash.update("deherm.defold-webtransport-native-abi.v1\0");
  hash.update(`ext.manifest\0${manifest.byteLength}\0`);
  hash.update(manifest);
  for (const relative of headers) {
    const bytes = await readFile(path.join(includeRoot, ...relative.split("/")));
    hash.update(`include/${relative}\0${bytes.byteLength}\0`);
    hash.update(bytes);
  }
  return hash.digest("hex");
}

function parseRows(manifestSource) {
  let manifest;
  try { manifest = parseYaml(manifestSource); }
  catch (error) { fail(`invalid ext.manifest: ${error.message}`); }
  if (!manifest?.platforms || Array.isArray(manifest.platforms) || typeof manifest.platforms !== "object") {
    fail("ext.manifest platforms must be a mapping");
  }
  const rows = [];
  for (const [target, definition] of Object.entries(manifest.platforms)) {
    if (WEB_TARGETS.has(target)) continue;
    const libraries = definition?.context?.libs;
    if (!Array.isArray(libraries) || libraries.some((name) => typeof name !== "string" || !name)) {
      fail(`${target} context.libs must be an array of names`);
    }
    const system = SYSTEM_LIBRARIES[target] ?? new Set();
    const files = libraries.filter((name) => !system.has(name)).map((name) => libraryFilename(target, name));
    rows.push({ target, files, asset: `defold-webtransport-native-${target}.zip` });
  }
  return rows.sort((left, right) => left.target < right.target ? -1 : left.target > right.target ? 1 : 0);
}

export async function readExpectedWebTransportArtifactRelease(extensionSource) {
  const root = path.resolve(extensionSource);
  const indexFile = path.join(root, INDEX);
  await regularFile(indexFile, "native artifact index");
  let index;
  try { index = JSON.parse(await readFile(indexFile, "utf8")); }
  catch (error) { fail(`invalid ${INDEX}: ${error.message}`); }
  if (index?.schemaVersion !== 1 || index.repository !== "ts-defold/deherm" ||
      !/^defold-webtransport-native-[0-9a-f]{12}$/u.test(index.tag ?? "") ||
      !/^[0-9a-f]{64}$/u.test(index.fingerprint ?? "") ||
      index.tag !== `defold-webtransport-native-${index.fingerprint.slice(0, 12)}` ||
      !/^[0-9a-f]{64}$/u.test(index.abiSha256 ?? "")) {
    fail(`${INDEX} has an invalid release identity`);
  }
  const abiSha256 = await nativeArtifactAbiSha256(root);
  if (index.abiSha256 !== abiSha256) {
    fail(`${INDEX} is not bound to the selected extension ABI; expected ${abiSha256}, recorded ${index.abiSha256}`);
  }
  const rows = parseRows(await readFile(path.join(root, "ext.manifest"), "utf8"));
  const indexedAssets = Array.isArray(index.assets) ? index.assets : [];
  if (indexedAssets.length !== rows.length || rows.some((row, position) =>
    indexedAssets[position]?.target !== row.target || indexedAssets[position]?.asset !== row.asset)) {
    fail(`${INDEX} asset inventory does not match ext.manifest`);
  }
  return { ...index, indexFile, rows };
}

function decodeArtifact(bytes, expected, row) {
  if (bytes.byteLength > MAXIMUM_ARCHIVE_BYTES) fail(`${row.asset} exceeds ${MAXIMUM_ARCHIVE_BYTES} bytes`);
  const expectedMembers = ["artifact.json", ...row.files.map((name) => `lib/${row.target}/${name}`)].sort();
  const expectedMemberSet = new Set(expectedMembers);
  let declaredExpandedBytes = 0;
  let declaredMembers = 0;
  let archive;
  try {
    archive = unzipSync(bytes, {
      filter(file) {
        ++declaredMembers;
        if (declaredMembers > MAXIMUM_ARCHIVE_MEMBERS) fail(`${row.asset} has too many members`);
        if (!expectedMemberSet.has(file.name)) fail(`${row.asset} contains unexpected member ${file.name}`);
        if (!Number.isSafeInteger(file.originalSize) || file.originalSize < 0) fail(`${row.asset} has an invalid member size`);
        declaredExpandedBytes += file.originalSize;
        if (declaredExpandedBytes > MAXIMUM_EXPANDED_BYTES) fail(`${row.asset} expands beyond ${MAXIMUM_EXPANDED_BYTES} bytes`);
        return true;
      }
    });
  }
  catch (error) { fail(`${row.asset} is not a valid ZIP: ${error.message}`); }
  const members = Object.keys(archive).sort();
  if (members.length !== expectedMembers.length || members.some((name, index) => name !== expectedMembers[index])) {
    fail(`${row.asset} members differ from the exact target inventory`);
  }
  const expandedBytes = Object.values(archive).reduce((sum, value) => sum + value.byteLength, 0);
  if (expandedBytes > MAXIMUM_EXPANDED_BYTES) fail(`${row.asset} expands beyond ${MAXIMUM_EXPANDED_BYTES} bytes`);
  let metadata;
  try { metadata = JSON.parse(Buffer.from(archive["artifact.json"]).toString("utf8")); }
  catch (error) { fail(`${row.asset} artifact.json is invalid: ${error.message}`); }
  if (metadata?.schemaVersion !== 1 || metadata.target !== row.target || metadata.fingerprint !== expected.fingerprint) {
    fail(`${row.asset} identity does not match expected tag ${expected.tag} and fingerprint ${expected.fingerprint}`);
  }
  if (!Array.isArray(metadata.files) || metadata.files.length !== row.files.length) fail(`${row.asset} file inventory is invalid`);
  for (const name of row.files) {
    const record = metadata.files.find((candidate) => candidate?.name === name);
    const member = archive[`lib/${row.target}/${name}`];
    if (!record || record.bytes !== member.byteLength || record.sha256 !== sha256(member)) {
      fail(`${row.asset} ${name} does not match artifact.json`);
    }
  }
  return { archive, metadata, archiveSha256: sha256(bytes) };
}

async function readGithubReleaseAsset(expected, row, fetchImpl) {
  const metadataUrl = `https://api.github.com/repos/${expected.repository}/releases/tags/${encodeURIComponent(expected.tag)}`;
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  let response;
  try { response = await fetchImpl(metadataUrl, {
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "deherm-webtransport-artifact-client",
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    redirect: "follow"
  }); }
  catch (error) { fail(`release metadata lookup failed for ${metadataUrl}: ${error.message}`); }
  if (!response.ok) fail(`release metadata lookup failed (${response.status}) for ${metadataUrl}`);
  let release;
  try { release = await response.json(); }
  catch (error) { fail(`release metadata is invalid for ${expected.tag}: ${error.message}`); }
  if (release?.tag_name !== expected.tag || !Array.isArray(release.assets)) {
    fail(`release metadata identity does not match ${expected.tag}`);
  }
  const matches = release.assets.filter((candidate) => candidate?.name === row.asset);
  if (matches.length !== 1) fail(`release ${expected.tag} must contain exactly one ${row.asset}; found ${matches.length}`);
  const asset = matches[0];
  const expectedUrl = `https://github.com/${expected.repository}/releases/download/${expected.tag}/${row.asset}`;
  const digest = /^sha256:([0-9a-f]{64})$/u.exec(asset.digest ?? "");
  if (asset.state !== "uploaded" || asset.browser_download_url !== expectedUrl || !digest) {
    fail(`release metadata for ${expected.tag}/${row.asset} has no usable GitHub-computed SHA-256 identity`);
  }
  return { metadataUrl, downloadUrl: expectedUrl, sha256: digest[1] };
}

export async function verifyPublishedWebTransportArtifact({ extensionSource, target, archiveBytes }) {
  const expected = await readExpectedWebTransportArtifactRelease(extensionSource);
  const row = expected.rows.find((candidate) => candidate.target === target);
  if (!row) fail(`target ${target} is not a native target in ext.manifest`);
  return { expected, row, ...decodeArtifact(archiveBytes, expected, row) };
}

async function stageDecodedArtifact({ verified, outputRoot }) {
  const resolvedOutput = path.resolve(outputRoot);
  const temporaryRoot = `${resolvedOutput}.tmp-${randomUUID()}`;
  const manifest = {
    schemaVersion: 1,
    tag: verified.expected.tag,
    fingerprint: verified.expected.fingerprint,
    abiSha256: verified.expected.abiSha256,
    artifacts: [{
      target: verified.row.target,
      asset: verified.row.asset,
      sha256: verified.archiveSha256,
      files: verified.metadata.files
    }]
  };
  try {
    for (const file of verified.metadata.files) {
      const destination = path.join(temporaryRoot, "lib", verified.row.target, file.name);
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, verified.archive[`lib/${verified.row.target}/${file.name}`]);
    }
    await writeFile(path.join(temporaryRoot, OVERLAY_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
    await rm(resolvedOutput, { recursive: true, force: true });
    await rename(temporaryRoot, resolvedOutput);
    return { root: resolvedOutput, manifest };
  } catch (error) {
    await rm(temporaryRoot, { recursive: true, force: true });
    throw error;
  }
}

export async function fetchWebTransportArtifactOverlay({
  extensionSource,
  target,
  cacheRoot,
  fetchImpl = globalThis.fetch
}) {
  if (typeof fetchImpl !== "function") fail("no fetch implementation is available");
  const expected = await readExpectedWebTransportArtifactRelease(extensionSource);
  const row = expected.rows.find((candidate) => candidate.target === target);
  if (!row) fail(`target ${target} is not a native target in ext.manifest`);
  const familyRoot = path.join(path.resolve(cacheRoot), expected.fingerprint);
  const archivePath = path.join(familyRoot, row.asset);
  const overlayRoot = path.join(familyRoot, "staged", target);
  let bytes;
  try {
    await regularFile(archivePath, "cached artifact");
    bytes = await readFile(archivePath);
    const verified = { expected, row, ...decodeArtifact(bytes, expected, row) };
    return { ...(await stageDecodedArtifact({ verified, outputRoot: overlayRoot })), source: "cache", archivePath };
  } catch (error) {
    if (error?.code !== "ENOENT" && !String(error?.message).startsWith("Defold WebTransport artifact:")) throw error;
    await rm(archivePath, { force: true });
  }
  const releaseAsset = await readGithubReleaseAsset(expected, row, fetchImpl);
  const url = releaseAsset.downloadUrl;
  let response;
  try { response = await fetchImpl(url, { redirect: "follow" }); }
  catch (error) { fail(`download failed for ${url}: ${error.message}`); }
  if (!response.ok) fail(`download failed (${response.status}) for ${url}`);
  const contentLength = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAXIMUM_ARCHIVE_BYTES) {
    fail(`download for ${url} declares ${contentLength} bytes, above the ${MAXIMUM_ARCHIVE_BYTES}-byte limit`);
  }
  bytes = new Uint8Array(await response.arrayBuffer());
  const observedArchiveSha256 = sha256(bytes);
  if (observedArchiveSha256 !== releaseAsset.sha256) {
    fail(`GitHub release digest mismatch for ${url}; expected ${releaseAsset.sha256}, observed ${observedArchiveSha256}. The immutable release asset is corrupt or was replaced.`);
  }
  let verified;
  try { verified = { expected, row, ...decodeArtifact(bytes, expected, row) }; }
  catch (error) {
    fail(`${error.message}. Immutable asset ${url} has SHA-256 ${observedArchiveSha256}; it cannot be overwritten in place. Quarantine/delete the corrupt release asset or rotate the input fingerprint before publishing.`);
  }
  await mkdir(familyRoot, { recursive: true });
  const temporary = `${archivePath}.tmp-${process.pid}`;
  await writeFile(temporary, bytes, { flag: "wx" });
  await rename(temporary, archivePath);
  return { ...(await stageDecodedArtifact({ verified, outputRoot: overlayRoot })), source: "download", archivePath, url };
}

export async function validateWebTransportArtifactOverlay({ extensionSource, overlayRoot }) {
  const expected = await readExpectedWebTransportArtifactRelease(extensionSource);
  const root = path.resolve(overlayRoot);
  const manifestFile = path.join(root, OVERLAY_MANIFEST);
  await regularFile(manifestFile, "artifact overlay manifest");
  let manifest;
  try { manifest = JSON.parse(await readFile(manifestFile, "utf8")); }
  catch (error) { fail(`invalid overlay manifest: ${error.message}`); }
  if (manifest?.schemaVersion !== 1 || manifest.tag !== expected.tag ||
      manifest.fingerprint !== expected.fingerprint || manifest.abiSha256 !== expected.abiSha256 ||
      !Array.isArray(manifest.artifacts) || manifest.artifacts.length === 0) {
    fail(`overlay identity does not match selected extension release ${expected.tag}`);
  }
  const allowed = new Set([OVERLAY_MANIFEST]);
  const files = [];
  const targets = new Set();
  for (const artifact of manifest.artifacts) {
    const row = expected.rows.find((candidate) => candidate.target === artifact?.target);
    if (!row || targets.has(row.target) || artifact.asset !== row.asset || !Array.isArray(artifact.files) ||
        artifact.files.length !== row.files.length) fail("overlay artifact inventory is invalid");
    targets.add(row.target);
    for (const name of row.files) {
      const record = artifact.files.find((candidate) => candidate?.name === name);
      const relative = `lib/${row.target}/${name}`;
      const absolute = path.join(root, ...relative.split("/"));
      await regularFile(absolute, relative);
      const bytes = await readFile(absolute);
      if (!record || record.bytes !== bytes.byteLength || record.sha256 !== sha256(bytes)) {
        fail(`${relative} does not match the overlay manifest`);
      }
      allowed.add(relative);
      files.push({ target: row.target, name, source: absolute, bytes: bytes.byteLength, sha256: record.sha256 });
    }
  }
  const observed = await filesBelow(root);
  const unexpected = observed.filter((relative) => !allowed.has(relative));
  if (unexpected.length) fail(`overlay contains uninventoried members: ${unexpected.join(", ")}`);
  return {
    root,
    files,
    targets: [...targets].sort(),
    identity: {
      tag: expected.tag,
      fingerprint: expected.fingerprint,
      abiSha256: expected.abiSha256,
      manifestSha256: sha256(await readFile(manifestFile)),
      filesSha256: sha256(Buffer.from(JSON.stringify(files.map(({ target, name, bytes, sha256: digest }) =>
        ({ target, name, bytes, sha256: digest })))))
    }
  };
}
