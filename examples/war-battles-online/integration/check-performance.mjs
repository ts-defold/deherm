#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runPerformanceHarness } from "./performance-harness.ts";
import {
  assertPerformanceEvidence,
  buildPerformanceSourceInputs,
  digestPerformanceSourceInputs,
  PERFORMANCE_OWNER,
} from "./performance-evidence.mjs";

const exampleRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const evidencePath = resolve(exampleRoot, "evidence/performance-operability.json");
const sourceInputs = await buildPerformanceSourceInputs();
const generated = {
  ...runPerformanceHarness(),
  owner: PERFORMANCE_OWNER,
  generator: PERFORMANCE_OWNER,
  sourceInputs,
  sourceKey: digestPerformanceSourceInputs(sourceInputs),
  evidenceBoundary:
    "Deterministic in-process simulation/codec operability evidence; no wall-clock, VM allocation, Defold engine, browser, native heap, or WAN claim.",
};
assertPerformanceEvidence(generated, { sourceInputs });
const serialized = `${JSON.stringify(generated, null, 2)}\n`;
const mode = process.argv[2] ?? "--record-evidence";
if (mode === "--record-evidence") {
  await writeFile(evidencePath, serialized);
  process.stdout.write(`war-battles-performance:recorded:${evidencePath}\n`);
} else if (mode === "--check-evidence") {
  const checked = await readFile(evidencePath, "utf8");
  assert.equal(checked, serialized, "performance evidence is stale; rerun --record-evidence");
  process.stdout.write(`war-battles-performance-evidence:fresh:${generated.sourceKey}\n`);
} else if (mode === "--check-sources") {
  const checked = JSON.parse(await readFile(evidencePath, "utf8"));
  assertPerformanceEvidence(checked, { sourceInputs });
  process.stdout.write(`war-battles-performance-sources:fresh:${generated.sourceKey}\n`);
} else if (mode === "--json") {
  process.stdout.write(serialized);
} else {
  throw new Error(`unknown mode: ${mode}`);
}
