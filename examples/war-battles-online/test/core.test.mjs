import assert from "node:assert/strict";
import test from "node:test";

import {
  ArenaMap,
  BattleClient,
  CELL_WALL,
  cellOfX,
  cellOfY,
  BattleWorld,
  BotController,
  BrowserWebTransportClient,
  CELL_FLOOR,
  CONTROL_BUY_UPGRADE,
  EVENT_KILL,
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
  PlayableBattle,
  RESUME_TOKEN_BYTES,
  SNAPSHOT_BYTES,
  TICK_MILLISECONDS,
  TRANSPORT_CHANNEL_CONTROL,
  TRANSPORT_CHANNEL_SESSION,
  UPGRADE_DAMAGE,
  WELCOME_BYTES,
  WEAPON_AUTOCANNON,
  WEAPON_MORTAR,
  WEAPON_RICOCHET,
  WEAPON_SCATTER,
  createBattleEvent,
  createInMemoryTransportPair,
  createInputCommand,
  createPlayerView,
  isqrt,
  readHello,
  readInputPacket,
  readWelcome,
  sendTickInput,
  writeHello,
  writeInputPacket,
  writeWelcome,
} from "../core/index.ts";
import { UPGRADE_MOBILITY } from "../core/content.ts";

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
    mapSeed: 0x1234_5678, serverTick: 4_321, tickRate: 60, resumeToken: token,
  });
  const observedWelcome = { matchId: 0, playerId: 0, team: 0, maximumPlayers: 0, botCount: 0, mapSeed: 0, serverTick: 0, tickRate: 0, resumeToken: new Uint8Array(RESUME_TOKEN_BYTES) };
  readWelcome(welcome, observedWelcome);
  assert.equal(observedWelcome.playerId, 3);
  assert.equal(observedWelcome.mapSeed, 0x1234_5678);
  assert.equal(observedWelcome.serverTick, 4_321);
  assert.throws(() => readHello(welcome, observedHello), /not kind/);
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
  const session = server.createSession();
  const [clientTransport, serverTransport] = createInMemoryTransportPair(client, session, options.transport);
  session.attach(serverTransport);
  client.attach(clientTransport);
  client.session = session;
  return client;
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

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

test("a control message buys an upgrade through the reliable lane", async () => {
  const errors = [];
  const server = new MatchServer({ rosterSize: 4, onError: (error) => errors.push(error) });
  const client = join(server, "buyer", errors);
  await settle();
  server.step();
  await settle();
  server.world.grantCredits(client.playerId, 500);
  const before = server.world.playerDamageLevel[client.playerId - 1];
  client.sendControl(CONTROL_BUY_UPGRADE, UPGRADE_DAMAGE);
  await settle();
  assert.equal(server.world.playerDamageLevel[client.playerId - 1], before + 1);
  assert.deepEqual(errors, []);
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

test("the browser adapter frames streams, handles fragmented reads, and checks datagram size", async () => {
  class FakeSession {
    ready = Promise.resolve();
    outgoingStreams = [];
    outgoingDatagrams = [];
    closeResolve;
    incomingController;
    datagramController;
    closed = new Promise((resolve) => { this.closeResolve = resolve; });
    incomingUnidirectionalStreams = new ReadableStream({
      start: (controller) => { this.incomingController = controller; },
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
      const chunks = [];
      return new WritableStream({
        write(chunk) { chunks.push(chunk.slice()); },
        close: () => { this.outgoingStreams.push(chunks); },
      });
    }
    close(options = {}) {
      this.incomingController.close();
      this.datagramController.close();
      this.closeResolve({ closeCode: options.closeCode, reason: options.reason });
    }
    pushReliable(channel, payload) {
      const frame = new Uint8Array(5 + payload.length);
      const view = new DataView(frame.buffer);
      view.setUint8(0, channel);
      view.setUint32(1, payload.length, true);
      frame.set(payload, 5);
      this.incomingController.enqueue(new ReadableStream({
        start(controller) {
          controller.enqueue(frame.subarray(0, 2));
          controller.enqueue(frame.subarray(2, 6));
          controller.enqueue(frame.subarray(6));
          controller.close();
        },
      }));
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
  assert.equal(await client.sendReliable(TRANSPORT_CHANNEL_SESSION, Uint8Array.of(8, 9)), "sent");
  assert.equal(session.outgoingStreams.length, 1);
  assert.deepEqual([...session.outgoingStreams[0][0]], [TRANSPORT_CHANNEL_SESSION, 2, 0, 0, 0]);
  assert.deepEqual([...session.outgoingStreams[0][1]], [8, 9]);
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
});

void CELL_FLOOR;
