#!/usr/bin/env node

import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  assertProjectNativeArtifact,
  ensureProjectNativeArtifact
} from "../packages/cli/src/toolchains.mjs";

export async function main(argv = process.argv.slice(2)) {
  const [project, target, variant, ...extra] = argv;
  if (!project || !target || !["debug", "release"].includes(variant) || extra.length) {
    throw new Error("Usage: check-project-native-artifact.mjs <project> <Defold bundle target> <debug|release>");
  }
  const root = path.resolve(project);
  await ensureProjectNativeArtifact(root, target, { variant });
  const verified = await assertProjectNativeArtifact(root, target, { variant });
  console.log(`verified ${verified.target} ${variant} ${path.relative(root, verified.file)}`);
  return verified;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
