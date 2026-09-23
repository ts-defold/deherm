#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertHeadlessSoakEvidence,
  buildHeadlessSoakEvidence,
  buildHeadlessSoakSourceInputs,
  digestHeadlessSoakSourceInputs,
} from "./soak-evidence.mjs";

const exampleRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const evidencePath = resolve(exampleRoot, "evidence/headless-soak.json");
const mode = process.argv[2] ?? "--check-evidence";
if (!["--record", "--record-evidence", "--check", "--check-evidence", "--check-sources"].includes(mode)) {
  throw new Error(`unknown mode: ${mode}`);
}

const sourceInputs = await buildHeadlessSoakSourceInputs();
const sourceKey = digestHeadlessSoakSourceInputs(sourceInputs);
const generated = buildHeadlessSoakEvidence({ sourceInputs, sourceKey });
const serialized = `${JSON.stringify(generated, null, 2)}\n`;

if (mode === "--record" || mode === "--record-evidence") {
  await writeFile(evidencePath, serialized);
  process.stdout.write(`war-battles-headless-soak:recorded:${evidencePath}\n`);
} else if (mode === "--check-sources") {
  const recorded = JSON.parse(await readFile(evidencePath, "utf8"));
  assertHeadlessSoakEvidence(recorded, { sourceInputs });
  process.stdout.write(`war-battles-headless-soak-sources:fresh:${sourceKey}\n`);
} else {
  const recorded = await readFile(evidencePath, "utf8");
  assertHeadlessSoakEvidence(JSON.parse(recorded), { sourceInputs });
  if (recorded !== serialized) throw new Error("headless soak evidence is stale; rerun --record-evidence");
  process.stdout.write(`war-battles-headless-soak-evidence:fresh:${sourceKey}\n`);
}
