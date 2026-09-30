import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { gunzipSync } from "node:zlib";

export { releaseIntegrityAssetName } from "./release-integrity-name.mjs";

const DIGEST = /^[0-9a-f]{64}$/u;
const TAR_BLOCK_BYTES = 512;
const TAR_CHECKSUM_OFFSET = 148;
const TAR_CHECKSUM_BYTES = 8;
export const RELEASE_INTEGRITY_KIND = "deherm.release-asset-integrity";

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function tarText(block, offset, length) {
  const field = block.subarray(offset, offset + length);
  const terminator = field.indexOf(0);
  return field.subarray(0, terminator < 0 ? field.length : terminator).toString("utf8");
}

function tarOctal(block, offset, length, fieldName, archiveName) {
  const value = tarText(block, offset, length).trim();
  if (value === "") return 0;
  if (!/^[0-7]+$/u.test(value)) throw new Error(`${archiveName} has an invalid tar ${fieldName}`);
  const parsed = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${archiveName} has an out-of-range tar ${fieldName}`);
  }
  return parsed;
}

function isZeroBlock(block) {
  return block.every((value) => value === 0);
}

function validateTarChecksum(block, archiveName) {
  const expected = tarOctal(block, TAR_CHECKSUM_OFFSET, TAR_CHECKSUM_BYTES, "checksum", archiveName);
  let observed = 0;
  for (let index = 0; index < block.length; ++index) {
    observed += index >= TAR_CHECKSUM_OFFSET && index < TAR_CHECKSUM_OFFSET + TAR_CHECKSUM_BYTES ? 0x20 : block[index];
  }
  if (observed !== expected) throw new Error(`${archiveName} has an invalid tar header checksum`);
}

function extractFlatTarGzipMembers(compressed, archiveName) {
  let tar;
  try {
    tar = gunzipSync(compressed);
  } catch (error) {
    throw new Error(`${archiveName} is not a valid gzip archive`, { cause: error });
  }

  const members = [];
  let offset = 0;
  let trailingZeroBlocks = 0;
  while (offset + TAR_BLOCK_BYTES <= tar.byteLength) {
    const header = tar.subarray(offset, offset + TAR_BLOCK_BYTES);
    offset += TAR_BLOCK_BYTES;
    if (isZeroBlock(header)) {
      trailingZeroBlocks += 1;
      continue;
    }
    if (trailingZeroBlocks !== 0) throw new Error(`${archiveName} has data after its tar terminator`);

    validateTarChecksum(header, archiveName);
    const baseName = tarText(header, 0, 100);
    const prefix = tarText(header, 345, 155);
    const name = prefix ? `${prefix}/${baseName}` : baseName;
    const type = header[156];
    if ((type !== 0 && type !== 0x30) || !baseName || name.includes("/") || name.includes("\\")) {
      throw new Error(`${archiveName} is not a flat release archive`);
    }

    const size = tarOctal(header, 124, 12, "member size", archiveName);
    const paddedSize = Math.ceil(size / TAR_BLOCK_BYTES) * TAR_BLOCK_BYTES;
    if (offset + paddedSize > tar.byteLength) throw new Error(`${archiveName} has a truncated tar member`);
    members.push({ name, bytes: Buffer.from(tar.subarray(offset, offset + size)) });
    offset += paddedSize;
  }

  if (trailingZeroBlocks < 2 || offset !== tar.byteLength) {
    throw new Error(`${archiveName} has an incomplete tar terminator`);
  }
  return members;
}

async function extractedMembers(archive) {
  const bytes = await readFile(archive);
  if (archive.endsWith(".zip")) {
    // Native Hermes artifacts are flat tarballs and their publisher runs
    // before workspace dependencies are installed. Keep that path free of
    // package imports; only consumers of ZIP artifacts need the package-owned
    // decoder.
    const { unzipSync } = await import("fflate");
    const entries = unzipSync(bytes);
    return Object.entries(entries).map(([name, value]) => ({ name, bytes: Buffer.from(value) }));
  }
  if (!archive.endsWith(".tar.gz")) throw new Error(`${path.basename(archive)} is not a supported release archive`);
  return extractFlatTarGzipMembers(bytes, path.basename(archive));
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
