#!/usr/bin/env node

// Emit the release coordinates the SHIPPED CLI needs to fetch a host tool.
//
// The tools are deliberately NOT in the npm package - that is the point of
// publishing them as content-addressed release archives. But a packed install
// has no way to work out WHICH release: the tag is a fingerprint over
// repository files the package does not carry, so it cannot be recomputed on a
// user's machine.
//
// This writes those coordinates into a small generated file that does ship, so
// `requireHostTool` can resolve family -> tag -> asset -> URL with no network
// round trip to discover them and no repository checkout. It is generated from
// the same `buildArtifactReferences` the policy site serves, so the package and
// the site cannot disagree about where an artifact lives.

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  defaultReleaseRepository,
  downloadReleaseAssets,
  releaseAssetUrlTemplate,
  resolveGithubReleaseAsset,
  verifyReleaseAssetBytes,
} from "../packages/cli/src/release-assets.mjs";
import { buildArtifactReferences } from "../packages/generator/src/policy/artifact-references.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const releaseTagsPath = path.join(root, "packages", "toolchains", "release-tags.json");

async function buildHostArtifactReferences(options = {}) {
  return buildArtifactReferences({ ...options, families: ["hermes-host", "dehermc"] });
}

export async function buildReleaseTags(options = {}) {
  return {
    schemaVersion: 1,
    kind: "deherm.release-tags",
    comment:
      "Where the published artifacts live. Generated: the tag is a fingerprint over repository " +
      "files the npm package does not carry, so a packed install cannot recompute it and has to " +
      "be told. Expand releaseAsset with a tag and an asset name to get a download URL.",
    repository: defaultReleaseRepository,
    releaseAsset: releaseAssetUrlTemplate(),
    families: await buildHostArtifactReferences({ integrityRoot: options.integrityRoot }),
  };
}

function withoutIntegrity(value) {
  const copy = structuredClone(value);
  // Target archive coordinates are authoritative only in the authenticated
  // per-Defold-revision policy/project lock. Older packages may still carry a
  // legacy native family; ignore it when checking this host-tool-only lock.
  delete copy.families?.["native-artifacts"];
  for (const family of Object.values(copy.families ?? {})) delete family.integrity;
  return copy;
}

function assertCompleteIntegrity(value) {
  for (const [familyName, family] of Object.entries(value.families ?? {})) {
    if (familyName === "native-artifacts") continue;
    for (const key of Object.keys(family.assets ?? {})) {
      const expectedAsset = `${family.assets[key]}.integrity.json`;
      const record = family.integrity?.[key];
      if (
        record?.asset !== expectedAsset ||
        !/^[a-f0-9]{64}$/u.test(record.sha256 ?? "") ||
        !/^[a-f0-9]{64}$/u.test(record.archiveSha256 ?? "") ||
        !Number.isSafeInteger(record.archiveBytes) ||
        record.archiveBytes < 1
      ) {
        throw new Error(`release-tags.json has no authenticated ${familyName}/${key} integrity record`);
      }
    }
  }
}

export async function downloadPublishedIntegrity() {
  const integrityRoot = await mkdtemp(path.join(tmpdir(), "deherm-release-integrity-"));
  const families = await buildHostArtifactReferences();
  try {
    for (const [familyName, family] of Object.entries(families)) {
      const destination = path.join(integrityRoot, familyName);
      await mkdir(destination, { recursive: true });
      for (const [key, asset] of Object.entries(family.assets)) {
        const tag = family.releases?.[key]?.tag ?? family.tag;
        if (!tag) throw new Error(`${familyName}/${key} has no immutable release coordinate`);
        const integrityAsset = `${asset}.integrity.json`;
        const metadata = await resolveGithubReleaseAsset({
          repository: defaultReleaseRepository,
          tag,
          asset: integrityAsset,
        });
        const { downloaded } = await downloadReleaseAssets({
          repository: defaultReleaseRepository,
          tag,
          assets: [integrityAsset],
          destination,
        });
        verifyReleaseAssetBytes(await readFile(downloaded[0]), metadata, integrityAsset);
      }
    }
    return integrityRoot;
  } catch (error) {
    await rm(integrityRoot, { recursive: true, force: true });
    throw error;
  }
}

async function main(argv = process.argv.slice(2)) {
  let check = false;
  let integrityRoot = null;
  let published = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--check") check = true;
    else if (argument === "--published") published = true;
    else if (argument === "--integrity-root") {
      const value = argv[++index];
      if (!value) throw new Error("--integrity-root requires a directory");
      integrityRoot = path.resolve(value);
    } else throw new Error(`Unknown argument: ${argument}`);
  }
  if (published && integrityRoot) throw new Error("--published and --integrity-root are mutually exclusive");
  let temporaryIntegrityRoot = null;
  try {
    if (published) {
      temporaryIntegrityRoot = await downloadPublishedIntegrity();
      integrityRoot = temporaryIntegrityRoot;
    }
    const generated = await buildReleaseTags({ integrityRoot });
    const serialized = `${JSON.stringify(generated, null, 2)}\n`;
    if (check) {
      const existingText = await readFile(releaseTagsPath, "utf8").catch(() => "");
      const existing = existingText ? JSON.parse(existingText) : null;
      const matches = JSON.stringify(withoutIntegrity(existing)) === JSON.stringify(withoutIntegrity(generated));
      if (!matches) {
        throw new Error(
          "packages/toolchains/release-tags.json is stale; run pnpm generate:release-tags after publishing artifacts",
        );
      }
      assertCompleteIntegrity(existing);
      console.log("release tags are current");
      return;
    }
    if (!integrityRoot) {
      throw new Error("Generating release-tags.json requires --published or --integrity-root with publisher sidecars");
    }
    await writeFile(releaseTagsPath, serialized);
    console.log(`wrote ${path.relative(root, releaseTagsPath)}`);
  } finally {
    if (temporaryIntegrityRoot) await rm(temporaryIntegrityRoot, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
