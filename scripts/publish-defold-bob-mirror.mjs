#!/usr/bin/env node

// Preserve the exact Bob bytes that policy derivation already authenticated.
// Defold's intermediate channel archives can expire; a policy must not depend
// on their continued availability after it has been published.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { bobMirrorTag, bobMirrorUrl } from "../packages/cli/src/dev/bob-mirror.mjs";

const execFileAsync = promisify(execFile);
const revisionPattern = /^[0-9a-f]{40}$/u;
const digestPattern = /^[0-9a-f]{64}$/u;
const repository = "ts-defold/deherm";
const licenseFiles = ["LICENSE.txt", "NOTICE", "TOOLS_LICENSES.md", "COMPLYING_WITH_LICENSES.md"];

function releaseNotes(revision, digest, verified) {
  const lines = [
    `Exact Defold Bob archive for ${revision}; SHA-256 ${digest}.`,
    "This is a toolchain mirror, not a déherm release. Defold license and notices are attached.",
  ];
  if (verified) lines.push(`Verified public download SHA-256: ${digest}`);
  return lines.join("\n\n");
}

async function verifyPublicDownload(url, digest, verifyDownload) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      await verifyDownload(url, digest);
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (attempt === 7 || !/HTTP (?:404|429|502|503|504)\b/u.test(message)) throw error;
      await sleep(2000);
    }
  }
}

export async function fileSha256(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

export async function verifyBobMirrorDownload(url, expectedDigest, fetchImpl = fetch) {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(180_000) });
  if (!response.ok || !response.body) throw new Error(`Bob mirror download failed: HTTP ${response.status}`);
  const hash = createHash("sha256");
  for await (const chunk of response.body) hash.update(chunk);
  const actual = hash.digest("hex");
  if (actual !== expectedDigest) throw new Error(`Bob mirror download digest mismatch: ${actual}`);
}

export function expectedBobFromLock(lock, revision) {
  const pinnedRevision = /^DEFOLD_REV=([0-9a-f]{40})$/mu.exec(lock)?.[1];
  const expected = /^DEFOLD_BOB_SHA256=([0-9a-f]{64})$/mu.exec(lock)?.[1];
  if (pinnedRevision !== revision || !digestPattern.test(expected ?? "")) {
    throw new Error(`Workspace lock does not authenticate Bob for ${revision}`);
  }
  return expected;
}

export function missingBobReleaseAssets(release, expectedAssets) {
  const assets = new Map();
  for (const asset of release?.assets ?? []) {
    if (assets.has(asset.name)) throw new Error(`Bob mirror release has duplicate ${asset.name} assets`);
    assets.set(asset.name, asset);
  }
  const missing = [];
  for (const { name, digest, size } of expectedAssets) {
    const asset = assets.get(name);
    if (!asset) missing.push(name);
    else if (asset.digest !== `sha256:${digest}` || asset.size !== size || asset.state !== "uploaded")
      throw new Error(`Bob mirror release has invalid ${name} asset`);
  }
  return missing;
}

export function verifyBobReleaseAssets(release, expectedAssets) {
  const missing = missingBobReleaseAssets(release, expectedAssets);
  if (missing.length) throw new Error(`Bob mirror release is missing ${missing.join(", ")}`);
}

async function gh(args, run) {
  const result = await run("gh", args, { maxBuffer: 4 * 1024 * 1024 });
  return result.stdout;
}

async function releaseForTag(tag, run) {
  try {
    // GitHub's releases/tags REST route returns 404 for a draft, even to an
    // authenticated writer. The release CLI resolves drafts by tag correctly.
    const release = JSON.parse(
      await gh(["release", "view", tag, "--repo", repository, "--json", "isDraft,assets,body,tagName"], run),
    );
    if (release.tagName !== tag) throw new Error(`Bob mirror lookup returned ${release.tagName}, expected ${tag}`);
    return { draft: release.isDraft, assets: release.assets, body: release.body };
  } catch (error) {
    if (/HTTP 404\b|release not found/u.test(`${error.stderr ?? ""}\n${error.message ?? ""}`)) return null;
    throw error;
  }
}

async function waitForRelease(tag, run) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const release = await releaseForTag(tag, run);
    if (release) return release;
    if (attempt < 7) await sleep(1000);
  }
  throw new Error(`Bob mirror ${tag} was created but is not readable`);
}

async function waitForReleaseAssets(tag, run, expectedAssets) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const release = await releaseForTag(tag, run);
    if (release && missingBobReleaseAssets(release, expectedAssets).length === 0) return release;
    if (attempt < 7) await sleep(1000);
  }
  throw new Error(`Bob mirror ${tag} did not expose every uploaded asset`);
}

export async function publishBobMirror({
  workspace,
  revision,
  target,
  run = execFileAsync,
  verifyDownload = verifyBobMirrorDownload,
}) {
  const tag = bobMirrorTag(revision);
  const lock = await readFile(path.join(workspace, "upstream.lock"), "utf8");
  const expectedDigest = expectedBobFromLock(lock, revision);
  const bob = path.join(workspace, "upstream/bob.jar");
  const actualDigest = await fileSha256(bob);
  if (actualDigest !== expectedDigest) {
    throw new Error(`Bob mirror input digest mismatch: expected ${expectedDigest}, got ${actualDigest}`);
  }
  const bobSize = (await stat(bob)).size;
  const sidecar = `${expectedDigest}  bob.jar\n`;
  const sidecarDigest = createHash("sha256").update(sidecar).digest("hex");
  const expectedAssets = [
    { name: "bob.jar", file: bob, digest: expectedDigest, size: bobSize },
    { name: "bob.jar.sha256", digest: sidecarDigest, size: Buffer.byteLength(sidecar) },
  ];
  for (const name of licenseFiles) {
    const file = path.join(workspace, "upstream/defold", name);
    expectedAssets.push({ name, file, digest: await fileSha256(file), size: (await stat(file)).size });
  }
  let release = await releaseForTag(tag, run);
  if (release && !release.draft) {
    verifyBobReleaseAssets(release, expectedAssets);
    if (!release.body?.includes(`Verified public download SHA-256: ${expectedDigest}`)) {
      await verifyPublicDownload(bobMirrorUrl(revision), expectedDigest, verifyDownload);
      await gh(
        ["release", "edit", tag, "--repo", repository, "--notes", releaseNotes(revision, expectedDigest, true)],
        run,
      );
    }
    return { tag, url: bobMirrorUrl(revision), reused: true };
  }
  if (!release && !target) throw new Error("A target commit is required to publish a Bob mirror");
  const temporary = await mkdtemp(path.join(tmpdir(), "deherm-bob-mirror-"));
  try {
    const sidecarPath = path.join(temporary, "bob.jar.sha256");
    await writeFile(sidecarPath, sidecar);
    expectedAssets[1].file = sidecarPath;
    if (!release) {
      await gh(
        [
          "release",
          "create",
          tag,
          "--repo",
          repository,
          "--target",
          target,
          "--title",
          `Defold Bob ${revision.slice(0, 12)}`,
          "--notes",
          releaseNotes(revision, expectedDigest, false),
          "--draft",
          "--latest=false",
        ],
        run,
      );
      release = await waitForRelease(tag, run);
    }
    if (!release?.draft) throw new Error(`Bob mirror ${tag} is not a draft`);
    const missing = missingBobReleaseAssets(release, expectedAssets);
    if (missing.length) {
      const paths = missing.map((name) => expectedAssets.find((asset) => asset.name === name).file);
      await gh(["release", "upload", tag, ...paths, "--repo", repository], run);
    }
    release = await waitForReleaseAssets(tag, run, expectedAssets);
    verifyBobReleaseAssets(release, expectedAssets);
    await gh(["release", "edit", tag, "--repo", repository, "--draft=false"], run);
    release = await releaseForTag(tag, run);
    if (release?.draft) throw new Error(`Bob mirror ${tag} remained a draft after publication`);
    verifyBobReleaseAssets(release, expectedAssets);
    await verifyPublicDownload(bobMirrorUrl(revision), expectedDigest, verifyDownload);
    await gh(
      ["release", "edit", tag, "--repo", repository, "--notes", releaseNotes(revision, expectedDigest, true)],
      run,
    );
    return { tag, url: bobMirrorUrl(revision), reused: false };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function main(argv = process.argv.slice(2)) {
  const workspace = argv[argv.indexOf("--workspace") + 1];
  const revision = argv[argv.indexOf("--revision") + 1];
  if (!workspace || !revision || !revisionPattern.test(revision)) {
    throw new Error("Usage: publish-defold-bob-mirror.mjs --workspace <path> --revision <sha>");
  }
  const result = await publishBobMirror({ workspace, revision, target: process.env.GITHUB_SHA });
  console.log(`${result.reused ? "Verified" : "Published"} Bob mirror ${result.url}`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await main();
