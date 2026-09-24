import assert from "node:assert/strict";
import test from "node:test";

import {
  ArenaMap,
  adoptServerWebTransportSession,
  BattleClient,
  CELL_WALL,
  cellOfX,
  cellOfY,
  BattleWorld,
  BotController,
  BrowserWebTransportClient,
  DenoWebTransportServer,
  CELL_FLOOR,
  CONTROL_BUY_UPGRADE,
  CONTROL_SET_CHASSIS,
  CONTROL_SET_WEAPON_UPGRADE,
  EVENT_KILL,
  EVENT_OBJECTIVE_CAPTURE,
  EVENT_PICKUP_TAKEN,
  HELLO_BYTES,
  INPUT_BUTTON_BOOST,
  INPUT_BUTTON_FIRE,
  INPUT_PACKET_BYTES,
  MAP_HEIGHT,
  MAP_WIDTH,
  MAX_PICKUPS,
  MAX_PLAYERS,
  MatchServer,
  PICKUP_HEALTH,
  REJECT_BAD_RESUME,
  PlayableBattle,
  RESUME_TOKEN_BYTES,
  SNAPSHOT_BYTES,
  SNAPSHOT_DELTA,
  SNAPSHOT_KEYFRAME,
  SNAPSHOT_KEYFRAME_INTERVAL,
  SNAPSHOT_MESSAGE_BYTES,
  TICK_MILLISECONDS,
  TRANSPORT_CHANNEL_CONTROL,
  TRANSPORT_CHANNEL_SESSION,
  TRANSPORT_CHANNEL_SNAPSHOT,
  UPGRADE_DAMAGE,
  WEAPON_UPGRADE_CANNON_BLAST,
  WEAPON_UPGRADE_CANNON_PIERCER,
  WELCOME_BYTES,
  WEAPON_AUTOCANNON,
  WEAPON_CANNON,
  WEAPON_MORTAR,
  WEAPON_RICOCHET,
  WEAPON_SCATTER,
  createBattleEvent,
  createInMemoryTransportPair,
  createInputCommand,
  createObjectiveView,
  createPlayerView,
  OBJECTIVE_CAPTURE_TICKS,
  isqrt,
  readHello,
  readInputPacket,
  readSnapshotFrame,
  readWelcome,
  sendTickInput,
  writeHello,
  writeInputPacket,
  writeSnapshotDelta,
  writeSnapshotKeyframe,
  writeWelcome,
} from "../core/index.ts";
import {
  CHASSIS_ARTILLERY,
  CHASSIS_BULWARK,
  CHASSIS_SCOUT,
  chassisById,
  chassisUnlockBit,
  UPGRADE_MOBILITY,
} from "../core/content.ts";

function command(playerId, tick, overrides = {}) {
  return {
    ...createInputCommand(77, playerId),
    tick,
    sequence: tick & 0xffff,
    aimX: 127,
    latestSnapshotTick: tick > 0 ? tick - 1 : 0,
    snapshotAckBits: 0xffff_ffff,
    ...overrides,
  };
}

const playerView = createPlayerView;

/** Steps `world` for `ticks`, holding one command per player. */
function run(world, ticks, stage) {
  for (let tick = 1; tick <= ticks; tick += 1) {
    stage?.(tick);
    world.step();
  }
}

// --- wire -------------------------------------------------------------------

test("input packets round-trip every authoritative and acknowledgement field", () => {
  const expected = command(7, 0x1020_3040, {
    sequence: 65_530,
    moveX: -127,
    moveY: 42,
    aimX: 99,
    aimY: -11,
    buttons: INPUT_BUTTON_FIRE | INPUT_BUTTON_BOOST,
    weaponRequest: WEAPON_MORTAR,
    fireSubtick: 91,
    latestSnapshotTick: 0x1020_3030,
    snapshotAckBits: 0xa55a_0ff0,
  });
  const bytes = new Uint8Array(INPUT_PACKET_BYTES * 2);
  assert.equal(writeInputPacket(bytes, INPUT_PACKET_BYTES, expected), INPUT_PACKET_BYTES * 2);
  const observed = createInputCommand(0, 1);
  assert.equal(readInputPacket(bytes, INPUT_PACKET_BYTES, observed), INPUT_PACKET_BYTES * 2);
  assert.deepEqual(observed, expected);
  bytes[INPUT_PACKET_BYTES + 9] ^= 1;
  assert.throws(() => readInputPacket(bytes, INPUT_PACKET_BYTES, observed), /checksum/);
});

test("session messages round-trip and reject a foreign kind", () => {
  const hello = new Uint8Array(HELLO_BYTES);
  const token = new Uint8Array(RESUME_TOKEN_BYTES).fill(7);
  writeHello(hello, { clientSalt: 0xdead_beef, name: "commander", resumeToken: token, preferredTeam: 2 });
  const observedHello = { clientSalt: 0, name: "", resumeToken: new Uint8Array(RESUME_TOKEN_BYTES), preferredTeam: 0 };
  readHello(hello, observedHello);
  assert.equal(observedHello.clientSalt, 0xdead_beef);
  assert.equal(observedHello.name, "commander");
  assert.equal(observedHello.preferredTeam, 2);
  assert.deepEqual([...observedHello.resumeToken], [...token]);

  const welcome = new Uint8Array(WELCOME_BYTES);
  writeWelcome(welcome, {
    matchId: 77, playerId: 3, team: 1, maximumPlayers: 8, botCount: 5,
    mapSeed: 0x1234_5678, serverTick: 4_321, tickRate: 60, snapshotIntervalTicks: 6, resumeToken: token,
  });
  const observedWelcome = { matchId: 0, playerId: 0, team: 0, maximumPlayers: 0, botCount: 0, mapSeed: 0, serverTick: 0, tickRate: 0, snapshotIntervalTicks: 0, resumeToken: new Uint8Array(RESUME_TOKEN_BYTES) };
  readWelcome(welcome, observedWelcome);
  assert.equal(observedWelcome.playerId, 3);
  assert.equal(observedWelcome.mapSeed, 0x1234_5678);
  assert.equal(observedWelcome.serverTick, 4_321);
  assert.equal(observedWelcome.snapshotIntervalTicks, 6);
  assert.throws(() => readHello(welcome, observedHello), /not kind/);
  hello[2] -= 1;
  assert.throws(() => readHello(hello, observedHello), /version mismatch/);
});

test("team command beacon capture is authoritative and snapshot-safe", () => {
  const world = new BattleWorld(77);
  world.addPlayer(1, 1, 0, 0);
  world.addPlayer(2, 2, 9_000, 9_000);
  const view = createObjectiveView();
  for (let tick = 1; tick <= OBJECTIVE_CAPTURE_TICKS; tick += 1) {
    world.step();
  }
  world.readObjective(view);
  assert.equal(view.owner, 1);
  assert.equal(view.teamOneScore, 1);
  assert.equal(view.teamTwoScore, 0);
  const event = createBattleEvent();
  assert.equal(world.events.read(world.events.sequence - 1, event), true);
  assert.equal(event.kind, EVENT_OBJECTIVE_CAPTURE);
  assert.equal(event.a, 1);

  const bytes = new Uint8Array(SNAPSHOT_BYTES);
  world.writeSnapshot(bytes);
  const restored = new BattleWorld(77);
  restored.restoreSnapshot(bytes);
  assert.deepEqual(restored.readObjective(createObjectiveView()), view);
  assert.equal(restored.stateHash(), world.stateHash());
});

test("32-player snapshot deltas are compact and keyframes recover the baseline", () => {
  const world = new BattleWorld(77);
  for (let playerId = 1; playerId <= MAX_PLAYERS; playerId += 1) world.addPlayer(playerId);
  const first = new Uint8Array(SNAPSHOT_BYTES);
  const second = new Uint8Array(SNAPSHOT_BYTES);
  const frame = new Uint8Array(SNAPSHOT_MESSAGE_BYTES);
  world.writeSnapshot(first);
  for (let tick = 1; tick <= 3; tick += 1) {
    for (let playerId = 1; playerId <= MAX_PLAYERS; playerId += 1) {
      const input = createInputCommand(77, playerId);
      input.tick = tick;
      input.sequence = tick;
      input.moveX = playerId % 2 === 0 ? -1 : 1;
      world.submitInput(input);
    }
    world.step();
  }
  world.writeSnapshot(second);
  const keyframeLength = writeSnapshotKeyframe(frame, world.tick, first);
  const deltaLength = writeSnapshotDelta(frame, world.tick, 0, first, second);
  assert.equal(keyframeLength, SNAPSHOT_MESSAGE_BYTES);
  assert.ok(deltaLength > 0 && deltaLength < keyframeLength, `delta ${deltaLength} must beat keyframe ${keyframeLength}`);

  const scratch = {
    baseline: new Uint8Array(SNAPSHOT_BYTES),
    decoded: new Uint8Array(SNAPSHOT_BYTES),
    baselineTick: -1,
  };
  writeSnapshotKeyframe(frame, 0, first);
  const previousProtocolFrame = frame.slice();
  previousProtocolFrame[2] = 4;
  assert.throws(() => readSnapshotFrame(previousProtocolFrame, scratch), /envelope mismatch/);
  const reservedByteFrame = frame.slice();
  reservedByteFrame[9] = 1;
  assert.throws(() => readSnapshotFrame(reservedByteFrame, scratch), /reserved byte/);
  const keyframeBaseFrame = frame.slice();
  keyframeBaseFrame[10] = 1;
  assert.throws(() => readSnapshotFrame(keyframeBaseFrame, scratch), /invalid snapshot keyframe/);
  assert.equal(readSnapshotFrame(frame, scratch), 0);
  writeSnapshotDelta(frame, world.tick, 0, first, second);
  assert.equal(readSnapshotFrame(frame.subarray(0, deltaLength), scratch), world.tick);
  assert.deepEqual(scratch.decoded, second);

  const validDelta = frame.slice(0, deltaLength);
  const malformed = validDelta.slice();
  malformed[18] = 0;
  malformed[19] = 0;
  writeSnapshotKeyframe(frame, 0, first);
  readSnapshotFrame(frame, scratch);
  assert.throws(() => readSnapshotFrame(malformed, scratch), /run is invalid/);

  const missingBase = { ...scratch, baselineTick: -1 };
  assert.throws(() => readSnapshotFrame(validDelta, missingBase), /base is unavailable/);
});

test("the bounded 32-player bot trace keeps snapshot bandwidth reproducible", () => {
  const world = new BattleWorld(77);
  const bots = new BotController();
  for (let playerId = 1; playerId <= MAX_PLAYERS; playerId += 1) {
    world.addPlayer(playerId);
    world.setBotSkill(playerId, 2);
  }
  const previous = new Uint8Array(SNAPSHOT_BYTES);
  const current = new Uint8Array(SNAPSHOT_BYTES);
  const frame = new Uint8Array(SNAPSHOT_MESSAGE_BYTES);
  const lengths = [];
  let baselineTick = -1;
  let framesSinceKeyframe = SNAPSHOT_KEYFRAME_INTERVAL;
  for (let tick = 1; tick <= 600; tick += 1) {
    for (let playerId = 1; playerId <= MAX_PLAYERS; playerId += 1) {
      const input = createInputCommand(77, playerId);
      bots.stage(world, input, playerId, tick);
      world.submitInput(input);
    }
    world.step();
    if (world.tick % 3 !== 0) continue;
    world.writeSnapshot(current);
    let length = -1;
    if (framesSinceKeyframe < SNAPSHOT_KEYFRAME_INTERVAL - 1) {
      length = writeSnapshotDelta(frame, world.tick, baselineTick, previous, current);
    }
    if (length < 0) {
      length = writeSnapshotKeyframe(frame, world.tick, current);
      framesSinceKeyframe = 0;
    } else {
      framesSinceKeyframe += 1;
    }
    lengths.push(length);
    previous.set(current);
    baselineTick = world.tick;
  }
  lengths.sort((left, right) => left - right);
  assert.equal(lengths.length, 200);
  assert.equal(lengths[0], 1_869);
  assert.equal(lengths.at(-1), SNAPSHOT_MESSAGE_BYTES);
  assert.equal(lengths[Math.floor(lengths.length / 2)], 2_438);
  assert.equal(lengths.filter((length) => length === SNAPSHOT_MESSAGE_BYTES).length, 10);
  const normal = lengths.filter((length) => length !== SNAPSHOT_MESSAGE_BYTES);
  assert.equal(normal.at(-1), 3_201);
});

test("a replaced in-flight snapshot forces a recovery keyframe", async () => {
  const server = new MatchServer({ rosterSize: 2 });
  const session = server.createSession();
  const frames = [];
  let releaseFirst;
  const transport = {
    capabilities: { protocol: "in-memory", reliableStreams: true, datagrams: false, maxDatagramBytes: 0 },
    sendReliable(_channel, payload) {
      frames.push(payload.slice());
      if (releaseFirst === undefined) return new Promise((resolve) => { releaseFirst = resolve; });
      return Promise.resolve("sent");
    },
    trySendDatagram: async () => "closed",
    close() {},
  };
  session.attach(transport);
  const first = new Uint8Array(SNAPSHOT_BYTES);
  const second = new Uint8Array(SNAPSHOT_BYTES).fill(7);
  session.sendSnapshot(first, 3);
  session.sendSnapshot(second, 6);
  assert.equal(frames.length, 1);
  assert.equal(frames[0][8], SNAPSHOT_KEYFRAME);
  releaseFirst("sent");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(frames.length, 2);
  assert.equal(frames[1][8], SNAPSHOT_KEYFRAME, "pending replacement cannot depend on an undelivered delta");
  assert.notEqual(frames[1][8], SNAPSHOT_DELTA);
  server.close();
});

test("a rejected snapshot send drops its stale pending replacement", async () => {
  const errors = [];
  const server = new MatchServer({ rosterSize: 2, onError: (error) => errors.push(error) });
  const session = server.createSession();
  const frames = [];
  let first = true;
  const transport = {
    capabilities: { protocol: "in-memory", reliableStreams: true, datagrams: false, maxDatagramBytes: 0 },
    sendReliable(_channel, payload) {
      frames.push(payload.slice());
      if (first) {
        first = false;
        return Promise.reject(new Error("snapshot send rejected"));
      }
      return Promise.resolve("sent");
    },
    trySendDatagram: async () => "closed",
    close() {},
  };
  session.attach(transport);
  session.sendSnapshot(new Uint8Array(SNAPSHOT_BYTES), 3);
  session.sendSnapshot(new Uint8Array(SNAPSHOT_BYTES).fill(7), 6);
  await new Promise((resolve) => setImmediate(resolve));
  session.sendSnapshot(new Uint8Array(SNAPSHOT_BYTES).fill(9), 9);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(frames.length, 2, "the rejected frame's stale pending replacement must not replay");
  assert.equal(frames[1][8], SNAPSHOT_KEYFRAME, "the next usable frame recovers with a keyframe");
  assert.equal(errors.length, 1);
  server.close();
});

test("a closed snapshot send releases the server session", async () => {
  const errors = [];
  const server = new MatchServer({ rosterSize: 1, onError: (error) => errors.push(error) });
  const client = new BattleClient({ name: "closing", onError: (error) => errors.push(error) });
  const session = server.createSession();
  const [clientTransport, serverTransport] = createInMemoryTransportPair(client, session);
  const sendReliable = serverTransport.sendReliable.bind(serverTransport);
  serverTransport.sendReliable = (channel, payload, signal) => channel === TRANSPORT_CHANNEL_SNAPSHOT
    ? Promise.resolve("closed")
    : sendReliable(channel, payload, signal);
  session.attach(serverTransport);
  client.attach(clientTransport);
  await settle();
  assert.equal(server.countHumans(), 1);
  server.step();
  server.step();
  server.step();
  await settle();
  assert.equal(session.closed, true);
  assert.equal(server.countHumans(), 0, "a terminal snapshot send must release its claimed slot");
  assert.deepEqual(errors, []);
  server.close();
});

// --- arena ------------------------------------------------------------------

test("the arena is reproducible from its seed, point-symmetric and fully connected", () => {
  const first = new ArenaMap(0x57_41_52_42);
  const second = new ArenaMap(0x57_41_52_42);
  assert.deepEqual([...first.cells], [...second.cells]);
  const other = new ArenaMap(0x0bad_f00d);
  assert.notDeepEqual([...first.cells], [...other.cells]);

  for (let cellY = 0; cellY < MAP_HEIGHT; cellY += 1) {
    for (let cellX = 0; cellX < MAP_WIDTH; cellX += 1) {
      assert.equal(
        first.cellAt(cellX, cellY),
        first.cellAt(MAP_WIDTH - 1 - cellX, MAP_HEIGHT - 1 - cellY),
        `arena is not point-symmetric at ${cellX},${cellY}`);
    }
  }

  // Every open cell must be reachable: a pocket of floor nothing can enter is a
  // pickup nobody can contest and a bot goal nobody can satisfy.
  const seen = new Uint8Array(MAP_WIDTH * MAP_HEIGHT);
  const stack = [[MAP_WIDTH >> 1, MAP_HEIGHT >> 1]];
  let reached = 0;
  while (stack.length > 0) {
    const [cellX, cellY] = stack.pop();
    if (cellX < 0 || cellY < 0 || cellX >= MAP_WIDTH || cellY >= MAP_HEIGHT) continue;
    const index = cellY * MAP_WIDTH + cellX;
    if (seen[index] === 1 || first.solidAt(cellX, cellY)) continue;
    seen[index] = 1;
    reached += 1;
    stack.push([cellX + 1, cellY], [cellX - 1, cellY], [cellX, cellY + 1], [cellX, cellY - 1]);
  }
  assert.equal(reached, first.openCellCount());
  // Cover, but still an arena: somewhere between a field and a maze.
  const solid = MAP_WIDTH * MAP_HEIGHT - first.openCellCount();
  assert.ok(solid > 800 && solid < 3_000, `arena has ${solid} solid cells`);
});

test("line of sight is blocked by cover and spawn pads stand in the open", () => {
  const map = new ArenaMap(0x57_41_52_42);
  let blocked = 0;
  let clear = 0;
  for (let a = 0; a < 16; a += 1) {
    for (let b = a + 1; b < 16; b += 1) {
      if (map.lineOfSight(map.spawnX[a], map.spawnY[a], map.spawnX[b], map.spawnY[b])) clear += 1;
      else blocked += 1;
    }
  }
  assert.ok(blocked > 0, "cover must block some sightlines");
  assert.ok(clear > 0, "the arena must still have long sightlines");
  for (let index = 0; index < MAX_PICKUPS; index += 1) {
    assert.equal(map.solidAtWorld(map.pickupX[index], map.pickupY[index]), false);
  }
  for (let index = 0; index < 16; index += 1) {
    assert.equal(map.solidAtWorld(map.spawnX[index], map.spawnY[index]), false);
  }
});

test("integer square root is exact at and around perfect squares", () => {
  for (const value of [0, 1, 2, 3, 4, 15, 16, 17, 9_999, 1_000_000, 2 ** 30, 2 ** 31 + 5]) {
    const root = isqrt(value);
    assert.ok(root * root <= value, `isqrt(${value}) = ${root} overshoots`);
    assert.ok((root + 1) * (root + 1) > value, `isqrt(${value}) = ${root} undershoots`);
  }
});

// --- simulation -------------------------------------------------------------

test("32-player results are stable across input arrival order", () => {
  const ascending = new BattleWorld(77);
  const descending = new BattleWorld(77);
  for (let playerId = 1; playerId <= MAX_PLAYERS; playerId += 1) {
    ascending.addPlayer(playerId, (playerId % 4) + 1);
    descending.addPlayer(playerId, (playerId % 4) + 1);
  }
  for (let tick = 1; tick <= 360; tick += 1) {
    const make = (playerId) => command(playerId, tick, {
      moveX: ((playerId + tick) % 3) - 1,
      moveY: ((playerId * 3 + tick) % 3) - 1,
      aimX: playerId % 2 === 0 ? -127 : 127,
      aimY: playerId % 3 === 0 ? 127 : 0,
      buttons: tick % 31 === playerId % 31 ? INPUT_BUTTON_FIRE : 0,
    });
    for (let playerId = 1; playerId <= MAX_PLAYERS; playerId += 1) {
      assert.equal(ascending.submitInput(make(playerId)), true);
    }
    for (let playerId = MAX_PLAYERS; playerId >= 1; playerId -= 1) {
      assert.equal(descending.submitInput(make(playerId)), true);
    }
    ascending.step();
    descending.step();
    assert.equal(ascending.stateHash(), descending.stateHash(), `state diverged on tick ${tick}`);
  }
});

test("a tank carries momentum rather than teleporting, and cover stops it", () => {
  const world = new BattleWorld(77);
  world.addPlayer(1);
  const view = playerView();
  run(world, 40, (tick) => world.submitInput(command(1, tick, { moveX: 1 })));
  world.readPlayer(1, view);
  const cruising = Math.abs(view.velocityX);
  assert.ok(cruising > 0, "thrust must build speed");

  // Release: the tank coasts, it does not stop dead.
  const coastFrom = view.x;
  run(world, 6, (tick) => world.submitInput(command(1, tick + 40, { moveX: 0 })));
  world.readPlayer(1, view);
  assert.ok(view.x !== coastFrom, "a released tank must keep travelling");
  assert.ok(Math.abs(view.velocityX) < cruising, "drag must bleed speed off");

  // Drive into the arena wall for long enough to be certain, and stay inside it.
  run(world, 600, (tick) => world.submitInput(command(1, tick + 46, { moveX: 1, moveY: 1 })));
  world.readPlayer(1, view);
  assert.equal(world.map.solidAtWorld(view.x, view.y), false, "a tank must never end inside cover");
});

test("armour absorbs damage, a kill scores, and the wreck respawns clear of the killer", () => {
  const world = new BattleWorld(77);
  world.addPlayer(1, 1, -2_000, 0);
  world.addPlayer(2, 2, 400, 0);
  world.playerArmor[1] = 60;
  world.grantCredits(1, 1_000);
  assert.equal(world.applyUpgrade(1, UPGRADE_DAMAGE), true);

  const shooter = playerView();
  const target = playerView();
  let killed = false;
  for (let tick = 1; tick <= 900 && !killed; tick += 1) {
    world.submitInput(command(1, tick, { buttons: INPUT_BUTTON_FIRE, aimX: 127, aimY: 0 }));
    world.step();
    world.readPlayer(2, target);
    killed = target.respawnTicks > 0;
  }
  assert.equal(killed, true, "the shooter should land a kill");
  world.readPlayer(1, shooter);
  assert.equal(shooter.score, 1);
  assert.equal(shooter.credits, 1_000 - 100 + 100);
  assert.equal(target.deaths, 1);

  const event = createBattleEvent();
  let sawKill = false;
  for (let sequence = world.events.oldest(); sequence < world.events.sequence; sequence += 1) {
    if (world.events.read(sequence, event) && event.kind === EVENT_KILL) sawKill = true;
  }
  assert.equal(sawKill, true, "a kill must reach the presentation event ring");

  run(world, 200);
  world.readPlayer(2, target);
  assert.equal(target.alive, true, "a wreck must come back");
  assert.ok(target.spawnProtectTicks >= 0);
});

test("splash damage reaches past a miss, hurts the shooter, and throws both", () => {
  const world = new BattleWorld(77);
  const map = world.map;
  const centre = { x: 0, y: 0 };
  map.nearestOpen(0, 0, centre);
  // Carve a known pocket so the assertion is about splash, not about whichever
  // cover the generated arena happened to put nearby, then stand one wall up.
  const cellX = cellOfX(centre.x);
  const cellY = cellOfY(centre.y);
  for (let offsetY = -3; offsetY <= 3; offsetY += 1) {
    for (let offsetX = -3; offsetX <= 4; offsetX += 1) {
      map.cells[map.index(cellX + offsetX, cellY + offsetY)] = CELL_FLOOR;
    }
  }
  map.cells[map.index(cellX + 2, cellY)] = CELL_WALL;

  world.addPlayer(1, 0, centre.x, centre.y);
  world.addPlayer(2, 0, centre.x, centre.y + 460);
  world.setWeapon(1, WEAPON_MORTAR);
  world.grantAmmo(1, WEAPON_MORTAR, 10);

  const shooter = playerView();
  const bystander = playerView();
  world.readPlayer(1, shooter);
  world.readPlayer(2, bystander);
  const shooterHealth = shooter.health;
  const bystanderHealth = bystander.health;

  // A turret slews; it does not snap. Hold the aim until it has actually come
  // round to +x, then pull the trigger.
  run(world, 40, (tick) => world.submitInput(command(1, tick, { aimX: 127, aimY: 0 })));
  assert.ok(world.playerTurretX[0] > 250, "the turret should have come round by now");
  run(world, 14, (tick) => world.submitInput(command(1, tick + 40, {
    buttons: tick === 1 ? INPUT_BUTTON_FIRE : 0, aimX: 127, aimY: 0,
  })));
  world.readPlayer(1, shooter);
  world.readPlayer(2, bystander);
  // The shell never touched either tank: it detonated on the wall between them.
  assert.ok(bystander.health < bystanderHealth, "splash must reach a tank the shell missed");
  assert.ok(shooter.health < shooterHealth, "splash must also hurt the shooter, at half strength");
  assert.ok(bystander.velocityX !== 0 || bystander.velocityY !== 0, "splash must impart knockback");
  // Thrown away from the blast, which is what makes a mortar a mobility tool
  // and not only a weapon.
  assert.ok(shooter.velocityX < 0, "the shooter must be pushed back off its own blast");
});

test("a bouncing projectile survives a wall the cannon would have died on", () => {
  const seed = 0x57_41_52_42;
  const counts = [];
  for (const weapon of [WEAPON_RICOCHET, WEAPON_AUTOCANNON]) {
    const world = new BattleWorld(77, seed);
    // Back into a corner and shoot at it.
    world.addPlayer(1, 0, world.map.spawnX[0], world.map.spawnY[0]);
    world.setWeapon(1, weapon);
    world.grantAmmo(1, weapon, 400);
    let alive = 0;
    for (let tick = 1; tick <= 240; tick += 1) {
      world.submitInput(command(1, tick, { buttons: INPUT_BUTTON_FIRE, aimX: -127, aimY: -127 }));
      world.step();
      for (let slot = 0; slot < world.projectileActive.length; slot += 1) alive += world.projectileActive[slot];
    }
    counts.push(alive);
  }
  assert.ok(counts[0] > counts[1], `ricochet should outlive the autocannon against a wall (${counts.join(" vs ")})`);
});

test("a scatter shot releases a fan of pellets from one trigger pull", () => {
  const world = new BattleWorld(77);
  world.addPlayer(1);
  world.setWeapon(1, WEAPON_SCATTER);
  world.grantAmmo(1, WEAPON_SCATTER, 10);
  world.submitInput(command(1, 1, { buttons: INPUT_BUTTON_FIRE }));
  world.step();
  let pellets = 0;
  const directions = new Set();
  for (let slot = 0; slot < world.projectileActive.length; slot += 1) {
    if (world.projectileActive[slot] === 0) continue;
    pellets += 1;
    directions.add(`${world.projectileDirectionX[slot]},${world.projectileDirectionY[slot]}`);
  }
  assert.equal(pellets, 7);
  assert.ok(directions.size > 1, "pellets must not all travel along one line");
});

test("pickups are taken, respawn on their own timer, and change the loadout", () => {
  const world = new BattleWorld(77);
  // Stand on the first weapon pad.
  let pad = -1;
  for (let index = 0; index < MAX_PICKUPS; index += 1) {
    if (world.pickupKind[index] === WEAPON_AUTOCANNON) { pad = index; break; }
  }
  assert.ok(pad >= 0, "the arena must place an autocannon pad");
  world.addPlayer(1, 0, world.pickupX[pad], world.pickupY[pad]);
  assert.equal(world.ammo(1, WEAPON_AUTOCANNON), 0);
  world.step();
  assert.equal(world.pickupActive[pad], 0, "standing on a live pad must take it");
  assert.ok(world.ammo(1, WEAPON_AUTOCANNON) > 0);
  const view = playerView();
  world.readPlayer(1, view);
  assert.equal(view.weaponId, WEAPON_AUTOCANNON, "a better weapon is equipped on pickup");

  const event = createBattleEvent();
  let taken = false;
  for (let sequence = world.events.oldest(); sequence < world.events.sequence; sequence += 1) {
    if (world.events.read(sequence, event) && event.kind === EVENT_PICKUP_TAKEN) taken = true;
  }
  assert.equal(taken, true);

  // The pad comes back on its own clock, not on a kill or a round. Drive off it
  // first, or the same tank simply takes it again on the tick it returns.
  world.playerX[0] = world.map.spawnX[0];
  world.playerY[0] = world.map.spawnY[0];
  run(world, 720);
  assert.equal(world.pickupActive[pad], 1);
});

test("a health pad is left alone by a tank that does not need it", () => {
  const world = new BattleWorld(77);
  let pad = -1;
  for (let index = 0; index < MAX_PICKUPS; index += 1) {
    if (world.pickupKind[index] === PICKUP_HEALTH) { pad = index; break; }
  }
  assert.ok(pad >= 0);
  world.addPlayer(1, 0, world.pickupX[pad], world.pickupY[pad]);
  world.playerHealth[0] = 200;
  run(world, 10);
  assert.equal(world.pickupActive[pad], 1, "a full tank must not waste a health pad");
});

test("a full snapshot restores and deterministically replays queued inputs", () => {
  const world = new BattleWorld(77);
  world.addPlayer(1, 1, -2_000, 0);
  world.addPlayer(2, 2, 2_000, 0);
  world.setWeapon(1, WEAPON_AUTOCANNON);
  const stage = (tick) => {
    world.submitInput(command(1, tick, {
      moveX: tick < 20 ? 1 : 0,
      buttons: tick % 7 === 1 ? INPUT_BUTTON_FIRE : 0,
    }));
    world.submitInput(command(2, tick, { moveX: tick < 20 ? -1 : 0, aimX: -127 }));
  };
  run(world, 30, stage);
  const snapshot = new Uint8Array(SNAPSHOT_BYTES);
  assert.equal(world.writeSnapshot(snapshot), SNAPSHOT_BYTES);
  for (let tick = 31; tick <= 80; tick += 1) { stage(tick); world.step(); }
  const expectedHash = world.stateHash();
  world.restoreSnapshot(snapshot);
  // Snapshots contain authoritative simulation state, not the external replay log.
  // Re-submit the recorded inputs that followed the rollback point.
  for (let tick = 31; tick <= 80; tick += 1) { stage(tick); world.step(); }
  assert.equal(world.stateHash(), expectedHash);
});

test("a full snapshot restores player boost ticks for rollback", () => {
  const world = new BattleWorld(77);
  world.addPlayer(1);
  world.playerBoostTicks[0] = 19;
  const snapshot = new Uint8Array(SNAPSHOT_BYTES);
  world.writeSnapshot(snapshot);
  world.playerBoostTicks[0] = 0;
  world.restoreSnapshot(snapshot);
  assert.equal(world.playerBoostTicks[0], 19);
});

test("a snapshot from another arena is refused rather than silently applied", () => {
  const first = new BattleWorld(77, 1);
  const second = new BattleWorld(77, 2);
  first.addPlayer(1);
  const snapshot = new Uint8Array(SNAPSHOT_BYTES);
  first.writeSnapshot(snapshot);
  assert.throws(() => second.restoreSnapshot(snapshot), /arena seed/);
});

test("generation-keyed player ids reject stale identity reuse", () => {
  const world = new BattleWorld(77);
  const first = world.addPlayer(1);
  world.removePlayer(1);
  const second = world.addPlayer(1);
  assert.notEqual(second, first);
  assert.equal(second >>> 16, (first >>> 16) + 1);
});

test("fixed stores retain identity through a sustained 32-player run", () => {
  const world = new BattleWorld(77);
  const playerX = world.playerX;
  const projectiles = world.projectileX;
  for (let playerId = 1; playerId <= MAX_PLAYERS; playerId += 1) {
    world.addPlayer(playerId, playerId);
  }
  run(world, 2_000, (tick) => {
    for (let playerId = 1; playerId <= MAX_PLAYERS; playerId += 1) {
      world.submitInput(command(playerId, tick, {
        moveX: playerId % 2 === 0 ? 1 : -1,
        buttons: tick % 20 === playerId % 20 ? INPUT_BUTTON_FIRE : 0,
      }));
    }
  });
  assert.equal(world.playerX, playerX);
  assert.equal(world.projectileX, projectiles);
  assert.equal(world.playerX.byteLength, MAX_PLAYERS * Int32Array.BYTES_PER_ELEMENT);
});

test("data-driven chassis stats, weapon slots, purchase selection and snapshots agree", () => {
  const world = new BattleWorld(77);
  world.addPlayer(1);
  world.addPlayer(2);
  assert.notEqual(world.playerChassis[0], world.playerChassis[1], "roster bootstrap should expose distinct roles");
  assert.ok(chassisById(CHASSIS_BULWARK).maxHealth > chassisById(CHASSIS_SCOUT).maxHealth);
  assert.ok(chassisById(CHASSIS_SCOUT).maxSpeed > chassisById(CHASSIS_BULWARK).maxSpeed);
  assert.ok(chassisById(CHASSIS_SCOUT).knockbackFactor > chassisById(CHASSIS_BULWARK).knockbackFactor);
  assert.notEqual(chassisById(CHASSIS_SCOUT).weaponMask, chassisById(CHASSIS_ARTILLERY).weaponMask);

  world.grantCredits(1, chassisById(CHASSIS_BULWARK).unlockCost);
  assert.equal(world.playerChassisUnlocks[0], chassisUnlockBit(CHASSIS_SCOUT));
  assert.equal(world.selectChassis(1, CHASSIS_BULWARK), true);
  assert.equal(world.playerChassis[0], CHASSIS_BULWARK);
  assert.equal(world.playerCredits[0], 0);
  assert.notEqual(world.playerChassisUnlocks[0] & chassisUnlockBit(CHASSIS_BULWARK), 0);
  world.playerArmor[0] = 3;
  assert.equal(world.selectChassis(1, CHASSIS_SCOUT), true);
  assert.equal(world.selectChassis(1, CHASSIS_BULWARK), true, "an unlocked chassis can be selected again");
  assert.equal(world.playerCredits[0], 0, "an unlocked chassis is never charged twice");
  assert.equal(world.playerArmor[0], 3, "switching chassis cannot mint armor");
  const snapshot = new Uint8Array(SNAPSHOT_BYTES);
  world.writeSnapshot(snapshot);
  world.setChassis(1, CHASSIS_SCOUT);
  world.restoreSnapshot(snapshot);
  assert.equal(world.playerChassis[0], CHASSIS_BULWARK, "rollback must restore the selected chassis");
  assert.notEqual(world.playerChassisUnlocks[0] & chassisUnlockBit(CHASSIS_BULWARK), 0, "rollback must restore unlocks");
});

test("chassis weapon masks and handling affect authoritative simulation", () => {
  const scout = new BattleWorld(77);
  const bulwark = new BattleWorld(77);
  scout.addPlayer(1);
  bulwark.addPlayer(1);
  scout.setChassis(1, CHASSIS_SCOUT);
  bulwark.setChassis(1, CHASSIS_BULWARK);

  scout.grantAmmo(1, WEAPON_MORTAR, 4);
  scout.submitInput(command(1, 1, { weaponRequest: WEAPON_MORTAR, moveX: 127, moveY: 0 }));
  bulwark.submitInput(command(1, 1, { moveX: 127, moveY: 0 }));
  scout.step();
  bulwark.step();
  assert.notEqual(scout.playerWeapon[0], WEAPON_MORTAR, "a weapon outside the chassis mask is rejected");
  assert.ok(Math.abs(scout.playerVelocityX[0]) > Math.abs(bulwark.playerVelocityX[0]), "the scout accelerates faster under identical input");
});

test("weapon branches are data-driven, purchased once, selected for free, and survive rollback", () => {
  const world = new BattleWorld(77);
  world.addPlayer(1);
  world.grantCredits(1, 500);
  assert.equal(world.applyWeaponUpgrade(1, WEAPON_UPGRADE_CANNON_BLAST), true);
  assert.equal(world.playerCredits[0], 375);
  assert.equal(world.weaponUpgradeSelected(1, WEAPON_CANNON), 1);
  assert.equal(world.applyWeaponUpgrade(1, WEAPON_UPGRADE_CANNON_BLAST), true);
  assert.equal(world.playerCredits[0], 375, "reselecting a purchased branch is free");
  assert.equal(world.applyWeaponUpgrade(1, WEAPON_UPGRADE_CANNON_PIERCER), true);
  assert.equal(world.playerCredits[0], 250);
  assert.equal(world.weaponUpgradeSelected(1, WEAPON_CANNON), 2);
  const snapshot = new Uint8Array(SNAPSHOT_BYTES);
  world.writeSnapshot(snapshot);
  world.applyWeaponUpgrade(1, WEAPON_UPGRADE_CANNON_BLAST);
  world.restoreSnapshot(snapshot);
  assert.equal(world.weaponUpgradeSelected(1, WEAPON_CANNON), 2);
  assert.equal(world.weaponUpgradeUnlocked(1, WEAPON_UPGRADE_CANNON_BLAST), true);
  world.submitInput(command(1, world.tick + 1, { buttons: INPUT_BUTTON_FIRE, aimX: 127, aimY: 0 }));
  world.step();
  const projectile = world.projectileActive.findIndex((active) => active !== 0);
  assert.ok(projectile >= 0);
  assert.equal(world.projectileUpgrade[projectile], WEAPON_UPGRADE_CANNON_PIERCER);
  assert.ok(world.projectileDamage[projectile] > 30, "piercer branch changes the fired damage");
  assert.equal(world.weaponUpgradeUnlocked(1, 255), false);
  assert.equal(world.applyWeaponUpgrade(1, 255), false);
});

test("bots use selected branch splash safety instead of base weapon tactics", () => {
  const stageAtCloseRange = (blast) => {
    const world = new BattleWorld(77);
    world.addPlayer(1, 1);
    world.addPlayer(2, 2);
    world.setBotSkill(1, 3);
    let found = false;
    for (let cellY = 1; cellY < MAP_HEIGHT - 1 && !found; cellY += 1) {
      for (let cellX = 1; cellX < MAP_WIDTH - 2; cellX += 1) {
        if (world.map.solidAt(cellX, cellY) || world.map.solidAt(cellX + 1, cellY)) continue;
        const x = cellX * 256 + 128;
        const y = cellY * 256 + 128;
        world.playerX[0] = x;
        world.playerY[0] = y;
        world.playerX[1] = x + 256;
        world.playerY[1] = y;
        found = true;
        break;
      }
    }
    assert.equal(found, true);
    world.playerTurretX[0] = 256;
    world.playerTurretY[0] = 0;
    if (blast) {
      world.grantCredits(1, 125);
      assert.equal(world.applyWeaponUpgrade(1, WEAPON_UPGRADE_CANNON_BLAST), true);
    }
    const bots = new BotController();
    bots.goalTarget[0] = 1;
    bots.decideAt[0] = 0x7fff_ffff;
    const staged = createInputCommand(77, 1);
    bots.stage(world, staged, 1, 1);
    return staged.buttons;
  };

  assert.notEqual(stageAtCloseRange(false) & INPUT_BUTTON_FIRE, 0, "base cannon may fire at one-cell range");
  assert.equal(stageAtCloseRange(true) & INPUT_BUTTON_FIRE, 0, "blast branch respects its larger self-damage radius");
});

// --- bots -------------------------------------------------------------------

test("bots fight, score, stay out of cover and pick their arena up", () => {
  const world = new BattleWorld(77);
  const bots = new BotController();
  const roster = 8;
  const commands = [];
  for (let playerId = 1; playerId <= roster; playerId += 1) {
    world.addPlayer(playerId);
    world.setBotSkill(playerId, 2);
    commands.push(createInputCommand(77, playerId));
  }
  run(world, 3_600, (tick) => {
    for (let playerId = 1; playerId <= roster; playerId += 1) {
      const staged = commands[playerId - 1];
      bots.stage(world, staged, playerId, tick);
      world.submitInput(staged);
    }
  });

  let frags = 0;
  let deaths = 0;
  const view = playerView();
  for (let playerId = 1; playerId <= roster; playerId += 1) {
    world.readPlayer(playerId, view);
    frags += view.score;
    deaths += view.deaths;
    assert.equal(world.map.solidAtWorld(view.x, view.y), false, `bot ${playerId} ended inside cover`);
  }
  assert.ok(frags >= roster, `eight veterans should trade more than ${frags} frags in a minute`);
  assert.equal(frags <= deaths, true, "every frag is somebody's death");

  let carrying = 0;
  for (let playerId = 1; playerId <= roster; playerId += 1) {
    world.readPlayer(playerId, view);
    if (view.weaponId !== 1) carrying += 1;
  }
  assert.ok(carrying > 0, "bots must contest weapon pads");
});

test("bot difficulty changes the outcome in the expected direction", () => {
  const scoreFor = (skillLow, skillHigh) => {
    const world = new BattleWorld(77);
    const bots = new BotController();
    const commands = [];
    for (let playerId = 1; playerId <= 8; playerId += 1) {
      world.addPlayer(playerId, playerId <= 4 ? 1 : 2);
      world.setBotSkill(playerId, playerId <= 4 ? skillLow : skillHigh);
      commands.push(createInputCommand(77, playerId));
    }
    run(world, 5_400, (tick) => {
      for (let playerId = 1; playerId <= 8; playerId += 1) {
        const staged = commands[playerId - 1];
        bots.stage(world, staged, playerId, tick);
        world.submitInput(staged);
      }
    });
    let low = 0;
    let high = 0;
    for (let slot = 0; slot < 8; slot += 1) {
      if (slot < 4) low += world.playerScore[slot];
      else high += world.playerScore[slot];
    }
    return { low, high };
  };
  const { low, high } = scoreFor(0, 3);
  assert.ok(high > low, `nightmare should beat recruits (${high} vs ${low})`);
});

test("playable orchestration is deterministic and supports restart and upgrades", () => {
  const first = new PlayableBattle({ players: 8, botSkill: 2 });
  const second = new PlayableBattle({ players: 8, botSkill: 2 });
  let observedProjectile = false;
  for (let tick = 0; tick < 900; tick += 1) {
    const controls = {
      moveX: tick < 240 ? 1 : tick < 480 ? 0 : -1,
      moveY: tick < 300 ? 1 : tick < 600 ? -1 : 0,
      fire: tick % 3 !== 0,
      boost: tick % 120 < 20,
    };
    first.setControls(controls);
    second.setControls(controls);
    first.step();
    second.step();
    observedProjectile ||= first.world.projectileActive.some((value) => value !== 0);
  }
  assert.equal(first.world.stateHash(), second.world.stateHash());
  assert.equal(first.world.tick, second.world.tick);
  assert.equal(observedProjectile, true);
  assert.ok(first.leaderScore() > 0, "fifteen seconds of eight tanks should produce frags");
  first.world.grantCredits(1, 500);
  assert.equal(first.buyUpgrade(UPGRADE_MOBILITY), true);
  const priorRound = first.round;
  first.restart();
  assert.equal(first.round, priorRound + 1);
  assert.equal(first.world.tick, 0);
  assert.equal(first.world.playerActive.reduce((sum, value) => sum + value, 0), 8);
});

// --- server and client ------------------------------------------------------

/** Wires a client to a server session over the in-memory transport pair. */
function join(server, name, errors, options = {}) {
  const client = new BattleClient({ name, onError: (error) => errors.push(error), ...options });
  if (options.resumeToken !== undefined) client.resumeToken.set(options.resumeToken);
  const session = server.createSession();
  const [clientTransport, serverTransport] = createInMemoryTransportPair(client, session, options.transport);
  session.attach(serverTransport);
  client.attach(clientTransport);
  client.session = session;
  return client;
}

/** Connects a client to a session whose welcome delivery deliberately fails. */
function failWelcome(server, client, disposition) {
  const session = server.createSession();
  const capabilities = { protocol: "in-memory", reliableStreams: true, datagrams: false, maxDatagramBytes: 0 };
  const clientTransport = {
    capabilities,
    sendReliable(channel, payload) {
      session.onReliable(channel, payload.slice());
      return Promise.resolve("sent");
    },
    trySendDatagram: async () => "closed",
    close(code, reason) {
      session.onClose(code, reason);
      client.onClose(code, reason);
    },
  };
  const serverTransport = {
    capabilities,
    sendReliable(channel, payload) {
      if (channel === TRANSPORT_CHANNEL_SESSION && payload[3] === 2) {
        if (disposition === "reject") return Promise.reject(new Error("welcome send rejected"));
        return Promise.resolve("closed");
      }
      client.onReliable(channel, payload.slice());
      return Promise.resolve("sent");
    },
    trySendDatagram: async () => "closed",
    close(code, reason) {
      client.onClose(code, reason);
      session.onClose(code, reason);
    },
  };
  session.attach(serverTransport);
  client.attach(clientTransport);
  return session;
}

async function settle() {
  // Native WebCrypto key import/signing crosses task boundaries. Give the
  // control-plane handshake bounded room to complete without assuming a
  // particular host's crypto scheduling latency.
  for (let turn = 0; turn < 12; turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

test("a welcomed player resumes its slot and the new stream starts from a keyframe", async () => {
  const errors = [];
  const server = new MatchServer({ rosterSize: 2, botSkill: 1, onError: (error) => errors.push(error) });
  const first = join(server, "commander", errors);
  await settle();
  assert.equal(first.state, "ready");
  const playerId = first.playerId;
  const tokenBeforeDisconnect = first.resumeToken.slice();
  server.world.playerScore[playerId - 1] = 7;
  server.world.playerCredits[playerId - 1] = 425;
  assert.equal(server.world.selectChassis(playerId, CHASSIS_BULWARK), true);
  const stateBeforeDisconnect = [
    server.world.playerScore[playerId - 1],
    server.world.playerCredits[playerId - 1],
    server.world.playerHealth[playerId - 1],
    server.world.playerChassis[playerId - 1],
    server.world.playerChassisUnlocks[playerId - 1],
  ];
  // Establish and consume the old session's baseline, then disconnect after
  // welcome. The world remains authoritative while the bot fills the slot.
  for (let tick = 0; tick < 3; tick += 1) server.step();
  await settle();
  first.update(0);
  first.close(1_001, "link lost");
  assert.equal(server.countHumans(), 0);

  const resumed = new BattleClient({ name: "renamed", onError: (error) => errors.push(error) });
  resumed.resumeToken.set(tokenBeforeDisconnect);
  const resumedSession = server.createSession();
  const [clientTransport, serverTransport] = createInMemoryTransportPair(resumed, resumedSession);
  const frames = [];
  const sendReliable = serverTransport.sendReliable.bind(serverTransport);
  serverTransport.sendReliable = async (channel, payload, signal) => {
    if (channel === 3) frames.push(payload.slice());
    return sendReliable(channel, payload, signal);
  };
  resumedSession.attach(serverTransport);
  resumed.attach(clientTransport);
  await settle();
  assert.equal(resumed.state, "ready");
  assert.equal(resumed.playerId, playerId, "resume must restore the authenticated player slot");
  assert.deepEqual([
    server.world.playerScore[playerId - 1],
    server.world.playerCredits[playerId - 1],
    server.world.playerHealth[playerId - 1],
    server.world.playerChassis[playerId - 1],
    server.world.playerChassisUnlocks[playerId - 1],
  ], stateBeforeDisconnect, "resume must not reset authoritative player state");

  server.step();
  server.step();
  server.step();
  await settle();
  assert.ok(frames.length > 0);
  assert.equal(frames[0][8], SNAPSHOT_KEYFRAME, "a resumed session cannot depend on the old baseline");
  resumed.update(0);
  assert.equal(resumed.stats.snapshotsApplied, 1);
  assert.equal(resumed.stats.lastServerTick, server.world.tick);
  assert.deepEqual(errors, []);
  server.close();
});

test("non-zero invalid, stale, and foreign resume tokens fail closed", async () => {
  const errors = [];
  const server = new MatchServer({ rosterSize: 2, resumeGraceTicks: 2, onError: (error) => errors.push(error) });
  const first = join(server, "owner", errors);
  await settle();
  const originalToken = first.resumeToken.slice();
  first.close(1_001, "link lost");

  const invalidRejected = [];
  const invalid = join(server, "invalid", errors, {
    resumeToken: new Uint8Array(RESUME_TOKEN_BYTES).fill(0x5a),
    onReject: (reject) => invalidRejected.push({ ...reject }),
  });
  await settle();
  assert.equal(invalid.state, "rejected");
  assert.equal(invalidRejected[0].code, REJECT_BAD_RESUME);
  assert.equal(server.countHumans(), 0);

  // A valid resume rotates the credential. The old one is then stale even
  // after the resumed connection disconnects.
  const resumed = join(server, "owner-again", errors, { resumeToken: originalToken });
  await settle();
  assert.equal(resumed.state, "ready");
  assert.notDeepEqual([...resumed.resumeToken], [...originalToken]);
  resumed.close(1_001, "link lost again");
  const staleRejected = [];
  const stale = join(server, "stale", errors, {
    resumeToken: originalToken,
    onReject: (reject) => staleRejected.push({ ...reject }),
  });
  await settle();
  assert.equal(stale.state, "rejected");
  assert.equal(staleRejected[0].code, REJECT_BAD_RESUME);

  const expiringServer = new MatchServer({ rosterSize: 1, resumeGraceTicks: 1 });
  const expiring = join(expiringServer, "expiring", errors);
  await settle();
  const expiringToken = expiring.resumeToken.slice();
  expiring.close(1_001, "link lost");
  expiringServer.step();
  expiringServer.step();
  const expiredRejected = [];
  const expired = join(expiringServer, "expired", errors, {
    resumeToken: expiringToken,
    onReject: (reject) => expiredRejected.push({ ...reject }),
  });
  await settle();
  assert.equal(expired.state, "rejected");
  assert.equal(expiredRejected[0].code, REJECT_BAD_RESUME);
  expiringServer.close();

  const otherServer = new MatchServer({ rosterSize: 2 });
  const foreign = join(otherServer, "foreign", errors);
  await settle();
  assert.notDeepEqual([...foreign.resumeToken], [...resumed.resumeToken], "same-match servers need distinct bearer secrets");
  const foreignRejected = [];
  const foreignAttempt = join(server, "foreign-attempt", errors, {
    resumeToken: foreign.resumeToken,
    onReject: (reject) => foreignRejected.push({ ...reject }),
  });
  await settle();
  assert.equal(foreignAttempt.state, "rejected");
  assert.equal(foreignRejected[0].code, REJECT_BAD_RESUME);
  otherServer.close();
  server.close();
  assert.deepEqual(errors, []);
});

test("failed welcome delivery does not consume an old or initial resume credential", async () => {
  const errors = [];
  const initialServer = new MatchServer({ rosterSize: 1 });
  const initialFailure = new BattleClient({ onError: (error) => errors.push(error) });
  failWelcome(initialServer, initialFailure, "closed");
  await settle();
  assert.equal(initialFailure.state, "closed");
  assert.equal(initialServer.countHumans(), 0);
  const initialRetry = join(initialServer, "initial-retry", errors);
  await settle();
  assert.equal(initialRetry.state, "ready", "an initial failed welcome must release its anonymous slot");
  initialServer.close();

  const server = new MatchServer({ rosterSize: 1 });
  const owner = join(server, "owner", errors);
  await settle();
  const oldToken = owner.resumeToken.slice();
  const playerId = owner.playerId;
  owner.close(1_001, "link lost");

  const failedResume = new BattleClient({ onError: (error) => errors.push(error) });
  failedResume.resumeToken.set(oldToken);
  failWelcome(server, failedResume, "reject");
  await settle();
  assert.equal(failedResume.state, "closed");
  assert.equal(server.countHumans(), 0);

  const retry = join(server, "retry", errors, { resumeToken: oldToken });
  await settle();
  assert.equal(retry.state, "ready");
  assert.equal(retry.playerId, playerId, "the old credential must remain usable after failed welcome delivery");
  assert.notDeepEqual([...retry.resumeToken], [...oldToken], "a successfully sent welcome must rotate the credential");

  const staleRejects = [];
  const stale = join(server, "stale", errors, {
    resumeToken: oldToken,
    onReject: (reject) => staleRejects.push({ ...reject }),
  });
  await settle();
  assert.equal(stale.state, "rejected");
  assert.equal(staleRejects[0].code, REJECT_BAD_RESUME);
  server.close();
  assert.deepEqual(errors, []);
});

test("a failed resumed welcome preserves the original grace deadline", async () => {
  const errors = [];
  const server = new MatchServer({ rosterSize: 1, resumeGraceTicks: 2 });
  const owner = join(server, "owner", errors);
  await settle();
  const oldToken = owner.resumeToken.slice();
  owner.close(1_001, "link lost");
  server.step();

  const failedResume = new BattleClient({ onError: (error) => errors.push(error) });
  failedResume.resumeToken.set(oldToken);
  failWelcome(server, failedResume, "closed");
  await settle();
  assert.equal(failedResume.state, "closed");

  server.step();
  server.step();
  const rejects = [];
  const expired = join(server, "expired", errors, {
    resumeToken: oldToken,
    onReject: (reject) => rejects.push({ ...reject }),
  });
  await settle();
  assert.equal(expired.state, "rejected");
  assert.equal(rejects[0].code, REJECT_BAD_RESUME);
  server.close();
  assert.deepEqual(errors, []);
});

test("a failed fresh takeover does not resurrect an expired resume credential", async () => {
  const errors = [];
  const server = new MatchServer({ rosterSize: 2, resumeGraceTicks: 1 });
  const occupied = join(server, "occupied", errors);
  await settle();
  const expiring = join(server, "expiring", errors);
  await settle();
  const staleToken = expiring.resumeToken.slice();
  expiring.close(1_001, "link lost");
  server.step();
  server.step();

  const failedFresh = new BattleClient({ onError: (error) => errors.push(error) });
  failWelcome(server, failedFresh, "reject");
  await settle();
  assert.equal(failedFresh.state, "closed");
  assert.equal(server.countHumans(), 1, "the failed takeover must release its claimed slot");

  const staleRejects = [];
  const stale = join(server, "stale", errors, {
    resumeToken: staleToken,
    onReject: (reject) => staleRejects.push({ ...reject }),
  });
  await settle();
  assert.equal(stale.state, "rejected");
  assert.equal(staleRejects[0].code, REJECT_BAD_RESUME);
  occupied.close(1_001, "test done");
  server.close();
  assert.deepEqual(errors, []);
});

test("snapshot decode failure latches until a keyframe and reports only its root error", async () => {
  const errors = [];
  const server = new MatchServer({ rosterSize: 2, onError: (error) => errors.push(error) });
  const client = join(server, "decoder", errors);
  await settle();
  server.step();
  server.step();
  server.step();
  await settle();
  client.update(0);
  const baseline = new Uint8Array(SNAPSHOT_BYTES);
  server.world.writeSnapshot(baseline);
  const nextWorld = new BattleWorld(server.world.matchId, server.world.mapSeed);
  nextWorld.restoreSnapshot(baseline);
  nextWorld.step();
  const next = new Uint8Array(SNAPSHOT_BYTES);
  nextWorld.writeSnapshot(next);
  const frame = new Uint8Array(SNAPSHOT_MESSAGE_BYTES);

  const missingBaseLength = writeSnapshotDelta(frame, 6, 999, baseline, baseline);
  client.onReliable(TRANSPORT_CHANNEL_SNAPSHOT, frame.subarray(0, missingBaseLength));
  assert.equal(errors.length, 1);
  const ignoredAfterRoot = client.stats.snapshotsIgnored;
  const dependentLength = writeSnapshotDelta(frame, 9, 3, baseline, baseline);
  client.onReliable(TRANSPORT_CHANNEL_SNAPSHOT, frame.subarray(0, dependentLength));
  assert.equal(errors.length, 1, "dependent deltas must not report a second error");
  assert.equal(client.stats.snapshotsIgnored, ignoredAfterRoot + 1);

  const keyframeLength = writeSnapshotKeyframe(frame, 12, baseline);
  client.onReliable(TRANSPORT_CHANNEL_SNAPSHOT, frame.subarray(0, keyframeLength));
  // The keyframe and its dependent delta can arrive in one receive burst. The
  // decoded keyframe must release the latch before the delta is considered.
  const recoveredDeltaLength = writeSnapshotDelta(frame, 15, 12, baseline, next);
  client.onReliable(TRANSPORT_CHANNEL_SNAPSHOT, frame.subarray(0, recoveredDeltaLength));
  client.update(0);
  assert.equal(client.stats.snapshotsApplied, 2, "a valid keyframe must recover a same-burst dependent delta");
  assert.equal(client.world.stateHash(), nextWorld.stateHash(), "the latest valid burst state must be applied");
  const nextDeltaLength = writeSnapshotDelta(frame, 18, 15, next, next);
  client.onReliable(TRANSPORT_CHANNEL_SNAPSHOT, frame.subarray(0, nextDeltaLength));
  client.update(0);
  assert.equal(client.stats.snapshotsApplied, 3, "the recovered delta chain must remain usable");
  assert.equal(errors.length, 1);
  server.close();
});

test("snapshot restore failures are reported without escaping update and recover by keyframe", async () => {
  const errors = [];
  const server = new MatchServer({ rosterSize: 2 });
  const client = join(server, "restore-guard", errors);
  await settle();
  server.step();
  server.step();
  server.step();
  await settle();
  client.update(0);
  const baseline = new Uint8Array(SNAPSHOT_BYTES);
  server.world.writeSnapshot(baseline);
  const bad = baseline.slice();
  bad[0] ^= 1;
  const frame = new Uint8Array(SNAPSHOT_MESSAGE_BYTES);
  const badLength = writeSnapshotKeyframe(frame, 6, bad);
  client.onReliable(TRANSPORT_CHANNEL_SNAPSHOT, frame.subarray(0, badLength));
  assert.doesNotThrow(() => client.update(0));
  assert.equal(errors.length, 1);

  const goodLength = writeSnapshotKeyframe(frame, 9, baseline);
  client.onReliable(TRANSPORT_CHANNEL_SNAPSHOT, frame.subarray(0, goodLength));
  assert.doesNotThrow(() => client.update(0));
  assert.equal(client.stats.snapshotsApplied, 2);
  assert.equal(errors.length, 1);
  server.close();
});

test("two clients join one authoritative match, replace bots and stay in sync", async () => {
  const errors = [];
  const server = new MatchServer({ rosterSize: 8, botSkill: 2, onError: (error) => errors.push(error) });
  const alpha = join(server, "alpha", errors);
  const bravo = join(server, "bravo", errors);
  await settle();
  server.step();
  await settle();

  assert.equal(alpha.state, "ready");
  assert.equal(bravo.state, "ready");
  assert.notEqual(alpha.playerId, bravo.playerId);
  assert.equal(server.countHumans(), 2);
  assert.equal(server.stats.bots, 6);
  assert.equal(alpha.world.mapSeed, server.world.mapSeed);

  alpha.setControls({ moveX: 1, moveY: 0, fire: true });
  bravo.setControls({ moveX: -1, moveY: 1, fire: true });
  for (let step = 0; step < 300; step += 1) {
    alpha.update(TICK_MILLISECONDS);
    bravo.update(TICK_MILLISECONDS);
    await settle();
    server.step();
    await settle();
  }

  const authoritative = playerView();
  const predicted = playerView();
  server.world.readPlayer(alpha.playerId, authoritative);
  alpha.world.readPlayer(alpha.playerId, predicted);
  assert.equal(predicted.x, authoritative.x);
  assert.equal(predicted.y, authoritative.y);
  assert.ok(alpha.stats.snapshotsApplied > 50);
  assert.ok(server.stats.inputsAccepted > 500);
  assert.equal(server.stats.inputsRejected, 0);
  assert.deepEqual(errors, []);
  server.close();
});

test("the first post-welcome input is accepted before the next server tick", async () => {
  const errors = [];
  const server = new MatchServer({ rosterSize: 2, inputBudgetPerTick: 1, onError: (error) => errors.push(error) });
  const client = join(server, "eager", errors);
  await settle();
  assert.equal(client.state, "ready");
  client.setControls({ moveX: 1, moveY: 0, fire: false });
  client.update(TICK_MILLISECONDS);
  await settle();
  assert.equal(client.state, "ready");
  assert.equal(server.stats.inputsAccepted, 1);
  assert.equal(server.stats.inputsRejected, 0);
  assert.deepEqual(errors, []);
  server.close();
});

test("a client that falls behind reconciles by replaying its own inputs", async () => {
  const errors = [];
  const server = new MatchServer({ rosterSize: 4, botSkill: 1, onError: (error) => errors.push(error) });
  const client = join(server, "laggy", errors, { leadTicks: 6 });
  await settle();
  server.step();
  await settle();
  assert.equal(client.state, "ready");

  client.setControls({ moveX: 1, moveY: 1, fire: false });
  // The client runs several ticks for every server tick it hears about, so each
  // snapshot lands behind the local clock and has to be replayed forward.
  for (let round = 0; round < 120; round += 1) {
    client.update(TICK_MILLISECONDS * 4, 8);
    await settle();
    server.step();
    server.step();
    await settle();
  }
  assert.ok(client.stats.replayedTicks > 0, "falling behind must produce a reconciliation replay");
  assert.ok(client.stats.snapshotsApplied > 0);
  assert.deepEqual(errors, []);
  server.close();
});

test("remote presentation uses bounded 20 Hz interpolation while local stays predicted", async () => {
  const errors = [];
  const server = new MatchServer({ rosterSize: 2, botSkill: 1, onError: (error) => errors.push(error) });
  const client = join(server, "presenter", errors);
  await settle();
  // Three 60 Hz ticks are one authoritative 20 Hz snapshot interval.
  server.step();
  server.step();
  server.step();
  await settle();
  client.update(0);
  const remoteSlot = client.playerId === 1 ? 1 : 0;
  const first = { x: 0, y: 0, hullX: 0, hullY: 0, turretX: 0, turretY: 0 };
  assert.equal(client.samplePlayerTransform(remoteSlot, first), true);

  server.step();
  server.step();
  server.step();
  await settle();
  client.update(0);
  const atSnapshot = { ...first };
  assert.equal(client.samplePlayerTransform(remoteSlot, atSnapshot), true);
  assert.deepEqual(atSnapshot, first, "a new snapshot starts the remote interpolation at the prior sample");
  client.update(25);
  const halfway = { ...first };
  assert.equal(client.samplePlayerTransform(remoteSlot, halfway), true);
  client.update(25);
  const current = { ...first };
  assert.equal(client.samplePlayerTransform(remoteSlot, current), true);
  assert.equal(current.x, server.world.playerX[remoteSlot], "remote presentation reaches the authoritative sample");

  client.setControls({ moveX: 1, moveY: 0, fire: false });
  client.update(TICK_MILLISECONDS * 4);
  const local = { ...first };
  assert.equal(client.samplePlayerTransform(client.playerId - 1, local), true);
  assert.equal(local.x, client.world.playerX[client.playerId - 1], "local presentation remains immediate prediction");
  assert.deepEqual(errors, []);
  server.close();
});

test("remote interpolation follows a six-tick cadence after snapshot coalescing", async () => {
  const errors = [];
  const server = new MatchServer({ rosterSize: 2, botSkill: 1, snapshotIntervalTicks: 6, onError: (error) => errors.push(error) });
  const client = join(server, "six-tick-presenter", errors);
  await settle();

  // Apply the first sample, then let two six-tick snapshots coalesce while the
  // client is away. The presentation delay must remain one server interval,
  // not the old hard-coded three ticks or the full received tick gap.
  for (let tick = 0; tick < 6; tick += 1) server.step();
  await settle();
  client.update(0);
  const remoteSlot = client.playerId === 1 ? 1 : 0;
  const first = { x: 0, y: 0, hullX: 0, hullY: 0, turretX: 0, turretY: 0 };
  assert.equal(client.samplePlayerTransform(remoteSlot, first), true);
  for (let tick = 0; tick < 12; tick += 1) server.step();
  await settle();
  client.update(0);
  const halfway = { ...first };
  client.update(50);
  assert.equal(client.samplePlayerTransform(remoteSlot, halfway), true);
  const current = { ...first };
  client.update(50);
  assert.equal(client.samplePlayerTransform(remoteSlot, current), true);
  assert.equal(current.x, server.world.playerX[remoteSlot]);
  assert.equal(halfway.x, Math.trunc((first.x + current.x) / 2));
  assert.deepEqual(errors, []);
  server.close();
});

test("client close lifecycle reports a pre-welcome failure", () => {
  const closes = [];
  const client = new BattleClient({ onClose: (close) => closes.push({ ...close }) });
  client.onClose(4_002, "dial failed");
  assert.equal(client.state, "closed");
  assert.deepEqual(closes, [{ code: 4_002, reason: "dial failed", state: "closed", welcomed: false }]);
});

test("a session may only move its own tank and the match refuses a ninth human", async () => {
  const errors = [];
  const server = new MatchServer({ rosterSize: 2, onError: (error) => errors.push(error) });
  const alpha = join(server, "alpha", errors);
  const bravo = join(server, "bravo", errors);
  const rejected = [];
  const charlie = join(server, "charlie", errors, { onReject: (reject) => rejected.push({ ...reject }) });
  await settle();
  server.step();
  await settle();
  assert.equal(alpha.state, "ready");
  assert.equal(bravo.state, "ready");
  assert.equal(charlie.state, "rejected");
  assert.equal(rejected.length, 1);
  assert.match(rejected[0].reason, /full/);

  // Alpha forges a packet claiming Bravo's slot and pushes it down its own
  // session. The server must refuse it rather than move somebody else's tank.
  const forged = new Uint8Array(INPUT_PACKET_BYTES);
  const targetTick = server.world.tick + 2;
  writeInputPacket(forged, 0, {
    ...command(bravo.playerId, targetTick, { moveX: 1 }),
    matchId: server.world.matchId,
  });
  const rejectedBefore = server.stats.inputsRejected;
  const movedBefore = server.world.playerX[bravo.playerId - 1];
  alpha.session.onDatagram(forged);
  server.step();
  assert.equal(server.stats.inputsRejected, rejectedBefore + 1);
  assert.equal(server.world.playerX[bravo.playerId - 1], movedBefore);
  server.close();
  assert.deepEqual(errors, []);
});

test("the server rejects input datagrams with trailing bytes", async () => {
  const errors = [];
  const server = new MatchServer({ rosterSize: 2, onError: (error) => errors.push(error) });
  const client = join(server, "exact-input", errors);
  await settle();
  server.step();
  await settle();

  const oversized = new Uint8Array(INPUT_PACKET_BYTES + 1);
  writeInputPacket(oversized, 0, {
    ...command(client.playerId, server.world.tick + 2, { moveX: 1 }),
    matchId: server.world.matchId,
  });
  const rejectedBefore = server.stats.inputsRejected;
  client.session.onDatagram(oversized);
  assert.equal(server.stats.inputsRejected, rejectedBefore + 1);
  assert.equal(client.session.closed, false, "one malformed datagram must not close the unreliable session");
  assert.equal(errors.length, 1);
  assert.match(String(errors[0]), /trailing bytes/);
  server.close();
});

test("a control message buys an upgrade through the reliable lane", async () => {
  const errors = [];
  const server = new MatchServer({ rosterSize: 4, onError: (error) => errors.push(error) });
  const client = join(server, "buyer", errors);
  await settle();
  server.step();
  await settle();
  server.world.grantCredits(client.playerId, 600);
  const before = server.world.playerDamageLevel[client.playerId - 1];
  client.sendControl(CONTROL_BUY_UPGRADE, UPGRADE_DAMAGE);
  await settle();
  assert.equal(server.world.playerDamageLevel[client.playerId - 1], before + 1);
  const chassisCredits = server.world.playerCredits[client.playerId - 1];
  client.sendControl(CONTROL_SET_CHASSIS, CHASSIS_BULWARK);
  await settle();
  assert.equal(server.world.playerChassis[client.playerId - 1], CHASSIS_BULWARK);
  assert.ok(server.world.playerCredits[client.playerId - 1] < chassisCredits);
  client.sendControl(CONTROL_SET_WEAPON_UPGRADE, WEAPON_UPGRADE_CANNON_BLAST);
  await settle();
  assert.equal(server.world.weaponUpgradeSelected(client.playerId, WEAPON_CANNON), 1);
  assert.deepEqual(errors, []);
  server.close();
});

test("an invalid chassis control fails closed", async () => {
  const errors = [];
  const server = new MatchServer({ rosterSize: 1, onError: (error) => errors.push(error) });
  const client = join(server, "invalid-chassis", errors);
  await settle();
  assert.equal(client.state, "ready");
  client.sendControl(CONTROL_SET_CHASSIS, 255);
  await settle();
  assert.equal(client.state, "closed");
  assert.equal(errors.length, 1);
  assert.match(String(errors[0]), /unknown chassis id 255/);
  server.close();
});

// --- transport --------------------------------------------------------------

test("the in-memory transport preserves reliable messages and models datagram loss", async () => {
  const leftEvents = [];
  const rightEvents = [];
  const receiver = (events) => ({
    onReliable(channel, payload) { events.push(["reliable", channel, [...payload]]); },
    onDatagram(payload) { events.push(["datagram", [...payload]]); },
    onClose(code, reason) { events.push(["close", code, reason]); },
  });
  const [left, right] = createInMemoryTransportPair(receiver(leftEvents), receiver(rightEvents), {
    maxDatagramBytes: 4,
    dropEvery: 2,
  });
  assert.equal(await left.sendReliable(TRANSPORT_CHANNEL_CONTROL, Uint8Array.of(1, 2)), "sent");
  assert.equal(await left.trySendDatagram(Uint8Array.of(3)), "sent");
  assert.equal(await left.trySendDatagram(Uint8Array.of(4)), "sent");
  assert.equal(await left.trySendDatagram(Uint8Array.of(1, 2, 3, 4, 5)), "too-large");
  assert.deepEqual(rightEvents, [
    ["reliable", TRANSPORT_CHANNEL_CONTROL, [1, 2]],
    ["datagram", [3]],
  ]);
  right.close(9, "done");
  assert.equal(await left.trySendDatagram(Uint8Array.of(1)), "closed");
});

test("tick input never disguises a reliable fallback as a datagram", async () => {
  const calls = [];
  const fallbackOnly = {
    capabilities: {
      protocol: "webtransport-h3",
      reliableStreams: true,
      datagrams: false,
      maxDatagramBytes: 0,
    },
    async sendReliable(channel, payload) {
      calls.push(["reliable", channel, payload.byteLength]);
      return "sent";
    },
    async trySendDatagram() {
      throw new Error("datagram path must not run");
    },
    close() {},
  };
  assert.deepEqual(await sendTickInput(fallbackOnly, Uint8Array.of(1, 2, 3)), {
    route: "reliable-fallback",
    disposition: "sent",
  });
  assert.deepEqual(calls, [["reliable", 4, 3]]);

  const congestedDatagram = {
    ...fallbackOnly,
    capabilities: { ...fallbackOnly.capabilities, datagrams: true, maxDatagramBytes: 64 },
    async sendReliable() {
      throw new Error("backpressure must not silently reroute stale input");
    },
    async trySendDatagram() { return "backpressured"; },
  };
  assert.deepEqual(await sendTickInput(congestedDatagram, Uint8Array.of(9)), {
    route: "datagram",
    disposition: "backpressured",
  });
});

test("Deno WebTransport readiness failure closes and releases the pending receiver", async () => {
  const errors = [];
  const pending = new Map();
  let closeOptions;
  let sessionAccepted = false;
  const session = {
    url: "https://war.invalid/failed",
    ready: Promise.reject(new Error("handshake rejected")),
    closed: Promise.resolve({}),
    close(options) { closeOptions = options; },
  };
  const incoming = { accept: async () => ({}) };
  const listener = {
    async *[Symbol.asyncIterator]() { yield incoming; },
  };
  const endpoint = {
    listen() { return listener; },
    close() {},
  };
  const runtime = {
    QuicEndpoint: class {
      constructor() { return endpoint; }
    },
    async upgradeWebTransport() { return session; },
  };
  const matchServer = new MatchServer();
  const receiver = matchServer.createSession();
  const server = DenoWebTransportServer.start({
    hostname: "127.0.0.1",
    port: 4_433,
    cert: "cert",
    key: "key",
    runtime,
    receiverForSession(url) {
      assert.equal(url, session.url);
      pending.set(receiver, receiver);
      return receiver;
    },
    onSession() { sessionAccepted = true; },
    onSessionError(url, failedReceiver) {
      assert.equal(url, session.url);
      pending.delete(failedReceiver);
    },
    onError(error) { errors.push(error); },
  });
  await server.completed;
  await settle();
  assert.equal(sessionAccepted, false);
  assert.equal(receiver.closed, true, "the MatchServer receiver must release its session");
  assert.equal(pending.size, 0, "failed handshakes must not leave pending receiver state");
  assert.deepEqual(closeOptions, { closeCode: 4_006, reason: "session readiness failed" });
  assert.equal(errors.length, 1);
  server.close();
  matchServer.close();
});

test("Deno WebTransport rejects a max-session connection without awaiting readiness", async () => {
  const errors = [];
  let closeCount = 0;
  let closeOptions;
  const failedSession = {
    url: "https://war.invalid/at-capacity",
    ready: new Promise(() => {}),
    closed: Promise.resolve({}),
    close(options) {
      closeCount += 1;
      closeOptions = options;
    },
  };
  const incomingInFlight = { accept: () => new Promise(() => {}) };
  const incomingAtCapacity = { accept: async () => ({ id: 2 }) };
  const listener = {
    async *[Symbol.asyncIterator]() {
      yield incomingInFlight;
      yield incomingAtCapacity;
    },
  };
  const endpoint = { listen() { return listener; }, close() {} };
  const runtime = {
    QuicEndpoint: class { constructor() { return endpoint; } },
    async upgradeWebTransport(connection) {
      assert.equal(connection.id, 2);
      return failedSession;
    },
  };
  const server = DenoWebTransportServer.start({
    hostname: "127.0.0.1",
    port: 4_434,
    cert: "cert",
    key: "key",
    maximumSessions: 1,
    runtime,
    receiverForSession() { throw new Error("max-session path must not create a receiver"); },
    onSession() { throw new Error("max-session path must not adopt a session"); },
    onError(error) { errors.push(error); },
  });
  await server.completed;
  await settle();
  assert.equal(closeCount, 1, "a rejected max-session handshake must close exactly once");
  assert.deepEqual(closeOptions, { closeCode: 4_001, reason: "server session limit reached" });
  assert.equal(errors.length, 0);
  server.close();
});

test("the browser adapter frames streams, handles fragmented reads, and checks datagram size", async () => {
  class FakeSession {
    ready = Promise.resolve();
    outgoingStreams = [];
    outgoingBidirectionalStreams = [];
    outgoingDatagrams = [];
    closeResolve;
    incomingController;
    incomingBidirectionalController;
    datagramController;
    closed = new Promise((resolve) => { this.closeResolve = resolve; });
    incomingUnidirectionalStreams = new ReadableStream({
      start: (controller) => { this.incomingController = controller; },
    });
    incomingBidirectionalStreams = new ReadableStream({
      start: (controller) => { this.incomingBidirectionalController = controller; },
    });
    datagrams = {
      maxDatagramSize: 8,
      readable: new ReadableStream({
        start: (controller) => { this.datagramController = controller; },
      }),
      writable: new WritableStream({
        write: (chunk) => { this.outgoingDatagrams.push([...chunk]); },
      }),
    };
    async createUnidirectionalStream() {
      const session = this;
      const chunks = [];
      this.outgoingStreams.push(chunks);
      return new WritableStream({
        write(chunk) { chunks.push(chunk.slice()); },
      });
    }
    async createBidirectionalStream() {
      const chunks = [];
      return {
        readable: new ReadableStream(),
        writable: new WritableStream({
          write(chunk) { chunks.push(chunk.slice()); },
          close: () => { this.outgoingBidirectionalStreams.push(chunks); },
        }),
      };
    }
    close(options = {}) {
      this.incomingController.close();
      this.incomingBidirectionalController.close();
      this.datagramController.close();
      this.closeResolve({ closeCode: options.closeCode, reason: options.reason });
    }
    pushReliable(channel, payload, direction = "client") {
      this.pushReliableFrames([[channel, payload]], direction);
    }
    pushReliableFrames(frames, direction = "client") {
      const bytes = new Uint8Array(frames.reduce((size, [, payload]) => size + 5 + payload.length, 0));
      let offset = 0;
      for (const [channel, payload] of frames) {
        const view = new DataView(bytes.buffer);
        view.setUint8(offset, channel);
        view.setUint32(offset + 1, payload.length, true);
        bytes.set(payload, offset + 5);
        offset += 5 + payload.length;
      }
      const readable = new ReadableStream({
        start(controller) {
          controller.enqueue(bytes.subarray(0, 2));
          controller.enqueue(bytes.subarray(2, 6));
          controller.enqueue(bytes.subarray(6));
          controller.close();
        },
      });
      if (direction === "server") {
        this.incomingBidirectionalController.enqueue({ readable, writable: new WritableStream() });
      } else {
        this.incomingController.enqueue(readable);
      }
    }
  }
  const session = new FakeSession();
  class FakeConstructor { constructor() { return session; } }
  const events = [];
  const client = await BrowserWebTransportClient.connect("https://example.invalid", {
    onReliable(channel, payload) { events.push(["reliable", channel, [...payload]]); },
    onDatagram(payload) { events.push(["datagram", [...payload]]); },
    onClose(code, reason) { events.push(["close", code, reason]); },
  }, FakeConstructor);
  const reusedPayload = Uint8Array.of(8, 9);
  const sendPromise = client.sendReliable(TRANSPORT_CHANNEL_SESSION, reusedPayload);
  reusedPayload[0] = 99;
  assert.equal(await sendPromise, "sent");
  assert.equal(session.outgoingBidirectionalStreams.length, 1);
  assert.equal(session.outgoingStreams.length, 0);
  assert.deepEqual([...session.outgoingBidirectionalStreams[0][0]], [TRANSPORT_CHANNEL_SESSION, 2, 0, 0, 0]);
  assert.deepEqual([...session.outgoingBidirectionalStreams[0][1]], [8, 9]);
  assert.equal(await client.trySendDatagram(Uint8Array.of(1, 2, 3)), "sent");
  assert.equal(await client.trySendDatagram(new Uint8Array(9)), "too-large");
  session.pushReliable(TRANSPORT_CHANNEL_CONTROL, Uint8Array.of(5, 6, 7));
  session.datagramController.enqueue(Uint8Array.of(4));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events.slice(0, 2), [
    ["datagram", [4]],
    ["reliable", TRANSPORT_CHANNEL_CONTROL, [5, 6, 7]],
  ]);
  client.close(12, "finished");
  assert.deepEqual(events.at(-1), ["close", 12, "finished"]);

  const serverSession = new FakeSession();
  const serverEvents = [];
  const serverTransport = await adoptServerWebTransportSession(serverSession, {
    onReliable(channel, payload) { serverEvents.push(["reliable", channel, [...payload]]); },
    onDatagram(payload) { serverEvents.push(["datagram", [...payload]]); },
    onClose(code, reason) { serverEvents.push(["close", code, reason]); },
  });
  assert.equal(await serverTransport.sendReliable(TRANSPORT_CHANNEL_SESSION, Uint8Array.of(3, 4)), "sent");
  assert.equal(serverSession.outgoingStreams.length, 1);
  assert.equal(serverSession.outgoingBidirectionalStreams.length, 0);
  assert.deepEqual([...serverSession.outgoingStreams[0][0]], [TRANSPORT_CHANNEL_SESSION, 2, 0, 0, 0, 3, 4]);
  assert.equal(await serverTransport.sendReliable(TRANSPORT_CHANNEL_CONTROL, Uint8Array.of(6)), "sent");
  assert.equal(serverSession.outgoingStreams.length, 1, "server reliable messages share one persistent stream");
  assert.deepEqual([...serverSession.outgoingStreams[0][1]], [TRANSPORT_CHANNEL_CONTROL, 1, 0, 0, 0, 6]);
  serverSession.pushReliable(TRANSPORT_CHANNEL_CONTROL, Uint8Array.of(7), "server");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(serverEvents, [["reliable", TRANSPORT_CHANNEL_CONTROL, [7]]]);
  serverTransport.close(12, "finished");
});

test("datagram staging owns caller bytes and has fixed in-flight capacity", async () => {
  class DelayedDatagramSession {
    ready = Promise.resolve();
    incomingUnidirectionalStreams = new ReadableStream();
    incomingBidirectionalStreams = new ReadableStream();
    closeResolve;
    closed = new Promise((resolve) => { this.closeResolve = resolve; });
    writes = [];
    writeResolves = [];
    datagramAbortCalls = 0;
    datagramReleaseCalls = 0;
    writer = {
      desiredSize: 1,
      write: (chunk) => {
        this.writes.push(chunk);
        return new Promise((resolve) => { this.writeResolves.push(resolve); });
      },
      abort: async () => { this.datagramAbortCalls += 1; },
      releaseLock: () => { this.datagramReleaseCalls += 1; },
    };
    datagrams = {
      maxDatagramSize: 8,
      readable: new ReadableStream(),
      writable: { getWriter: () => this.writer },
    };
    createUnidirectionalStream() { throw new Error("not used"); }
    createBidirectionalStream() { throw new Error("not used"); }
    close(options = {}) { this.closeResolve({ closeCode: options.closeCode, reason: options.reason }); }
  }

  const session = new DelayedDatagramSession();
  class FakeConstructor { constructor() { return session; } }
  const client = await BrowserWebTransportClient.connect("https://example.invalid", {
    onReliable() {},
    onDatagram() {},
    onClose() {},
  }, FakeConstructor);

  const sends = [];
  for (let index = 0; index < 4; index += 1) {
    const source = Uint8Array.of(index, index + 10);
    sends.push(client.trySendDatagram(source));
    source[0] = 99;
  }
  assert.equal(await client.trySendDatagram(Uint8Array.of(4, 14)), "backpressured");
  assert.equal(session.writes.length, 4);
  assert.deepEqual([...session.writes[0]], [0, 10], "staging preserves bytes after caller reuse");

  session.writeResolves.shift()();
  assert.equal(await sends[0], "sent");
  const replacement = client.trySendDatagram(Uint8Array.of(8, 18));
  assert.equal(session.writes.length, 5, "a settled write returns one staging slot");
  for (const resolve of session.writeResolves.splice(0)) resolve();
  assert.equal(await replacement, "sent");
  assert.deepEqual(await Promise.all(sends.slice(1)), ["sent", "sent", "sent"]);
  client.close(12, "finished");
  client.close(13, "ignored");
  assert.equal(session.datagramAbortCalls, 1);
  assert.equal(session.datagramReleaseCalls, 1);
});

test("repeated client reliable streams cancel their unused reverse directions", async () => {
  class RepeatedBidiSession {
    ready = Promise.resolve();
    incomingController;
    incomingUnidirectionalStreams = new ReadableStream();
    incomingBidirectionalStreams = new ReadableStream();
    datagrams = { maxDatagramSize: 8, readable: new ReadableStream(), writable: new WritableStream() };
    closeResolve;
    closed = new Promise((resolve) => { this.closeResolve = resolve; });
    reverseCancels = 0;
    close(options = {}) { this.closeResolve({ closeCode: options.closeCode, reason: options.reason }); }
    createUnidirectionalStream() { throw new Error("not used"); }
    createBidirectionalStream() {
      const session = this;
      const readable = new ReadableStream({ cancel() { session.reverseCancels += 1; } });
      return { readable, writable: new WritableStream() };
    }
  }
  const session = new RepeatedBidiSession();
  class FakeConstructor { constructor() { return session; } }
  const client = await BrowserWebTransportClient.connect("https://example.invalid", {
    onReliable() {},
    onDatagram() {},
    onClose() {},
  }, FakeConstructor);
  for (let index = 0; index < 8; index += 1) {
    assert.equal(await client.sendReliable(TRANSPORT_CHANNEL_CONTROL, Uint8Array.of(index)), "sent");
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(session.reverseCancels, 8);
  client.close(12, "finished");
});

test("server reliable streams close reverse writers without escalating peer resets", async () => {
  class RepeatedServerSession {
    ready = Promise.resolve();
    incomingController;
    incomingBidirectionalStreams = new ReadableStream({ start: (controller) => { this.incomingController = controller; } });
    incomingUnidirectionalStreams = new ReadableStream();
    datagrams = { maxDatagramSize: 8, readable: new ReadableStream(), writable: new WritableStream() };
    closeResolve;
    closed = new Promise((resolve) => { this.closeResolve = resolve; });
    closeCalls = 0;
    reverseCloses = 0;
    reverseReleases = 0;
    push(channel, value, rejectClose = false) {
      const session = this;
      const bytes = Uint8Array.of(channel, 1, 0, 0, 0, value);
      const readable = new ReadableStream({
        start(controller) { controller.enqueue(bytes); controller.close(); },
      });
      const writable = {
        getWriter() {
          return {
            close: () => {
              session.reverseCloses += 1;
              return rejectClose ? Promise.reject(new Error("peer reset")) : Promise.resolve();
            },
            releaseLock() { session.reverseReleases += 1; },
          };
        },
      };
      this.incomingController.enqueue({ readable, writable });
    }
    createUnidirectionalStream() { throw new Error("not used"); }
    createBidirectionalStream() { throw new Error("not used"); }
    close(options = {}) {
      this.closeCalls += 1;
      this.incomingController.close();
      this.closeResolve({ closeCode: options.closeCode, reason: options.reason });
    }
  }
  const session = new RepeatedServerSession();
  const events = [];
  const transport = await adoptServerWebTransportSession(session, {
    onReliable(channel, payload) { events.push([channel, payload[0]]); },
    onDatagram() {},
    onClose(code, reason) { events.push(["close", code, reason]); },
  });
  for (let index = 0; index < 7; index += 1) session.push(TRANSPORT_CHANNEL_CONTROL, index, index === 6);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, [
    [TRANSPORT_CHANNEL_CONTROL, 0],
    [TRANSPORT_CHANNEL_CONTROL, 1],
    [TRANSPORT_CHANNEL_CONTROL, 2],
    [TRANSPORT_CHANNEL_CONTROL, 3],
    [TRANSPORT_CHANNEL_CONTROL, 4],
    [TRANSPORT_CHANNEL_CONTROL, 5],
    [TRANSPORT_CHANNEL_CONTROL, 6],
  ]);
  assert.equal(session.reverseCloses, 7);
  assert.equal(session.reverseReleases, 7);
  assert.equal(session.closeCalls, 0, "a peer-reset reverse writer does not close the healthy session");
  transport.close(12, "finished");
});

test("the persistent reliable decoder handles coalesced frames and rejects oversized lengths", async () => {
  class DecoderSession {
    ready = Promise.resolve();
    incomingController;
    datagramController;
    closeResolve;
    closed = new Promise((resolve) => { this.closeResolve = resolve; });
    closeCalls = 0;
    incomingUnidirectionalStreams = new ReadableStream({
      start: (controller) => { this.incomingController = controller; },
    });
    incomingBidirectionalStreams = new ReadableStream();
    datagrams = {
      maxDatagramSize: 8,
      readable: new ReadableStream({
        start: (controller) => { this.datagramController = controller; },
      }),
      writable: new WritableStream(),
    };
    createUnidirectionalStream() { throw new Error("not used"); }
    createBidirectionalStream() { throw new Error("not used"); }
    close(options = {}) {
      this.closeCalls += 1;
      this.incomingController.close();
      this.datagramController.close();
      this.closeResolve({ closeCode: options.closeCode, reason: options.reason });
    }
    pushBytes(bytes) {
      this.incomingController.enqueue(new ReadableStream({
        start: (controller) => {
          controller.enqueue(bytes.subarray(0, 1));
          controller.enqueue(bytes.subarray(1, 8));
          controller.enqueue(bytes.subarray(8));
          controller.close();
        },
      }));
    }
  }
  const session = new DecoderSession();
  class FakeConstructor { constructor() { return session; } }
  const events = [];
  const client = await BrowserWebTransportClient.connect("https://example.invalid", {
    onReliable(channel, payload) { events.push(["reliable", channel, [...payload]]); },
    onDatagram() {},
    onClose(code, reason) { events.push(["close", code, reason]); },
  }, FakeConstructor);
  const frames = new Uint8Array([TRANSPORT_CHANNEL_CONTROL, 2, 0, 0, 0, 9, 8, TRANSPORT_CHANNEL_SESSION, 1, 0, 0, 0, 7]);
  session.pushBytes(frames);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, [
    ["reliable", TRANSPORT_CHANNEL_CONTROL, [9, 8]],
    ["reliable", TRANSPORT_CHANNEL_SESSION, [7]],
  ]);
  const oversized = new Uint8Array(5);
  new DataView(oversized.buffer).setUint32(1, 64 * 1024 + 1, true);
  oversized[0] = TRANSPORT_CHANNEL_CONTROL;
  session.pushBytes(oversized);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(events.at(-1)[0], "close");
  assert.equal(events.at(-1)[1], 2);
  assert.equal(session.closeCalls, 1, "decoder failure closes the underlying session exactly once");
  client.close(12, "finished");
});

test("a remote WebTransport close is observed without issuing a second close", async () => {
  class RemotelyClosedSession {
    ready = Promise.resolve();
    incomingUnidirectionalStreams = new ReadableStream();
    incomingBidirectionalStreams = new ReadableStream();
    datagrams = { maxDatagramSize: 8, readable: new ReadableStream(), writable: new WritableStream() };
    closeCalls = 0;
    closedResolve;
    closed = new Promise((resolve) => { this.closedResolve = resolve; });
    createUnidirectionalStream() { throw new Error("not used"); }
    createBidirectionalStream() { throw new Error("not used"); }
    close() { this.closeCalls += 1; }
  }
  const session = new RemotelyClosedSession();
  class FakeConstructor { constructor() { return session; } }
  const events = [];
  await BrowserWebTransportClient.connect("https://example.invalid", {
    onReliable() {},
    onDatagram() {},
    onClose(code, reason) { events.push([code, reason]); },
  }, FakeConstructor);
  session.closedResolve({ closeCode: 7, reason: "peer closed" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(session.closeCalls, 0);
  assert.deepEqual(events, [[7, "peer closed"]]);
});

test("server snapshots coalesce to one bounded pending frame under stream backpressure", async () => {
  class BackpressuredSession {
    ready = Promise.resolve();
    outgoingStreams = [];
    incomingBidirectionalStreams = new ReadableStream();
    incomingUnidirectionalStreams = new ReadableStream();
    datagrams = { maxDatagramSize: 8, readable: new ReadableStream(), writable: new WritableStream() };
    closeResolve;
    closed = new Promise((resolve) => { this.closeResolve = resolve; });
    closeCalls = 0;
    capacity = 0;
    readyResolve;
    readyWaiters = 0;
    async createUnidirectionalStream() {
      const chunks = [];
      this.outgoingStreams.push(chunks);
      let ready = new Promise((resolve) => { this.readyResolve = resolve; });
      const writer = {
        get desiredSize() { return session.capacity; },
        get ready() { session.readyWaiters += 1; return ready; },
        write: async (chunk) => { chunks.push(chunk.slice()); this.capacity = 0; ready = new Promise((resolve) => { this.readyResolve = resolve; }); },
        abort: async () => {},
        releaseLock() {},
      };
      return { getWriter: () => writer };
    }
    createBidirectionalStream() { throw new Error("not used"); }
    releaseCapacity() { this.capacity = 1; this.readyResolve?.(); }
    close(options = {}) { this.closeCalls += 1; this.closeResolve({ closeCode: options.closeCode, reason: options.reason }); }
  }
  const session = new BackpressuredSession();
  const transport = await adoptServerWebTransportSession(session, {
    onReliable() {},
    onDatagram() {},
    onClose() {},
  });
  assert.equal(await transport.sendReliable(3, Uint8Array.of(1)), "backpressured");
  assert.equal(await transport.sendReliable(3, Uint8Array.of(2)), "backpressured");
  assert.equal(session.outgoingStreams.length, 1);
  assert.deepEqual(session.outgoingStreams[0], []);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(session.readyWaiters, 1, "one active pump owns the blocked writer.ready wait");
  for (let value = 3; value <= 100; value += 1) {
    assert.equal(await transport.sendReliable(3, Uint8Array.of(value)), "backpressured");
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(session.readyWaiters, 1, "snapshot flood does not retain additional writer.ready waiters");
  session.releaseCapacity();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual([...session.outgoingStreams[0][0]], [3, 1, 0, 0, 0, 100], "only the latest snapshot is retained");
  session.releaseCapacity();
  assert.equal(await transport.sendReliable(TRANSPORT_CHANNEL_CONTROL, Uint8Array.of(4)), "sent");
  assert.deepEqual([...session.outgoingStreams[0][1]], [TRANSPORT_CHANNEL_CONTROL, 1, 0, 0, 0, 4]);
  transport.close(12, "finished");
});

test("server control backpressure has one bounded FIFO and fails closed on overflow", async () => {
  class BackpressuredSession {
    ready = Promise.resolve();
    outgoingStreams = [];
    incomingBidirectionalStreams = new ReadableStream();
    incomingUnidirectionalStreams = new ReadableStream();
    datagrams = { maxDatagramSize: 8, readable: new ReadableStream(), writable: new WritableStream() };
    closeResolve;
    closed = new Promise((resolve) => { this.closeResolve = resolve; });
    closeCalls = 0;
    capacity = 0;
    readyResolve;
    readyWaiters = 0;
    async createUnidirectionalStream() {
      const chunks = [];
      this.outgoingStreams.push(chunks);
      let ready = new Promise((resolve) => { this.readyResolve = resolve; });
      const session = this;
      const writer = {
        get desiredSize() { return session.capacity; },
        get ready() { session.readyWaiters += 1; return ready; },
        write: async (chunk) => {
          chunks.push(chunk.slice());
          this.capacity = 0;
          ready = new Promise((resolve) => { this.readyResolve = resolve; });
        },
        abort: async () => {},
        releaseLock() {},
      };
      return { getWriter: () => writer };
    }
    createBidirectionalStream() { throw new Error("not used"); }
    close(options = {}) { this.closeCalls += 1; this.closeResolve({ closeCode: options.closeCode, reason: options.reason }); }
  }

  const session = new BackpressuredSession();
  const transport = await adoptServerWebTransportSession(session, {
    onReliable() {},
    onDatagram() {},
    onClose() {},
  });

  const first = transport.sendReliable(TRANSPORT_CHANNEL_CONTROL, Uint8Array.of(1));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(session.readyWaiters, 1, "one pump owns writer.ready while blocked");
  const queued = [first];
  for (let index = 2; index <= 40; index += 1) {
    queued.push(transport.sendReliable(TRANSPORT_CHANNEL_CONTROL, Uint8Array.of(index)));
  }
  assert.deepEqual(await Promise.all(queued), queued.map(() => "closed"));
  assert.equal(session.closeCalls, 1, "queue overflow closes the session once");
  assert.equal(session.readyWaiters, 1, "overflow does not add writer.ready waiters");
});

test("server reliable admission is bounded while stream creation is pending", async () => {
  class DelayedStreamSession {
    ready = Promise.resolve();
    incomingBidirectionalStreams = new ReadableStream();
    incomingUnidirectionalStreams = new ReadableStream();
    datagrams = { maxDatagramSize: 8, readable: new ReadableStream(), writable: new WritableStream() };
    closeResolve;
    closed = new Promise((resolve) => { this.closeResolve = resolve; });
    closeCalls = 0;
    createCalls = 0;
    resolveCreate;
    async createUnidirectionalStream() {
      this.createCalls += 1;
      return new Promise((resolve) => {
        this.resolveCreate = () => resolve(new WritableStream());
      });
    }
    createBidirectionalStream() { throw new Error("not used"); }
    close(options = {}) { this.closeCalls += 1; this.closeResolve({ closeCode: options.closeCode, reason: options.reason }); }
  }

  const session = new DelayedStreamSession();
  const transport = await adoptServerWebTransportSession(session, {
    onReliable() {},
    onDatagram() {},
    onClose() {},
  });
  const sends = [transport.sendReliable(TRANSPORT_CHANNEL_CONTROL, Uint8Array.of(0))];
  assert.equal(session.createCalls, 0, "admission does not await stream creation per send");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(session.createCalls, 1, "one pump owns pending stream creation");
  for (let index = 1; index < 40; index += 1) {
    sends.push(transport.sendReliable(TRANSPORT_CHANNEL_CONTROL, Uint8Array.of(index)));
  }
  assert.deepEqual(await Promise.all(sends), sends.map(() => "closed"));
  assert.equal(session.closeCalls, 1, "pending-create overflow closes once");
  session.resolveCreate?.();
  void transport;
});

void CELL_FLOOR;
