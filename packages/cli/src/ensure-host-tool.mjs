// Fetch a host tool on first use, instead of shipping it in the package.
//
// hermesc, shermes and dehermc are published as content-addressed release
// archives precisely so the npm package stays small and a user installs only
// the tools their own host needs. The consequence is that a fresh install has
// none of them on disk, and `requireHostTool` fails closed - correctly, but
// uselessly, because nothing was ever going to put them there.
//
// This is that missing step. On a miss it resolves the release coordinates from
// the generated `release-tags.json` that ships with the package, downloads the
// one archive for this host, extracts it into a per-user cache, and verifies
// every member against the digest the manifest records. The digest check is the
// point: the URL is derived from a fingerprint of build inputs, but nothing
// about HTTPS proves the bytes that arrive are the bytes that were built.
//
// The cache lives outside the package because an install under node_modules may
// be read-only, is wiped by a reinstall, and would be duplicated per project.
// Keyed by tag, so two deherm versions sharing a tag share the download and a
// new tag never overwrites an old one in place.

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { downloadReleaseAssets, extractReleaseArchive } from "./release-assets.mjs";

const moduleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/**
 * Where fetched tools live: inside the PROJECT, not the user's home.
 *
 * A per-user cache would make a build depend on machine state that no
 * teammate, CI runner or future checkout shares - the same class of problem as
 * a tool resolved from PATH. Keeping it under the project means the toolchain a
 * build used is visible next to the project that used it, and can be COMMITTED
 * so a teammate or a CI run gets the exact bytes without re-downloading and
 * without network access at all.
 *
 * `.deherm/cache` is the existing home for project-local derived state, so this
 * sits beside it rather than inventing a second location. The path is keyed by
 * release tag, so two deherm versions sharing a tag share the download and a
 * new tag never overwrites an old one in place.
 *
 * It is GITIGNORED by default - this repository at .gitignore:19, and scaffolded
 * projects through scaffold.mjs - so the default behaviour is to re-download per
 * machine and per worktree. Committing it is a deliberate opt-in for anyone who
 * wants teammates or CI to build with no network. Tag-keyed paths are what make
 * that safe: a committed cache for one tag cannot collide with another, and a
 * stale one is never silently preferred because the tag would not match.
 */
export function projectRoot(from = process.cwd()) {
  let directory = path.resolve(from);
  for (;;) {
    for (const marker of ["deherm.lock", "game.project", "package.json", ".git"]) {
      if (existsSync(path.join(directory, marker))) return directory;
    }
    const parent = path.dirname(directory);
    if (parent === directory) return path.resolve(from);
    directory = parent;
  }
}

export function toolCacheRoot(options = {}) {
  if (process.env.DEHERM_TOOL_CACHE) return path.resolve(process.env.DEHERM_TOOL_CACHE);
  return path.join(options.projectRoot ?? projectRoot(), ".deherm", "cache", "toolchains");
}

async function readReleaseTags(options = {}) {
  const file = options.releaseTagsPath
    ?? path.join(moduleRoot, "packages", "toolchains", "release-tags.json");
  return JSON.parse(await readFile(file, "utf8"));
}

async function digestOf(file) {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

async function cachedMembersMatch(destination, members, expectedDigests) {
  for (const member of members) {
    const file = path.join(destination, member);
    const present = await stat(file).then((entry) => entry.isFile(), () => false);
    if (!present) return false;
    const expected = expectedDigests[member];
    if (expected && await digestOf(file).catch(() => null) !== expected) return false;
  }
  return members.length > 0;
}

/**
 * Ensure every tool of one host family is present, and return where they live.
 *
 * Extraction goes to a temporary sibling and is renamed into place only after
 * every digest matches, so an interrupted download cannot leave a half-populated
 * directory that a later run would treat as a cache hit.
 */
export async function ensureHostFamily(family, host, options = {}) {
  const tags = await readReleaseTags(options);
  const reference = tags.families?.[family];
  if (!reference) throw new Error(`release-tags.json names no ${family} family`);
  const asset = reference.assets?.[host];
  if (!asset) throw new Error(`${family} publishes nothing for ${host}`);

  const destination = path.join(toolCacheRoot(options), reference.tag, host);
  const members = reference.contents?.[host] ?? [];
  const expectedDigests = options.expectedDigests ?? {};
  for (const [member, digest] of Object.entries(expectedDigests)) {
    if (!members.includes(member)) {
      throw new Error(`${family} digest manifest names ${member}, which ${asset} does not contain`);
    }
    if (!/^[a-f0-9]{64}$/.test(digest)) {
      throw new Error(`${family} digest manifest records an invalid SHA-256 for ${member}`);
    }
  }
  if (await cachedMembersMatch(destination, members, expectedDigests)) {
    return { destination, tag: reference.tag, cached: true, members };
  }

  const staging = `${destination}.incoming-${process.pid}`;
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  try {
    const { downloaded } = await downloadReleaseAssets({
      repository: tags.repository,
      tag: reference.tag,
      assets: [asset],
      destination: staging,
      onProgress: options.onProgress
    });
    await extractReleaseArchive({ archive: downloaded[0], destination: staging });
    await rm(downloaded[0], { force: true });
    for (const member of members) {
      const file = path.join(staging, member);
      if (!await stat(file).then(() => true, () => false)) {
        throw new Error(`${asset} does not contain ${member}`);
      }
      const expected = expectedDigests[member];
      if (expected) await verifyAgainstManifest(file, expected);
      // Archives preserve the mode, but a defensive chmod costs nothing and
      // makes a hand-assembled cache work too.
      await chmod(file, 0o755).catch(() => {});
    }
    await mkdir(path.dirname(destination), { recursive: true });
    await rm(destination, { recursive: true, force: true });
    await rename(staging, destination);
    return { destination, tag: reference.tag, cached: false, members };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/** Verify one extracted tool against the digest the host manifest records. */
export async function verifyAgainstManifest(file, expectedSha256) {
  if (!expectedSha256) return { verified: false, reason: "manifest records no digest" };
  const actual = await digestOf(file);
  if (actual !== expectedSha256) {
    throw new Error(`${path.basename(file)} hashes ${actual.slice(0, 12)}, manifest expects ${expectedSha256.slice(0, 12)}`);
  }
  return { verified: true, sha256: actual };
}
