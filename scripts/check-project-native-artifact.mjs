#!/usr/bin/env node

import path from "node:path";
import { pathToFileURL } from "node:url";

import { assertProjectNativeArtifact } from "../packages/cli/src/toolchains.mjs";

export async function main(argv = process.argv.slice(2)) {
  const [project, target, ...extra] = argv;
  if (!project || !target || extra.length) {
    throw new Error("Usage: check-project-native-artifact.mjs <project> <Defold bundle target>");
  }
  const verified = await assertProjectNativeArtifact(path.resolve(project), target);
  console.log(`verified ${verified.target} ${path.relative(path.resolve(project), verified.file)} ${verified.sha256}`);
  return verified;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
