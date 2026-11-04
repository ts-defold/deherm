#!/usr/bin/env node

// Do not dispatch a full Bob matrix until its pinned policy has a compatible,
// authenticated native mapping. Native-artifacts will refresh the policy site
// and trigger this check again after publishing the missing release.

import { appendFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { readPolicyLocator, resolvePublishedPolicy } from "../packages/cli/src/policy-client.mjs";
import { publishedNativeArtifactState } from "./check-end-to-end.mjs";

export function parseArguments(argv = []) {
  let revision;
  let githubOutput;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--defold-sdk") revision = argv[++index];
    else if (argv[index] === "--github-output") githubOutput = argv[++index];
    else throw new Error(`Unknown argument ${argv[index]}`);
  }
  if (!/^[a-f0-9]{40}$/u.test(revision ?? "")) {
    throw new Error(
      "Usage: check-published-native-artifacts.mjs --defold-sdk <40-character SHA> --github-output <path>",
    );
  }
  if (!githubOutput) {
    throw new Error(
      "Usage: check-published-native-artifacts.mjs --defold-sdk <40-character SHA> --github-output <path>",
    );
  }
  return { revision, githubOutput };
}

export async function checkPublishedNativeArtifactReadiness(revision, options = {}) {
  if (!/^[a-f0-9]{40}$/u.test(revision ?? "")) {
    throw new Error("Published native-artifact readiness requires an exact Defold revision");
  }
  const locator = options.index ?? (await readPolicyLocator());
  const resolve = options.resolvePublishedPolicy ?? resolvePublishedPolicy;
  const resolved = await resolve(revision, { index: locator });
  const status = publishedNativeArtifactState(resolved.artifacts?.artifacts?.["native-artifacts"]);
  return { revision, status };
}

async function main(argv = process.argv.slice(2)) {
  const { revision, githubOutput } = parseArguments(argv);
  const readiness = await checkPublishedNativeArtifactReadiness(revision);
  await appendFile(githubOutput, `revision=${revision}\nready=${readiness.status === "ready"}\n`);
  console.log(`${revision}: published native artifacts ${readiness.status}`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await main();
