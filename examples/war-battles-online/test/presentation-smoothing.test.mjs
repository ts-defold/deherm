import assert from "node:assert/strict";
import test from "node:test";

import {
  BattleClient,
  DIRECTION_SCALE,
  MatchServer,
  SNAPSHOT_BYTES,
  SNAPSHOT_MESSAGE_BYTES,
  TICK_MILLISECONDS,
  TRANSPORT_CHANNEL_SNAPSHOT,
  createInMemoryTransportPair,
  writeSnapshotKeyframe,
} from "../core/index.ts";
import { waitForCondition } from "./async-conditions.mjs";

const transform = () => ({ x: 0, y: 0, hullX: 0, hullY: 0, turretX: 0, turretY: 0 });

function direction(degrees) {
  const radians = (degrees * Math.PI) / 180;
  return {
    x: Math.round(Math.cos(radians) * DIRECTION_SCALE),
    y: Math.round(Math.sin(radians) * DIRECTION_SCALE),
  };
}

async function join(options = {}) {
  const errors = [];
  const server = new MatchServer({ rosterSize: 2, onError: (error) => errors.push(error) });
  const client = new BattleClient({
    name: "presentation-smoothing",
    onError: (error) => errors.push(error),
    ...options,
  });
  const session = server.createSession();
  const [clientTransport, serverTransport] = createInMemoryTransportPair(client, session);
  session.attach(serverTransport);
  client.attach(clientTransport);
  assert.equal(
    await waitForCondition(() => client.state === "ready", { timeoutMilliseconds: 1_000 }),
    true,
    "client welcome",
  );
  return { client, errors, server };
}

function deliverKeyframe(client, world, tick, raw, frame) {
  world.tick = tick >>> 0;
  world.writeSnapshot(raw);
  const length = writeSnapshotKeyframe(frame, world.tick, raw);
  client.onReliable(TRANSPORT_CHANNEL_SNAPSHOT, frame.subarray(0, length));
}

test("a nonzero update starts new local and remote smoothing at the currently presented pose", async () => {
  const { client, errors, server } = await join();
  const raw = new Uint8Array(SNAPSHOT_BYTES);
  const frame = new Uint8Array(SNAPSHOT_MESSAGE_BYTES);
  const localSlot = client.playerId - 1;
  const remoteSlot = localSlot === 0 ? 1 : 0;

  server.world.playerX[remoteSlot] = 1_000;
  deliverKeyframe(client, server.world, 3, raw, frame);
  client.update(0);
  const firstRemote = transform();
  client.samplePlayerTransform(remoteSlot, firstRemote);

  server.world.playerX[remoteSlot] = 1_100;
  deliverKeyframe(client, server.world, 6, raw, frame);
  client.update(0);
  client.update(10);

  server.world.playerX[remoteSlot] = 1_200;
  deliverKeyframe(client, server.world, 9, raw, frame);
  client.update(17);
  const rebasedRemote = transform();
  client.samplePlayerTransform(remoteSlot, rebasedRemote);
  assert.equal(rebasedRemote.x, Math.trunc(firstRemote.x + (100 * 27) / 50));
  assert.ok(client.stats.remoteInterpolationRebases > 0);
  assert.ok(client.stats.maximumRemoteInterpolationRebaseDistance > 0);
  assert.equal(client.stats.maximumRemoteInterpolationDiscontinuity, 0);

  client.world.playerX[localSlot] += 400;
  const beforeCorrection = transform();
  client.samplePlayerTransform(localSlot, beforeCorrection);
  deliverKeyframe(client, server.world, 12, raw, frame);
  client.update(17);
  const correctionFrame = transform();
  client.samplePlayerTransform(localSlot, correctionFrame);
  assert.equal(correctionFrame.x, beforeCorrection.x, "the preceding frame delta must not decay a new correction");
  assert.equal(client.stats.localCorrectionMagnitude, 400);
  assert.equal(client.stats.maximumLocalCorrectionMagnitude, 400);

  client.update(100);
  assert.equal(client.stats.localCorrectionMagnitude, 0);
  assert.deepEqual(errors, []);
  server.close();
});

test("remote lifecycle changes hard-snap and directions interpolate across the shortest arc", async () => {
  const { client, errors, server } = await join();
  const raw = new Uint8Array(SNAPSHOT_BYTES);
  const frame = new Uint8Array(SNAPSHOT_MESSAGE_BYTES);
  const remoteSlot = client.playerId === 1 ? 1 : 0;
  const positive = direction(170);
  const negative = direction(-170);

  server.world.playerHullX[remoteSlot] = positive.x;
  server.world.playerHullY[remoteSlot] = positive.y;
  server.world.playerTurretX[remoteSlot] = positive.x;
  server.world.playerTurretY[remoteSlot] = positive.y;
  deliverKeyframe(client, server.world, 3, raw, frame);
  client.update(0);

  server.world.playerHullX[remoteSlot] = negative.x;
  server.world.playerHullY[remoteSlot] = negative.y;
  server.world.playerTurretX[remoteSlot] = negative.x;
  server.world.playerTurretY[remoteSlot] = negative.y;
  deliverKeyframe(client, server.world, 6, raw, frame);
  client.update(0);
  client.update(25);
  const halfway = transform();
  client.samplePlayerTransform(remoteSlot, halfway);
  assert.ok(halfway.hullX < -250 && Math.abs(halfway.hullY) <= 2, "170° to -170° must pass through 180°");
  assert.ok(halfway.turretX < -250 && Math.abs(halfway.turretY) <= 2);

  server.world.playerGeneration[remoteSlot] += 1;
  server.world.playerX[remoteSlot] += 2_000;
  deliverKeyframe(client, server.world, 9, raw, frame);
  client.update(0);
  const respawned = transform();
  client.samplePlayerTransform(remoteSlot, respawned);
  assert.equal(respawned.x, server.world.playerX[remoteSlot]);
  assert.equal(client.stats.remoteLifecycleHardSnaps, 1);
  assert.deepEqual(errors, []);
  server.close();
});

test("local direction correction uses the shortest arc and decays over the bounded window", async () => {
  const { client, errors, server } = await join();
  const raw = new Uint8Array(SNAPSHOT_BYTES);
  const frame = new Uint8Array(SNAPSHOT_MESSAGE_BYTES);
  const slot = client.playerId - 1;
  const positive = direction(170);
  const negative = direction(-170);

  deliverKeyframe(client, server.world, 3, raw, frame);
  client.update(0);
  client.world.playerHullX[slot] = positive.x;
  client.world.playerHullY[slot] = positive.y;
  client.world.playerTurretX[slot] = positive.x;
  client.world.playerTurretY[slot] = positive.y;
  server.world.playerHullX[slot] = negative.x;
  server.world.playerHullY[slot] = negative.y;
  server.world.playerTurretX[slot] = negative.x;
  server.world.playerTurretY[slot] = negative.y;
  const before = transform();
  client.samplePlayerTransform(slot, before);

  deliverKeyframe(client, server.world, 6, raw, frame);
  client.update(0);
  const continuous = transform();
  client.samplePlayerTransform(slot, continuous);
  assert.ok(continuous.hullX < -240 && continuous.hullY > 0, "correction frame retains the +170° pose");
  client.update(50);
  const halfway = transform();
  client.samplePlayerTransform(slot, halfway);
  assert.ok(halfway.hullX < -250 && Math.abs(halfway.hullY) <= 2, "local correction crosses the ±180° seam");
  client.update(50);
  const settled = transform();
  client.samplePlayerTransform(slot, settled);
  assert.equal(settled.hullX, client.world.playerHullX[slot]);
  assert.equal(settled.hullY, client.world.playerHullY[slot]);
  assert.deepEqual(errors, []);
  server.close();
});

test("prediction lead decays after sustained recovery and catches down without rewinding", async () => {
  const { client, errors, server } = await join({ leadTicks: 2 });
  const raw = new Uint8Array(SNAPSHOT_BYTES);
  const frame = new Uint8Array(SNAPSHOT_MESSAGE_BYTES);
  let snapshotTick = 0;

  for (let sample = 0; sample < 6; sample += 1) {
    client.update(TICK_MILLISECONDS * 4, 8);
    snapshotTick += 1;
    deliverKeyframe(client, server.world, snapshotTick, raw, frame);
    client.update(0);
  }
  const inflatedLead = client.leadTicks;
  assert.ok(inflatedLead > 3, `expected an inflated lead, got ${inflatedLead}`);

  for (let sample = 0; sample < 96 && client.stats.inputLeadDecreases === 0; sample += 1) {
    snapshotTick = ((client.world?.tick ?? snapshotTick) + 1) >>> 0;
    deliverKeyframe(client, server.world, snapshotTick, raw, frame);
    client.update(0);
    client.update(TICK_MILLISECONDS);
  }
  assert.ok(client.stats.inputLeadDecreases > 0, "sustained low transit must lower the adaptive lead");
  assert.ok(client.leadTicks < inflatedLead);
  assert.equal(client.stats.inputLeadCatchdownSkips, client.stats.inputLeadDecreases);
  assert.deepEqual(errors, []);
  server.close();
});
