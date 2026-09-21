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
import { chmod, mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { downloadReleaseAssets, extractReleaseArchive } from "./release-assets.mjs";
import { defoldSurfaceCacheHome } from "./defold-surface.mjs";

const moduleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** Platform-native, per-user cache for downloaded host executables. */
export function toolCacheRoot(options = {}) {
  const env = options.env ?? process.env;
  if (env.DEHERM_TOOL_CACHE) return path.resolve(env.DEHERM_TOOL_CACHE);
  if (options.cacheRoot) return path.resolve(options.cacheRoot);
  return path.join(defoldSurfaceCacheHome(env), "toolchains");
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
