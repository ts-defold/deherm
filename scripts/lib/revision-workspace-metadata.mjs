import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, mkdir, readFile, readlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const DIGEST = /^[0-9a-f]{64}$/u;
const REVISION = /^[0-9a-f]{40}$/u;

export const revisionWorkspaceMetadataRelative = ".deherm/revision-derivation.json";

function compareCodeUnits(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function appendRecord(hash, relative, kind, bytes) {
  hash.update(relative).update("\0").update(kind).update("\0");
  hash.update(String(bytes.length)).update("\0").update(bytes).update("\0");
}

/**
 * Fingerprint the exact repository snapshot copied into a revision workspace.
 *
 * This deliberately follows materializeWorkspace's Git-owned input boundary:
 * tracked paths plus new, non-ignored paths from the working tree. Hashing HEAD
 * would miss an uncommitted generator fix; hashing only named generators would
 * miss a newly introduced helper or policy recipe. Deleted tracked files and
 * symlink targets are inputs too.
 */
export async function revisionProducerInputIdentity(sourceRoot) {
  const { stdout } = await run(
    "git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { cwd: sourceRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }
  );
  const files = stdout.split("\0").filter(Boolean).sort(compareCodeUnits);
  const hash = createHash("sha256");
  for (const relative of files) {
    const absolute = path.join(sourceRoot, relative);
    let information;
    try {
      information = await lstat(absolute);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      appendRecord(hash, relative, "deleted", Buffer.alloc(0));
      continue;
    }
    if (information.isSymbolicLink()) {
      appendRecord(hash, relative, "symlink", Buffer.from(await readlink(absolute)));
    } else if (information.isFile()) {
      appendRecord(hash, relative, "file", await readFile(absolute));
    } else {
      throw new Error(`${relative}: unsupported producer input type`);
    }
  }
  return Object.freeze({ algorithm: "sha256", sha256: hash.digest("hex"), fileCount: files.length });
}

export function makeRevisionWorkspaceMetadata({ revision, producerInput, packageVersion, policyRoot, generator }) {
  if (!REVISION.test(revision ?? "") || producerInput?.algorithm !== "sha256" ||
      !DIGEST.test(producerInput?.sha256 ?? "") || !Number.isSafeInteger(producerInput?.fileCount) ||
      producerInput.fileCount < 1 || typeof packageVersion !== "string" || !packageVersion ||
      !DIGEST.test(policyRoot ?? "")) {
    throw new Error("Invalid revision workspace metadata input");
  }
  return {
    schemaVersion: 1,
    kind: "deherm.revision-derivation-workspace",
    revision,
    status: "derived",
    producerInput: { ...producerInput },
    currentCompiler: {
      packageVersion,
      sourceTreeSha256: producerInput.sha256
    },
    policy: { root: policyRoot, generator: generator ?? null }
  };
}

export async function writeRevisionWorkspaceMetadata(workspace, metadata) {
  const destination = path.join(workspace, revisionWorkspaceMetadataRelative);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, `${JSON.stringify(metadata, null, 2)}\n`);
  return destination;
}

export async function readRevisionWorkspaceMetadata(workspace) {
  try {
    return JSON.parse(await readFile(path.join(workspace, revisionWorkspaceMetadataRelative), "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

export function revisionWorkspaceMetadataMismatch(metadata, expected) {
  if (!metadata) return "derivation metadata is missing";
  if (metadata.schemaVersion !== 1 || metadata.kind !== "deherm.revision-derivation-workspace" ||
      metadata.status !== "derived") return "derivation metadata is invalid";
  if (metadata.revision !== expected.revision) {
    return `metadata names revision ${metadata.revision ?? "missing"}`;
  }
  if (metadata.producerInput?.algorithm !== "sha256" ||
      metadata.producerInput?.sha256 !== expected.producerInput.sha256 ||
      metadata.producerInput?.fileCount !== expected.producerInput.fileCount) {
    return "producer input fingerprint is stale";
  }
  if (metadata.currentCompiler?.packageVersion !== expected.packageVersion ||
      metadata.currentCompiler?.sourceTreeSha256 !== expected.producerInput.sha256) {
    return "current compiler identity is stale";
  }
  if (metadata.policy?.root !== expected.policyRoot) return "policy root does not match the workspace manifest";
  return null;
}
