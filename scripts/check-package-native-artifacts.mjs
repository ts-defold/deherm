#!/usr/bin/env node

import { lstat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const requirements = Object.freeze([
  { relative: "defold/defold_hermes/lib/arm64-osx/libhermes.a", minimumBytes: 1_000_000 },
  { relative: "defold/defold_hermes/include/hermes/hermes.h", minimumBytes: 1 },
  { relative: "defold/defold_hermes/include/jsi/jsi.h", minimumBytes: 1 },
  { relative: "defold/defold_hermes/lib/web/library_defold_hermes.js", minimumBytes: 1 },
  { relative: "defold/defold_hermes/lib/web/generated_script_universal_value.js", minimumBytes: 1 },
  { relative: "defold/defold_hermes/lib/web/generated_dmsdk_universal.js", minimumBytes: 1 }
]);

for (const requirement of requirements) {
  const absolute = path.join(repositoryRoot, requirement.relative);
  let information;
  try {
    information = await lstat(absolute);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`Publishable déherm package is missing required native artifact: ${requirement.relative}`);
    }
    throw error;
  }
  if (!information.isFile() || information.isSymbolicLink() || information.size < requirement.minimumBytes) {
    throw new Error(`Publishable déherm native artifact is invalid or incomplete: ${requirement.relative}`);
  }
}

// This runs as npm `prepack`, whose stdout is interleaved with `npm pack --json`
// output, so the diagnostic must stay on stderr.
console.error(`ok package native artifacts: ${requirements.length}`);
