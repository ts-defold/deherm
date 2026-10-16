#!/usr/bin/env node

// Do not dispatch a full Bob matrix until its pinned policy has a compatible,
// authenticated native mapping. Native-artifacts will refresh the policy site
// and trigger this check again after publishing the missing release.

import { appendFile, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { readPolicyLocator, resolvePublishedPolicy } from "../packages/cli/src/policy-client.mjs";
import { publishedNativeArtifactState } from "./check-end-to-end.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 2 || argv[0] !== "--github-output") {
    throw new Error("Usage: check-published-native-artifacts.mjs --github-output <path>");
  }
  const manifest = JSON.parse(await readFile(path.join(root, "packages/toolchains/native-artifacts.json"), "utf8"));
  const revision = manifest.defoldRevision;
  const resolved = await resolvePublishedPolicy(revision, { index: await readPolicyLocator() });
  const status = publishedNativeArtifactState(resolved.artifacts?.artifacts?.["native-artifacts"]);
  await appendFile(argv[1], `ready=${status === "ready"}\n`);
  console.log(`${revision}: published native artifacts ${status}`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await main();
