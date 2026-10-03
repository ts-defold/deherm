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
    families: await buildArtifactReferences({ integrityRoot: options.integrityRoot }),
  };
}

function withoutIntegrity(value) {
  const copy = structuredClone(value);
  for (const family of Object.values(copy.families ?? {})) delete family.integrity;
  return copy;
}

function assertCompleteIntegrity(value) {
  for (const [familyName, family] of Object.entries(value.families ?? {})) {
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

async function main(argv = process.argv.slice(2)) {
  let check = false;
  let integrityRoot = null;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--check") check = true;
    else if (argument === "--integrity-root") {
      const value = argv[++index];
      if (!value) throw new Error("--integrity-root requires a directory");
      integrityRoot = path.resolve(value);
    } else throw new Error(`Unknown argument: ${argument}`);
  }
  const generated = await buildReleaseTags({ integrityRoot });
  const serialized = `${JSON.stringify(generated, null, 2)}\n`;
  if (check) {
    const existingText = await readFile(releaseTagsPath, "utf8").catch(() => "");
    const existing = existingText ? JSON.parse(existingText) : null;
    const matches = integrityRoot
      ? existingText === serialized
      : JSON.stringify(withoutIntegrity(existing)) === JSON.stringify(withoutIntegrity(generated));
    if (!matches) {
      throw new Error("packages/toolchains/release-tags.json is stale; run node scripts/generate-release-tags.mjs");
    }
    assertCompleteIntegrity(existing);
    console.log("release tags are current");
    return;
  }
  if (!integrityRoot) {
    throw new Error("Generating release-tags.json requires --integrity-root with publisher sidecars");
  }
  await writeFile(releaseTagsPath, serialized);
  console.log(`wrote ${path.relative(root, releaseTagsPath)}`);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
