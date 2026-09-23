#!/usr/bin/env node

import { chmod, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildEvidenceDocument,
  checkedRequiredMarkers,
  digestEvidenceInputs,
  REQUIRED_MARKERS,
  runPackagedRuntimeEvidence,
  sha256Artifact,
  sha256Tree,
  transcriptEvidence,
} from "./packaged-runtime-evidence.mjs";
import {
  harvestTranscript,
  mergeOccurrences,
  readBugPool,
  writeBugPool,
} from "@ts-defold/deherm/dev/bug-pool";

const exampleRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(exampleRoot, "../..");
const engine = resolve(exampleRoot, "defold/build/arm64-osx/dmengine");
const runtimeCwd = resolve(exampleRoot, "defold/build/default");
const evidencePath = resolve(exampleRoot, "evidence/packaged-runtime-arm64-macos.json");
const bugPoolPath = resolve(exampleRoot, "defold/.deherm/dev/bug-pool.json");
const artifactPaths = [
  "examples/war-battles-online/defold/build/arm64-osx/dmengine",
  "examples/war-battles-online/defold/build/default/game.arcd",
  "examples/war-battles-online/defold/build/default/game.arci",
  "examples/war-battles-online/defold/build/default/game.dmanifest",
  "examples/war-battles-online/defold/build/default/game.projectc",
  "examples/war-battles-online/defold/build/default/deherm/app.dehermc",
];
const sourceFilePaths = [
  "upstream.lock",
  "examples/war-battles-online/defold/deherm.lock",
  "examples/war-battles-online/defold/.deherm/ir/binding-lowering-plan.sentinel.json",
  "examples/war-battles-online/defold/.deherm/generated/components/manifest.json",
];
const arguments_ = new Set(process.argv.slice(2));
for (const argument of arguments_) {
  if (!["--record-evidence", "--check-evidence", "--check-sources"].includes(argument)) throw new Error(`Unknown argument: ${argument}`);
}
if (["--record-evidence", "--check-evidence", "--check-sources"].filter((argument) => arguments_.has(argument)).length > 1) {
  throw new Error("Runtime evidence modes are mutually exclusive");
}

const sourceInputs = [
  await sha256Tree(repositoryRoot, "defold/defold_hermes"),
  await sha256Tree(repositoryRoot, "examples/war-battles-online/defold", {
    exclude: (path) => path === "build" || path.startsWith("build/") ||
      path === ".defignore" ||
      path.endsWith(".md") || path === ".vscode" || path.startsWith(".vscode/") ||
      path === "defold_hermes" || path.startsWith("defold_hermes/") ||
      path === ".internal" || path.startsWith(".internal/") ||
      path === ".deherm" || path.startsWith(".deherm/") ||
      path === "deherm" || path.startsWith("deherm/") ||
      path === "deherm.lock",
  }),
  ...await Promise.all(sourceFilePaths.map((path) => sha256Artifact(repositoryRoot, path))),
];

if (arguments_.has("--check-sources")) {
  const checked = JSON.parse(await readFile(evidencePath, "utf8"));
  const sourceKey = digestEvidenceInputs(sourceInputs);
  if (JSON.stringify(checked.sourceInputs) !== JSON.stringify(sourceInputs) || checked.sourceKey !== sourceKey) {
    throw new Error(`Packaged runtime source evidence is stale: ${evidencePath}`);
  }
  console.log(`war-battles-packaged-runtime-sources:fresh:${sourceKey}`);
  process.exit(0);
}

const artifacts = await Promise.all(artifactPaths.map((path) => sha256Artifact(repositoryRoot, path)));

if (arguments_.has("--check-evidence")) {
  const checked = JSON.parse(await readFile(evidencePath, "utf8"));
  const expected = buildEvidenceDocument({
    artifacts,
    sourceInputs,
    markers: checkedRequiredMarkers(checked.observation?.requiredMarkers),
    shutdownMarkers: checked.observation?.shutdownMarkers,
    settleMs: checked.observation?.settleMs,
    termination: checked.observation?.termination,
    transcript: checked.observation?.transcript,
  });
  if (JSON.stringify(checked) !== JSON.stringify(expected)) {
    throw new Error(`Packaged runtime evidence is stale or malformed: ${evidencePath}`);
  }
  console.log(`war-battles-packaged-runtime-evidence:fresh:${checked.evidenceKey}`);
  process.exit(0);
}

const timeoutMs = Number.parseInt(process.env.DEHERM_WAR_BATTLES_TIMEOUT_MS ?? "30000", 10);
const settleMs = Number.parseInt(process.env.DEHERM_WAR_BATTLES_SETTLE_MS ?? "1500", 10);
// Every packaged run is also an observation of how this software behaved. The
// transcript feeds the shared runtime bug pool so defects accumulate across
// runs; the pool is behavioural evidence only and never a conformance claim.
const harvestRun = async (transcript) => {
  try {
    const pool = await readBugPool(bugPoolPath);
    mergeOccurrences(pool, harvestTranscript(transcript, { origin: "packaged-run" }));
    await writeBugPool(bugPoolPath, pool);
  } catch {
    // Harvesting must never change the outcome of the runtime gate.
  }
};

// Bob's `bundle` step sets the executable bit; its `build` step, which is what
// produces the engine this gate runs, leaves the linked artifact at 0644. The
// mode is not part of the artifact's identity - the evidence hashes contents -
// so setting it here is what lets a fresh `resolve build` be run directly.
const engineMode = (await stat(engine)).mode;
if ((engineMode & 0o111) === 0) await chmod(engine, engineMode | 0o755);

let result;
try {
  result = await runPackagedRuntimeEvidence({
    command: engine,
    cwd: runtimeCwd,
    timeoutMs,
    settleMs,
  });
} catch (error) {
  await harvestRun(String(error?.message ?? error));
  throw error;
}
await harvestRun(result.transcript);
const evidence = buildEvidenceDocument({
  artifacts,
  sourceInputs,
  markers: result.markers,
  shutdownMarkers: result.shutdownMarkers,
  settleMs: result.settleMs,
  termination: result.termination,
  transcript: transcriptEvidence(result.transcript),
});
console.log(`war-battles-packaged-runtime:ok:${evidence.evidenceKey}`);
for (const marker of result.markers) console.log(marker);
for (const marker of result.shutdownMarkers) console.log(marker);
console.log(`war-battles-packaged-runtime:graceful-exit:port=${result.termination.port}:code=${result.termination.exitCode}`);
if (arguments_.has("--record-evidence")) {
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`war-battles-packaged-runtime:evidence:${evidencePath}`);
}
