#!/usr/bin/env node

// The post-publication reporter runs on a fresh checkout without dependencies.
// Keep this entrypoint independent of policy generation and release tooling.
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export async function assertNativeArtifactReconciliationHealth(file) {
  const health = JSON.parse(await readFile(file, "utf8"));
  if (!health || typeof health !== "object" || !Array.isArray(health.failures) || !Array.isArray(health.unsupported)) {
    throw new Error("Native-artifact reconciliation health report is malformed");
  }
  if (health.failures.length) {
    throw new Error(
      `${health.failures.length} native-artifact reconciliation failure(s) require attention: ` +
        health.failures.map(({ compatibilitySha256, message }) => `${compatibilitySha256}: ${message}`).join("; "),
    );
  }
  for (const { compatibilitySha256, revision, message } of health.unsupported) {
    process.stdout.write(
      `::notice::Native optimization is unsupported for ${compatibilitySha256 ?? "unknown compatibility"}` +
        `${revision ? ` (${revision})` : ""}: ${message ?? "no actionable detail was recorded"}\n`,
    );
  }
  return health;
}

async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 1 || argv[0].startsWith("--")) {
    throw new Error("Usage: check-policy-native-artifact-health.mjs <report.json>");
  }
  await assertNativeArtifactReconciliationHealth(argv[0]);
  process.stdout.write("native-artifact reconciliation health is clean\n");
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await main();
