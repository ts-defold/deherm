import assert from "node:assert/strict";
import test from "node:test";

import {
  BattleWorld,
  BrowserWebTransportClient,
  INPUT_BUTTON_FIRE,
  INPUT_PACKET_BYTES,
  MAX_PLAYERS,
  PlayableBattle,
  projectWorldToScreen,
  SNAPSHOT_BYTES,
  TRANSPORT_CHANNEL_CONTROL,
  TRANSPORT_CHANNEL_SESSION,
  UPGRADE_DAMAGE,
  WEAPON_AUTOCANNON,
  createInMemoryTransportPair,
  readInputPacket,
  sendTickInput,
  writeInputPacket,
} from "../core/index.ts";
import { UPGRADE_MOBILITY } from "../core/content.ts";

function command(playerId, tick, overrides = {}) {
  return {
    matchId: 77,
    playerId,
    tick,
    sequence: tick & 0xffff,
    moveX: 0,
    moveY: 0,
    aimX: 127,
    aimY: 0,
    buttons: 0,
    fireSubtick: 255,
    latestSnapshotTick: tick > 0 ? tick - 1 : 0,
    snapshotAckBits: 0xffff_ffff,
    ...overrides,
  };
}

function playerView() {
  return {
    active: false, entityId: 0, playerId: 0, team: 0, x: 0, y: 0,
    aimX: 0, aimY: 0, health: 0, score: 0, credits: 0,
    weaponId: 0, damageLevel: 0, mobilityLevel: 0, armorLevel: 0,
  };
}

test("input packets round-trip every authoritative and acknowledgement field", () => {
  const expected = command(7, 0x1020_3040, {
    sequence: 65_530,
    moveX: -127,
    moveY: 42,
    aimX: 99,
    aimY: -11,
    buttons: INPUT_BUTTON_FIRE,
    fireSubtick: 91,
    latestSnapshotTick: 0x1020_3030,
    snapshotAckBits: 0xa55a_0ff0,
  });
  const packet = new Uint8Array(INPUT_PACKET_BYTES + 8);
  assert.equal(writeInputPacket(packet, 4, expected), INPUT_PACKET_BYTES + 4);
  const actual = command(1, 1);
  assert.equal(readInputPacket(packet, 4, actual), INPUT_PACKET_BYTES + 4);
  assert.deepEqual(actual, expected);
  packet[12] ^= 1;
  assert.throws(() => readInputPacket(packet, 4, actual), /checksum/);
});

test("32-player results are stable across input arrival order", () => {
  const ascending = new BattleWorld(77);
  const descending = new BattleWorld(77);
  for (let playerId = 1; playerId <= MAX_PLAYERS; playerId += 1) {
    ascending.addPlayer(playerId, (playerId % 4) + 1);
    descending.addPlayer(playerId, (playerId % 4) + 1);
  }
  for (let tick = 1; tick <= 360; tick += 1) {
    for (let playerId = 1; playerId <= MAX_PLAYERS; playerId += 1) {
      const input = command(playerId, tick, {
        moveX: ((playerId + tick) % 3) - 1,
        moveY: ((playerId * 3 + tick) % 3) - 1,
        aimX: playerId % 2 === 0 ? -127 : 127,
        aimY: playerId % 3 === 0 ? 127 : 0,
        buttons: tick % 31 === playerId % 31 ? INPUT_BUTTON_FIRE : 0,
      });
      assert.equal(ascending.submitInput(input), true);
    }
    for (let playerId = MAX_PLAYERS; playerId >= 1; playerId -= 1) {
      const input = command(playerId, tick, {
        moveX: ((playerId + tick) % 3) - 1,
        moveY: ((playerId * 3 + tick) % 3) - 1,
        aimX: playerId % 2 === 0 ? -127 : 127,
        aimY: playerId % 3 === 0 ? 127 : 0,
        buttons: tick % 31 === playerId % 31 ? INPUT_BUTTON_FIRE : 0,
      });
      assert.equal(descending.submitInput(input), true);
    }
    ascending.step();
    descending.step();
    assert.equal(ascending.stateHash(), descending.stateHash(), `state diverged on tick ${tick}`);
  }
});

test("authoritative combat applies data-driven upgrades and awards the kill", () => {
  const world = new BattleWorld(77);
  world.addPlayer(1, 1, 0, 0);
  world.addPlayer(2, 2, 1_200, 0);
  world.grantCredits(1, 1_000);
  assert.equal(world.applyUpgrade(1, UPGRADE_DAMAGE), true);
  assert.equal(world.applyUpgrade(1, UPGRADE_DAMAGE), true);
  assert.equal(world.applyUpgrade(1, UPGRADE_DAMAGE), true);
  for (let tick = 1; tick <= 60; tick += 1) {
    if (tick === 1 || tick === 19 || tick === 37) {
      assert.equal(world.submitInput(command(1, tick, { buttons: INPUT_BUTTON_FIRE, fireSubtick: 20 })), true);
    }
    world.step();
  }
  const shooter = playerView();
  const target = playerView();
  world.readPlayer(1, shooter);
  world.readPlayer(2, target);
  assert.equal(target.health, 0);
  assert.equal(shooter.score, 1);
  assert.equal(shooter.credits, 575);
  assert.equal(shooter.damageLevel, 3);
});

test("a full snapshot restores and deterministically replays queued inputs", () => {
  const world = new BattleWorld(77);
  world.addPlayer(1, 1, -2_000, 0);
  world.addPlayer(2, 2, 2_000, 0);
  world.setWeapon(1, WEAPON_AUTOCANNON);
  for (let tick = 1; tick <= 80; tick += 1) {
    world.submitInput(command(1, tick, {
      moveX: tick < 20 ? 1 : 0,
      buttons: tick % 7 === 1 ? INPUT_BUTTON_FIRE : 0,
    }));
    world.submitInput(command(2, tick, { moveX: tick < 20 ? -1 : 0, aimX: -127 }));
  }
  for (let tick = 1; tick <= 30; tick += 1) world.step();
  const snapshot = new Uint8Array(SNAPSHOT_BYTES);
  assert.equal(world.writeSnapshot(snapshot), SNAPSHOT_BYTES);
  for (let tick = 31; tick <= 80; tick += 1) world.step();
  const expectedHash = world.stateHash();
  world.restoreSnapshot(snapshot);
  // Snapshots contain authoritative simulation state, not the external replay log.
  // Re-submit the recorded inputs that followed the rollback point.
  for (let tick = 31; tick <= 80; tick += 1) {
    world.submitInput(command(1, tick, {
      moveX: tick < 20 ? 1 : 0,
      buttons: tick % 7 === 1 ? INPUT_BUTTON_FIRE : 0,
    }));
    world.submitInput(command(2, tick, { moveX: tick < 20 ? -1 : 0, aimX: -127 }));
  }
  for (let tick = 31; tick <= 80; tick += 1) world.step();
  assert.equal(world.stateHash(), expectedHash);
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
  for (let tick = 1; tick <= 2_000; tick += 1) {
    for (let playerId = 1; playerId <= MAX_PLAYERS; playerId += 1) {
      world.submitInput(command(playerId, tick, {
        moveX: playerId % 2 === 0 ? 1 : -1,
        buttons: tick % 20 === playerId % 20 ? INPUT_BUTTON_FIRE : 0,
      }));
    }
    world.step();
  }
  assert.equal(world.playerX, playerX);
  assert.equal(world.projectileX, projectiles);
  assert.equal(world.playerX.byteLength, MAX_PLAYERS * Int32Array.BYTES_PER_ELEMENT);
});

test("playable orchestration drives 31 deterministic bots and supports restart/upgrades", () => {
  const first = new PlayableBattle();
  const second = new PlayableBattle();
  let observedProjectile = false;
  for (let tick = 0; tick < 900; tick += 1) {
    const controls = {
      moveX: tick < 240 ? 1 : tick < 480 ? 0 : -1,
      moveY: tick < 300 ? 1 : tick < 600 ? -1 : 0,
      fire: tick % 3 !== 0,
    };
    first.setControls(controls);
    second.setControls(controls);
    first.step();
    second.step();
    observedProjectile ||= first.world.projectileActive.some((value) => value !== 0);
  }
  assert.equal(first.world.stateHash(), second.world.stateHash());
  assert.equal(first.round, second.round);
  assert.equal(first.world.tick, second.world.tick);
  assert.ok(first.round > 1, "the defeated local player should exercise automatic restart");
  assert.equal(observedProjectile, true);
  assert.equal(first.buyUpgrade(UPGRADE_MOBILITY), true);
  const priorRound = first.round;
  first.restart();
  assert.equal(first.round, priorRound + 1);
  assert.equal(first.world.tick, 0);
  assert.equal(first.world.playerActive.reduce((sum, value) => sum + value, 0), MAX_PLAYERS);
});

test("camera projection keeps the followed tank centered", () => {
  const point = { x: 0, y: 0 };
  projectWorldToScreen(1200, -900, 1200, -900, 1280, 720, 0.035, point);
  assert.deepEqual(point, { x: 640, y: 360 });
  projectWorldToScreen(2200, 100, 1200, -900, 1280, 720, 0.035, point);
  assert.deepEqual(point, { x: 675, y: 395 });
});

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
