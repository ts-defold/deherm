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

import { writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { defaultReleaseRepository, releaseAssetUrlTemplate } from "../packages/cli/src/release-assets.mjs";
import { buildArtifactReferences } from "./generate-api-policy.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const releaseTagsPath = path.join(root, "packages", "toolchains", "release-tags.json");

export async function buildReleaseTags() {
  return {
    schemaVersion: 1,
    kind: "deherm.release-tags",
    comment:
      "Where the published artifacts live. Generated: the tag is a fingerprint over repository " +
      "files the npm package does not carry, so a packed install cannot recompute it and has to " +
      "be told. Expand releaseAsset with a tag and an asset name to get a download URL.",
    repository: defaultReleaseRepository,
    releaseAsset: releaseAssetUrlTemplate(),
    families: await buildArtifactReferences()
  };
}

async function main(argv = process.argv.slice(2)) {
  const serialized = `${JSON.stringify(await buildReleaseTags(), null, 2)}\n`;
  if (argv.includes("--check")) {
    const existing = await readFile(releaseTagsPath, "utf8").catch(() => "");
    if (existing !== serialized) {
      throw new Error("packages/toolchains/release-tags.json is stale; run node scripts/generate-release-tags.mjs");
    }
    console.log("release tags are current");
    return;
  }
  await writeFile(releaseTagsPath, serialized);
  console.log(`wrote ${path.relative(root, releaseTagsPath)}`);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
