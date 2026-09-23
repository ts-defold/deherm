#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runAuthoritativeLoadHarness } from "./authoritative-load-harness.ts";
import {
  assertAuthoritativeLoadEvidence,
  AUTHORITATIVE_LOAD_OWNER,
  buildAuthoritativeLoadSourceInputs,
  digestAuthoritativeLoadSourceInputs,
} from "./authoritative-load-evidence.mjs";

const exampleRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const repositoryRoot = resolve(exampleRoot, "../..");
const evidencePath = resolve(exampleRoot, "evidence/authoritative-load-32.json");

const sourceInputs = await buildAuthoritativeLoadSourceInputs();
const generated = {
  ...await runAuthoritativeLoadHarness(),
  owner: AUTHORITATIVE_LOAD_OWNER,
  generator: AUTHORITATIVE_LOAD_OWNER,
  sourceInputs,
  sourceKey: digestAuthoritativeLoadSourceInputs(sourceInputs),
};
assertAuthoritativeLoadEvidence(generated, { sourceInputs });
const serialized = `${JSON.stringify(generated, null, 2)}\n`;
const mode = process.argv[2] ?? "--record-evidence";
if (mode === "--record-evidence") {
  await writeFile(evidencePath, serialized);
  process.stdout.write(`war-battles-authoritative-load:recorded:${evidencePath}\n`);
} else if (mode === "--check-evidence") {
  const checked = await readFile(evidencePath, "utf8");
  assert.equal(checked, serialized, "authoritative load evidence is stale; rerun --record-evidence");
  process.stdout.write(`war-battles-authoritative-load-evidence:fresh:${generated.sourceKey}\n`);
} else if (mode === "--check-sources") {
  const checked = JSON.parse(await readFile(evidencePath, "utf8"));
  assertAuthoritativeLoadEvidence(checked, { sourceInputs });
  process.stdout.write(`war-battles-authoritative-load-sources:fresh:${generated.sourceKey}\n`);
} else if (mode === "--json") {
  process.stdout.write(serialized);
} else {
  throw new Error(`unknown mode: ${mode}`);
}
