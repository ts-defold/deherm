#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixturePath = path.join(repositoryRoot, "tests", "fixtures", "policy-surface-old-pipeline", "manifest.json");
const generatedRoot = path.join(repositoryRoot, "packages", "sdk", "src", "generated");
const loweringPlanPath = path.join(repositoryRoot, "packages", "bindings", "generated", "defold-binding-lowering-plan.json");
const policyIndexPath = path.join(repositoryRoot, "packages", "bindings", "generated", "defold-policy-index.json");

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function capture() {
  const previous = JSON.parse(await readFile(fixturePath, "utf8"));
  const policyIndex = JSON.parse(await readFile(policyIndexPath, "utf8"));
  const files = {};
  const aggregate = createHash("sha256");
  for (const relative of Object.keys(previous.files).sort()) {
    const bytes = await readFile(path.join(generatedRoot, relative));
    const digest = sha256(bytes);
    files[relative] = { bytes: bytes.byteLength, sha256: digest };
    aggregate.update(relative);
    aggregate.update("\0");
    aggregate.update(digest);
    aggregate.update("\0");
  }
  const loweringPlan = await readFile(loweringPlanPath);
  return {
    schemaVersion: 2,
    kind: "deherm.fixture.old-pipeline-sdk",
    defoldRevision: policyIndex.entries[0].defoldRevision,
    treeSha256: aggregate.digest("hex"),
    source:
      "Frozen SHA-256 golden captured from the checkout-backed generated SDK and canonical lowering plan produced by the source pipeline. " +
      "It catches accidental materializer drift but is not implementation-independent because some source-pipeline and materializer emitters are shared. " +
      "It changes only through this explicit capture command after reviewed source-pipeline regeneration.",
    files,
    documents: {
      "defold-binding-lowering-plan.json": {
        bytes: loweringPlan.byteLength,
        sha256: sha256(loweringPlan)
      }
    }
  };
}

const serialized = `${JSON.stringify(await capture(), null, 2)}\n`;
if (process.argv.includes("--update")) {
  await writeFile(fixturePath, serialized);
  console.log(`updated ${path.relative(repositoryRoot, fixturePath)}`);
} else {
  const existing = await readFile(fixturePath, "utf8").catch(() => "");
  if (existing !== serialized) {
    throw new Error(
      "The frozen source-pipeline SDK golden is stale; regenerate the checkout-backed SDK through its source pipeline, " +
      "then run node scripts/capture-policy-surface-old-pipeline.mjs --update."
    );
  }
  console.log(`source-pipeline SDK golden is current (${Object.keys(JSON.parse(serialized).files).length} files)`);
}
