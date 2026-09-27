import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const defoldSdkExtractionManifestName = ".deherm-sdk-extraction-manifest.json";

const manifestKind = "deherm.defold-sdk-extraction-manifest";
const digestPattern = /^[0-9a-f]{64}$/u;
const reservedNames = new Set([
  defoldSdkExtractionManifestName,
  `${defoldSdkExtractionManifestName}.tmp`,
  ".deherm-sdk-sha256",
]);

function compareMemberPaths(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertDigest(value, label) {
  if (!digestPattern.test(value ?? "")) throw new Error(`${label} is not a lowercase SHA-256 digest`);
}

function assertMemberPath(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    path.posix.isAbsolute(value) ||
    value.includes("\\") ||
    value.split("/").includes("..")
  ) {
    throw new Error(`Invalid Defold SDK extraction manifest member path: ${JSON.stringify(value)}`);
  }
}

async function sha256File(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

async function inventoryFiles(root, relative = "") {
  const entries = await readdir(path.join(root, relative), { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, "en"))) {
    if (!relative && reservedNames.has(entry.name)) continue;
    const member = relative ? `${relative}/${entry.name}` : entry.name;
    const absolute = path.join(root, ...member.split("/"));
    if (entry.isDirectory()) {
      files.push(...(await inventoryFiles(root, member)));
      continue;
    }
    if (!entry.isFile()) throw new Error(`Unsupported non-file Defold SDK archive member: ${member}`);
    const metadata = await lstat(absolute);
    files.push({ path: member, size: metadata.size, sha256: await sha256File(absolute) });
  }
  return files;
}

export async function createDefoldSdkExtractionManifest({ sdkRoot, archiveSha256 }) {
  assertDigest(archiveSha256, "Defold SDK archive SHA-256");
  const entries = (await inventoryFiles(sdkRoot)).sort((left, right) => compareMemberPaths(left.path, right.path));
  const manifest = {
    schemaVersion: 1,
    kind: manifestKind,
    archiveSha256,
    entryCount: entries.length,
    entries,
  };
  const target = path.join(sdkRoot, defoldSdkExtractionManifestName);
  const temporary = `${target}.tmp`;
  await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`);
  await rename(temporary, target);
  return manifest;
}

export function validateDefoldSdkExtractionManifest(manifest, expectedArchiveSha256) {
  assertDigest(expectedArchiveSha256, "Expected Defold SDK archive SHA-256");
  if (manifest?.schemaVersion !== 1 || manifest?.kind !== manifestKind || !Array.isArray(manifest?.entries)) {
    throw new Error("The Defold SDK extraction manifest has an unsupported schema");
  }
  assertDigest(manifest.archiveSha256, "Defold SDK extraction manifest archive SHA-256");
  if (manifest.archiveSha256 !== expectedArchiveSha256) {
    throw new Error(
      `The Defold SDK extraction manifest authenticates archive ${manifest.archiveSha256}, expected ${expectedArchiveSha256}`,
    );
  }
  if (manifest.entryCount !== manifest.entries.length) {
    throw new Error("The Defold SDK extraction manifest entry count is inconsistent");
  }
  const members = new Map();
  let previous = null;
  for (const entry of manifest.entries) {
    assertMemberPath(entry?.path);
    if (!Number.isSafeInteger(entry.size) || entry.size < 0) {
      throw new Error(`Invalid size for Defold SDK extraction manifest member ${entry.path}`);
    }
    assertDigest(entry.sha256, `Defold SDK extraction manifest member ${entry.path} SHA-256`);
    if (previous !== null && compareMemberPaths(previous, entry.path) >= 0) {
      throw new Error("The Defold SDK extraction manifest members are not uniquely sorted");
    }
    previous = entry.path;
    members.set(entry.path, entry);
  }
  return members;
}

export async function readDefoldSdkExtractionManifest({ sdkRoot, expectedArchiveSha256 }) {
  const manifestPath = path.join(sdkRoot, defoldSdkExtractionManifestName);
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (cause) {
    throw new Error(`The pinned Defold SDK extraction has no readable archive manifest: ${manifestPath}`, { cause });
  }
  return { manifest, members: validateDefoldSdkExtractionManifest(manifest, expectedArchiveSha256), manifestPath };
}

async function main() {
  const [command, sdkRoot, archiveSha256] = process.argv.slice(2);
  if (command === "create" && sdkRoot && archiveSha256) {
    const manifest = await createDefoldSdkExtractionManifest({ sdkRoot, archiveSha256 });
    console.log(`defold-sdk-manifest ${manifest.entryCount} ${manifest.archiveSha256}`);
    return;
  }
  if (command === "check" && sdkRoot && archiveSha256) {
    const { manifest } = await readDefoldSdkExtractionManifest({ sdkRoot, expectedArchiveSha256: archiveSha256 });
    console.log(`defold-sdk-manifest ${manifest.entryCount} ${manifest.archiveSha256}`);
    return;
  }
  throw new Error("Usage: defold-sdk-extraction-manifest.mjs <create|check> <sdk-root> <archive-sha256>");
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch(async (error) => {
    const temporary = process.argv[3] ? path.join(process.argv[3], `${defoldSdkExtractionManifestName}.tmp`) : null;
    if (temporary) await rm(temporary, { force: true }).catch(() => {});
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
