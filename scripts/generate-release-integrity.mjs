#!/usr/bin/env node

import { writeFile } from "node:fs/promises";

import { buildReleaseIntegrity } from "../packages/cli/src/release-integrity.mjs";

const [archive, output, family, tag, fingerprint, asset] = process.argv.slice(2);
if (!archive || !output || !family || !tag || !fingerprint || !asset) {
  throw new Error("Usage: generate-release-integrity.mjs <archive> <output> <family> <tag> <fingerprint> <asset>");
}
const document = await buildReleaseIntegrity({ family, tag, fingerprint, asset, archive });
await writeFile(output, `${JSON.stringify(document, null, 2)}\n`);
