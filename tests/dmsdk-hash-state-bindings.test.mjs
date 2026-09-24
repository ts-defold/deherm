import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { build } from "../scripts/generate-dmsdk-hash-state-bindings.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sdk = path.join(root, "upstream/extender/server/app/sdk/7f0f554f41f9dce1e0ddff99bf08200657d1ee05/defoldsdk");
const cxx = process.env.CXX || "clang++";
const run = (command, args, options = {}) => execFileSync(command, args, { cwd: root, encoding: "utf8", stdio: "pipe", ...options });
const includes = ["-Idefold/defold_hermes/include", "-isystem", path.join(sdk, "sdk/include"), "-isystem", path.join(sdk, "include")];

test("hash-state family is structural, exhaustive, evidence-gated, and clean-room deterministic", async () => {
  const report = JSON.parse(await readFile(path.join(root, "packages/bindings/generated/defold-dmsdk-hash-state-bindings.json"), "utf8"));
  assert.deepEqual(report.coverage, { discovered: 10, generated: 10, blocked: 0, registryCapacityPerWidth: 16, exactFixtureCount: 10 });
  assert.equal(new Set(report.declarations.map(({ id }) => id)).size, 10);
  assert.deepEqual(new Set(report.declarations.map(({ operation }) => operation)), new Set(["Init", "Clone", "UpdateBuffer", "Final", "Release"]));
  for (const declaration of report.declarations) {
    assert.equal(declaration.disposition, "generated");
    assert.ok([32, 64].includes(declaration.width));
  }
  const directory = await mkdtemp(path.join(tmpdir(), "deherm-hash-state-"));
  try {
    run(process.execPath, ["scripts/generate-dmsdk-hash-state-bindings.mjs", "--out-root", directory]);
    for (const artifact of [...report.artifacts, "packages/bindings/generated/defold-dmsdk-hash-state-bindings.json"]) assert.equal(await readFile(path.join(directory, artifact), "utf8"), await readFile(path.join(root, artifact), "utf8"), artifact);
    const options = {};
    for (const [key, relative] of Object.entries(report.sources)) options[key] = await readFile(path.join(root, relative), "utf8");
    const changed = JSON.parse(options.symbols);
    changed.declarations[report.declarations[0].id].availability = "partial";
    const linkageDrift = await build({ ...options, symbols: JSON.stringify(changed) });
    assert.equal(linkageDrift.report.coverage.generated, 9);
    assert.equal(linkageDrift.report.coverage.blocked, 1);
    assert.equal(linkageDrift.report.blockedDeclarations[0].blocker, "hash-state-linkage-unverified");
    assert.equal(linkageDrift.report.blockedDeclarations[0].universalFallback, "retained");
    const changedPolicy = JSON.parse(options.policy);
    changedPolicy.candidateSelector.expectedCount = 11;
    const staleHistoricalCount = await build({ ...options, policy: JSON.stringify(changedPolicy) });
    assert.equal(staleHistoricalCount.report.coverage.discovered, 10);
    assert.equal(staleHistoricalCount.report.coverage.generated, 10);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("hash-state registry exact twin sanitizes and stays allocation-free when warm", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "deherm-hash-state-runtime-"));
  try {
    const executable = path.join(directory, "runtime");
    run(cxx, ["-std=c++17", "-Wall", "-Wextra", "-Werror", "-pedantic", "-fsanitize=address,undefined", "-fno-omit-frame-pointer", ...includes, "defold/defold_hermes/src/generated_dmsdk_hash_state.cpp", "tests/fixtures/generated_dmsdk_hash_state_exact.cpp", "native/dmsdk_hash_state_runtime_test.cpp", "-o", executable]);
    assert.equal(run(executable, [], { env: { ...process.env, ASAN_OPTIONS: "detect_leaks=0", UBSAN_OPTIONS: "halt_on_error=1" } }).trim(), "dmsdk-hash-state:ok allocations=0 iterations=100000");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("hash-state generator rejects source and symbol provenance drift", async () => {
  const report = JSON.parse(await readFile(path.join(root, "packages/bindings/generated/defold-dmsdk-hash-state-bindings.json"), "utf8"));
  const options = {};
  for (const [key, relative] of Object.entries(report.sources)) options[key] = await readFile(path.join(root, relative), "utf8");
  await assert.rejects(() => build({ ...options, ir: `${options.ir}\n` }), /provenance drifted/);
});
