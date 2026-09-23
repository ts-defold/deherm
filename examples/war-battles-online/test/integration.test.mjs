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
import { EXPECTED_COMPONENT_COUNT } from "../integration/check-browser-runtime.mjs";
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
  const bySource = new Map(exampleManifest.components.map((component) => [component.source, component]));
  assert.deepEqual([...bySource.keys()].sort(), [
    // The director owns the match and every factory in the scene.
    "main/arena.script.ts",
    // The camera is a component like any other: the scrolling world reads its
    // orthographic zoom back off the render camera rather than assuming one.
    "main/camera.script.ts",
    "main/pickup.script.ts",
    "main/player.script.ts",
    "main/rocket.script.ts",
    // One component draws both halves of a tank, because both halves do the
    // same thing: move themselves to the slot they were spawned for.
    "main/tank.script.ts",
    "main/ui.gui.ts",
    "reference/battle.gui.ts",
  ]);
  assert.equal(
    bySource.size,
    EXPECTED_COMPONENT_COUNT,
    "the browser runtime gate asserts this exact count inside the engine",
  );
  assert.equal(bySource.get("main/player.script.ts").proxy, "main/player.script");
  assert.equal(bySource.get("main/player.script.ts").contextKind, "game-object");
  assert.equal(bySource.get("main/rocket.script.ts").proxy, "main/rocket.script");
  assert.deepEqual(
    bySource.get("main/rocket.script.ts").properties.map((property) => [property.name, property.kind]),
    [["dir", "vector3"], ["slot", "number"], ["generation", "number"], ["weapon", "number"]],
  );
  assert.deepEqual(
    bySource.get("main/tank.script.ts").properties.map((property) => property.name),
    ["slot", "part"],
  );
  assert.equal(bySource.get("main/ui.gui.ts").proxy, "main/ui.gui_script");
  assert.equal(bySource.get("main/ui.gui.ts").contextKind, "gui-scene");
  assert.equal(bySource.get("reference/battle.gui.ts").proxy, "reference/battle.gui_script");
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
  assert.match(result, /15 generated Defold sources are fresh/);
});

test("the built project is the arena, and the mockup stays out of the build", async () => {
  const [collection, playerObject, rocketObject, tankObject, arenaObject, levelObject, scene,
    playerSource, rocketSource, arenaSource, uiSource, inputBinding, blockers] =
    await Promise.all([
      readFile(fromExample("defold/main/main.collection"), "utf8"),
      readFile(fromExample("defold/main/player.go"), "utf8"),
      readFile(fromExample("defold/main/rocket.go"), "utf8"),
      readFile(fromExample("defold/main/tank.go"), "utf8"),
      readFile(fromExample("defold/main/arena.go"), "utf8"),
      readFile(fromExample("defold/main/level.go"), "utf8"),
      readFile(fromExample("defold/main/ui.gui"), "utf8"),
      readFile(fromExample("defold/main/player.script.ts"), "utf8"),
      readFile(fromExample("defold/main/rocket.script.ts"), "utf8"),
      readFile(fromExample("defold/main/arena.script.ts"), "utf8"),
      readFile(fromExample("defold/main/ui.gui.ts"), "utf8"),
      readFile(fromExample("defold/input/game.input_binding"), "utf8"),
      readFile(fromExample("defold/PLAYABLE-BLOCKERS.md"), "utf8"),
    ]);

  assert.match(collection, /prototype: "\/main\/level\.go"/);
  assert.match(collection, /prototype: "\/main\/player\.go"/);
  assert.match(collection, /prototype: "\/main\/gui\.go"/);
  assert.match(collection, /prototype: "\/main\/arena\.go"/);
  // The four tutorial tanks stay: they are the collision targets the packaged
  // runtime gate's demonstration rocket is observed hitting.
  assert.equal((collection.match(/prototype: "\/main\/tank\.go"/g) ?? []).length, 4);
  assert.doesNotMatch(collection, /battle\.go/);

  assert.match(levelObject, /component: "\/main\/arena\.tilemap"/);
  assert.match(playerObject, /component: "\/main\/player\.script"/);
  assert.match(playerObject, /type: "factory"/);
  assert.match(playerObject, /prototype: \\"\/main\/rocket\.go\\"/);
  assert.match(rocketObject, /type: COLLISION_OBJECT_TYPE_KINEMATIC/);
  assert.match(rocketObject, /group: \\"rockets\\"/);
  assert.match(rocketObject, /mask: \\"tanks\\"/);
  assert.match(tankObject, /group: \\"tanks\\"/);
  assert.match(tankObject, /mask: \\"rockets\\"/);

  // Every object the arena creates is created through the director's own
  // relative factory URLs.
  for (const factoryId of ["tankfactory", "pickupfactory", "shotfactory", "boomfactory", "sparkfactory"]) {
    assert.match(arenaObject, new RegExp(`id: "${factoryId}"`), `arena.go is missing ${factoryId}`);
    assert.match(arenaSource, new RegExp(`"#${factoryId}"`), `arena.script.ts never uses ${factoryId}`);
  }
  for (const soundId of ["sfx_fire", "sfx_hit", "sfx_explosion", "sfx_pickup", "sfx_round"]) {
    assert.match(arenaObject, new RegExp(`id: "${soundId}"`), `arena.go is missing ${soundId}`);
    assert.match(arenaSource, new RegExp(`"#${soundId}"`), `arena.script.ts never plays ${soundId}`);
  }
  assert.match(inputBinding, /input: KEY_R[\s\S]*action: "restart"/);
  assert.match(playerSource, /msg\.post\(ARENA, "restart"\)/);
  assert.match(arenaSource, /war-battles:arena-restart:round=/);
  assert.match(arenaSource, /sound\.play\(url\)/);

  assert.match(scene, /script: "\/main\/ui\.gui_script"/);
  assert.equal((scene.match(/type: TYPE_TEXT/g) ?? []).length, 4);
  assert.match(scene, /id: "score"/);
  assert.match(scene, /id: "status"/);

  // The scripted demonstration the runtime gates observe is still exactly what
  // it was, and still reaches the same markers.
  assert.match(playerSource, /factory\.create\("#rocketfactory"/);
  assert.match(playerSource, /war-battles:player-fire/);
  assert.match(playerSource, /war-battles:player-moved/);
  assert.match(rocketSource, /property\.vector3\(0, 0, 0\)/);
  assert.match(rocketSource, /msg\.post\("\/gui#ui", "add_score"/);
  assert.match(uiSource, /gui\.getNode\("score"\)/);
  assert.match(blockers, /war-battles:rocket-explosion-done/);
});

test("the arena tilemap is the picture of the arena the simulation collides with", () => {
  const result = execFileSync(
    process.execPath,
    [fromExample("tools/generate-arena-tilemap.mjs"), "--check"],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
  assert.match(result, /war-battles-arena-tilemap:fresh/);
});

test("the generated arena art is fresh and its tile map is machine-readable", async () => {
  const result = execFileSync(
    process.execPath,
    [fromExample("tools/generate-art.mjs"), "--check"],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
  assert.match(result, /war-battles-art:fresh/);
  const manifest = JSON.parse(await readFile(
    fromExample("defold/assets/derived/arena/arena-art.json"),
    "utf8",
  ));
  const map = manifest.tileSheet.map;
  assert.equal(map.groundTileIds.length, 4);
  assert.deepEqual(
    Object.keys(map.wallTileIds).sort(),
    ["centre", "e", "n", "ne", "nw", "s", "se", "sw", "w"],
  );
  for (const key of ["crateTileId", "sandbagTileId", "spawnPadTileId", "pickupPadTileId"]) {
    assert.equal(Number.isInteger(map[key]), true, `${key} must be a tile id`);
  }
  // The atlas the components address by name has to actually declare them.
  const atlas = await readFile(fromExample("defold/main/arena-sprites.atlas"), "utf8");
  for (const animation of [
    "tank-blue-hull", "tank-blue-turret", "tank-blue-wreck",
    "tank-red-hull", "tank-green-hull", "tank-sand-hull",
    "proj-cannon", "proj-machinegun", "proj-railgun", "proj-scatter", "proj-mortar", "proj-ricochet",
    "explosion-big", "explosion-small",
    "pickup-health", "pickup-armor", "pickup-overdrive",
    "pickup-machinegun", "pickup-railgun", "pickup-scatter", "pickup-mortar", "pickup-ricochet",
  ]) {
    assert.match(atlas, new RegExp(`id: "${animation}"`), `arena-sprites.atlas is missing ${animation}`);
  }
});

test("the generated 8-bit sound cues are fresh and valid PCM WAV resources", async () => {
  const result = execFileSync(
    process.execPath,
    [fromExample("tools/generate-sound.mjs"), "--check"],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
  assert.match(result, /war-battles-sound:fresh:5/);
  for (const cue of ["fire", "hit", "explosion", "pickup", "round"]) {
    const bytes = await readFile(fromExample(`defold/assets/derived/audio/${cue}.wav`));
    assert.equal(bytes.subarray(0, 4).toString("ascii"), "RIFF");
    assert.equal(bytes.subarray(8, 12).toString("ascii"), "WAVE");
    assert.ok(bytes.length > 1_000, `${cue}.wav is unexpectedly empty`);
  }
});
