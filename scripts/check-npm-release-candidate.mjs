#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const requiredTargets = ["wasm-web", "x86_64-linux"];

export function assertNpmReleaseCandidateEvidence({ consumer, snake, commit, version }) {
  assert.equal(consumer.kind, "deherm.npm-clean-consumer-proof");
  assert.equal(snake.kind, "deherm.npm-snake-consumer-proof");
  assert.equal(consumer.commit, commit, "consumer proof belongs to a different source commit");
  assert.equal(consumer.version, version, "candidate version differs from package.json");
  assert.equal(consumer.sourceClean, true, "candidate source checkout was dirty");
  assert.match(consumer.tarballSha256, /^[a-f0-9]{64}$/u);
  assert.equal(snake.tarballSha256, consumer.tarballSha256, "Snake and clean consumer tested different archives");
  for (const [name, report] of [
    ["consumer", consumer],
    ["Snake", snake],
  ]) {
    assert.ok(report.stages.includes("bob-bundled"), `${name} did not complete Bob bundling`);
    assert.deepEqual(
      report.bundles.map(({ target }) => target).sort(),
      requiredTargets,
      `${name} did not build both targets`,
    );
  }
  return {
    schemaVersion: 1,
    kind: "deherm.npm-release-candidate-evidence",
    commit,
    version,
    tarball: consumer.tarball,
    tarballSha256: consumer.tarballSha256,
    targets: requiredTargets,
    stages: ["isolated-snake-bundled", "isolated-clean-consumer-bundled"],
    limitation: "Bob build and link evidence; packaged game runtime remains a separate gate.",
  };
}

async function main() {
  const [consumer, snake, manifest] = await Promise.all([
    readFile(path.join(root, "build/npm-consumer-proof.json"), "utf8").then(JSON.parse),
    readFile(path.join(root, "build/npm-snake-proof.json"), "utf8").then(JSON.parse),
    readFile(path.join(root, "package.json"), "utf8").then(JSON.parse),
  ]);
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const result = assertNpmReleaseCandidateEvidence({ consumer, snake, commit, version: manifest.version });
  await writeFile(path.join(root, "build/npm-release-evidence.json"), `${JSON.stringify(result, null, 2)}\n`);
  console.log(`npm-release-candidate:${result.commit}:${result.tarballSha256}:${result.targets.join(",")}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
