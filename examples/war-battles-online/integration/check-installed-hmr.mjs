#!/usr/bin/env node

// Installed-package War Battles HMR soak.
//
// The command launches the public package boundary and owns the integration
// claim; browser HMR, compiler fingerprints, and HTTP reload acknowledgements
// are not substitutes for a native entity/component state snapshot.

import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_HMR_SOAK_CYCLES,
  HMR_STATE_API,
  formatHmrFailure,
  runHmrStateSoak,
  validateHmrSoakEvidence,
} from "./hmr-state-soak.mjs";
import {
  assertInstalledPackageTreeSha256,
  createWarBattlesHmrDriver,
  packedPackageTreeSha256,
} from "./installed-hmr-driver.mjs";

const exampleRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultEvidencePath = resolve(exampleRoot, "evidence/installed-hmr-soak-native.json");
const repositoryRoot = resolve(exampleRoot, "../..");
const args = new Set(process.argv.slice(2));

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

const cycles = Number.parseInt(
  option("--cycles", process.env.DEHERM_WAR_BATTLES_HMR_CYCLES ?? String(DEFAULT_HMR_SOAK_CYCLES)),
  10,
);
if (!Number.isSafeInteger(cycles) || cycles < 1) throw new Error("--cycles must be a positive integer");
const evidencePath = resolve(option("--evidence", process.env.DEHERM_WAR_BATTLES_HMR_EVIDENCE ?? defaultEvidencePath));
const installedPackageRoot = process.env.DEHERM_INSTALLED_PACKAGE_ROOT
  ? resolve(process.env.DEHERM_INSTALLED_PACKAGE_ROOT)
  : undefined;

async function loadDriver() {
  // The default path is the real public package boundary. An explicit root is
  // useful for CI's already-installed tarball, but no external driver is
  // required to run this command.
  return createWarBattlesHmrDriver({ repositoryRoot, exampleRoot, installedPackageRoot, cycles });
}

async function main() {
  let evidence;
  if (!args.has("--check-evidence")) {
    const adapter = await loadDriver();
    evidence = await runHmrStateSoak(adapter, { cycles });
    if (args.has("--record-evidence")) {
      await writeFile(
        evidencePath,
        `${JSON.stringify(
          {
            schemaVersion: 1,
            title: "War Battles installed native HMR state-preservation soak",
            installedPackage: evidence.installedPackage,
            runtimeApi: evidence.runtimeApi,
            cyclesRequired: cycles,
            ...evidence,
          },
          null,
          2,
        )}\n`,
      );
      console.log(`war-battles-installed-hmr:evidence:${evidencePath}`);
    }
  } else {
    // Recorded evidence is checked explicitly; the default command always
    // exercises a live installed-package/native session.
    let recorded;
    try {
      recorded = await readFile(evidencePath, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") {
        throw new Error(
          [
            `native runtime state API ${HMR_STATE_API} is required`,
            `no recorded evidence exists at ${evidencePath}`,
            "run the live command to capture installed native evidence",
          ].join("; "),
        );
      }
      throw error;
    }
    evidence = JSON.parse(recorded);
    // Evidence is only useful when it describes the package currently being
    // offered at the public npm boundary. Re-pack and hash the package on
    // every check; never trust a digest copied into an old evidence file.
    const currentTreeSha256 = await packedPackageTreeSha256(repositoryRoot);
    assertInstalledPackageTreeSha256(evidence.installedPackage?.treeSha256, currentTreeSha256);
    validateHmrSoakEvidence(evidence, { cycles });
  }
  console.log(`war-battles-installed-hmr:ok:cycles=${evidence.cyclesRequired ?? cycles}`);
  console.log(
    `war-battles-installed-hmr:baseline:entities=${evidence.baseline.entityCount}:components=${evidence.baseline.componentCount}`,
  );
  console.log(
    `war-battles-installed-hmr:telemetry:samples=${evidence.telemetry.samples}:max-components=${evidence.telemetry.maxComponentCount}`,
  );
}

main().catch((error) => {
  console.error(`war-battles-installed-hmr:blocked:${formatHmrFailure(error)}`);
  process.exitCode = 1;
});
