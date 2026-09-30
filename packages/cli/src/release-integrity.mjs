import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { unzipSync } from "fflate";

const execFileAsync = promisify(execFile);
const DIGEST = /^[0-9a-f]{64}$/u;
export const RELEASE_INTEGRITY_KIND = "deherm.release-asset-integrity";

export function releaseIntegrityAssetName(asset) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(asset ?? "")) {
    throw new Error(`Invalid release asset ${JSON.stringify(asset)}`);
  }
  return `${asset}.integrity.json`;
}

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function extractedMembers(archive) {
  const bytes = await readFile(archive);
  if (archive.endsWith(".zip")) {
    const entries = unzipSync(bytes);
    return Object.entries(entries).map(([name, value]) => ({ name, bytes: Buffer.from(value) }));
  }
  if (!archive.endsWith(".tar.gz")) throw new Error(`${path.basename(archive)} is not a supported release archive`);
  const directory = await mkdtemp(path.join(tmpdir(), "deherm-release-integrity-"));
  try {
    await execFileAsync("tar", ["-xzf", path.resolve(archive), "-C", directory]);
    const entries = await readdir(directory, { withFileTypes: true });
    if (entries.some((entry) => !entry.isFile())) {
      throw new Error(`${path.basename(archive)} is not a flat release archive`);
    }
    return Promise.all(
      entries.map(async (entry) => ({ name: entry.name, bytes: await readFile(path.join(directory, entry.name)) })),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function buildReleaseIntegrity({ family, tag, fingerprint, asset, archive }) {
  if (!family || !tag || !DIGEST.test(fingerprint ?? "")) throw new Error("Invalid release integrity identity");
  const archiveBytes = await readFile(archive);
  const members = (await extractedMembers(archive))
    .map(({ name, bytes }) => ({ name, bytes: bytes.byteLength, sha256: sha256(bytes) }))
    .sort((left, right) => left.name.localeCompare(right.name));
  if (members.length === 0 || new Set(members.map(({ name }) => name)).size !== members.length) {
    throw new Error(`${asset} has an empty or duplicate release member inventory`);
  }
  return {
    schemaVersion: 1,
    kind: RELEASE_INTEGRITY_KIND,
    family,
    tag,
    fingerprint,
    asset,
    archive: { bytes: archiveBytes.byteLength, sha256: sha256(archiveBytes) },
    members,
  };
}

export function validateReleaseIntegrity(value, expected = {}) {
  if (
    value?.schemaVersion !== 1 ||
    value.kind !== RELEASE_INTEGRITY_KIND ||
    typeof value.family !== "string" ||
    typeof value.tag !== "string" ||
    !DIGEST.test(value.fingerprint ?? "") ||
    typeof value.asset !== "string" ||
    !Number.isSafeInteger(value.archive?.bytes) ||
    value.archive.bytes < 1 ||
    !DIGEST.test(value.archive?.sha256 ?? "") ||
    !Array.isArray(value.members) ||
    value.members.length === 0
  ) {
    throw new Error("Invalid release integrity document");
  }
  for (const [field, wanted] of Object.entries(expected)) {
    if (field === "members") continue;
    if (wanted !== undefined && value[field] !== wanted) {
      throw new Error(`Release integrity ${field} mismatch: expected ${wanted}, observed ${value[field]}`);
    }
  }
  const names = [];
  for (const member of value.members) {
    const normalized = path.posix.normalize(member?.name ?? "");
    if (
      !member ||
      typeof member.name !== "string" ||
      member.name.length === 0 ||
      member.name.includes("\\") ||
      normalized !== member.name ||
      normalized.startsWith("../") ||
      path.posix.isAbsolute(normalized) ||
      !Number.isSafeInteger(member.bytes) ||
      member.bytes < 0 ||
      !DIGEST.test(member.sha256 ?? "")
    ) {
      throw new Error("Invalid release integrity member");
    }
    names.push(member.name);
  }
  if (new Set(names).size !== names.length) throw new Error("Duplicate release integrity member");
  const expectedMembers = expected.members ? [...expected.members].sort() : null;
  if (expectedMembers && JSON.stringify([...names].sort()) !== JSON.stringify(expectedMembers)) {
    throw new Error(
      `Release integrity members mismatch: expected ${expectedMembers.join(", ")}, observed ${names.join(", ")}`,
    );
  }
  return value;
}

export async function verifyReleaseArchive({ archive, integrity, expected = {}, extractedRoot = null }) {
  const document = validateReleaseIntegrity(integrity, expected);
  const archiveBytes = await readFile(archive);
  if (archiveBytes.byteLength !== document.archive.bytes || sha256(archiveBytes) !== document.archive.sha256) {
    throw new Error(`${document.asset} does not match its publisher integrity document`);
  }
  if (extractedRoot) {
    const names = [];
    async function visit(directory, prefix = "") {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) await visit(path.join(directory, entry.name), relative);
        else if (entry.isFile()) names.push(relative);
        else throw new Error(`${document.asset} extracted an unsupported ${relative}`);
      }
    }
    await visit(extractedRoot);
    names.sort();
    const expectedNames = document.members.map(({ name }) => name).sort();
    if (JSON.stringify(names) !== JSON.stringify(expectedNames)) {
      throw new Error(`${document.asset} extracted member inventory does not match its publisher integrity document`);
    }
    for (const member of document.members) {
      const bytes = await readFile(path.join(extractedRoot, member.name));
      if (bytes.byteLength !== member.bytes || sha256(bytes) !== member.sha256) {
        throw new Error(`${document.asset} member ${member.name} does not match its publisher integrity document`);
      }
    }
  }
  return document;
}
