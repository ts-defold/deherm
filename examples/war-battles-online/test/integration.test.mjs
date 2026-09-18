import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { runReplay } from "../headless/match.ts";
import { buildBotReplay, readReplayHeader } from "../headless/replay.ts";
import {
  CURRENT_TRANSPORT_EVIDENCE,
  TransportSelectionMachine,
} from "../integration/transport-selection.ts";
import { evaluateEngineAttachment } from "../integration/runtime-capability.ts";
import {
  COMPONENT_PROXY_CAPABILITY,
  WAR_BATTLES_ENGINE_CAPABILITY,
} from "../defold/src/capability-snapshot.ts";

const exampleRoot = path.resolve(import.meta.dirname, "..");
const repositoryRoot = path.resolve(exampleRoot, "../..");
const fromExample = (...segments) => path.join(exampleRoot, ...segments);
const fromRepository = (...segments) => path.join(repositoryRoot, ...segments);

test("32-bot replay is byte-reproducible and detects corruption", () => {
  const options = { players: 32, ticks: 300, seed: 0xc0ffee, matchId: 77 };
  const first = buildBotReplay(options);
  const second = buildBotReplay(options);
  assert.deepEqual(first, second);
  assert.deepEqual(readReplayHeader(first), readReplayHeader(second));
  const corrupted = first.slice();
  corrupted[corrupted.length - 1] ^= 1;
  assert.throws(() => readReplayHeader(corrupted), /body hash/);
});

test("authoritative rollback reproduces the uninterrupted 32-player match", () => {
  const replay = buildBotReplay({ players: 32, ticks: 1_200, seed: 0xc0ffee, matchId: 77 });
  const baseline = runReplay(replay);
  const rolledBack = runReplay(replay, { restoreTick: 350, triggerTick: 430 });
  assert.equal(rolledBack.stateHash, baseline.stateHash);
  assert.equal(rolledBack.totalKills, baseline.totalKills);
  assert.equal(rolledBack.rollbackCount, 1);
  assert.ok(baseline.totalKills > 0, "bots should exercise authoritative combat");
});

test("32-player ten-minute simulated soak remains deterministic across rollback", async () => {
  const replay = buildBotReplay({ players: 32, ticks: 36_000, seed: 0xc0ffee, matchId: 77 });
  const baseline = runReplay(replay);
  const rolledBack = runReplay(replay, { restoreTick: 12_000, triggerTick: 12_060 });
  assert.equal(rolledBack.stateHash, baseline.stateHash);
  assert.equal(rolledBack.replayBodyHash, baseline.replayBodyHash);
  assert.equal(rolledBack.rollbackCount, 1);
  assert.equal(baseline.players, 32);
  assert.equal(baseline.ticks, 36_000);
  const evidence = JSON.parse(await readFile(
    fromExample("evidence/headless-soak.json"),
    "utf8",
  ));
  assert.equal(evidence.stateHash, baseline.stateHash);
  assert.equal(evidence.replayBodyHash, baseline.replayBodyHash);
  assert.equal(evidence.replayBytes, replay.byteLength);
  assert.equal(evidence.rollbackMatchesUninterrupted, true);
});

test("transport selection labels WebSocket fallback and never promotes it as QUIC", () => {
  const machine = new TransportSelectionMachine(CURRENT_TRANSPORT_EVIDENCE);
  const probing = machine.begin();
  assert.equal(probing.kind, "probing");
  assert.equal(probing.candidate.id, "colyseus-websocket");
  assert.equal(probing.candidate.protocol, "websocket-tcp");
  const selected = machine.reportProbe(true, "official Defold WebSocket adapter connected");
  assert.equal(selected.kind, "selected");
  assert.equal(selected.candidate.protocol, "websocket-tcp");
  assert.notEqual(selected.candidate.protocol, "webtransport-h3-quic");
});

test("transport selection exhausts honestly when every fallback is disabled", () => {
  const machine = new TransportSelectionMachine({
    ...CURRENT_TRANSPORT_EVIDENCE,
    defoldWebSocket: false,
    allowWebSocketFallback: false,
    allowOfflineHeadless: false,
  });
  const result = machine.begin();
  assert.equal(result.kind, "exhausted");
  assert.equal(result.failures.length, 6);
});

test("Defold attachment consumes generated proxy evidence and the independent engine gate", async () => {
  const fixtureManifest = JSON.parse(await readFile(
    fromRepository("tests/fixtures/war-battles/.deherm/generated/components/manifest.json"),
    "utf8",
  ));
  const runtimeGate = JSON.parse(await readFile(fromRepository(".agents/docs/data/war-battles-runtime-gate.json"), "utf8"));
  const exampleManifest = JSON.parse(await readFile(
    fromExample("defold/.deherm/generated/components/manifest.json"),
    "utf8",
  ));
  const staleFixtureDecision = evaluateEngineAttachment(fixtureManifest, runtimeGate);
  assert.equal(staleFixtureDecision.allowed, false);
  assert.match(staleFixtureDecision.blockers.join("\n"), /packaged-engine gameplay execution has not been observed/);

  const decision = evaluateEngineAttachment(exampleManifest, runtimeGate);
  assert.equal(decision.allowed, false);
  assert.match(decision.blockers.join("\n"), /gameplay execution has not been observed/);
  assert.equal(COMPONENT_PROXY_CAPABILITY.state, exampleManifest.proxyRuntimeCapability.state);
  assert.equal(
    COMPONENT_PROXY_CAPABILITY.runtimeConformant,
    exampleManifest.proxyRuntimeCapability.runtimeConformant,
  );
  assert.equal(WAR_BATTLES_ENGINE_CAPABILITY.status, runtimeGate.status);
  assert.equal(
    WAR_BATTLES_ENGINE_CAPABILITY.gameplayExecutionObserved,
    runtimeGate.gameplayExecutionObserved,
  );
  assert.equal(
    WAR_BATTLES_ENGINE_CAPABILITY.requirementsEngineVerified,
    runtimeGate.requirements.every((requirement) => requirement.engineContextVerified === true),
  );
  assert.equal(exampleManifest.proxyRuntimeCapability.runtimeConformant, false);
  assert.equal(
    exampleManifest.proxyRuntimeCapability.state,
    "native-dynamic-hermes-harness-executable",
  );
  assert.equal(exampleManifest.components.length, 1);
  assert.equal(exampleManifest.components[0].source, "main/battle.gui.ts");
  assert.equal(exampleManifest.components[0].proxy, "main/battle.gui_script");
  assert.equal(exampleManifest.components[0].contextKind, "gui-scene");
});

test("checked bundle evidence is reproducible from the measurement command", async () => {
  const observed = JSON.parse(execFileSync(
    process.execPath,
    [fromExample("headless/measure-bundles.mjs")],
    { cwd: repositoryRoot, encoding: "utf8" },
  ));
  const checked = JSON.parse(await readFile(
    fromExample("evidence/bundle-size.json"),
    "utf8",
  ));
  assert.deepEqual(observed, checked);
});

test("checked Defold capability snapshot is fresh against both generated reports", () => {
  const result = execFileSync(
    process.execPath,
    [fromExample("integration/generate-capability-snapshot.mjs"), "--check"],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
  assert.match(result, /fresh/);
});

test("packaged runtime evidence remains bound to current extension and project sources", () => {
  const result = execFileSync(
    process.execPath,
    [fromExample("integration/check-packaged-runtime.mjs"), "--check-sources"],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
  assert.match(result, /war-battles-packaged-runtime-sources:fresh/);
});

test("Defold-local deterministic sources are fresh copies of the canonical core", () => {
  const result = execFileSync(
    process.execPath,
    [fromExample("integration/sync-defold-sources.mjs"), "--check"],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
  assert.match(result, /9 generated Defold sources are fresh/);
});

test("playable GUI uses fixed render pools and the generated proxy flow", async () => {
  const [scene, proxy, collection, authored, blockers, packagedEvidence] = await Promise.all([
    readFile(fromExample("defold/main/battle.gui"), "utf8"),
    readFile(fromExample("defold/main/battle.gui_script"), "utf8"),
    readFile(fromExample("defold/main/main.collection"), "utf8"),
    readFile(fromExample("defold/main/battle.gui.ts"), "utf8"),
    readFile(fromExample("defold/PLAYABLE-BLOCKERS.md"), "utf8"),
    readFile(fromExample("evidence/packaged-runtime-arm64-macos.json"), "utf8").then(JSON.parse),
  ]);
  assert.equal((scene.match(/id: "tank_body_/g) ?? []).length, 32);
  assert.equal((scene.match(/id: "tank_turret_/g) ?? []).length, 32);
  assert.equal((scene.match(/id: "projectile_/g) ?? []).length, 160);
  assert.match(scene, /script: "\/main\/battle\.gui_script"/);
  assert.match(proxy, /@generated by @ts-defold\/deherm/);
  assert.match(proxy, /COMPONENT_CONTEXT = "gui-scene"/);
  assert.match(collection, /prototype: "\/main\/battle\.go"/);
  assert.match(authored, /gui\.getNode/);
  assert.doesNotMatch(authored, /gui\.new(?:Box|Text)Node/);
  assert.match(blockers, /script:gui\.new_box_node.*0xfdb31d1e/);
  assert.match(blockers, /global '_deherm_' \(a nil value\)/);
  assert.match(authored, /war-battles-runtime:gui-init-rendered/);
  assert.equal(packagedEvidence.status, "observed-clean");
  assert.equal(packagedEvidence.schemaVersion, 2);
  assert.equal(packagedEvidence.scope, "war-battles-packaged-gui-typescript-dynamic-hermes");
  assert.equal(packagedEvidence.observation.requiredMarkers.includes(
    "INFO:DEFOLD_HERMES: war-battles-runtime:gui-init-rendered:32:160",
  ), true);
  assert.equal(packagedEvidence.observation.requiredMarkers.includes(
    "INFO:DEFOLD_HERMES: war-battles-runtime:first-update-rendered:32:160",
  ), true);
  assert.match(packagedEvidence.sourceKey, /^[0-9a-f]{64}$/);
  assert.match(packagedEvidence.observation.transcript.canonicalSha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(packagedEvidence.observation.termination, { method: "sigterm", exitCode: null, signal: "SIGTERM" });
  assert.equal(Object.hasOwn(packagedEvidence, "timestamp"), false);
});
