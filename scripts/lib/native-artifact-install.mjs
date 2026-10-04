import { createHash, randomBytes } from "node:crypto";
import { cp, mkdir, readFile, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Install only native libraries whose publisher-authenticated member digests were checked. */
export async function installNativeArtifacts({
  manifest,
  downloadRoot,
  expectedByTarget,
  root,
  minimumBytes = 1_000_000,
}) {
  if (!(expectedByTarget instanceof Map)) {
    throw new Error("Native artifact installation requires publisher-authenticated release metadata");
  }
  const available = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) available.push(absolute);
    }
  }
  await visit(path.resolve(downloadRoot));

  const installed = [];
  for (const [target, artifact] of Object.entries(manifest.targets)) {
    if (artifact.status !== "vendored" && artifact.status !== "required-missing") continue;
    const expected = expectedByTarget.get(target);
    if (!expected) continue;
    const directory = `hermes-${target}`;
    const find = (name) => {
      const candidates = available.filter(
        (file) => path.basename(file) === name && file.split(path.sep).includes(directory),
      );
      if (candidates.length > 1) throw new Error(`Expected one ${name} in ${directory}, found ${candidates.length}`);
      return candidates[0] ?? null;
    };
    const releaseName = path.posix.basename(artifact.library);
    const debugName = `${releaseName.slice(0, -path.posix.extname(releaseName).length)}.debug${path.posix.extname(releaseName)}`;
    const release = find(releaseName);
    if (!release) continue;

    const integrity = expected.integrity;
    if (
      integrity?.family !== "native-artifacts" ||
      integrity.tag !== expected.tag ||
      integrity.fingerprint !== expected.fingerprint ||
      integrity.asset !== expected.asset ||
      expected.asset !== `hermes-${target}.tar.gz` ||
      !expected.tag.endsWith(expected.fingerprint.slice(0, 12))
    ) {
      throw new Error(`${target} has no matching publisher-authenticated artifact identity`);
    }
    const expectedMember = (name) => {
      const member = integrity.members.find((candidate) => candidate.name === name);
      if (!member) throw new Error(`${expected.asset} has no publisher digest for ${name}`);
      return member;
    };
    const releaseMember = expectedMember(releaseName);
    const debugMember = expectedMember(debugName);
    const debug = find(debugName);
    if (!debug) throw new Error(`${expected.asset} is missing required debugger library ${debugName}`);

    // Stage both destinations first, then verify the staged bytes. This keeps a
    // changed download file from racing validation and makes the manifest a
    // record of the publisher's expectation, never a digest learned on install.
    const staged = [];
    for (const [source, relative, member] of [
      [release, artifact.library, releaseMember],
      [debug, artifact.debugLibrary ?? path.posix.join(path.posix.dirname(artifact.library), debugName), debugMember],
    ]) {
      const destination = path.join(root, relative);
      const temporary = `${destination}.deherm-replace-${process.pid}-${randomBytes(5).toString("hex")}`;
      await mkdir(path.dirname(destination), { recursive: true });
      try {
        await cp(source, temporary, { errorOnExist: true, force: false });
        const bytes = await readFile(temporary);
        if (bytes.byteLength < minimumBytes)
          throw new Error(`${relative} is implausibly small (${bytes.byteLength} bytes)`);
        if (bytes.byteLength !== member.bytes || sha256(bytes) !== member.sha256) {
          throw new Error(`${expected.asset} member ${member.name} does not match its publisher integrity document`);
        }
        staged.push({ temporary, destination, relative, member });
      } catch (error) {
        await rm(temporary, { force: true });
        await Promise.all(staged.map(({ temporary: stagedPath }) => rm(stagedPath, { force: true })));
        throw error;
      }
    }

    for (const { temporary, destination, relative, member } of staged) {
      await rename(temporary, destination);
      if (relative === artifact.library) {
        artifact.sha256 = member.sha256;
        artifact.bytes = member.bytes;
      } else {
        artifact.debugLibrary = relative;
        artifact.debugSha256 = member.sha256;
        artifact.debugBytes = member.bytes;
      }
    }
    artifact.status = "vendored";
    installed.push(target);
  }
  return installed;
}
