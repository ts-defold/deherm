import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runReplay } from "../headless/match.ts";
import { buildBotReplay, readReplayHeader } from "../headless/replay.ts";
import { CURRENT_TRANSPORT_EVIDENCE, TransportSelectionMachine } from "../integration/transport-selection.ts";
import { evaluateEngineAttachment } from "../integration/runtime-capability.ts";
import { EXPECTED_COMPONENT_COUNT } from "../integration/check-browser-runtime.mjs";
import { COMPONENT_PROXY_CAPABILITY, WAR_BATTLES_ENGINE_CAPABILITY } from "../defold/src/capability-snapshot.ts";

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
  const evidence = JSON.parse(await readFile(fromExample("evidence/headless-soak.json"), "utf8"));
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
  const fixtureManifest = JSON.parse(
    await readFile(fromRepository("tests/fixtures/war-battles/.deherm/generated/components/manifest.json"), "utf8"),
  );
  const runtimeGate = JSON.parse(
    await readFile(fromRepository(".agents/docs/data/war-battles-runtime-gate.json"), "utf8"),
  );
  const exampleManifest = JSON.parse(
    await readFile(fromExample("defold/.deherm/generated/components/manifest.json"), "utf8"),
  );
  const staleFixtureDecision = evaluateEngineAttachment(fixtureManifest, runtimeGate);
  assert.equal(staleFixtureDecision.allowed, false);
  assert.match(staleFixtureDecision.blockers.join("\n"), /packaged-engine gameplay execution has not been observed/);

  const decision = evaluateEngineAttachment(exampleManifest, runtimeGate);
  assert.equal(decision.allowed, false);
  assert.match(decision.blockers.join("\n"), /gameplay execution has not been observed/);
  assert.equal(COMPONENT_PROXY_CAPABILITY.state, exampleManifest.proxyRuntimeCapability.state);
  assert.equal(COMPONENT_PROXY_CAPABILITY.runtimeConformant, exampleManifest.proxyRuntimeCapability.runtimeConformant);
  assert.equal(WAR_BATTLES_ENGINE_CAPABILITY.status, runtimeGate.status);
  assert.equal(WAR_BATTLES_ENGINE_CAPABILITY.gameplayExecutionObserved, runtimeGate.gameplayExecutionObserved);
  assert.equal(
    WAR_BATTLES_ENGINE_CAPABILITY.requirementsEngineVerified,
    runtimeGate.requirements.every((requirement) => requirement.engineContextVerified === true),
  );
  assert.equal(exampleManifest.proxyRuntimeCapability.runtimeConformant, false);
  assert.equal(exampleManifest.proxyRuntimeCapability.state, "native-dynamic-hermes-harness-executable");
  const bySource = new Map(exampleManifest.components.map((component) => [component.source, component]));
  assert.deepEqual([...bySource.keys()].sort(), [
    "main/arena-landmark.script.ts",
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
    [
      ["dir", "vector3"],
      ["slot", "number"],
      ["generation", "number"],
      ["weapon", "number"],
    ],
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
  const observed = JSON.parse(
    execFileSync(process.execPath, [fromExample("headless/measure-bundles.mjs")], {
      cwd: repositoryRoot,
      encoding: "utf8",
    }),
  );
  const checked = JSON.parse(await readFile(fromExample("evidence/bundle-size.json"), "utf8"));
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
  const result = execFileSync(process.execPath, [fromExample("integration/sync-defold-sources.mjs"), "--check"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  assert.match(result, /21 generated Defold sources are fresh/);
});

test("all targets consume the generated WebTransport constructor without a game-level native split", async () => {
  const arena = await readFile(fromExample("defold/main/arena.script.ts"), "utf8");
  const adapter = await readFile(fromExample("core/browser-webtransport.ts"), "utf8");
  assert.match(arena, /defold\.runtime\(\) === "hermes"/u);
  assert.match(arena, /WebTransportGameClient\.connect\([^]*WebTransport/u);
  assert.doesNotMatch(arena, /NativeWebTransportClient|NativeWebTransport,/u);
  assert.match(adapter, /class WebTransportGameClient/u);
  assert.doesNotMatch(adapter, /callScriptApi|callExtension|dispatchScript|\.pump\(/u);
});

test("the built project is the arena, and the mockup stays out of the build", async () => {
  const [
    collection,
    playerObject,
    rocketObject,
    tankObject,
    arenaObject,
    landmarkObject,
    levelObject,
    scene,
    cameraObject,
    playerSource,
    rocketSource,
    arenaSource,
    landmarkSource,
    uiSource,
    cameraSource,
    inputBinding,
    blockers,
  ] = await Promise.all([
    readFile(fromExample("defold/main/main.collection"), "utf8"),
    readFile(fromExample("defold/main/player.go"), "utf8"),
    readFile(fromExample("defold/main/rocket.go"), "utf8"),
    readFile(fromExample("defold/main/tank.go"), "utf8"),
    readFile(fromExample("defold/main/arena.go"), "utf8"),
    readFile(fromExample("defold/main/arena-landmark.go"), "utf8"),
    readFile(fromExample("defold/main/level.go"), "utf8"),
    readFile(fromExample("defold/main/ui.gui"), "utf8"),
    readFile(fromExample("defold/main/camera.go"), "utf8"),
    readFile(fromExample("defold/main/player.script.ts"), "utf8"),
    readFile(fromExample("defold/main/rocket.script.ts"), "utf8"),
    readFile(fromExample("defold/main/arena.script.ts"), "utf8"),
    readFile(fromExample("defold/main/arena-landmark.script.ts"), "utf8"),
    readFile(fromExample("defold/main/ui.gui.ts"), "utf8"),
    readFile(fromExample("defold/main/camera.script.ts"), "utf8"),
    readFile(fromExample("defold/input/game.input_binding"), "utf8"),
    readFile(fromExample("defold/PLAYABLE-BLOCKERS.md"), "utf8"),
  ]);

  assert.match(collection, /prototype: "\/main\/level\.go"/);
  assert.match(collection, /prototype: "\/main\/player\.go"/);
  assert.match(collection, /prototype: "\/main\/gui\.go"/);
  assert.match(collection, /prototype: "\/main\/arena\.go"/);
  // Production play has no static tutorial tanks. The explicit scripted-demo
  // mode owns one factory-created collision target for the evidence shot.
  assert.equal((collection.match(/prototype: "\/main\/tank\.go"/g) ?? []).length, 0);
  assert.match(playerObject, /id: "demotankfactory"/);
  assert.match(playerObject, /prototype: \\"\/main\/tank\.go\\"/);
  assert.doesNotMatch(collection, /battle\.go/);

  // The presentation is one 2:1 projection contract: the tilemap rotates in
  // its component, the level compresses world Y, and dynamic entities use the
  // matching generated TypeScript projection.
  assert.match(levelObject, /z: 0\.3826834323650898[\s\S]*w: 0\.9238795325112867/);
  assert.match(collection, /id: "level"[\s\S]*y: 0\.5/);
  assert.match(playerSource, /projectedX\(self\.transform\.x, self\.transform\.y\)/);
  assert.match(arenaSource, /projectedDirectionRadians\(directionX, directionY\)/);

  assert.match(levelObject, /component: "\/main\/arena\.tilemap"/);
  assert.match(playerObject, /component: "\/main\/player\.script"/);
  assert.match(tankObject, /component: "\/main\/tank\.script"/);
  assert.match(tankObject, /tile_set: \\"\/main\/arena-sprites\.atlas\\"/);
  assert.match(tankObject, /id: "hero"/);
  assert.match(tankObject, /tile_set: \\"\/main\/tutorial-sprites\.atlas\\"/);
  assert.match(playerObject, /type: "factory"/);
  assert.match(playerObject, /prototype: \\"\/main\/rocket\.go\\"/);
  assert.match(rocketObject, /type: COLLISION_OBJECT_TYPE_KINEMATIC/);
  assert.match(rocketObject, /group: \\"rockets\\"/);
  assert.match(rocketObject, /mask: \\"tanks\\"/);
  assert.match(tankObject, /group: \\"tanks\\"/);
  assert.match(tankObject, /mask: \\"rockets\\"/);
  assert.match(landmarkObject, /component: "\/main\/arena-landmark\.script"/);
  assert.match(landmarkObject, /default_animation: \\"landmark-field-bunker\\"/);
  assert.match(landmarkSource, /LANDMARKS: readonly DefoldHash\[\]/);

  // Every object the arena creates is created through the director's own
  // relative factory URLs.
  for (const factoryId of [
    "tankfactory",
    "pickupfactory",
    "shotfactory",
    "boomfactory",
    "sparkfactory",
    "muzzlefactory",
    "landmarkfactory",
  ]) {
    assert.match(arenaObject, new RegExp(`id: "${factoryId}"`), `arena.go is missing ${factoryId}`);
    assert.match(arenaSource, new RegExp(`"#${factoryId}"`), `arena.script.ts never uses ${factoryId}`);
  }
  for (const soundId of ["sfx_fire", "sfx_hit", "sfx_explosion", "sfx_pickup", "sfx_round"]) {
    assert.match(arenaObject, new RegExp(`id: "${soundId}"`), `arena.go is missing ${soundId}`);
    assert.match(arenaSource, new RegExp(`"#${soundId}"`), `arena.script.ts never plays ${soundId}`);
  }
  assert.match(inputBinding, /input: KEY_R[\s\S]*action: "restart"/);
  assert.match(inputBinding, /input: MOUSE_BUTTON_1[\s\S]*action: "deploy"/);
  assert.match(playerSource, /actionId === DEPLOY/);
  assert.match(playerSource, /msg\.post\(UI, "deploy"\)/);
  assert.match(playerSource, /sys\.getConfigInt\("war_battles\.demo", 0\) === 1/);
  assert.match(playerSource, /__warBattlesConfigV1\?\.demo === true/);
  assert.match(playerSource, /msg\.post\(ARENA, "restart"\)/);
  assert.match(arenaSource, /war-battles:arena-restart:round=/);
  assert.match(arenaSource, /sound\.play\(url\)/);
  assert.match(arenaSource, /spawnMuzzle\(self/);
  assert.match(arenaSource, /EVENT_COVER_CHANGED/);
  assert.match(arenaSource, /tilemap\.setTile\(ARENA_TILEMAP, ARENA_MARKS_LAYER/);
  assert.match(arenaSource, /coverVisualDestroyed/);
  assert.match(arenaSource, /EVENT_HAZARD_DAMAGE/);
  assert.match(arenaSource, /spawnEffect\(self, false, self\.event\.x, self\.event\.y\)/);
  assert.match(arenaSource, /msg\.post\(CAMERA, CAMERA_IMPACT, self\.impact\)/);
  assert.match(arenaSource, /self\.impact\.strength = 0/);
  assert.match(
    arenaSource,
    /onWelcome: \(welcome\) => \{[^]*self\.players = Math\.max\(2, Math\.min\(32, Math\.trunc\(welcome\.maximumPlayers\)\)\)/u,
    "the native scene must adopt the authoritative online roster before spawning presentation objects",
  );
  assert.equal((arenaSource.match(/msg\.post\(CAMERA, CAMERA_IMPACT/g) ?? []).length, 1);
  const muzzleObject = await readFile(fromExample("defold/main/arena-muzzle.go"), "utf8");
  assert.match(muzzleObject, /type: "sprite"/);
  assert.match(muzzleObject, /tile_set: \\"\/main\/arena-sprites\.atlas\\"/);
  assert.match(muzzleObject, /default_animation: \\"muzzle\\"/);
  assert.doesNotMatch(muzzleObject, /component:/);
  // Camera clamps must use the effective auto-fit zoom. The HTML5 canvas is
  // responsive, so fixed-mode reference dimensions place the first spawn
  // partly outside the viewport even though the map bounds are correct.
  assert.match(cameraSource, /getOrthographicAutoZoom/);
  assert.match(cameraObject, /orthographic_mode: ORTHO_MODE_AUTO_FIT/);
  assert.match(cameraSource, /SHAKE_DURATION = 0\.18/);
  assert.match(cameraSource, /messageId !== CAMERA_IMPACT/);
  assert.match(cameraSource, /self\.shakeRemaining -= dt/);
  assert.match(cameraSource, /Clamp after applying the impulse/);

  assert.match(scene, /script: "\/main\/ui\.gui_script"/);
  assert.equal((scene.match(/type: TYPE_TEXT/g) ?? []).length, 15);
  for (const id of ["title_back", "title_logo", "title_panel", "title_portrait", "title_deploy", "title_sponsor"]) {
    assert.match(scene, new RegExp(`id: "${id}"`));
  }
  assert.match(scene, /id: "title_panel"[\s\S]*?slice9 \{ x: 6\.0 y: 6\.0 z: 6\.0 w: 6\.0 \}/);
  assert.match(scene, /id: "score"/);
  assert.match(scene, /id: "score_back"/);
  assert.match(scene, /id: "status"/);
  assert.match(scene, /id: "telemetry"/);
  assert.match(scene, /id: "health_label"/);
  assert.match(scene, /id: "armor_label"/);
  assert.match(scene, /id: "announcement"/);
  assert.match(scene, /id: "announcement_back"/);
  assert.match(scene, /id: "objective"/);
  assert.match(scene, /id: "objective_back"/);
  assert.match(scene, /size \{ x: 610\.0 y: 94\.0 \}[\s\S]*?id: "hud_back"/);
  assert.doesNotMatch(scene, /size \{ x: 1280\.0 y: 116\.0 \}[\s\S]*?id: "hud_back"/);
  assert.match(uiSource, /EVENT_KILL/);
  assert.match(uiSource, /EVENT_OBJECTIVE_CAPTURE/);
  assert.match(uiSource, /EVENT_HAZARD_DAMAGE/);
  assert.match(uiSource, /EVENT_COVER_CHANGED/);
  assert.match(uiSource, /COVER PANEL \$\{self\.event\.a \+ 1\} DESTROYED/);
  assert.match(uiSource, /VENT \$\{hazard \+ 1\} HOT/);
  assert.match(uiSource, /COMMAND BEACON/);
  assert.match(uiSource, /gui\.setEnabled\(self\.announcement, false\)/);
  assert.match(uiSource, /ANNOUNCEMENT_TICKS = 180/);
  assert.match(uiSource, /self\.presentationWorld !== world/);
  assert.match(uiSource, /YOU DESTROYED P\$\{victim\}/);
  assert.match(uiSource, /P\$\{attacker\} DESTROYED YOU/);
  assert.match(uiSource, /VENT DESTROYED YOU/);
  assert.match(uiSource, /ROUND \$\{round\}/);
  assert.match(uiSource, /titleVisible: boolean/);
  assert.match(uiSource, /if \(self\.titleVisible\) return/);

  // The scripted demonstration the runtime gates observe still exercises
  // factory creation, movement, GUI lookup, and bounded projectile lifetime.
  assert.match(playerSource, /factory\.create\("#rocketfactory"/);
  assert.match(playerSource, /war-battles:player-fire/);
  assert.match(playerSource, /war-battles:player-moved/);
  assert.match(rocketSource, /property\.vector3\(0, 0, 0\)/);
  assert.match(rocketSource, /msg\.post\("\/gui#ui", "add_score"/);
  assert.match(uiSource, /gui\.getNode\("score"\)/);
  assert.match(blockers, /war-battles:rocket-expired/);
});

test("the arena tilemap is the picture of the arena the simulation collides with", () => {
  const result = execFileSync(process.execPath, [fromExample("tools/generate-arena-tilemap.mjs"), "--check"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  assert.match(result, /war-battles-arena-tilemap:fresh/);
  const tilemap = readFileSync(fromExample("defold/main/arena.tilemap"), "utf8");
  const faces = readFileSync(fromExample("defold/main/arena-wall-faces.tilemap"), "utf8");
  const level = readFileSync(fromExample("defold/main/level.go"), "utf8");
  assert.match(tilemap, /id: "decor"/);
  assert.match(tilemap, /z: 0\.05/);
  assert.match(tilemap, /id: "walls"/);
  assert.match(tilemap, /z: 0\.1/);
  assert.match(faces, /id: "faces"/);
  assert.match(faces, /z: 0\.075/);
  assert.match(level, /component: "\/main\/arena-wall-faces\.tilemap"/);
  assert.doesNotMatch(level, /y: -10\.0/);
});

test("the Defold tilemap generator materializes every seeded visual theme", () => {
  const outputRoot = mkdtempSync(path.join(os.tmpdir(), "war-battles-themes-"));
  const themes = [
    [0x57_41_52_42, "frontier"],
    [0x57_41_52_43, "refinery"],
    [0x57_41_52_40, "canyon"],
  ];
  for (const [seed, theme] of themes) {
    const output = path.join(outputRoot, `${theme}.tilemap`);
    const result = execFileSync(
      process.execPath,
      [fromExample("tools/generate-arena-tilemap.mjs"), "--seed", String(seed), "--output", output],
      { cwd: repositoryRoot, encoding: "utf8" },
    );
    assert.match(result, new RegExp(`theme ${theme} `));
    const tilemap = readFileSync(output, "utf8");
    assert.match(tilemap, /id: "ground"/);
    assert.match(tilemap, /id: "decor"/);
    assert.match(tilemap, /id: "walls"/);
    assert.match(tilemap, /id: "marks"/);
    assert.equal((tilemap.match(/cell \{/g) ?? []).length > 10_800, true);
  }
});

test("the generated arena art is fresh and its tile map is machine-readable", async () => {
  const result = execFileSync(process.execPath, [fromExample("tools/generate-art.mjs"), "--check"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  assert.match(result, /war-battles-art:fresh/);
  const manifest = JSON.parse(await readFile(fromExample("defold/assets/derived/arena/arena-art.json"), "utf8"));
  const map = manifest.tileSheet.map;
  assert.deepEqual(map.themeOrder, ["frontier", "refinery", "canyon"]);
  assert.deepEqual(map.autotile.maskBits, { north: 1, south: 2, east: 4, west: 8 });
  assert.deepEqual(map.autotile.maskToFrame, [
    "centre",
    "centre",
    "centre",
    "centre",
    "centre",
    "sw",
    "nw",
    "w",
    "centre",
    "se",
    "ne",
    "e",
    "centre",
    "s",
    "n",
    "centre",
  ]);
  assert.equal(map.groundTileIds.length, 208, "the connected four-material landscape role table must be total");
  assert.deepEqual(Object.keys(map.wallTileIds).sort(), ["centre", "e", "n", "ne", "nw", "s", "se", "sw", "w"]);
  for (const key of ["crateTileId", "sandbagTileId", "spawnPadTileId", "pickupPadTileId"]) {
    assert.equal(Number.isInteger(map[key]), true, `${key} must be a tile id`);
  }
  assert.deepEqual(Object.keys(map.worldTileIds).sort(), [
    "floor-vent",
    "lava-fissure",
    "pickup-pedestal",
    "pipe-junction",
    "pipe-run",
    "thermal-vent",
  ]);
  assert.equal(map.worldTileIds["pickup-pedestal"] > map.pickupPadTileId, true);
  for (const themeId of map.themeOrder) {
    const theme = map.themes[themeId];
    assert.equal(
      theme.groundRoleTileIds.length,
      224,
      `${themeId} must cover 208 connected landscape roles plus 16 wall roles`,
    );
    assert.equal(theme.wallMaskTileIds.length, 16, `${themeId} must cover all neighbour masks`);
    assert.equal(theme.wallFaceTileIds.length, 16, `${themeId} must cover every raised-wall facade`);
    assert.equal(theme.markRoleTileIds.length, 5, `${themeId} must cover every mark role`);
    assert.equal(theme.decorRoleTileIds.length, 39, `${themeId} must cover every decor, road, and landmark role`);
    assert.ok(theme.wallMaskTileIds.every((tileId) => Number.isInteger(tileId) && tileId > 0));
    assert.ok(theme.wallFaceTileIds.every((tileId) => Number.isInteger(tileId) && tileId > 0));
  }
  const arenaSource = await readFile(fromExample("defold/main/arena.script.ts"), "utf8");
  assert.doesNotMatch(arenaSource, /const (?:CRATE|SANDBAG)_TILE/);
  assert.match(arenaSource, /syncArenaVisualMap\(self\)/);
  assert.match(arenaSource, /projectArenaVisualRoles\(world\.map, seed/);
  assert.match(arenaSource, /arenaGroundTileId\(theme/);
  assert.match(arenaSource, /arenaDecorTileId\(theme/);
  assert.match(arenaSource, /arenaMarkTileId\(theme/);
  assert.match(arenaSource, /arenaWallFaceTileId\(theme/);
  const generatedContract = await readFile(fromExample("defold/src/generated-arena-art.ts"), "utf8");
  assert.match(generatedContract, /export const ARENA_ART_THEMES/);
  for (const themeId of map.themeOrder) assert.match(generatedContract, new RegExp(`id: "${themeId}"`));
  // The atlas the components address by name has to actually declare them.
  const atlas = await readFile(fromExample("defold/main/arena-sprites.atlas"), "utf8");
  for (const animation of [
    "tank-depot",
    "tank-blue-hull",
    "tank-blue-turret",
    "tank-blue-wreck",
    "tank-red-hull",
    "tank-green-hull",
    "tank-sand-hull",
    "proj-cannon",
    "proj-machinegun",
    "proj-railgun",
    "proj-scatter",
    "proj-mortar",
    "proj-ricochet",
    "explosion-big",
    "explosion-small",
    "muzzle",
    "pickup-health",
    "pickup-armor",
    "pickup-overdrive",
    "pickup-machinegun",
    "pickup-railgun",
    "pickup-scatter",
    "pickup-mortar",
    "pickup-ricochet",
  ]) {
    assert.match(atlas, new RegExp(`id: "${animation}"`), `arena-sprites.atlas is missing ${animation}`);
  }
  const landmarkIds = [
    "field-bunker",
    "rock-outcrop",
    "supply-dump",
    "tank-wreck",
    "fuel-cluster",
    "gun-nest",
    "radio-mast",
    "scrap-barricade",
    "shell-crater",
  ];
  assert.deepEqual(manifest.source.worldLandmarks.ids, landmarkIds);
  assert.match(manifest.source.worldLandmarks.sourceSha256, /^[a-f0-9]{64}$/u);
  assert.match(arenaSource, /wall \? cell === CELL_WALL : cell === CELL_FLOOR/);
  for (const id of landmarkIds) {
    assert.match(atlas, new RegExp(`id: "landmark-${id}"`), `arena-sprites.atlas is missing landmark ${id}`);
    const sprite = manifest.sprites.find(({ file }) => file === `landmark-${id}.png`);
    assert.deepEqual(sprite?.size, [160, 128], `${id} must use the common bottom-registered landmark cell`);
  }
  const chassisTeams = ["blue", "red", "green", "sand"];
  const chassisKinds = ["scout", "assault", "bulwark", "artillery"];
  const chassisDirections = ["se", "s", "sw", "w", "e", "nw", "n", "ne"];
  for (const team of chassisTeams) {
    for (const kind of chassisKinds) {
      assert.match(
        atlas,
        new RegExp(`id: "chassis-${team}-${kind}"`),
        `arena-sprites.atlas is missing ${team} ${kind} chassis art`,
      );
      for (const direction of chassisDirections) {
        assert.match(atlas, new RegExp(`id: "chassis-${team}-${kind}-${direction}"`));
        assert.match(atlas, new RegExp(`id: "chassis-${team}-${kind}-turret-${direction}"`));
      }
    }
  }
  const chassisSprites = manifest.sprites.filter(({ role }) => role.startsWith("chassis."));
  const directionalHulls = chassisSprites.filter(({ role }) => role.includes(".hull."));
  const directionalTurrets = chassisSprites.filter(({ role }) => role.includes(".turret.") && !role.endsWith(".alias"));
  assert.equal(
    directionalHulls.length,
    chassisTeams.length * chassisKinds.length * chassisDirections.length * 2,
    "every team/chassis/direction hull must retain two generated frames",
  );
  for (const team of chassisTeams) {
    for (const kind of chassisKinds) {
      for (const direction of chassisDirections) {
        const first = manifest.sprites.find(({ file }) => file === `chassis-${team}-${kind}-${direction}-1.png`);
        const second = manifest.sprites.find(({ file }) => file === `chassis-${team}-${kind}-${direction}-2.png`);
        assert.ok(first && second);
        assert.notEqual(first.sha256, second.sha256, `${team} ${kind} ${direction} must animate its track links`);
      }
    }
  }
  assert.equal(
    directionalTurrets.length,
    chassisTeams.length * chassisKinds.length * chassisDirections.length,
    "every team/chassis/direction turret must have one generated frame",
  );
  const tankContract = await readFile(fromExample("defold/src/generated-tank-art.ts"), "utf8");
  assert.match(tankContract, /export function tankHullAnimation/);
  assert.match(tankContract, /export function tankHullIdleAnimation/);
  assert.match(tankContract, /export function tankTurretAnimation/);
  const arenaPrototype = await readFile(fromExample("defold/main/arena.go"), "utf8");
  assert.match(arenaPrototype, /id: "depotfactory"/);
  assert.match(arenaPrototype, /prototype: \\"\/main\/arena-depot\.go\\"/);
  assert.match(arenaPrototype, /id: "landmarkfactory"/);
  assert.match(arenaPrototype, /prototype: \\"\/main\/arena-landmark\.go\\"/);
});

test("the generated 8-bit sound cues are fresh and valid PCM WAV resources", async () => {
  const result = execFileSync(process.execPath, [fromExample("tools/generate-sound.mjs"), "--check"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  assert.match(result, /war-battles-sound:fresh:5/);
  for (const cue of ["fire", "hit", "explosion", "pickup", "round"]) {
    const bytes = await readFile(fromExample(`defold/assets/derived/audio/${cue}.wav`));
    assert.equal(bytes.subarray(0, 4).toString("ascii"), "RIFF");
    assert.equal(bytes.subarray(8, 12).toString("ascii"), "WAVE");
    assert.ok(bytes.length > 1_000, `${cue}.wav is unexpectedly empty`);
  }
});
