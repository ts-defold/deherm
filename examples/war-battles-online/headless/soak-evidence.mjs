import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, readlink } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runReplay } from "./match.ts";
import { buildBotReplay, readReplayHeader } from "./replay.ts";

const headlessRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const repositoryRoot = resolve(headlessRoot, "../..");

export const HEADLESS_SOAK_OWNER = "examples/war-battles-online/headless/record-soak.mjs";
export const HEADLESS_SOAK_CONFIG = Object.freeze({
  players: 32,
  ticks: 36_000,
  seed: 0xc0ffee,
  matchId: 77,
});

// The owner is deliberately included in the inventory. Changing the recorder
// is a change to the evidence contract and must force a fresh deterministic
// observation rather than silently reusing an old report.
export const HEADLESS_SOAK_SOURCE_PATHS = Object.freeze([
  "examples/war-battles-online/core",
  "examples/war-battles-online/headless/fixture.ts",
  "examples/war-battles-online/headless/match.ts",
  "examples/war-battles-online/headless/replay.ts",
  HEADLESS_SOAK_OWNER,
  "examples/war-battles-online/headless/soak-evidence.mjs",
  "examples/war-battles-online/package.json",
  "package.json",
  "pnpm-lock.yaml",
]);

async function hashFile(repositoryPath) {
  const bytes = await readFile(resolve(repositoryRoot, repositoryPath));
  return {
    path: repositoryPath,
    kind: "file",
    bytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

async function hashTree(repositoryPath) {
  const root = resolve(repositoryRoot, repositoryPath);
  const files = [];
  let bytes = 0;
  async function visit(absolute, local) {
    const metadata = await lstat(absolute);
    if (metadata.isDirectory()) {
      const entries = await readdir(absolute, { withFileTypes: true });
      for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
        await visit(resolve(absolute, entry.name), local === "" ? entry.name : `${local}/${entry.name}`);
      }
      return;
    }
    if (metadata.isSymbolicLink()) {
      const target = Buffer.from(await readlink(absolute));
      files.push({
        path: local,
        kind: "symlink",
        bytes: target.byteLength,
        sha256: createHash("sha256").update(target).digest("hex"),
      });
      bytes += target.byteLength;
      return;
    }
    assert.equal(metadata.isFile(), true, `unsupported headless soak input: ${absolute}`);
    const contents = await readFile(absolute);
    files.push({
      path: local,
      kind: "file",
      bytes: contents.byteLength,
      sha256: createHash("sha256").update(contents).digest("hex"),
    });
    bytes += contents.byteLength;
  }
  await visit(root, "");
  return {
    path: repositoryPath,
    kind: "tree",
    fileCount: files.length,
    bytes,
    sha256: createHash("sha256").update(JSON.stringify(files)).digest("hex"),
  };
}

export async function buildHeadlessSoakSourceInputs() {
  return Promise.all(
    HEADLESS_SOAK_SOURCE_PATHS.map((path) =>
      path === "examples/war-battles-online/core" ? hashTree(path) : hashFile(path),
    ),
  );
}

export function digestHeadlessSoakSourceInputs(sourceInputs) {
  return createHash("sha256").update(JSON.stringify(sourceInputs)).digest("hex");
}

export function buildHeadlessSoakEvidence({ sourceInputs, sourceKey } = {}) {
  const replay = buildBotReplay(HEADLESS_SOAK_CONFIG);
  const header = readReplayHeader(replay);
  const baseline = runReplay(replay);
  const authoritative = runReplay(replay, {
    restoreTick: 12_000,
    triggerTick: 12_060,
  });
  assert.equal(baseline.stateHash, authoritative.stateHash);
  assert.equal(baseline.replayBodyHash, authoritative.replayBodyHash);
  assert.equal(authoritative.rollbackCount, 1);
  const report = {
    schemaVersion: 2,
    owner: HEADLESS_SOAK_OWNER,
    generator: HEADLESS_SOAK_OWNER,
    kind: "war-battles.headless-soak",
    scope: "In-process deterministic simulation; no network, engine, renderer, or VM allocation profiling",
    fixture:
      "Recorded match: the real BotController drives all 32 tanks, and the replay is the input stream it produced",
    players: header.players,
    ticks: header.ticks,
    tickRate: 60,
    simulatedSeconds: header.ticks / 60,
    replayBytes: replay.byteLength,
    seed: header.seed,
    matchId: header.matchId,
    mapSeed: header.seed,
    stateHash: baseline.stateHash,
    replayBodyHash: baseline.replayBodyHash,
    alivePlayers: baseline.alivePlayers,
    totalKills: baseline.totalKills,
    rollbackCount: authoritative.rollbackCount,
    rollbackMatchesUninterrupted: true,
    ...(sourceInputs === undefined ? {} : { sourceInputs }),
    ...(sourceKey === undefined ? {} : { sourceKey }),
    evidenceBoundary:
      "Deterministic in-process simulation and rollback replay only; not network, Defold engine, rendering, VM allocation, or wall-clock performance evidence.",
  };
  assertHeadlessSoakEvidence(report, { sourceInputs });
  return report;
}

export function assertHeadlessSoakEvidence(document, { sourceInputs } = {}) {
  assert.equal(document?.schemaVersion, 2);
  assert.equal(document?.owner, HEADLESS_SOAK_OWNER);
  assert.equal(document?.generator, HEADLESS_SOAK_OWNER);
  assert.equal(document?.kind, "war-battles.headless-soak");
  assert.equal(document?.players, HEADLESS_SOAK_CONFIG.players);
  assert.equal(document?.ticks, HEADLESS_SOAK_CONFIG.ticks);
  assert.equal(document?.tickRate, 60);
  assert.equal(document?.simulatedSeconds, 600);
  assert.equal(document?.replayBytes, 36_864_032);
  assert.equal(document?.seed, HEADLESS_SOAK_CONFIG.seed);
  assert.equal(document?.matchId, HEADLESS_SOAK_CONFIG.matchId);
  assert.equal(document?.mapSeed, HEADLESS_SOAK_CONFIG.seed);
  assert.equal(document?.rollbackCount, 1);
  assert.equal(document?.rollbackMatchesUninterrupted, true);
  assert.equal(typeof document?.stateHash, "number");
  assert.equal(typeof document?.replayBodyHash, "number");
  assert.equal(typeof document?.evidenceBoundary, "string");
  if (sourceInputs !== undefined) {
    assert.deepEqual(document.sourceInputs, sourceInputs, "headless soak evidence source inventory is stale");
    assert.equal(document.sourceKey, digestHeadlessSoakSourceInputs(sourceInputs), "headless soak source key is stale");
  }
  return document;
}
