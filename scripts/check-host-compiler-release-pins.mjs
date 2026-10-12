#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { defaultReleaseRepository, resolveGithubReleaseAsset } from "../packages/cli/src/release-assets.mjs";
import { artifactReleaseForRow, publishedAssets } from "./lib/artifact-releases.mjs";
import { verifyHostCompilerReleasePins } from "./lib/host-compiler-release-pins.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export async function checkHostCompilerReleasePins({
  root: checkout = root,
  resolveAsset = (identity) => resolveGithubReleaseAsset(identity),
  fetchAsset = (url) => fetch(url),
} = {}) {
  const manifest = JSON.parse(await readFile(path.join(checkout, "packages/toolchains/host-compilers.json"), "utf8"));
  const releaseTags = JSON.parse(await readFile(path.join(checkout, "packages/toolchains/release-tags.json"), "utf8"));
  if (releaseTags.repository !== defaultReleaseRepository) {
    throw new Error(`release-tags.json repository is ${releaseTags.repository}, expected ${defaultReleaseRepository}`);
  }
  const releases = [];
  for (const family of ["hermes-host", "dehermc"]) {
    const rows = await publishedAssets(family, { root: checkout });
    for (const row of rows) {
      const identity = await artifactReleaseForRow(family, row, { root: checkout });
      releases.push({ family, tag: identity.tag, fingerprint: identity.fingerprint, row });
    }
  }
  return verifyHostCompilerReleasePins({ manifest, releases, releaseTags, resolveAsset, fetchAsset });
}

async function main() {
  const checked = await checkHostCompilerReleasePins();
  console.log(`host compiler release pins match publisher integrity sidecars (${checked.length} tools)`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
