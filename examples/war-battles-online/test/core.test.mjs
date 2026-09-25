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
  WebTransportGameClient,
  DenoWebTransportServer,
  CELL_FLOOR,
  CONTROL_BYTES,
  CONTROL_BUY_UPGRADE,
  CONTROL_SET_CHASSIS,
  CONTROL_SET_WEAPON_UPGRADE,
  CONTROL_SUICIDE,
  DEFAULT_ARENA_SEED,
  EVENT_KILL,
  EVENT_EJECT,
  EVENT_TANK_ACQUIRED,
  EVENT_COVER_CHANGED,
  EVENT_HAZARD_DAMAGE,
  EVENT_OBJECTIVE_CAPTURE,
  EVENT_PICKUP_TAKEN,
  HELLO_BYTES,
  INPUT_BUTTON_BOOST,
  INPUT_BUTTON_FIRE,
  INPUT_BUNDLE_MAX_COMMANDS,
  INPUT_PACKET_BYTES,
  MAP_HEIGHT,
  MAP_WIDTH,
  MAX_PICKUPS,
  MAX_HAZARDS,
  MAX_COVER_PANELS,
  COVER_MAX_HEALTH,
  MAX_PLAYERS,
  MatchServer,
  NetworkBotDriver,
  PICKUP_HEALTH,
  REJECT_BAD_RESUME,
  REJECT_FULL,
  REJECT_MAXIMUM_BYTES,
  REJECT_RATE_LIMITED,
  PlayableBattle,
  RESUME_TOKEN_BYTES,
  SNAPSHOT_BYTES,
  SNAPSHOT_BASE_HISTORY_FRAMES,
  SNAPSHOT_DELTA,
  SNAPSHOT_FRAME_HEADER_BYTES,
  SNAPSHOT_KEYFRAME,
  SNAPSHOT_KEYFRAME_INTERVAL,
  SNAPSHOT_MESSAGE_BYTES,
  TICK_MILLISECONDS,
  TILE_UNITS,
  TRANSPORT_CHANNEL_CONTROL,
  TRANSPORT_CHANNEL_INPUT_FALLBACK,
  TRANSPORT_CHANNEL_SESSION,
  TRANSPORT_CHANNEL_SNAPSHOT,
  UPGRADE_DAMAGE,
  WEAPON_UPGRADE_CANNON_BLAST,
  WEAPON_UPGRADE_CANNON_PIERCER,
  WELCOME_BYTES,
  WELCOME_ACK_BYTES,
  WEAPON_AUTOCANNON,
  WEAPON_CANNON,
  WEAPON_MORTAR,
  WEAPON_RICOCHET,
  WEAPON_SCATTER,
  createBattleEvent,
  createArenaRouteScratch,
  createInMemoryTransportPair,
  createInputCommand,
  createObjectiveView,
  createPlayerView,
  OBJECTIVE_CAPTURE_TICKS,
  PLAYER_MODE_DEAD,
  PLAYER_MODE_INFANTRY,
  PLAYER_MODE_TANK,
  HAZARD_ACTIVE_TICKS,
  HAZARD_CYCLE_TICKS,
  HAZARD_PULSE_TICKS,
  HAZARD_RADIUS,
  isqrt,
  readHello,
  readInputPacket,
  readReject,
  readSnapshotFrame,
  readWelcome,
  readWelcomeAck,
  sendTickInput,
  writeHello,
  writeControl,
  writeInputPacket,
  writeReject,
  writeSnapshotDelta,
  writeSnapshotKeyframe,
  writeWelcome,
  writeWelcomeAck,
} from "../core/index.ts";
import {
  ARENA_DECOR_ROLE_COUNT,
  ARENA_GROUND_ROLE_WALL_BASE,
  ARENA_MARK_ROLE_COUNT,
  ARENA_VISUAL_CELL_COUNT,
  ARENA_WALL_MASK_BITS,
  ARENA_WALL_MASK_TO_FRAME,
  arenaThemeIndex,
  arenaWallMask,
  projectArenaVisualRoles,
} from "../core/arena-visual.ts";
import {
  CHASSIS_ARTILLERY,
  CHASSIS_BULWARK,
  CHASSIS_SCOUT,
  DRIVER_COUNT,
  chassisById,
  chassisUnlockBit,
  driverByPlayerId,
  UPGRADE_MOBILITY,
} from "../core/content.ts";
import { NetworkBotClock } from "../bot-dashboard/network-bot-clock.ts";
import { settleEventLoop, waitForCondition } from "./async-conditions.mjs";

test("every authoritative tank slot has one stable driver identity", () => {
  const callSigns = new Set();
  const variants = new Set();
  for (let playerId = 1; playerId <= MAX_PLAYERS; playerId += 1) {
    const driver = driverByPlayerId(playerId);
    assert.equal(driver.id, playerId);
    assert.ok(driver.callSign.length > 0);
    callSigns.add(driver.callSign);
    variants.add(driver.variant);
  }
  assert.equal(DRIVER_COUNT, MAX_PLAYERS);
  assert.equal(callSigns.size, MAX_PLAYERS);
  assert.deepEqual([...variants], [0, 1, 2, 3]);
  assert.throws(() => driverByPlayerId(0), /unknown driver player id/);
  assert.throws(() => driverByPlayerId(MAX_PLAYERS + 1), /unknown driver player id/);
});

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
    matchId: 77,
    playerId: 3,
    team: 1,
    maximumPlayers: 8,
    botCount: 5,
    mapSeed: 0x1234_5678,
    serverTick: 4_321,
    tickRate: 60,
    snapshotIntervalTicks: 6,
    resumeToken: token,
  });
  const observedWelcome = {
    matchId: 0,
    playerId: 0,
    team: 0,
    maximumPlayers: 0,
    botCount: 0,
    mapSeed: 0,
    serverTick: 0,
    tickRate: 0,
    snapshotIntervalTicks: 0,
    resumeToken: new Uint8Array(RESUME_TOKEN_BYTES),
  };
  readWelcome(welcome, observedWelcome);
  assert.equal(observedWelcome.playerId, 3);
  assert.equal(observedWelcome.mapSeed, 0x1234_5678);
  assert.equal(observedWelcome.serverTick, 4_321);
  assert.equal(observedWelcome.snapshotIntervalTicks, 6);
  const acknowledgement = new Uint8Array(WELCOME_ACK_BYTES);
  writeWelcomeAck(acknowledgement, { resumeToken: token });
  const observedAcknowledgement = { resumeToken: new Uint8Array(RESUME_TOKEN_BYTES) };
  readWelcomeAck(acknowledgement, observedAcknowledgement);
  assert.deepEqual([...observedAcknowledgement.resumeToken], [...token]);
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
  assert.ok(keyframeLength > SNAPSHOT_FRAME_HEADER_BYTES && keyframeLength < SNAPSHOT_MESSAGE_BYTES);
  assert.ok(
    deltaLength > 0 && deltaLength < keyframeLength,
    `delta ${deltaLength} must beat keyframe ${keyframeLength}`,
  );

  const scratch = {
    baseline: new Uint8Array(SNAPSHOT_BYTES),
    decoded: new Uint8Array(SNAPSHOT_BYTES),
    baselineTick: -1,
  };
  const baselineKeyframeLength = writeSnapshotKeyframe(frame, 0, first);
  const previousProtocolFrame = frame.slice(0, baselineKeyframeLength);
  previousProtocolFrame[2] = 4;
  assert.throws(() => readSnapshotFrame(previousProtocolFrame, scratch), /envelope mismatch/);
  const reservedByteFrame = frame.slice(0, baselineKeyframeLength);
  reservedByteFrame[9] = 1;
  assert.throws(() => readSnapshotFrame(reservedByteFrame, scratch), /reserved byte/);
  const keyframeBaseFrame = frame.slice(0, baselineKeyframeLength);
  keyframeBaseFrame[10] = 1;
  assert.throws(() => readSnapshotFrame(keyframeBaseFrame, scratch), /invalid snapshot keyframe/);
  assert.equal(readSnapshotFrame(frame.subarray(0, baselineKeyframeLength), scratch), 0);
  writeSnapshotDelta(frame, world.tick, 0, first, second);
  assert.equal(readSnapshotFrame(frame.subarray(0, deltaLength), scratch), world.tick);
  assert.deepEqual(scratch.decoded, second);

  const validDelta = frame.slice(0, deltaLength);
  const malformed = validDelta.slice(0, SNAPSHOT_FRAME_HEADER_BYTES + 1);
  malformed[14] = 1;
  malformed[15] = 0;
  const recoveryKeyframeLength = writeSnapshotKeyframe(frame, 0, first);
  readSnapshotFrame(frame.subarray(0, recoveryKeyframeLength), scratch);
  assert.throws(() => readSnapshotFrame(malformed, scratch), /run header is truncated/);

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
  const normal = [];
  let baselineTick = -1;
  let framesSinceKeyframe = SNAPSHOT_KEYFRAME_INTERVAL;
  let keyframes = 0;
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
      keyframes += 1;
    } else {
      framesSinceKeyframe += 1;
      normal.push(length);
    }
    lengths.push(length);
    previous.set(current);
    baselineTick = world.tick;
  }
  lengths.sort((left, right) => left - right);
  assert.equal(lengths.length, 200);
  assert.equal(lengths[0], 1_268);
  assert.equal(lengths.at(-1), 4_748);
  assert.equal(lengths[Math.floor(lengths.length / 2)], 1_496);
  assert.equal(keyframes, 10);
  normal.sort((left, right) => left - right);
  assert.equal(normal.at(-1), 1_902);
});

test("snapshot admission stays bounded when a host ignores stream cancellation", async () => {
  const server = new MatchServer({ rosterSize: 2 });
  const session = server.createSession();
  const frames = [];
  const signals = [];
  const transport = {
    capabilities: { protocol: "in-memory", reliableStreams: true, datagrams: false, maxDatagramBytes: 0 },
    sendReliable(_channel, payload, signal) {
      frames.push(payload.slice());
      signals.push(signal);
      return new Promise(() => {});
    },
    trySendDatagram: async () => "closed",
    close() {},
  };
  session.attach(transport);
  const first = new Uint8Array(SNAPSHOT_BYTES);
  for (let index = 0; index < 8; index += 1) session.sendSnapshot(first, 3 + index * 3);
  assert.equal(frames.length, 8);
  session.sendSnapshot(new Uint8Array(SNAPSHOT_BYTES).fill(7), 27);
  assert.equal(frames.length, 8, "a cancellation-ignoring host cannot grow the stream window");
  assert.equal(frames[0][8], SNAPSHOT_KEYFRAME);
  assert.equal(frames[7][8], SNAPSHOT_KEYFRAME, "unacknowledged state cannot become a delta base");
  assert.equal(
    signals.every((signal) => signal.aborted),
    true,
    "every obsolete operation is asked to reset",
  );
  server.close();
});

test("snapshot stale capacity follows the injected match clock", () => {
  let nowMilliseconds = 0;
  const frames = [];
  const signals = [];
  const server = new MatchServer({ rosterSize: 2, nowMilliseconds: () => nowMilliseconds });
  const session = server.createSession();
  const transport = {
    capabilities: { protocol: "in-memory", reliableStreams: true, datagrams: false, maxDatagramBytes: 0 },
    sendReliable(_channel, payload, signal) {
      frames.push(payload.slice());
      signals.push(signal);
      return new Promise(() => {});
    },
    trySendDatagram: async () => "closed",
    close() {},
  };
  session.attach(transport);
  const source = new Uint8Array(SNAPSHOT_BYTES);
  for (let tick = 3; tick <= 60; tick += 3) {
    nowMilliseconds = tick * TICK_MILLISECONDS;
    session.beginTick();
    session.sendSnapshot(source, tick);
  }
  assert.ok(frames.length > 8, "stale streams must free capacity from the injected clock");
  assert.ok(
    signals.some((signal) => signal.aborted),
    "the injected clock must abort stale streams",
  );
  server.close();
});

test("snapshot cadence does not throttle an acknowledged baseline inside the 64-frame history", async () => {
  let nowMilliseconds = 0;
  const frames = [];
  const server = new MatchServer({
    rosterSize: 2,
    snapshotIntervalTicks: 3,
    nowMilliseconds: () => nowMilliseconds,
  });
  const session = server.createSession();
  // This test isolates snapshot scheduling; the handshake is covered by the
  // transport integration tests below. The session is an admitted player so
  // its acknowledgement packet exercises the production decoder.
  session.ready = true;
  session.slot = 0;
  session.attach({
    capabilities: { protocol: "in-memory", reliableStreams: true, datagrams: false, maxDatagramBytes: 0 },
    sendReliable(_channel, payload) {
      frames.push(payload.slice());
      return Promise.resolve("sent");
    },
    trySendDatagram: async () => "closed",
    close() {},
  });
  for (let tick = 0; tick < 3; tick += 1) {
    nowMilliseconds = tick * TICK_MILLISECONDS;
    server.step();
  }
  await settleEventLoop();
  const acknowledgement = createInputCommand(server.world.matchId, 1);
  acknowledgement.tick = server.world.tick + 1;
  acknowledgement.latestSnapshotTick = server.world.tick;
  acknowledgement.snapshotAckBits = 1;
  const input = new Uint8Array(INPUT_PACKET_BYTES);
  writeInputPacket(input, 0, acknowledgement);
  session.onDatagram(input);
  await settleEventLoop();

  const source = new Uint8Array(SNAPSHOT_BYTES);
  for (let tick = 6; tick <= 36; tick += 3) {
    nowMilliseconds = tick * TICK_MILLISECONDS;
    session.beginTick();
    session.sendSnapshot(source, tick);
    await settleEventLoop();
  }
  assert.equal(frames.length, 12, "an ACK lag below the 64-frame ring bound must not impose an eight-frame throttle");
  server.close();
});

test("acknowledged snapshot streams are reset before leaving the bounded window", async () => {
  const server = new MatchServer({ rosterSize: 2 });
  const client = new BattleClient({ name: "snapshot-ack-reset" });
  const session = server.createSession();
  const [clientTransport, serverTransport] = createInMemoryTransportPair(client, session);
  const sendReliable = serverTransport.sendReliable.bind(serverTransport);
  const snapshotSignals = [];
  serverTransport.sendReliable = (channel, payload, signal) => {
    if (channel !== TRANSPORT_CHANNEL_SNAPSHOT) return sendReliable(channel, payload, signal);
    snapshotSignals.push(signal);
    return new Promise((resolve) => {
      signal.addEventListener("abort", () => resolve("backpressured"), { once: true });
    });
  };
  session.attach(serverTransport);
  client.attach(clientTransport);
  await settle();
  for (let tick = 0; tick < 3; tick += 1) server.step();
  assert.equal(snapshotSignals.length, 1);
  assert.equal(snapshotSignals[0].aborted, false);

  const acknowledged = new Uint8Array(INPUT_PACKET_BYTES);
  const input = createInputCommand(server.world.matchId, client.playerId);
  input.tick = server.world.tick + 1;
  input.latestSnapshotTick = server.world.tick;
  input.snapshotAckBits = 1;
  writeInputPacket(acknowledged, 0, input);
  session.onDatagram(acknowledged);
  assert.equal(snapshotSignals[0].aborted, true, "ACKed state no longer consumes QUIC stream credit");
  server.close();
});

test("the authoritative baseline ring covers 3.2 seconds of 20 Hz snapshots", () => {
  const server = new MatchServer({ rosterSize: 2, snapshotIntervalTicks: 1 });
  for (let tick = 0; tick < SNAPSHOT_BASE_HISTORY_FRAMES; tick += 1) server.step();
  assert.ok(server.snapshotAt(1));
  server.step();
  assert.equal(server.snapshotAt(1), undefined);
  server.close();
});

test("a rejected independent snapshot does not block fresher state", async () => {
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
  assert.equal(frames.length, 3, "each current state gets one independent send attempt");
  assert.equal(frames[2][8], SNAPSHOT_KEYFRAME, "unacknowledged streams never become delta bases");
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
  serverTransport.sendReliable = (channel, payload, signal) =>
    channel === TRANSPORT_CHANNEL_SNAPSHOT ? Promise.resolve("closed") : sendReliable(channel, payload, signal);
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
        `arena is not point-symmetric at ${cellX},${cellY}`,
      );
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

test("arena routing finds deterministic visible waypoints around blocked direct paths", () => {
  const map = new ArenaMap(DEFAULT_ARENA_SEED);
  const scratch = createArenaRouteScratch();
  const waypoint = { x: 0, y: 0 };
  let blockedRoute;
  for (let spawn = 0; spawn < map.spawnX.length && blockedRoute === undefined; spawn += 1) {
    for (let pickup = 0; pickup < map.pickupX.length; pickup += 1) {
      const startX = map.spawnX[spawn];
      const startY = map.spawnY[spawn];
      const goalX = map.pickupX[pickup];
      const goalY = map.pickupY[pickup];
      const cost = map.routeWaypoint(startX, startY, goalX, goalY, spawn, scratch, waypoint);
      assert.ok(cost >= 0, `spawn ${spawn} must reach pickup ${pickup}`);
      assert.equal(map.solidAtWorld(waypoint.x, waypoint.y), false);
      assert.equal(map.lineOfSight(startX, startY, waypoint.x, waypoint.y), true);
      if (!map.lineOfSight(startX, startY, goalX, goalY)) {
        blockedRoute = { startX, startY, goalX, goalY, bias: spawn, cost, x: waypoint.x, y: waypoint.y };
        break;
      }
    }
  }
  assert.ok(blockedRoute, "the authored arena must exercise a route around cover");
  assert.ok(blockedRoute.cost > 0);
  assert.notDeepEqual(
    { x: blockedRoute.x, y: blockedRoute.y },
    { x: blockedRoute.goalX, y: blockedRoute.goalY },
    "a blocked direct path must produce an intermediate route waypoint",
  );

  const repeated = { x: 0, y: 0 };
  const repeatedCost = map.routeWaypoint(
    blockedRoute.startX,
    blockedRoute.startY,
    blockedRoute.goalX,
    blockedRoute.goalY,
    blockedRoute.bias,
    scratch,
    repeated,
  );
  assert.equal(repeatedCost, blockedRoute.cost);
  assert.deepEqual(repeated, { x: blockedRoute.x, y: blockedRoute.y });
});

test("the arena visual projector owns an explicit and exhaustive four-neighbour wall grammar", () => {
  assert.deepEqual(ARENA_WALL_MASK_BITS, { north: 1, south: 2, east: 4, west: 8 });
  assert.deepEqual(
    [...ARENA_WALL_MASK_TO_FRAME],
    [
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
    ],
  );
  for (let expected = 0; expected < 16; expected += 1) {
    const map = {
      cellAt(cellX, cellY) {
        if (cellX === 1 && cellY === 2) return (expected & ARENA_WALL_MASK_BITS.north) === 0 ? CELL_FLOOR : CELL_WALL;
        if (cellX === 1 && cellY === 0) return (expected & ARENA_WALL_MASK_BITS.south) === 0 ? CELL_FLOOR : CELL_WALL;
        if (cellX === 2 && cellY === 1) return (expected & ARENA_WALL_MASK_BITS.east) === 0 ? CELL_FLOOR : CELL_WALL;
        if (cellX === 0 && cellY === 1) return (expected & ARENA_WALL_MASK_BITS.west) === 0 ? CELL_FLOOR : CELL_WALL;
        return CELL_FLOOR;
      },
    };
    assert.equal(arenaWallMask(map, 1, 1), expected, `wall mask ${expected} must round-trip`);
    assert.ok(ARENA_WALL_MASK_TO_FRAME[expected].length > 0);
  }
});

test("one allocation-free semantic projection drives every arena theme", () => {
  const map = new ArenaMap(DEFAULT_ARENA_SEED);
  const ground = new Uint8Array(ARENA_VISUAL_CELL_COUNT);
  const decor = new Uint8Array(ARENA_VISUAL_CELL_COUNT);
  const marks = new Uint8Array(ARENA_VISUAL_CELL_COUNT);
  projectArenaVisualRoles(map, DEFAULT_ARENA_SEED, ground, decor, marks);
  assert.ok(ground.some((role) => role < 4));
  assert.ok(ground.some((role) => role >= ARENA_GROUND_ROLE_WALL_BASE && role < ARENA_GROUND_ROLE_WALL_BASE + 16));
  assert.ok(decor.some((role) => role > 0 && role < ARENA_DECOR_ROLE_COUNT));
  assert.ok(marks.some((role) => role > 0 && role < ARENA_MARK_ROLE_COUNT));
  assert.equal(arenaThemeIndex(DEFAULT_ARENA_SEED, DEFAULT_ARENA_SEED, 3), 0);
  assert.equal(arenaThemeIndex(DEFAULT_ARENA_SEED ^ 1, DEFAULT_ARENA_SEED, 3), 1);
  assert.equal(arenaThemeIndex(DEFAULT_ARENA_SEED ^ 2, DEFAULT_ARENA_SEED, 3), 2);
  assert.throws(
    () => projectArenaVisualRoles(map, DEFAULT_ARENA_SEED ^ 1, ground, decor, marks),
    /visual seed does not match/,
  );
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

test("rotating hazard vents are deterministic, open, and authoritative", () => {
  const first = new ArenaMap(0x57_41_52_42);
  const second = new ArenaMap(0x57_41_52_42);
  assert.deepEqual([...first.hazardX], [...second.hazardX]);
  assert.deepEqual([...first.hazardY], [...second.hazardY]);
  assert.equal(first.hazardX[0], first.hazardX[1] * -1);
  assert.equal(first.hazardY[0], first.hazardY[2] * -1);
  for (let index = 0; index < MAX_HAZARDS; index += 1) {
    assert.equal(first.solidAtWorld(first.hazardX[index], first.hazardY[index]), false);
  }

  const world = new BattleWorld(77, 0x57_41_52_42);
  world.addPlayer(1, 0, world.map.hazardX[0], world.map.hazardY[0]);
  world.playerSpawnProtectTicks[0] = 0;
  world.playerArmor[0] = 0;
  const hazard = { index: 0, active: false, x: 0, y: 0, remainingTicks: 0 };
  world.readHazard(0, hazard);
  assert.equal(hazard.active, true);
  assert.equal(hazard.remainingTicks, HAZARD_ACTIVE_TICKS);
  for (let tick = 1; tick <= HAZARD_CYCLE_TICKS / 20; tick += 1) world.step();
  assert.equal(world.playerHealth[0], 100 - 8, "a live vent pulse must damage a tank authoritatively");
  let sawHazardEvent = false;
  const event = createBattleEvent();
  for (let sequence = world.events.oldest(); sequence < world.events.sequence; sequence += 1) {
    if (world.events.read(sequence, event) && event.kind === EVENT_HAZARD_DAMAGE) sawHazardEvent = true;
  }
  assert.equal(sawHazardEvent, true, "hazard damage must reach the presentation ring");
  assert.equal(world.activeHazardIndex(), 0);
  for (let tick = world.tick + 1; tick <= HAZARD_CYCLE_TICKS; tick += 1) world.step();
  assert.equal(world.activeHazardIndex(), 1, "the next vent must take over at the cycle boundary");
  assert.ok(HAZARD_RADIUS > 0);

  const lethal = new BattleWorld(78, 0x57_41_52_42);
  lethal.addPlayer(1, 0, lethal.map.hazardX[0], lethal.map.hazardY[0]);
  lethal.playerSpawnProtectTicks[0] = 0;
  lethal.playerArmor[0] = 0;
  lethal.playerHealth[0] = 8;
  for (let tick = 1; tick <= HAZARD_PULSE_TICKS * 4; tick += 1) lethal.step();
  let sawKill = false;
  let killTick = -1;
  const hazardHitTicks = new Set();
  for (let sequence = lethal.events.oldest(); sequence < lethal.events.sequence; sequence += 1) {
    if (!lethal.events.read(sequence, event)) continue;
    if (event.kind === EVENT_KILL) {
      sawKill = true;
      killTick = event.tick;
    }
    if (event.kind === EVENT_HAZARD_DAMAGE) hazardHitTicks.add(event.tick);
  }
  assert.equal(sawKill, true, "the vent must eject the pilot and then emit a terminal kill event");
  assert.equal(
    hazardHitTicks.has(killTick),
    false,
    "the terminal pulse must not overwrite its kill presentation with a hit event",
  );
});

test("destructible cover is fixed-capacity, authoritative, and snapshot-safe", () => {
  const world = new BattleWorld(77, 0x57_41_52_42);
  const panel = 0;
  assert.equal(world.map.coverHealth.length, MAX_COVER_PANELS);
  assert.ok(world.map.coverPanelCount > 0 && world.map.coverPanelCount <= MAX_COVER_PANELS);
  assert.equal(world.map.coverPanelCount % 2, 0, "bounded cover must be selected in symmetric pairs");
  for (let index = 0; index < world.map.coverPanelCount; index += 1) {
    const mirrorX = -world.map.coverX[index];
    const mirrorY = -world.map.coverY[index];
    assert.ok(
      world.map.coverPanelAtWorld(mirrorX, mirrorY) >= 0,
      "every destructible panel must include its point mirror",
    );
  }
  assert.equal(world.map.coverHealth[panel], COVER_MAX_HEALTH);
  const x = world.map.coverX[panel];
  const y = world.map.coverY[panel];
  assert.ok(world.map.solidAtWorld(x, y), "an intact panel must remain collision-solid");
  // Drive a real authoritative projectile into the panel from its open west
  // neighbour; the event and health mutation must come from stepProjectiles.
  world.projectileActive[0] = 1;
  world.projectileX[0] = x - TILE_UNITS;
  world.projectileY[0] = y;
  world.projectileDirectionX[0] = 256;
  world.projectileDirectionY[0] = 0;
  world.projectileWeapon[0] = WEAPON_CANNON;
  world.projectileSpeed[0] = 232;
  world.projectileLife[0] = 8;
  world.projectileDamage[0] = 25;
  world.projectileBounces[0] = 0;
  world.step();
  assert.equal(world.map.coverHealth[panel], 75, "projectile damage must be authoritative");
  const coverEvent = createBattleEvent();
  let sawCoverEvent = false;
  for (let sequence = world.events.oldest(); sequence < world.events.sequence; sequence += 1) {
    if (world.events.read(sequence, coverEvent) && coverEvent.kind === EVENT_COVER_CHANGED) sawCoverEvent = true;
  }
  assert.equal(sawCoverEvent, true, "cover damage must reach the bounded event ring");
  assert.equal(world.map.damageCoverAtWorld(x, y, 74), 1);
  assert.ok(world.map.solidAtWorld(x, y), "partial damage must preserve cover collision");
  assert.equal(world.map.damageCoverAtWorld(x, y, 1), 0);
  assert.equal(world.map.solidAtWorld(x, y), false, "destroyed cover must open collision and sightlines");

  const snapshot = new Uint8Array(SNAPSHOT_BYTES);
  world.writeSnapshot(snapshot);
  const restored = new BattleWorld(77, 0x57_41_52_42);
  restored.restoreSnapshot(snapshot);
  assert.equal(restored.map.coverHealth[panel], 0);
  assert.equal(restored.map.solidAtWorld(x, y), false);
  assert.equal(restored.stateHash(), world.stateHash(), "cover health belongs to authoritative rollback state");

  const event = createBattleEvent();
  const before = world.events.sequence;
  world.events.push(EVENT_COVER_CHANGED, panel, 0, x, y, world.tick);
  assert.equal(world.events.read(before, event), true);
  assert.equal(event.kind, EVENT_COVER_CHANGED);
  assert.equal(event.a, panel);
  assert.equal(event.b, 0);
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
    const make = (playerId) =>
      command(playerId, tick, {
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

test("armour absorbs damage, tank destruction ejects the pilot, and the terminal kill scores", () => {
  const world = new BattleWorld(77);
  world.addPlayer(1, 1, -2_000, 0);
  world.addPlayer(2, 2, 400, 0);
  world.playerArmor[1] = 60;
  world.grantCredits(1, 1_000);
  assert.equal(world.applyUpgrade(1, UPGRADE_DAMAGE), true);

  const shooter = playerView();
  const target = playerView();
  let ejected = false;
  let killed = false;
  for (let tick = 1; tick <= 1_800 && !killed; tick += 1) {
    world.submitInput(command(1, tick, { buttons: INPUT_BUTTON_FIRE, aimX: 127, aimY: 0 }));
    world.step();
    world.readPlayer(2, target);
    ejected ||= target.mode === PLAYER_MODE_INFANTRY;
    killed = target.mode === PLAYER_MODE_DEAD;
  }
  assert.equal(ejected, true, "destroying the tank must give its pilot a last chance on foot");
  assert.equal(killed, true, "the shooter should land a kill");
  world.readPlayer(1, shooter);
  assert.equal(shooter.score, 1);
  assert.equal(shooter.credits, 1_000 - 100 + 100);
  assert.equal(target.deaths, 1);

  const event = createBattleEvent();
  let sawEject = false;
  let sawKill = false;
  for (let sequence = world.events.oldest(); sequence < world.events.sequence; sequence += 1) {
    if (!world.events.read(sequence, event)) continue;
    if (event.kind === EVENT_EJECT) sawEject = true;
    if (event.kind === EVENT_KILL) sawKill = true;
  }
  assert.equal(sawEject, true, "tank destruction must reach the presentation event ring");
  assert.equal(sawKill, true, "a kill must reach the presentation event ring");

  run(world, 200);
  world.readPlayer(2, target);
  assert.equal(target.alive, true, "a wreck must come back");
  assert.ok(target.spawnProtectTicks >= 0);
});

test("an on-foot pilot acquires a replacement tank at a depot and snapshots preserve the mode", () => {
  const world = new BattleWorld(77);
  world.addPlayer(1);
  const slot = 0;
  const depot = world.nearestTankDepot(1);
  world.playerMode[slot] = PLAYER_MODE_INFANTRY;
  world.playerHealth[slot] = 24;
  world.playerArmor[slot] = 0;
  world.playerRespawnTicks[slot] = 0;
  world.playerX[slot] = world.map.spawnX[depot];
  world.playerY[slot] = world.map.spawnY[depot];

  const snapshot = new Uint8Array(SNAPSHOT_BYTES);
  world.writeSnapshot(snapshot);
  world.playerMode[slot] = PLAYER_MODE_TANK;
  world.restoreSnapshot(snapshot);
  assert.equal(world.playerMode[slot], PLAYER_MODE_INFANTRY);

  world.step();
  assert.equal(world.playerMode[slot], PLAYER_MODE_TANK);
  assert.equal(world.playerHealth[slot], 100);
  const event = createBattleEvent();
  let acquired = false;
  for (let sequence = world.events.oldest(); sequence < world.events.sequence; sequence += 1) {
    if (world.events.read(sequence, event) && event.kind === EVENT_TANK_ACQUIRED) acquired = true;
  }
  assert.equal(acquired, true);
});

test("a moving hostile tank can run over an on-foot pilot", () => {
  const world = new BattleWorld(77);
  world.addPlayer(1, 1);
  world.addPlayer(2, 2);
  const centre = { x: 0, y: 0 };
  world.map.nearestOpen(0, 0, centre);
  const centreCellX = cellOfX(centre.x);
  const centreCellY = cellOfY(centre.y);
  for (let y = -2; y <= 2; y += 1) {
    for (let x = -2; x <= 2; x += 1) world.map.cells[world.map.index(centreCellX + x, centreCellY + y)] = CELL_FLOOR;
  }
  world.playerMode[1] = PLAYER_MODE_INFANTRY;
  world.playerHealth[1] = 24;
  world.playerArmor[1] = 0;
  world.playerRespawnTicks[1] = 10;
  world.playerX[0] = centre.x;
  world.playerY[0] = centre.y;
  world.playerX[1] = centre.x;
  world.playerY[1] = centre.y;
  world.playerVelocityX[0] = 5 * 256;
  world.step();
  assert.equal(world.playerMode[1], PLAYER_MODE_DEAD);
  assert.equal(world.playerScore[0], 1);
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
  run(world, 14, (tick) =>
    world.submitInput(
      command(1, tick + 40, {
        buttons: tick === 1 ? INPUT_BUTTON_FIRE : 0,
        aimX: 127,
        aimY: 0,
      }),
    ),
  );
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
    if (world.pickupKind[index] === WEAPON_AUTOCANNON) {
      pad = index;
      break;
    }
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
    if (world.pickupKind[index] === PICKUP_HEALTH) {
      pad = index;
      break;
    }
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
    world.submitInput(
      command(1, tick, {
        moveX: tick < 20 ? 1 : 0,
        buttons: tick % 7 === 1 ? INPUT_BUTTON_FIRE : 0,
      }),
    );
    world.submitInput(command(2, tick, { moveX: tick < 20 ? -1 : 0, aimX: -127 }));
  };
  run(world, 30, stage);
  const snapshot = new Uint8Array(SNAPSHOT_BYTES);
  assert.equal(world.writeSnapshot(snapshot), SNAPSHOT_BYTES);
  for (let tick = 31; tick <= 80; tick += 1) {
    stage(tick);
    world.step();
  }
  const expectedHash = world.stateHash();
  world.restoreSnapshot(snapshot);
  // Snapshots contain authoritative simulation state, not the external replay log.
  // Re-submit the recorded inputs that followed the rollback point.
  for (let tick = 31; tick <= 80; tick += 1) {
    stage(tick);
    world.step();
  }
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
      world.submitInput(
        command(playerId, tick, {
          moveX: playerId % 2 === 0 ? 1 : -1,
          buttons: tick % 20 === playerId % 20 ? INPUT_BUTTON_FIRE : 0,
        }),
      );
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
  assert.notEqual(
    world.playerChassisUnlocks[0] & chassisUnlockBit(CHASSIS_BULWARK),
    0,
    "rollback must restore unlocks",
  );
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
  assert.ok(
    Math.abs(scout.playerVelocityX[0]) > Math.abs(bulwark.playerVelocityX[0]),
    "the scout accelerates faster under identical input",
  );
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
    bots.decideAt[0] = 0;
    const staged = createInputCommand(77, 1);
    bots.stage(world, staged, 1, 1);
    return staged.buttons;
  };

  assert.notEqual(stageAtCloseRange(false) & INPUT_BUTTON_FIRE, 0, "base cannon may fire at one-cell range");
  assert.equal(stageAtCloseRange(true) & INPUT_BUTTON_FIRE, 0, "blast branch respects its larger self-damage radius");
});

// --- bots -------------------------------------------------------------------

test("network bots adapt the shared bot brain through ordinary client controls", () => {
  const world = new BattleWorld(71, 0xace0);
  world.addPlayer(1);
  world.addPlayer(2);
  world.playerX[0] = 10 * TILE_UNITS;
  world.playerY[0] = 10 * TILE_UNITS;
  world.playerX[1] = 16 * TILE_UNITS;
  world.playerY[1] = 10 * TILE_UNITS;
  world.setBotSkill(1, 2);

  const expected = createInputCommand(world.matchId, 1);
  new BotController().stage(world, expected, 1, world.tick + 1);
  let controls;
  let aim;
  const chassisRequests = [];
  const weaponUpgradeRequests = [];
  const client = {
    state: "ready",
    world,
    playerId: 1,
    setControls(value) {
      controls = { ...value };
    },
    setAim(x, y) {
      aim = { x, y };
    },
    sendChassis(chassisId) {
      chassisRequests.push(chassisId);
    },
    sendWeaponUpgrade(upgradeId) {
      weaponUpgradeRequests.push(upgradeId);
    },
    update(elapsed, maximumSteps) {
      assert.equal(elapsed, 17);
      assert.equal(maximumSteps, 4);
      return 3;
    },
  };
  const driver = new NetworkBotDriver(client, { skill: 2 });

  assert.equal(driver.update(17, 4), 3);
  assert.deepEqual(controls, {
    moveX: expected.moveX,
    moveY: expected.moveY,
    fire: (expected.buttons & INPUT_BUTTON_FIRE) !== 0,
    boost: (expected.buttons & INPUT_BUTTON_BOOST) !== 0,
    weapon: expected.weaponRequest,
  });
  assert.deepEqual(aim, { x: expected.aimX, y: expected.aimY });
  assert.equal(driver.stats.commandsStaged, 1);
  assert.equal(driver.stats.nonIdleCommands, 1);
  assert.deepEqual(chassisRequests, []);
  assert.deepEqual(weaponUpgradeRequests, []);
});

test("network bots send predicted weapon purchases over the authoritative control lane", () => {
  const world = new BattleWorld(72, 0xace1);
  world.addPlayer(1);
  world.addPlayer(2);
  world.grantCredits(1, 1_000);
  const weaponUpgradeRequests = [];
  const client = {
    state: "ready",
    world,
    playerId: 1,
    setControls() {},
    setAim() {},
    sendChassis() {},
    sendWeaponUpgrade(upgradeId) {
      weaponUpgradeRequests.push(upgradeId);
    },
    update() {
      return 1;
    },
  };
  const driver = new NetworkBotDriver(client, { skill: 2 });

  assert.equal(driver.update(17, 4), 1);
  assert.equal(weaponUpgradeRequests.length, 1);
  assert.ok(weaponUpgradeRequests[0] > 0);
  assert.equal(driver.stats.weaponUpgradeRequests, 1);
});

test("network bot snapshot clocks keep driving when dashboard timers are throttled", () => {
  const world = new BattleWorld(73, 0xace2);
  world.addPlayer(1);
  const updates = [];
  const client = {
    playerId: 1,
    world,
    stats: { snapshotsApplied: 0 },
    update(elapsed, maximumSteps) {
      assert.equal(elapsed, 0);
      assert.equal(maximumSteps, undefined);
      this.stats.snapshotsApplied += 1;
      this.world.playerX[0] += 32;
      return 0;
    },
  };
  const driver = {
    update(elapsed, maximumSteps) {
      updates.push([elapsed, maximumSteps]);
      return 1;
    },
  };
  const clock = new NetworkBotClock(client, driver, 1_000);

  // There is no foreground interval between these calls: incoming snapshots
  // alone wake the bot and preserve the bounded catch-up policy.
  assert.equal(clock.onSnapshot(1_050), 1);
  assert.equal(clock.onSnapshot(1_100), 1);
  assert.deepEqual(updates, [
    [50, 8],
    [50, 8],
  ]);
  assert.equal(clock.observedTravelUnits, 32);

  // A long suspended interval remains bounded instead of causing a packet
  // storm when the browser delivers the next network event.
  assert.equal(clock.onSnapshot(2_000), 1);
  assert.deepEqual(updates.at(-1), [250, 8]);
});

test("client gates control until WELCOME_ACK and preserves ordered control writes", async () => {
  const calls = [];
  const transport = {
    capabilities: {
      protocol: "webtransport-h3",
      reliableStreams: true,
      datagrams: true,
      maxDatagramBytes: 1_200,
    },
    sendReliable(channel, payload) {
      let resolve;
      const completed = new Promise((done) => {
        resolve = done;
      });
      calls.push({ channel, payload: payload.slice(), resolve });
      return completed;
    },
    async trySendDatagram() {
      return "sent";
    },
    close() {},
  };
  const client = new BattleClient();
  client.attach(transport);
  await new Promise((done) => setImmediate(done));
  assert.equal(calls.length, 1, "hello starts first");
  calls[0].resolve("sent");
  await new Promise((done) => setImmediate(done));

  client.sendChassis(CHASSIS_BULWARK);
  assert.equal(calls.length, 1, "control before welcome is not admitted to the ordered stream");
  const welcome = new Uint8Array(WELCOME_BYTES);
  writeWelcome(welcome, {
    matchId: 77,
    playerId: 1,
    team: 1,
    maximumPlayers: 8,
    botCount: 7,
    mapSeed: DEFAULT_ARENA_SEED,
    serverTick: 0,
    tickRate: 60,
    snapshotIntervalTicks: 3,
    resumeToken: new Uint8Array(RESUME_TOKEN_BYTES).fill(7),
  });
  client.onReliable(TRANSPORT_CHANNEL_SESSION, welcome);
  await new Promise((done) => setImmediate(done));
  assert.equal(calls.length, 2, "welcome acknowledgement is the first post-hello frame");
  assert.equal(calls[1].channel, TRANSPORT_CHANNEL_SESSION);
  assert.equal(client.state, "connecting", "welcome is not admission until its acknowledgement enters the stream");
  client.sendChassis(CHASSIS_BULWARK);
  assert.equal(calls.length, 2, "control remains gated while the welcome acknowledgement is pending");
  calls[1].resolve("sent");
  await new Promise((done) => setImmediate(done));
  assert.equal(client.state, "ready");

  client.sendChassis(CHASSIS_BULWARK);
  client.sendWeaponUpgrade(WEAPON_UPGRADE_CANNON_BLAST);
  await new Promise((done) => setImmediate(done));
  assert.equal(calls.length, 3, "the second control waits for the first stream to finish");
  assert.deepEqual([...calls[2].payload.subarray(4, 6)], [CONTROL_SET_CHASSIS, CHASSIS_BULWARK]);

  calls[2].resolve("sent");
  await new Promise((done) => setImmediate(done));
  assert.equal(calls.length, 4);
  assert.deepEqual([...calls[3].payload.subarray(4, 6)], [CONTROL_SET_WEAPON_UPGRADE, WEAPON_UPGRADE_CANNON_BLAST]);
  calls[3].resolve("sent");
});

test("a reconnect is not blocked by the previous transport's pending acknowledgement", async () => {
  const makeTransport = () => {
    const calls = [];
    return {
      calls,
      capabilities: {
        protocol: "webtransport-h3",
        reliableStreams: true,
        datagrams: true,
        maxDatagramBytes: 1_200,
      },
      sendReliable(channel, payload) {
        let resolve;
        const completed = new Promise((done) => {
          resolve = done;
        });
        calls.push({ channel, payload: payload.slice(), resolve });
        return completed;
      },
      async trySendDatagram() {
        return "sent";
      },
      close() {},
    };
  };
  const welcome = new Uint8Array(WELCOME_BYTES);
  writeWelcome(welcome, {
    matchId: 77,
    playerId: 1,
    team: 1,
    maximumPlayers: 8,
    botCount: 7,
    mapSeed: DEFAULT_ARENA_SEED,
    serverTick: 0,
    tickRate: 60,
    snapshotIntervalTicks: 3,
    resumeToken: new Uint8Array(RESUME_TOKEN_BYTES).fill(7),
  });
  const client = new BattleClient();
  const first = makeTransport();
  client.attach(first);
  await new Promise((done) => setImmediate(done));
  first.calls[0].resolve("sent");
  await new Promise((done) => setImmediate(done));
  client.onReliable(TRANSPORT_CHANNEL_SESSION, welcome);
  await new Promise((done) => setImmediate(done));
  assert.equal(first.calls.length, 2);

  const second = makeTransport();
  client.attach(second);
  await new Promise((done) => setImmediate(done));
  assert.equal(second.calls.length, 1, "the new HELLO does not wait on the old transport's ACK");
  second.calls[0].resolve("sent");
  await new Promise((done) => setImmediate(done));
  client.onReliable(TRANSPORT_CHANNEL_SESSION, welcome);
  await new Promise((done) => setImmediate(done));
  assert.equal(second.calls.length, 2);
  second.calls[1].resolve("sent");
  await new Promise((done) => setImmediate(done));
  assert.equal(client.state, "ready");

  first.calls[1].resolve("sent");
  await new Promise((done) => setImmediate(done));
  assert.equal(client.state, "ready", "the stale ACK completion cannot mutate the replacement connection");
});

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
  assert.equal(
    first.world.playerActive.reduce((sum, value) => sum + value, 0),
    8,
  );
});

// --- server and client ------------------------------------------------------

test("authoritative stats expose the initial bot roster before first admission", () => {
  const server = new MatchServer({ rosterSize: 8 });
  assert.deepEqual({ humans: server.stats.humans, bots: server.stats.bots }, { humans: 0, bots: 8 });
  server.close();
});

test("server preserves HELLO, acknowledgement, and control order across async admission", async () => {
  const token = new Uint8Array(RESUME_TOKEN_BYTES).fill(0x5a);
  let releaseIssue;
  const resumeTokenService = {
    issue() {
      return new Promise((resolve) => {
        releaseIssue = () => resolve(token.slice());
      });
    },
    async verify() {
      return null;
    },
  };
  const errors = [];
  const closes = [];
  const server = new MatchServer({
    rosterSize: 2,
    resumeTokenService,
    onError: (error) => errors.push(error),
  });
  const session = server.createSession();
  session.attach({
    capabilities: { protocol: "webtransport-h3", reliableStreams: true, datagrams: true, maxDatagramBytes: 1_200 },
    async sendReliable() {
      return "sent";
    },
    async trySendDatagram() {
      return "sent";
    },
    close(code, reason) {
      closes.push([code, reason]);
      session.onClose(code, reason);
    },
  });

  const hello = new Uint8Array(HELLO_BYTES);
  writeHello(hello, {
    clientSalt: 7,
    name: "ordered",
    resumeToken: new Uint8Array(RESUME_TOKEN_BYTES),
    preferredTeam: 0,
  });
  const acknowledgement = new Uint8Array(WELCOME_ACK_BYTES);
  writeWelcomeAck(acknowledgement, { resumeToken: token });
  const control = new Uint8Array(CONTROL_BYTES);
  writeControl(control, { action: CONTROL_SUICIDE, argument: 0 });

  // These are the exact callback timings of coalesced frames on one ordered
  // QUIC stream: decoding is synchronous while credential issuance is not.
  session.onReliable(TRANSPORT_CHANNEL_SESSION, hello);
  session.onReliable(TRANSPORT_CHANNEL_SESSION, acknowledgement);
  session.onReliable(TRANSPORT_CHANNEL_CONTROL, control);
  await settleUntil(() => typeof releaseIssue === "function", "credential issue boundary");
  assert.equal(session.ready, false);
  assert.equal(errors.length, 0);
  assert.equal(closes.length, 0);

  releaseIssue();
  await settleUntil(() => session.ready, "ordered async admission");
  await settle();
  assert.equal(server.world.playerHealth[session.slot], 0, "control executes only after the queued acknowledgement");
  assert.equal(errors.length, 0);
  assert.equal(closes.length, 0);
  server.close();
});

test("server retains the latest input datagram that overtakes WELCOME_ACK", async () => {
  const errors = [];
  const reliable = [];
  const server = new MatchServer({
    rosterSize: 2,
    inputBudgetPerTick: 4,
    onError: (error) => errors.push(error),
  });
  const session = server.createSession();
  session.attach({
    capabilities: { protocol: "webtransport-h3", reliableStreams: true, datagrams: true, maxDatagramBytes: 1_200 },
    async sendReliable(channel, payload) {
      reliable.push({ channel, payload: payload.slice() });
      return "sent";
    },
    async trySendDatagram() {
      return "sent";
    },
    close(code, reason) {
      session.onClose(code, reason);
    },
  });

  const hello = new Uint8Array(HELLO_BYTES);
  writeHello(hello, {
    clientSalt: 17,
    name: "cross-lane",
    resumeToken: new Uint8Array(RESUME_TOKEN_BYTES),
    preferredTeam: 0,
  });
  session.onReliable(TRANSPORT_CHANNEL_SESSION, hello);
  await settleUntil(
    () => reliable.some(({ payload }) => payload.byteLength === WELCOME_BYTES),
    "welcome before cross-lane input",
  );
  const welcomeFrame = reliable.find(({ payload }) => payload.byteLength === WELCOME_BYTES).payload;
  const welcome = {
    matchId: 0,
    playerId: 0,
    team: 0,
    maximumPlayers: 0,
    botCount: 0,
    mapSeed: 0,
    serverTick: 0,
    tickRate: 0,
    snapshotIntervalTicks: 0,
    resumeToken: new Uint8Array(RESUME_TOKEN_BYTES),
  };
  readWelcome(welcomeFrame, welcome);

  const first = createInputCommand(welcome.matchId, welcome.playerId);
  first.tick = 1;
  first.sequence = 1;
  first.moveX = -127;
  const firstPacket = new Uint8Array(INPUT_PACKET_BYTES);
  writeInputPacket(firstPacket, 0, first);
  session.onDatagram(firstPacket);

  const latest = createInputCommand(welcome.matchId, welcome.playerId);
  latest.tick = 1;
  latest.sequence = 2;
  latest.moveX = 127;
  const latestPacket = new Uint8Array(INPUT_PACKET_BYTES);
  writeInputPacket(latestPacket, 0, latest);
  session.onDatagram(latestPacket);
  assert.equal(server.stats.inputsAccepted, 0, "pre-ACK input cannot execute before admission");

  const acknowledgement = new Uint8Array(WELCOME_ACK_BYTES);
  writeWelcomeAck(acknowledgement, { resumeToken: welcome.resumeToken });
  session.onReliable(TRANSPORT_CHANNEL_SESSION, acknowledgement);
  await settleUntil(() => session.ready, "cross-lane acknowledgement");
  const initialX = server.world.playerX[welcome.playerId - 1];
  server.step();

  assert.equal(server.stats.inputsAccepted, 1, "exactly the latest bounded pre-ACK bundle is admitted");
  assert.equal(server.world.playerLastInputTick[welcome.playerId - 1], 1);
  assert.ok(
    server.world.playerX[welcome.playerId - 1] > initialX,
    "the latest input replaces the older buffered datagram",
  );
  assert.deepEqual(errors, []);
  server.close();
});

test("server fail-closes control before HELLO or before WELCOME_ACK", async () => {
  const control = new Uint8Array(CONTROL_BYTES);
  writeControl(control, { action: CONTROL_SUICIDE, argument: 0 });

  for (const afterHello of [false, true]) {
    const errors = [];
    const closes = [];
    const token = new Uint8Array(RESUME_TOKEN_BYTES).fill(0x31);
    const server = new MatchServer({
      rosterSize: 2,
      resumeTokenService: {
        async issue() {
          return token.slice();
        },
        async verify() {
          return null;
        },
      },
      onError: (error) => errors.push(error),
    });
    const session = server.createSession();
    session.attach({
      capabilities: { protocol: "webtransport-h3", reliableStreams: true, datagrams: true, maxDatagramBytes: 1_200 },
      async sendReliable() {
        return "sent";
      },
      async trySendDatagram() {
        return "sent";
      },
      close(code, reason) {
        closes.push([code, reason]);
        session.onClose(code, reason);
      },
    });
    if (afterHello) {
      const hello = new Uint8Array(HELLO_BYTES);
      writeHello(hello, {
        clientSalt: 9,
        name: "not-yet-admitted",
        resumeToken: new Uint8Array(RESUME_TOKEN_BYTES),
        preferredTeam: 0,
      });
      session.onReliable(TRANSPORT_CHANNEL_SESSION, hello);
    }
    session.onReliable(TRANSPORT_CHANNEL_CONTROL, control.slice());
    await settleUntil(() => session.closed, afterHello ? "pre-ack rejection" : "pre-hello rejection");
    assert.deepEqual(closes, [[4_003, "protocol error"]]);
    assert.match(String(errors[0]), afterHello ? /before welcome acknowledgement/u : /before hello/u);
    server.close();
  }
});

test("server reliable admission queue fails closed at its fixed capacity", async () => {
  const token = new Uint8Array(RESUME_TOKEN_BYTES).fill(0x42);
  let releaseIssue;
  const errors = [];
  const closes = [];
  const server = new MatchServer({
    rosterSize: 2,
    resumeTokenService: {
      issue() {
        return new Promise((resolve) => {
          releaseIssue = () => resolve(token.slice());
        });
      },
      async verify() {
        return null;
      },
    },
    onError: (error) => errors.push(error),
  });
  const session = server.createSession();
  session.attach({
    capabilities: { protocol: "webtransport-h3", reliableStreams: true, datagrams: true, maxDatagramBytes: 1_200 },
    async sendReliable() {
      return "sent";
    },
    async trySendDatagram() {
      return "sent";
    },
    close(code, reason) {
      closes.push([code, reason]);
      session.onClose(code, reason);
    },
  });
  const hello = new Uint8Array(HELLO_BYTES);
  writeHello(hello, {
    clientSalt: 11,
    name: "bounded",
    resumeToken: new Uint8Array(RESUME_TOKEN_BYTES),
    preferredTeam: 0,
  });
  const control = new Uint8Array(CONTROL_BYTES);
  writeControl(control, { action: CONTROL_SUICIDE, argument: 0 });
  session.onReliable(TRANSPORT_CHANNEL_SESSION, hello);
  await settleUntil(() => typeof releaseIssue === "function", "blocked credential issue");
  for (let index = 0; index < 33; index += 1) {
    session.onReliable(TRANSPORT_CHANNEL_CONTROL, control.slice());
  }
  assert.deepEqual(closes, [[4_003, "protocol queue capacity exceeded"]]);
  assert.match(String(errors[0]), /ordered reliable dispatch capacity exceeded/u);
  releaseIssue();
  await settle();
  server.close();
});

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
      if (disposition === "drop-ack" && channel === TRANSPORT_CHANNEL_SESSION && payload[3] === 8) {
        return Promise.resolve("sent");
      }
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
      if (channel === TRANSPORT_CHANNEL_SESSION && payload[3] === 2 && disposition !== "drop-ack") {
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
  await settleEventLoop();
}

async function settleUntil(predicate, what, timeoutMilliseconds = 1_000) {
  if (!(await waitForCondition(predicate, { timeoutMilliseconds }))) {
    throw new Error(`${what} did not settle within ${timeoutMilliseconds} milliseconds`);
  }
}

test("a welcomed player resumes its slot and the new stream starts from a keyframe", async () => {
  const errors = [];
  const server = new MatchServer({ rosterSize: 2, botSkill: 1, onError: (error) => errors.push(error) });
  const first = join(server, "commander", errors);
  await settleUntil(() => first.state === "ready", "initial welcome");
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
  await settleUntil(() => first.state === "ready", "initial snapshot delivery");
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
  await settleUntil(() => resumed.state === "ready", "resumed welcome");
  assert.equal(resumed.state, "ready");
  assert.equal(resumed.playerId, playerId, "resume must restore the authenticated player slot");
  assert.deepEqual(
    [
      server.world.playerScore[playerId - 1],
      server.world.playerCredits[playerId - 1],
      server.world.playerHealth[playerId - 1],
      server.world.playerChassis[playerId - 1],
      server.world.playerChassisUnlocks[playerId - 1],
    ],
    stateBeforeDisconnect,
    "resume must not reset authoritative player state",
  );

  server.step();
  server.step();
  server.step();
  await settleUntil(() => frames.length > 0, "resumed snapshot");
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
  await settleUntil(() => first.state === "ready", "initial owner welcome");
  const originalToken = first.resumeToken.slice();
  first.close(1_001, "link lost");

  const invalidRejected = [];
  const invalid = join(server, "invalid", errors, {
    resumeToken: new Uint8Array(RESUME_TOKEN_BYTES).fill(0x5a),
    onReject: (reject) => invalidRejected.push({ ...reject }),
  });
  await settleUntil(() => invalid.state === "rejected", "invalid resume rejection");
  assert.equal(invalid.state, "rejected");
  assert.equal(invalidRejected[0].code, REJECT_BAD_RESUME);
  assert.equal(server.countHumans(), 0);

  // A valid resume rotates the credential. The old one is then stale even
  // after the resumed connection disconnects.
  const resumed = join(server, "owner-again", errors, { resumeToken: originalToken });
  await settleUntil(() => resumed.state === "ready", "valid resume");
  assert.equal(resumed.state, "ready");
  assert.notDeepEqual([...resumed.resumeToken], [...originalToken]);
  resumed.close(1_001, "link lost again");
  const staleRejected = [];
  const stale = join(server, "stale", errors, {
    resumeToken: originalToken,
    onReject: (reject) => staleRejected.push({ ...reject }),
  });
  await settleUntil(() => stale.state === "rejected", "stale resume rejection");
  assert.equal(stale.state, "rejected");
  assert.equal(staleRejected[0].code, REJECT_BAD_RESUME);

  const expiringServer = new MatchServer({ rosterSize: 1, resumeGraceTicks: 1 });
  const expiring = join(expiringServer, "expiring", errors);
  await settleUntil(() => expiring.state === "ready", "expiring owner welcome");
  const expiringToken = expiring.resumeToken.slice();
  expiring.close(1_001, "link lost");
  expiringServer.step();
  expiringServer.step();
  const expiredRejected = [];
  const expired = join(expiringServer, "expired", errors, {
    resumeToken: expiringToken,
    onReject: (reject) => expiredRejected.push({ ...reject }),
  });
  await settleUntil(() => expired.state === "rejected", "expired resume rejection");
  assert.equal(expired.state, "rejected");
  assert.equal(expiredRejected[0].code, REJECT_BAD_RESUME);
  expiringServer.close();

  const otherServer = new MatchServer({ rosterSize: 2 });
  const foreign = join(otherServer, "foreign", errors);
  await settleUntil(() => foreign.state === "ready", "foreign owner welcome");
  assert.notDeepEqual(
    [...foreign.resumeToken],
    [...resumed.resumeToken],
    "same-match servers need distinct bearer secrets",
  );
  const foreignRejected = [];
  const foreignAttempt = join(server, "foreign-attempt", errors, {
    resumeToken: foreign.resumeToken,
    onReject: (reject) => foreignRejected.push({ ...reject }),
  });
  await settleUntil(() => foreignAttempt.state === "rejected", "foreign resume rejection");
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
  await settleUntil(() => initialFailure.state === "closed", "initial failed welcome");
  assert.equal(initialFailure.state, "closed");
  assert.equal(initialServer.countHumans(), 0);
  const initialRetry = join(initialServer, "initial-retry", errors);
  await settleUntil(() => initialRetry.state === "ready", "initial retry welcome");
  assert.equal(initialRetry.state, "ready", "an initial failed welcome must release its anonymous slot");
  initialServer.close();

  const server = new MatchServer({ rosterSize: 1 });
  const owner = join(server, "owner", errors);
  await settleUntil(() => owner.state === "ready", "owner welcome");
  const oldToken = owner.resumeToken.slice();
  const playerId = owner.playerId;
  owner.close(1_001, "link lost");

  const failedResume = new BattleClient({ onError: (error) => errors.push(error) });
  failedResume.resumeToken.set(oldToken);
  failWelcome(server, failedResume, "reject");
  await settleUntil(() => failedResume.state === "closed", "failed resumed welcome");
  assert.equal(failedResume.state, "closed");
  assert.equal(server.countHumans(), 0);

  const retry = join(server, "retry", errors, { resumeToken: oldToken });
  await settleUntil(() => retry.state === "ready", "retry welcome");
  assert.equal(retry.state, "ready");
  assert.equal(retry.playerId, playerId, "the old credential must remain usable after failed welcome delivery");
  assert.notDeepEqual([...retry.resumeToken], [...oldToken], "a successfully sent welcome must rotate the credential");

  const staleRejects = [];
  const stale = join(server, "stale", errors, {
    resumeToken: oldToken,
    onReject: (reject) => staleRejects.push({ ...reject }),
  });
  await settleUntil(() => stale.state === "rejected", "stale retry rejection");
  assert.equal(stale.state, "rejected");
  assert.equal(staleRejects[0].code, REJECT_BAD_RESUME);
  server.close();
  assert.deepEqual(errors, []);
});

test("a welcome enqueued without credential acknowledgement keeps the previous token current", async () => {
  const errors = [];
  const server = new MatchServer({ rosterSize: 1, resumeGraceTicks: 600 });
  const owner = join(server, "owner", errors);
  await settleUntil(() => owner.state === "ready", "initial owner welcome");
  const oldToken = owner.resumeToken.slice();
  const generation = server.sessionLedger.generation[0];
  owner.close(1_001, "link lost");

  const lostAck = new BattleClient({ onError: (error) => errors.push(error) });
  lostAck.resumeToken.set(oldToken);
  failWelcome(server, lostAck, "drop-ack");
  await settleUntil(() => lostAck.state === "ready", "unacknowledged welcome delivery");
  assert.equal(lostAck.state, "ready", "the client did receive the welcome before its acknowledgement was lost");
  assert.equal(server.sessionLedger.generation[0], generation, "enqueue alone must not rotate durable admission");
  for (let tick = 0; tick < 302; tick += 1) server.step();
  await settleUntil(() => lostAck.state === "closed", "unacknowledged welcome timeout");
  assert.equal(lostAck.state, "closed", "an unacknowledged welcome must release its slot on a bounded timer");

  const retry = join(server, "retry", errors, { resumeToken: oldToken });
  await settleUntil(() => retry.state === "ready", "old-token retry");
  assert.equal(retry.state, "ready");
  assert.equal(server.sessionLedger.generation[0], generation + 1);
  server.close();
  assert.deepEqual(errors, []);
});

test("a failed resumed welcome preserves the original grace deadline", async () => {
  const errors = [];
  const server = new MatchServer({ rosterSize: 1, resumeGraceTicks: 2 });
  const owner = join(server, "owner", errors);
  await settleUntil(() => owner.state === "ready", "short-grace owner welcome");
  const oldToken = owner.resumeToken.slice();
  owner.close(1_001, "link lost");
  server.step();

  const failedResume = new BattleClient({ onError: (error) => errors.push(error) });
  failedResume.resumeToken.set(oldToken);
  failWelcome(server, failedResume, "closed");
  await settleUntil(() => failedResume.state === "closed", "failed resumed welcome");
  assert.equal(failedResume.state, "closed");

  server.step();
  server.step();
  const rejects = [];
  const expired = join(server, "expired", errors, {
    resumeToken: oldToken,
    onReject: (reject) => rejects.push({ ...reject }),
  });
  await settleUntil(() => expired.state === "rejected", "expired resume rejection");
  assert.equal(expired.state, "rejected");
  assert.equal(rejects[0].code, REJECT_BAD_RESUME);
  server.close();
  assert.deepEqual(errors, []);
});

test("a failed fresh takeover does not resurrect an expired resume credential", async () => {
  const errors = [];
  const server = new MatchServer({ rosterSize: 2, resumeGraceTicks: 1 });
  const occupied = join(server, "occupied", errors);
  await settleUntil(() => occupied.state === "ready", "occupied welcome");
  const expiring = join(server, "expiring", errors);
  await settleUntil(() => expiring.state === "ready", "expiring welcome");
  const staleToken = expiring.resumeToken.slice();
  expiring.close(1_001, "link lost");
  server.step();
  server.step();

  const failedFresh = new BattleClient({ onError: (error) => errors.push(error) });
  failWelcome(server, failedFresh, "reject");
  await settleUntil(() => failedFresh.state === "closed", "failed fresh welcome");
  assert.equal(failedFresh.state, "closed");
  assert.equal(server.countHumans(), 1, "the failed takeover must release its claimed slot");

  const staleRejects = [];
  const stale = join(server, "stale", errors, {
    resumeToken: staleToken,
    onReject: (reject) => staleRejects.push({ ...reject }),
  });
  await settleUntil(() => stale.state === "rejected", "expired stale rejection");
  assert.equal(stale.state, "rejected");
  assert.equal(staleRejects[0].code, REJECT_BAD_RESUME);
  occupied.close(1_001, "test done");
  server.close();
  assert.deepEqual(errors, []);
});

test("snapshot decode rejects foreign bases and advances only after applied acknowledgements", async () => {
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
  assert.equal(errors.length, 1, "another frame based on the applied acknowledgement remains decodable");
  assert.equal(client.stats.snapshotsIgnored, ignoredAfterRoot);

  const keyframeLength = writeSnapshotKeyframe(frame, 12, baseline);
  client.onReliable(TRANSPORT_CHANNEL_SNAPSHOT, frame.subarray(0, keyframeLength));
  // A received-but-not-applied keyframe is deliberately not a delta base. The
  // client acknowledges only state that entered its simulation timeline.
  const recoveredDeltaLength = writeSnapshotDelta(frame, 15, 12, baseline, next);
  client.onReliable(TRANSPORT_CHANNEL_SNAPSHOT, frame.subarray(0, recoveredDeltaLength));
  client.update(0);
  assert.equal(client.stats.snapshotsApplied, 2, "the complete keyframe must apply before dependent state");
  const nextDeltaLength = writeSnapshotDelta(frame, 18, 12, baseline, next);
  client.onReliable(TRANSPORT_CHANNEL_SNAPSHOT, frame.subarray(0, nextDeltaLength));
  client.update(0);
  assert.equal(client.stats.snapshotsApplied, 3, "the recovered delta chain must remain usable");
  assert.equal(client.world.stateHash(), nextWorld.stateHash());
  assert.equal(errors.length, 2);
  server.close();
});

test("independent deltas sharing one acknowledged base coalesce without losing that base", async () => {
  const errors = [];
  const server = new MatchServer({ rosterSize: 2, onError: (error) => errors.push(error) });
  const client = join(server, "shared-base", errors);
  await settle();
  for (let tick = 0; tick < 3; tick += 1) server.step();
  await settle();
  client.update(0);

  const baseline = new Uint8Array(SNAPSHOT_BYTES);
  server.world.writeSnapshot(baseline);
  const future = new BattleWorld(server.world.matchId, server.world.mapSeed);
  future.restoreSnapshot(baseline);
  const first = new Uint8Array(SNAPSHOT_BYTES);
  const second = new Uint8Array(SNAPSHOT_BYTES);
  future.step();
  future.writeSnapshot(first);
  future.step();
  future.writeSnapshot(second);
  const frame = new Uint8Array(SNAPSHOT_MESSAGE_BYTES);
  let length = writeSnapshotDelta(frame, 6, 3, baseline, first);
  client.onReliable(TRANSPORT_CHANNEL_SNAPSHOT, frame.subarray(0, length));
  length = writeSnapshotDelta(frame, 9, 3, baseline, second);
  client.onReliable(TRANSPORT_CHANNEL_SNAPSHOT, frame.subarray(0, length));
  client.update(0);

  assert.equal(client.stats.snapshotsApplied, 2, "the newest complete sibling delta is applied once");
  assert.equal(client.world.stateHash(), future.stateHash());
  assert.deepEqual(errors, []);
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

test("late input accounting ignores accepted and repeated redundancy across tick wrap", async () => {
  const errors = [];
  const server = new MatchServer({ rosterSize: 2, inputBudgetPerTick: 8, onError: (error) => errors.push(error) });
  const client = join(server, "late-accounting", errors);
  await settle();
  const command = createInputCommand(server.world.matchId, client.playerId);
  const packet = new Uint8Array(INPUT_PACKET_BYTES);

  server.world.tick = 0xffff_fffe;
  command.tick = 0xffff_ffff;
  command.sequence = 1;
  writeInputPacket(packet, 0, command);
  client.session.onDatagram(packet);
  assert.equal(server.stats.inputsAccepted, 1);
  server.step();
  client.session.onDatagram(packet);
  assert.equal(server.stats.inputsLate, 0, "an accepted command repeated after consumption is benign redundancy");

  command.tick = 0xffff_fffe;
  command.sequence = 2;
  writeInputPacket(packet, 0, command);
  client.session.onDatagram(packet);
  client.session.onDatagram(packet);
  assert.equal(server.stats.inputsLate, 1, "one never-accepted tick is counted once across redundant copies");
  assert.equal(server.stats.inputsRejected, 0);
  assert.deepEqual(errors, []);
  server.close();
});

test("world input, snapshot state, and bot stepping cross the uint32 tick boundary", () => {
  const world = new BattleWorld(77);
  world.addPlayer(1);
  world.tick = 0xffff_fffd;
  const command = createInputCommand(77, 1);
  const expectedTicks = [0xffff_fffe, 0xffff_ffff, 0, 1];

  for (let index = 0; index < expectedTicks.length; index += 1) {
    command.tick = expectedTicks[index];
    command.sequence = index + 1;
    command.moveX = 1;
    assert.equal(world.submitInput(command), true, `tick ${command.tick} must remain queueable`);
    world.step();
    assert.equal(world.tick, command.tick);
    assert.equal(world.playerLastInputTick[0], command.tick);

    if (command.tick === 0xffff_ffff) {
      const snapshot = new Uint8Array(SNAPSHOT_BYTES);
      world.writeSnapshot(snapshot);
      const restored = new BattleWorld(77);
      restored.restoreSnapshot(snapshot);
      assert.equal(restored.tick, 0xffff_ffff);
      assert.equal(restored.playerLastInputTick[0], 0xffff_ffff);
      assert.equal(restored.stateHash(), world.stateHash());
    }
  }
});

test("client transmits and the server executes input across the signed uint32 boundary", async () => {
  const errors = [];
  const server = new MatchServer({
    rosterSize: 2,
    snapshotIntervalTicks: 1,
    inputBudgetPerTick: 4,
    onError: (error) => errors.push(error),
  });
  server.world.tick = 0x7fff_ffff;
  const client = join(server, "signed-boundary", errors, { leadTicks: 0 });
  await settleUntil(() => client.state === "ready", "signed-boundary welcome");
  assert.equal(client.world.tick, 0x7fff_ffff);

  client.setControls({ moveX: 1, moveY: 0, fire: false });
  client.update(TICK_MILLISECONDS);
  await settle();
  assert.equal(client.world.tick, 0x8000_0000);
  assert.equal(client.stats.inputsSent, 1, "the unsigned tick must survive history lookup and transmission");

  server.step();
  await settle();
  assert.equal(server.world.tick, 0x8000_0000);
  assert.equal(server.world.playerLastInputTick[client.playerId - 1], 0x8000_0000);
  assert.equal(server.stats.inputsAccepted, 1);
  assert.deepEqual(errors, []);
  server.close();
});

test("authoritative prediction, redundant datagrams, and snapshots survive uint32 tick wrap", async () => {
  const errors = [];
  const server = new MatchServer({
    rosterSize: 2,
    snapshotIntervalTicks: 1,
    inputBudgetPerTick: 8,
    onError: (error) => errors.push(error),
  });
  server.world.tick = 0xffff_fffd;
  const client = join(server, "wrap-client", errors, { leadTicks: 2 });
  await settle();
  assert.equal(client.state, "ready");
  assert.equal(client.world.tick, 0xffff_ffff);

  client.setControls({ moveX: 1, moveY: 0, fire: false });
  for (let step = 0; step < 8; step += 1) {
    client.update(TICK_MILLISECONDS);
    await settle();
    server.step();
    await settle();
    client.update(0);
  }

  assert.equal(server.world.tick, 5);
  assert.ok(server.stats.inputsAccepted >= 8, "the wrapped redundant input window must remain admissible");
  assert.ok(client.stats.snapshotsApplied >= 5, "post-wrap snapshots must remain ordered in serial space");
  assert.equal(client.state, "ready");
  assert.deepEqual(errors, []);
  server.close();
});

test("input rate limiting is advisory and does not reject a live client", async () => {
  const errors = [];
  const logs = [];
  const rejects = [];
  const server = new MatchServer({ rosterSize: 2, inputBudgetPerTick: 1, onError: (error) => errors.push(error) });
  const client = join(server, "rate-limited", errors, {
    onLog: (line) => logs.push(line),
    onReject: (reject) => rejects.push({ ...reject }),
  });
  await settle();
  assert.equal(client.state, "ready");

  // More than one datagram before the next authoritative tick exhausts the
  // per-session ingress budget and makes the server send REJECT_RATE_LIMITED.
  client.update(TICK_MILLISECONDS * 3, 3);
  await settle();
  assert.equal(client.state, "ready");
  assert.equal(client.stats.rateLimitAdvisories, 1);
  assert.deepEqual(rejects, [], "advisory throttling must not enter the terminal admission-reject path");
  assert.ok(logs.some((line) => line.startsWith("client-rate-limited:")));
  assert.deepEqual(errors, []);
  server.close();
});

test("terminal rejection remains distinct from a live rate-limit advisory", () => {
  const rejects = [];
  const client = new BattleClient({ onReject: (reject) => rejects.push({ ...reject }) });
  const payload = new Uint8Array(128);
  const length = writeReject(payload, { code: REJECT_BAD_RESUME, reason: "terminal" });
  client.onReliable(TRANSPORT_CHANNEL_CONTROL, payload.subarray(0, length));
  assert.equal(client.state, "rejected");
  assert.deepEqual(rejects, [{ code: REJECT_BAD_RESUME, reason: "terminal" }]);

  const advisoryClient = new BattleClient();
  advisoryClient.state = "ready";
  const advisoryLength = writeReject(payload, { code: REJECT_RATE_LIMITED, reason: "slow down" });
  advisoryClient.onReliable(TRANSPORT_CHANNEL_CONTROL, payload.subarray(0, advisoryLength));
  assert.equal(advisoryClient.state, "ready");
  assert.equal(advisoryClient.stats.rateLimitAdvisories, 1);
});

test("prediction lead advances the local clock without retimestamping input", async () => {
  const errors = [];
  const server = new MatchServer({ rosterSize: 2, onError: (error) => errors.push(error) });
  const client = join(server, "same-timeline", errors, { leadTicks: 2 });
  await settle();
  assert.equal(client.world.tick, server.world.tick + 2);
  client.setControls({ moveX: 1, moveY: 0, fire: false });
  client.update(TICK_MILLISECONDS);
  await settle();
  assert.equal(client.world.tick, 3);
  for (let tick = 0; tick < 3; tick += 1) server.step();
  await settle();
  const slot = client.playerId - 1;
  assert.equal(server.world.playerLastInputTick[slot], 3, "the server must consume the command on its predicted tick");
  assert.equal(client.world.playerX[slot], server.world.playerX[slot]);
  assert.equal(client.world.playerY[slot], server.world.playerY[slot]);
  assert.deepEqual(errors, []);
  server.close();
});

test("server deltas use the latest client-applied snapshot as their exact base", async () => {
  const errors = [];
  const frames = [];
  const server = new MatchServer({ rosterSize: 2, onError: (error) => errors.push(error) });
  const client = new BattleClient({ name: "snapshot-ack", onError: (error) => errors.push(error) });
  const session = server.createSession();
  const [clientTransport, serverTransport] = createInMemoryTransportPair(client, session);
  const sendReliable = serverTransport.sendReliable.bind(serverTransport);
  serverTransport.sendReliable = (channel, payload, signal) => {
    if (channel === TRANSPORT_CHANNEL_SNAPSHOT) frames.push(payload.slice());
    return sendReliable(channel, payload, signal);
  };
  session.attach(serverTransport);
  client.attach(clientTransport);
  await settle();

  for (let tick = 0; tick < 3; tick += 1) server.step();
  await settle();
  client.update(0);
  assert.equal(frames[0][8], SNAPSHOT_KEYFRAME);
  client.update(TICK_MILLISECONDS);
  await settle();
  for (let tick = 0; tick < 3; tick += 1) server.step();
  await settle();
  assert.equal(frames[1][8], SNAPSHOT_DELTA);
  assert.equal(new DataView(frames[1].buffer, frames[1].byteOffset).getUint32(10, true), 3);
  assert.deepEqual(errors, []);
  server.close();
});

test("input datagrams repeat a bounded command window and survive deterministic loss", async () => {
  const errors = [];
  const server = new MatchServer({ rosterSize: 2, inputBudgetPerTick: 4, onError: (error) => errors.push(error) });
  const client = join(server, "lossy", errors, { leadTicks: 4, transport: { dropEvery: 2 } });
  await settle();
  const slot = client.playerId - 1;
  const startX = server.world.playerX[slot];
  client.setControls({ moveX: 1, moveY: 0, fire: false });
  for (let tick = 0; tick < 180; tick += 1) {
    client.update(TICK_MILLISECONDS);
    await settle();
    server.step();
    await settle();
  }
  assert.ok(client.stats.inputCommandsSent >= client.stats.inputsSent * 2);
  assert.ok(client.stats.inputCommandsSent <= client.stats.inputsSent * INPUT_BUNDLE_MAX_COMMANDS);
  assert.ok(server.stats.inputsAccepted > 150, "redundant future commands must fill dropped datagram gaps");
  assert.equal(server.stats.inputsRejected, 0);
  assert.ok(server.world.playerX[slot] > startX + TILE_UNITS, "loss must not leave the tank stationary");
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

test("local authoritative corrections decay in presentation without delaying simulation truth", async () => {
  const errors = [];
  const server = new MatchServer({ rosterSize: 2, onError: (error) => errors.push(error) });
  const client = join(server, "correction-smoothing", errors);
  await settle();
  for (let tick = 0; tick < 3; tick += 1) server.step();
  await settle();
  client.update(0);
  const slot = client.playerId - 1;
  client.world.playerX[slot] += TILE_UNITS * 4;
  const before = { x: 0, y: 0, hullX: 0, hullY: 0, turretX: 0, turretY: 0 };
  client.samplePlayerTransform(slot, before);

  for (let tick = 0; tick < 3; tick += 1) server.step();
  await settle();
  client.update(0);
  const correctedTruth = client.world.playerX[slot];
  assert.notEqual(correctedTruth, before.x, "the simulation must accept the authoritative correction immediately");
  const continuous = { ...before };
  client.samplePlayerTransform(slot, continuous);
  assert.equal(continuous.x, before.x, "presentation must be continuous on the correction frame");

  client.update(50);
  const halfway = { ...before };
  client.samplePlayerTransform(slot, halfway);
  assert.ok(Math.abs(halfway.x - correctedTruth) < Math.abs(before.x - correctedTruth));
  client.update(50);
  const settled = { ...before };
  client.samplePlayerTransform(slot, settled);
  assert.equal(settled.x, client.world.playerX[slot]);
  assert.deepEqual(errors, []);
  server.close();
});

test("remote interpolation follows a six-tick cadence after snapshot coalescing", async () => {
  const errors = [];
  const server = new MatchServer({
    rosterSize: 2,
    botSkill: 1,
    snapshotIntervalTicks: 6,
    onError: (error) => errors.push(error),
  });
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
    onReliable(channel, payload) {
      events.push(["reliable", channel, [...payload]]);
    },
    onDatagram(payload) {
      events.push(["datagram", [...payload]]);
    },
    onClose(code, reason) {
      events.push(["close", code, reason]);
    },
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
    async trySendDatagram() {
      return "backpressured";
    },
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
    close(options) {
      closeOptions = options;
    },
  };
  const incoming = { accept: async () => ({}) };
  const listener = {
    async *[Symbol.asyncIterator]() {
      yield incoming;
    },
  };
  const endpoint = {
    listen() {
      return listener;
    },
    close() {},
  };
  const runtime = {
    QuicEndpoint: class {
      constructor() {
        return endpoint;
      }
    },
    async upgradeWebTransport() {
      return session;
    },
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
    onSession() {
      sessionAccepted = true;
    },
    onSessionError(url, failedReceiver) {
      assert.equal(url, session.url);
      pending.delete(failedReceiver);
    },
    onError(error) {
      errors.push(error);
    },
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
  const endpoint = {
    listen() {
      return listener;
    },
    close() {},
  };
  const runtime = {
    QuicEndpoint: class {
      constructor() {
        return endpoint;
      }
    },
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
    receiverForSession() {
      throw new Error("max-session path must not create a receiver");
    },
    onSession() {
      throw new Error("max-session path must not adopt a session");
    },
    onError(error) {
      errors.push(error);
    },
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
    reliableController;
    incomingBidirectionalController;
    datagramController;
    closed = new Promise((resolve) => {
      this.closeResolve = resolve;
    });
    incomingUnidirectionalStreams = new ReadableStream({
      start: (controller) => {
        this.incomingController = controller;
      },
    });
    incomingBidirectionalStreams = new ReadableStream({
      start: (controller) => {
        this.incomingBidirectionalController = controller;
      },
    });
    datagrams = {
      maxDatagramSize: 8,
      readable: new ReadableStream({
        start: (controller) => {
          this.datagramController = controller;
        },
      }),
      writable: new WritableStream({
        write: (chunk) => {
          this.outgoingDatagrams.push([...chunk]);
        },
      }),
    };
    async createUnidirectionalStream() {
      const chunks = [];
      this.outgoingStreams.push(chunks);
      return new WritableStream({
        write(chunk) {
          chunks.push(chunk.slice());
        },
      });
    }
    async createBidirectionalStream() {
      const chunks = [];
      this.outgoingBidirectionalStreams.push(chunks);
      return {
        readable: new ReadableStream(),
        writable: new WritableStream({
          write(chunk) {
            chunks.push(chunk.slice());
          },
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
      if (direction === "server") {
        const readable = new ReadableStream({
          start(controller) {
            controller.enqueue(bytes.subarray(0, 2));
            controller.enqueue(bytes.subarray(2, 6));
            controller.enqueue(bytes.subarray(6));
            controller.close();
          },
        });
        this.incomingBidirectionalController.enqueue({ readable, writable: new WritableStream() });
      } else {
        if (this.reliableController === undefined) {
          this.incomingController.enqueue(
            new ReadableStream({
              start: (controller) => {
                this.reliableController = controller;
              },
            }),
          );
        }
        this.reliableController.enqueue(bytes.subarray(0, 2));
        this.reliableController.enqueue(bytes.subarray(2, 6));
        this.reliableController.enqueue(bytes.subarray(6));
      }
    }
  }
  const session = new FakeSession();
  class FakeConstructor {
    constructor() {
      return session;
    }
  }
  const events = [];
  const client = await WebTransportGameClient.connect(
    "https://example.invalid",
    {
      onReliable(channel, payload) {
        events.push(["reliable", channel, [...payload]]);
      },
      onDatagram(payload) {
        events.push(["datagram", [...payload]]);
      },
      onClose(code, reason) {
        events.push(["close", code, reason]);
      },
    },
    FakeConstructor,
  );
  const reusedPayload = Uint8Array.of(8, 9);
  const sendPromise = client.sendReliable(TRANSPORT_CHANNEL_SESSION, reusedPayload);
  reusedPayload[0] = 99;
  assert.equal(await sendPromise, "sent");
  assert.equal(session.outgoingBidirectionalStreams.length, 1);
  assert.equal(session.outgoingStreams.length, 0);
  assert.deepEqual([...session.outgoingBidirectionalStreams[0][0]], [TRANSPORT_CHANNEL_SESSION, 2, 0, 0, 0, 8, 9]);
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
    onReliable(channel, payload) {
      serverEvents.push(["reliable", channel, [...payload]]);
    },
    onDatagram(payload) {
      serverEvents.push(["datagram", [...payload]]);
    },
    onClose(code, reason) {
      serverEvents.push(["close", code, reason]);
    },
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

class AsynchronousServerWebTransportSession {
  ready = Promise.resolve();
  incomingUnidirectionalStreams = new ReadableStream();
  incomingBidirectionalStreams = new ReadableStream();
  datagrams = { maxDatagramSize: 0, readable: new ReadableStream(), writable: new WritableStream() };
  closeResolve;
  closed = new Promise((resolve) => {
    this.closeResolve = resolve;
  });
  closeCalls = 0;
  terminal = false;
  delivered = [];
  events = [];
  stallStreamClose = false;
  outgoing = new WritableStream({
    write: (chunk) => {
      const owned = chunk.slice();
      this.events.push("write-start");
      // A browser WebTransport write crosses an asynchronous stream/network
      // boundary. Closing the session first makes this queued write disappear.
      return new Promise((resolve) => {
        setImmediate(() => {
          if (!this.terminal) {
            this.delivered.push(owned);
            this.events.push("network-delivery");
          }
          resolve();
        });
      });
    },
    close: () => {
      this.events.push("stream-close");
      return this.stallStreamClose ? new Promise(() => {}) : Promise.resolve();
    },
    abort: () => {
      this.events.push("stream-abort");
    },
  });

  async createUnidirectionalStream() {
    await new Promise((resolve) => setImmediate(resolve));
    return this.outgoing;
  }

  createBidirectionalStream() {
    throw new Error("not used");
  }

  close(options = {}) {
    this.closeCalls += 1;
    this.terminal = true;
    this.events.push("session-close");
    this.closeResolve({ closeCode: options.closeCode, reason: options.reason });
  }
}

function encodedReject(code, reason) {
  const target = new Uint8Array(REJECT_MAXIMUM_BYTES);
  return target.subarray(0, writeReject(target, { code, reason }));
}

test("a terminal reject drains and FINs the real stream-shaped adapter before session close", async () => {
  const session = new AsynchronousServerWebTransportSession();
  const closes = [];
  const transport = await adoptServerWebTransportSession(session, {
    onReliable() {},
    onDatagram() {},
    onClose(code, reason) {
      closes.push([code, reason]);
    },
  });
  const send = transport.sendReliable(TRANSPORT_CHANNEL_SESSION, encodedReject(REJECT_FULL, "match is full"));
  transport.close(4_004, "match is full");

  assert.equal(session.closeCalls, 0, "close is deferred while the terminal frame crosses the stream boundary");
  assert.equal(
    await transport.sendReliable(TRANSPORT_CHANNEL_CONTROL, encodedReject(REJECT_RATE_LIMITED, "late")),
    "closed",
    "graceful close admits no new reliable frames",
  );
  assert.equal(await send, "sent");
  assert.equal(await waitForCondition(() => session.closeCalls === 1), true);
  assert.deepEqual(session.events, ["write-start", "network-delivery", "stream-close", "session-close"]);
  assert.equal(session.delivered.length, 1);
  const frame = session.delivered[0];
  assert.equal(frame[0], TRANSPORT_CHANNEL_SESSION);
  assert.equal(new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(1, true), frame.byteLength - 5);
  assert.deepEqual(readReject(frame.subarray(5), { code: 0, reason: "" }), {
    code: REJECT_FULL,
    reason: "match is full",
  });
  assert.deepEqual(closes, [[4_004, "match is full"]]);
});

test("a rate-limit reject remains advisory and graceful close has a hard deadline", async () => {
  const advisorySession = new AsynchronousServerWebTransportSession();
  const advisoryTransport = await adoptServerWebTransportSession(advisorySession, {
    onReliable() {},
    onDatagram() {},
    onClose() {},
  });
  assert.equal(
    await advisoryTransport.sendReliable(
      TRANSPORT_CHANNEL_CONTROL,
      encodedReject(REJECT_RATE_LIMITED, "input rate exceeded"),
    ),
    "sent",
  );
  assert.equal(advisorySession.closeCalls, 0, "a rate advisory does not terminate the session");
  assert.deepEqual(readReject(advisorySession.delivered[0].subarray(5), { code: 0, reason: "" }), {
    code: REJECT_RATE_LIMITED,
    reason: "input rate exceeded",
  });
  advisoryTransport.close(12, "finished");
  assert.equal(await waitForCondition(() => advisorySession.closeCalls === 1), true);

  const stalledSession = new AsynchronousServerWebTransportSession();
  stalledSession.stallStreamClose = true;
  const stalledTransport = await adoptServerWebTransportSession(stalledSession, {
    onReliable() {},
    onDatagram() {},
    onClose() {},
  });
  assert.equal(
    await stalledTransport.sendReliable(TRANSPORT_CHANNEL_SESSION, encodedReject(REJECT_FULL, "match is full")),
    "sent",
  );
  stalledTransport.close(4_004, "match is full");
  assert.equal(
    await waitForCondition(() => stalledSession.closeCalls === 1, { timeoutMilliseconds: 1_500 }),
    true,
    "a stuck stream close cannot retain a rejected session",
  );
  assert.equal(stalledSession.events.includes("session-close"), true);
});

test("datagram staging owns caller bytes and has fixed in-flight capacity", async () => {
  class DelayedDatagramSession {
    ready = Promise.resolve();
    incomingUnidirectionalStreams = new ReadableStream();
    incomingBidirectionalStreams = new ReadableStream();
    closeResolve;
    closed = new Promise((resolve) => {
      this.closeResolve = resolve;
    });
    writes = [];
    writeResolves = [];
    datagramAbortCalls = 0;
    datagramReleaseCalls = 0;
    writer = {
      desiredSize: 1,
      write: (chunk) => {
        this.writes.push(chunk);
        return new Promise((resolve) => {
          this.writeResolves.push(resolve);
        });
      },
      abort: async () => {
        this.datagramAbortCalls += 1;
      },
      releaseLock: () => {
        this.datagramReleaseCalls += 1;
      },
    };
    datagrams = {
      maxDatagramSize: 8,
      readable: new ReadableStream(),
      writable: { getWriter: () => this.writer },
    };
    createUnidirectionalStream() {
      throw new Error("not used");
    }
    createBidirectionalStream() {
      throw new Error("not used");
    }
    close(options = {}) {
      this.closeResolve({ closeCode: options.closeCode, reason: options.reason });
    }
  }

  const session = new DelayedDatagramSession();
  class FakeConstructor {
    constructor() {
      return session;
    }
  }
  const client = await WebTransportGameClient.connect(
    "https://example.invalid",
    {
      onReliable() {},
      onDatagram() {},
      onClose() {},
    },
    FakeConstructor,
  );

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

test("WebTransport datagrams support the current createWritable API", async () => {
  class CurrentDatagramSession {
    ready = Promise.resolve();
    incomingUnidirectionalStreams = new ReadableStream();
    incomingBidirectionalStreams = new ReadableStream();
    writes = [];
    createWritableCalls = 0;
    closeResolve;
    closed = new Promise((resolve) => {
      this.closeResolve = resolve;
    });
    datagrams = {
      maxDatagramSize: 8,
      readable: new ReadableStream(),
      createWritable: () => {
        this.createWritableCalls += 1;
        return new WritableStream({
          write: (chunk) => {
            this.writes.push(chunk.slice());
          },
        });
      },
    };
    createUnidirectionalStream() {
      throw new Error("not used");
    }
    createBidirectionalStream() {
      throw new Error("not used");
    }
    close(options = {}) {
      this.closeResolve({ closeCode: options.closeCode, reason: options.reason });
    }
  }

  const session = new CurrentDatagramSession();
  class FakeConstructor {
    constructor() {
      return session;
    }
  }
  const client = await WebTransportGameClient.connect(
    "https://example.invalid",
    {
      onReliable() {},
      onDatagram() {},
      onClose() {},
    },
    FakeConstructor,
  );

  assert.equal(session.createWritableCalls, 1);
  assert.equal(await client.trySendDatagram(Uint8Array.of(3, 4)), "sent");
  assert.deepEqual(
    session.writes.map((chunk) => [...chunk]),
    [[3, 4]],
  );
  client.close(12, "finished");
});

test("client hello and control frames share one ordered stream", async () => {
  class RepeatedBidiSession {
    ready = Promise.resolve();
    incomingController;
    incomingUnidirectionalStreams = new ReadableStream();
    incomingBidirectionalStreams = new ReadableStream();
    datagrams = { maxDatagramSize: 8, readable: new ReadableStream(), writable: new WritableStream() };
    closeResolve;
    closed = new Promise((resolve) => {
      this.closeResolve = resolve;
    });
    reverseCancels = 0;
    outgoingStreams = [];
    close(options = {}) {
      this.closeResolve({ closeCode: options.closeCode, reason: options.reason });
    }
    createUnidirectionalStream() {
      throw new Error("not used");
    }
    async createBidirectionalStream() {
      const session = this;
      const chunks = [];
      this.outgoingStreams.push(chunks);
      const readable = new ReadableStream({
        cancel() {
          session.reverseCancels += 1;
        },
      });
      return {
        readable,
        writable: new WritableStream({
          write(chunk) {
            chunks.push(chunk.slice());
          },
        }),
      };
    }
  }
  const session = new RepeatedBidiSession();
  class FakeConstructor {
    constructor() {
      return session;
    }
  }
  const client = await WebTransportGameClient.connect(
    "https://example.invalid",
    {
      onReliable() {},
      onDatagram() {},
      onClose() {},
    },
    FakeConstructor,
  );
  assert.equal(await client.sendReliable(TRANSPORT_CHANNEL_SESSION, Uint8Array.of(11)), "sent");
  assert.equal(await client.sendReliable(TRANSPORT_CHANNEL_CONTROL, Uint8Array.of(22)), "sent");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(session.outgoingStreams.length, 1, "QUIC stream ordering is the handshake ordering guarantee");
  assert.deepEqual(
    session.outgoingStreams[0].map((chunk) => [...chunk]),
    [
      [TRANSPORT_CHANNEL_SESSION, 1, 0, 0, 0, 11],
      [TRANSPORT_CHANNEL_CONTROL, 1, 0, 0, 0, 22],
    ],
  );
  assert.equal(session.reverseCancels, 1);
  client.close(12, "finished");
});

test("client reliable input fallback is latest-only under stream backpressure", async () => {
  let releaseInput;
  const writes = [];
  const session = {
    ready: Promise.resolve(),
    incomingUnidirectionalStreams: new ReadableStream(),
    incomingBidirectionalStreams: new ReadableStream(),
    datagrams: { maxDatagramSize: 0, readable: new ReadableStream(), writable: new WritableStream() },
    closed: new Promise(() => {}),
    async createBidirectionalStream() {
      return {
        readable: new ReadableStream(),
        writable: {
          getWriter() {
            return {
              desiredSize: 1,
              ready: Promise.resolve(),
              write(frame) {
                writes.push(frame.slice());
                if (frame[0] !== TRANSPORT_CHANNEL_INPUT_FALLBACK) return Promise.resolve();
                return new Promise((resolve) => {
                  releaseInput = resolve;
                });
              },
              abort: async () => {},
              releaseLock() {},
            };
          },
        },
      };
    },
    createUnidirectionalStream() {
      throw new Error("not used");
    },
    close() {},
  };
  class FakeConstructor {
    constructor() {
      return session;
    }
  }
  const client = await WebTransportGameClient.connect(
    "https://example.invalid",
    { onReliable() {}, onDatagram() {}, onClose() {} },
    FakeConstructor,
  );
  assert.equal(await client.sendReliable(TRANSPORT_CHANNEL_SESSION, Uint8Array.of(1)), "sent");
  const first = client.sendReliable(TRANSPORT_CHANNEL_INPUT_FALLBACK, Uint8Array.of(2));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await client.sendReliable(TRANSPORT_CHANNEL_INPUT_FALLBACK, Uint8Array.of(3)), "backpressured");
  releaseInput();
  assert.equal(await first, "sent");
  assert.equal(writes.length, 2, "the stale fallback never entered the persistent stream queue");
  const aborted = new AbortController();
  aborted.abort("stale tick");
  assert.equal(
    await client.sendReliable(TRANSPORT_CHANNEL_INPUT_FALLBACK, Uint8Array.of(4), aborted.signal),
    "backpressured",
  );
  client.close(12, "finished");
});

test("a snapshot cancelled during stream creation resets the created QUIC stream", async () => {
  let resolveCreate;
  let aborts = 0;
  const session = {
    ready: Promise.resolve(),
    incomingBidirectionalStreams: new ReadableStream(),
    incomingUnidirectionalStreams: new ReadableStream(),
    datagrams: { maxDatagramSize: 8, readable: new ReadableStream(), writable: new WritableStream() },
    closed: new Promise(() => {}),
    createUnidirectionalStream() {
      return new Promise((resolve) => {
        resolveCreate = () =>
          resolve(
            new WritableStream({
              abort() {
                aborts += 1;
              },
            }),
          );
      });
    },
    createBidirectionalStream() {
      throw new Error("not used");
    },
    close() {},
  };
  const transport = await adoptServerWebTransportSession(session, {
    onReliable() {},
    onDatagram() {},
    onClose() {},
  });
  const stale = new AbortController();
  const send = transport.sendReliable(TRANSPORT_CHANNEL_SNAPSHOT, Uint8Array.of(1), stale.signal);
  await new Promise((resolve) => setImmediate(resolve));
  stale.abort("superseded before stream credit arrived");
  resolveCreate();
  assert.equal(await send, "backpressured");
  assert.equal(aborts, 1, "the late-created stream is reset rather than leaked");
  transport.close(12, "finished");
});

test("server reliable streams close reverse writers without escalating peer resets", async () => {
  class RepeatedServerSession {
    ready = Promise.resolve();
    incomingController;
    incomingBidirectionalStreams = new ReadableStream({
      start: (controller) => {
        this.incomingController = controller;
      },
    });
    incomingUnidirectionalStreams = new ReadableStream();
    datagrams = { maxDatagramSize: 8, readable: new ReadableStream(), writable: new WritableStream() };
    closeResolve;
    closed = new Promise((resolve) => {
      this.closeResolve = resolve;
    });
    closeCalls = 0;
    reverseCloses = 0;
    reverseReleases = 0;
    push(channel, value, rejectClose = false) {
      const session = this;
      const bytes = Uint8Array.of(channel, 1, 0, 0, 0, value);
      const readable = new ReadableStream({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      });
      const writable = {
        getWriter() {
          return {
            close: () => {
              session.reverseCloses += 1;
              return rejectClose ? Promise.reject(new Error("peer reset")) : Promise.resolve();
            },
            releaseLock() {
              session.reverseReleases += 1;
            },
          };
        },
      };
      this.incomingController.enqueue({ readable, writable });
    }
    createUnidirectionalStream() {
      throw new Error("not used");
    }
    createBidirectionalStream() {
      throw new Error("not used");
    }
    close(options = {}) {
      this.closeCalls += 1;
      this.incomingController.close();
      this.closeResolve({ closeCode: options.closeCode, reason: options.reason });
    }
  }
  const session = new RepeatedServerSession();
  const events = [];
  const transport = await adoptServerWebTransportSession(session, {
    onReliable(channel, payload) {
      events.push([channel, payload[0]]);
    },
    onDatagram() {},
    onClose(code, reason) {
      events.push(["close", code, reason]);
    },
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
    closed = new Promise((resolve) => {
      this.closeResolve = resolve;
    });
    closeCalls = 0;
    incomingUnidirectionalStreams = new ReadableStream({
      start: (controller) => {
        this.incomingController = controller;
      },
    });
    incomingBidirectionalStreams = new ReadableStream();
    datagrams = {
      maxDatagramSize: 8,
      readable: new ReadableStream({
        start: (controller) => {
          this.datagramController = controller;
        },
      }),
      writable: new WritableStream(),
    };
    createUnidirectionalStream() {
      throw new Error("not used");
    }
    createBidirectionalStream() {
      throw new Error("not used");
    }
    close(options = {}) {
      this.closeCalls += 1;
      this.incomingController.close();
      this.datagramController.close();
      this.closeResolve({ closeCode: options.closeCode, reason: options.reason });
    }
    pushBytes(bytes) {
      if (this.reliableController === undefined) {
        this.incomingController.enqueue(
          new ReadableStream({
            start: (controller) => {
              this.reliableController = controller;
            },
          }),
        );
      }
      this.reliableController.enqueue(bytes.subarray(0, 1));
      this.reliableController.enqueue(bytes.subarray(1, 8));
      this.reliableController.enqueue(bytes.subarray(8));
    }
  }
  const session = new DecoderSession();
  class FakeConstructor {
    constructor() {
      return session;
    }
  }
  const events = [];
  const client = await WebTransportGameClient.connect(
    "https://example.invalid",
    {
      onReliable(channel, payload) {
        events.push(["reliable", channel, [...payload]]);
      },
      onDatagram() {},
      onClose(code, reason) {
        events.push(["close", code, reason]);
      },
    },
    FakeConstructor,
  );
  const frames = new Uint8Array([
    TRANSPORT_CHANNEL_CONTROL,
    2,
    0,
    0,
    0,
    9,
    8,
    TRANSPORT_CHANNEL_SESSION,
    1,
    0,
    0,
    0,
    7,
  ]);
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

test("ending the persistent server event stream closes the client session", async () => {
  let incomingController;
  let closeResolve;
  const session = {
    ready: Promise.resolve(),
    incomingUnidirectionalStreams: new ReadableStream({
      start(controller) {
        incomingController = controller;
      },
    }),
    incomingBidirectionalStreams: new ReadableStream(),
    datagrams: { maxDatagramSize: 8, readable: new ReadableStream(), writable: new WritableStream() },
    closed: new Promise((resolve) => {
      closeResolve = resolve;
    }),
    createUnidirectionalStream() {
      throw new Error("not used");
    },
    createBidirectionalStream() {
      throw new Error("not used");
    },
    close(options = {}) {
      closeResolve({ closeCode: options.closeCode, reason: options.reason });
    },
  };
  class FakeConstructor {
    constructor() {
      return session;
    }
  }
  const closes = [];
  await WebTransportGameClient.connect(
    "https://example.invalid",
    { onReliable() {}, onDatagram() {}, onClose: (code, reason) => closes.push([code, reason]) },
    FakeConstructor,
  );
  incomingController.enqueue(
    new ReadableStream({
      start(controller) {
        controller.enqueue(Uint8Array.of(TRANSPORT_CHANNEL_SESSION, 1, 0, 0, 0, 7));
        controller.close();
      },
    }),
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(closes, [[2, "persistent server reliable stream ended"]]);
});

test("a remote WebTransport close is observed without issuing a second close", async () => {
  class RemotelyClosedSession {
    ready = Promise.resolve();
    incomingUnidirectionalStreams = new ReadableStream();
    incomingBidirectionalStreams = new ReadableStream();
    datagrams = { maxDatagramSize: 8, readable: new ReadableStream(), writable: new WritableStream() };
    closeCalls = 0;
    closedResolve;
    closed = new Promise((resolve) => {
      this.closedResolve = resolve;
    });
    createUnidirectionalStream() {
      throw new Error("not used");
    }
    createBidirectionalStream() {
      throw new Error("not used");
    }
    close() {
      this.closeCalls += 1;
    }
  }
  const session = new RemotelyClosedSession();
  class FakeConstructor {
    constructor() {
      return session;
    }
  }
  const events = [];
  await WebTransportGameClient.connect(
    "https://example.invalid",
    {
      onReliable() {},
      onDatagram() {},
      onClose(code, reason) {
        events.push([code, reason]);
      },
    },
    FakeConstructor,
  );
  session.closedResolve({ closeCode: 7, reason: "peer closed" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(session.closeCalls, 0);
  assert.deepEqual(events, [[7, "peer closed"]]);
});

test("malformed host close metadata is normalized before it reaches the match", async () => {
  class RemotelyClosedSession {
    ready = Promise.resolve();
    incomingUnidirectionalStreams = new ReadableStream();
    incomingBidirectionalStreams = new ReadableStream();
    datagrams = { maxDatagramSize: 8, readable: new ReadableStream(), writable: new WritableStream() };
    closedResolve;
    closed = new Promise((resolve) => {
      this.closedResolve = resolve;
    });
    createUnidirectionalStream() {
      throw new Error("not used");
    }
    createBidirectionalStream() {
      throw new Error("not used");
    }
    close() {
      throw new Error("a remote close must not issue a second close");
    }
  }
  const session = new RemotelyClosedSession();
  class FakeConstructor {
    constructor() {
      return session;
    }
  }
  const events = [];
  await WebTransportGameClient.connect(
    "https://example.invalid",
    {
      onReliable() {},
      onDatagram() {},
      onClose(code, reason) {
        events.push([code, reason]);
      },
    },
    FakeConstructor,
  );
  session.closedResolve({ closeCode: 91_141_958_510_812, reason: "y\uFFFDB\uFFFDK" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, [[1, "invalid peer close metadata"]]);
});

test("peer close reasons are single-line and bounded before logging", async () => {
  class RemotelyClosedSession {
    ready = Promise.resolve();
    incomingUnidirectionalStreams = new ReadableStream();
    incomingBidirectionalStreams = new ReadableStream();
    datagrams = { maxDatagramSize: 8, readable: new ReadableStream(), writable: new WritableStream() };
    closedResolve;
    closed = new Promise((resolve) => {
      this.closedResolve = resolve;
    });
    createUnidirectionalStream() {
      throw new Error("not used");
    }
    createBidirectionalStream() {
      throw new Error("not used");
    }
    close() {}
  }
  const session = new RemotelyClosedSession();
  class FakeConstructor {
    constructor() {
      return session;
    }
  }
  const events = [];
  await WebTransportGameClient.connect(
    "https://example.invalid",
    {
      onReliable() {},
      onDatagram() {},
      onClose(code, reason) {
        events.push([code, reason]);
      },
    },
    FakeConstructor,
  );
  session.closedResolve({ closeCode: 7, reason: `line-one\nline-two${"x".repeat(300)}` });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(events[0][0], 7);
  assert.equal(events[0][1].length, 256);
  assert.doesNotMatch(events[0][1], /[\r\n]/u);
  assert.match(events[0][1], /^line-one line-two/u);
});

test("server snapshot streams are independently cancellable under backpressure", async () => {
  class BackpressuredSession {
    ready = Promise.resolve();
    outgoingStreams = [];
    incomingBidirectionalStreams = new ReadableStream();
    incomingUnidirectionalStreams = new ReadableStream();
    datagrams = { maxDatagramSize: 8, readable: new ReadableStream(), writable: new WritableStream() };
    closeResolve;
    closed = new Promise((resolve) => {
      this.closeResolve = resolve;
    });
    closeCalls = 0;
    capacity = 0;
    rejectClose = false;
    readyResolve;
    readyWaiters = 0;
    async createUnidirectionalStream() {
      const chunks = [];
      this.outgoingStreams.push(chunks);
      let ready = new Promise((resolve) => {
        this.readyResolve = resolve;
      });
      const writer = {
        get desiredSize() {
          return session.capacity;
        },
        get ready() {
          session.readyWaiters += 1;
          return ready;
        },
        write: async (chunk) => {
          chunks.push(chunk.slice());
          this.capacity = 0;
          ready = new Promise((resolve) => {
            this.readyResolve = resolve;
          });
        },
        close: async () => {
          if (this.rejectClose) throw new Error("peer stopped snapshot stream");
        },
        abort: async () => {},
        releaseLock() {},
      };
      return { getWriter: () => writer };
    }
    createBidirectionalStream() {
      throw new Error("not used");
    }
    releaseCapacity() {
      this.capacity = 1;
      this.readyResolve?.();
    }
    close(options = {}) {
      this.closeCalls += 1;
      this.closeResolve({ closeCode: options.closeCode, reason: options.reason });
    }
  }
  const session = new BackpressuredSession();
  const transport = await adoptServerWebTransportSession(session, {
    onReliable() {},
    onDatagram() {},
    onClose() {},
  });
  const stale = new AbortController();
  const first = transport.sendReliable(3, Uint8Array.of(1), stale.signal);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(session.outgoingStreams.length, 1);
  assert.deepEqual(session.outgoingStreams[0], []);
  assert.equal(session.readyWaiters, 1, "one active pump owns the blocked writer.ready wait");
  stale.abort("superseded");
  assert.equal(await first, "backpressured");

  const current = new AbortController();
  const second = transport.sendReliable(3, Uint8Array.of(100), current.signal);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(session.outgoingStreams.length, 2, "fresh state owns a fresh QUIC stream");
  session.releaseCapacity();
  assert.equal(await second, "sent");
  assert.deepEqual([...session.outgoingStreams[1][0]], [3, 1, 0, 0, 0]);
  assert.deepEqual([...session.outgoingStreams[1][1]], [100]);

  session.rejectClose = true;
  const retiredByPeer = transport.sendReliable(3, Uint8Array.of(101));
  await new Promise((resolve) => setImmediate(resolve));
  session.releaseCapacity();
  assert.equal(await retiredByPeer, "backpressured", "a peer-retired snapshot stream is not a session failure");
  assert.equal(session.closeCalls, 0);
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
    closed = new Promise((resolve) => {
      this.closeResolve = resolve;
    });
    closeCalls = 0;
    capacity = 0;
    readyResolve;
    readyWaiters = 0;
    async createUnidirectionalStream() {
      const chunks = [];
      this.outgoingStreams.push(chunks);
      let ready = new Promise((resolve) => {
        this.readyResolve = resolve;
      });
      const session = this;
      const writer = {
        get desiredSize() {
          return session.capacity;
        },
        get ready() {
          session.readyWaiters += 1;
          return ready;
        },
        write: async (chunk) => {
          chunks.push(chunk.slice());
          this.capacity = 0;
          ready = new Promise((resolve) => {
            this.readyResolve = resolve;
          });
        },
        abort: async () => {},
        releaseLock() {},
      };
      return { getWriter: () => writer };
    }
    createBidirectionalStream() {
      throw new Error("not used");
    }
    close(options = {}) {
      this.closeCalls += 1;
      this.closeResolve({ closeCode: options.closeCode, reason: options.reason });
    }
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
  assert.deepEqual(
    await Promise.all(queued),
    queued.map(() => "closed"),
  );
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
    closed = new Promise((resolve) => {
      this.closeResolve = resolve;
    });
    closeCalls = 0;
    createCalls = 0;
    resolveCreate;
    async createUnidirectionalStream() {
      this.createCalls += 1;
      return new Promise((resolve) => {
        this.resolveCreate = () => resolve(new WritableStream());
      });
    }
    createBidirectionalStream() {
      throw new Error("not used");
    }
    close(options = {}) {
      this.closeCalls += 1;
      this.closeResolve({ closeCode: options.closeCode, reason: options.reason });
    }
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
  assert.deepEqual(
    await Promise.all(sends),
    sends.map(() => "closed"),
  );
  assert.equal(session.closeCalls, 1, "pending-create overflow closes once");
  session.resolveCreate?.();
  void transport;
});

void CELL_FLOOR;
