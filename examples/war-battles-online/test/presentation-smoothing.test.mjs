import assert from "node:assert/strict";
import test from "node:test";

import {
  BattleClient,
  DIRECTION_SCALE,
  MatchServer,
  NETWORK_SNAPSHOT_BYTES,
  NETWORK_SNAPSHOT_MESSAGE_BYTES,
  PLAYER_MODE_DEAD,
  PLAYER_MODE_INFANTRY,
  PLAYER_MODE_TANK,
  SNAPSHOT_BYTES,
  TICK_MILLISECONDS,
  TRANSPORT_CHANNEL_SNAPSHOT,
  VELOCITY_SCALE,
  createInMemoryTransportPair,
  compactNetworkSnapshot,
  writeNetworkSnapshotKeyframe,
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
  const server = new MatchServer({
    rosterSize: 2,
    snapshotIntervalTicks: options.snapshotIntervalTicks ?? 3,
    onError: (error) => errors.push(error),
  });
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

function deliverKeyframe(client, world, tick, raw, network, frame) {
  world.tick = tick >>> 0;
  world.writeSnapshot(raw);
  compactNetworkSnapshot(raw, network);
  const length = writeNetworkSnapshotKeyframe(frame, world.tick, network);
  client.onReliable(TRANSPORT_CHANNEL_SNAPSHOT, frame.subarray(0, length));
}

test("the first visible online pose comes from the authoritative keyframe, not the guessed roster", async () => {
  const { client, errors, server } = await join();
  const raw = new Uint8Array(SNAPSHOT_BYTES);
  const network = new Uint8Array(NETWORK_SNAPSHOT_BYTES);
  const frame = new Uint8Array(NETWORK_SNAPSHOT_MESSAGE_BYTES);
  const localSlot = client.playerId - 1;
  const presented = transform();

  assert.equal(client.stats.snapshotsApplied, 0);
  assert.equal(client.samplePlayerTransform(localSlot, presented), false, "welcome guesses are not a renderable pose");
  server.world.playerX[localSlot] += 800;
  deliverKeyframe(client, server.world, 3, raw, network, frame);
  client.update(0);
  assert.equal(client.samplePlayerTransform(localSlot, presented), true);
  assert.equal(presented.x, client.world.playerX[localSlot]);
  assert.equal(client.stats.maximumLocalCorrectionMagnitude, 0, "first keyframe is a spawn, not a correction");
  assert.equal(client.stats.maximumPredictionErrorMagnitude, 0, "first keyframe has no same-tick prediction baseline");
  assert.equal(
    client.stats.localCorrectionBuckets.reduce((sum, count) => sum + count, 0),
    0,
  );
  assert.deepEqual(errors, []);
  server.close();
});

test("remote art lifecycle is sampled with its authoritative pose, not the newer prediction world", async () => {
  const { client, errors, server } = await join();
  const raw = new Uint8Array(SNAPSHOT_BYTES);
  const network = new Uint8Array(NETWORK_SNAPSHOT_BYTES);
  const frame = new Uint8Array(NETWORK_SNAPSHOT_MESSAGE_BYTES);
  const remoteSlot = client.playerId === 1 ? 1 : 0;
  server.world.playerVelocityX[remoteSlot] = 2 * VELOCITY_SCALE;
  deliverKeyframe(client, server.world, 3, raw, network, frame);
  client.update(0);

  const presented = transform();
  assert.equal(client.samplePlayerTransform(remoteSlot, presented), true);
  assert.equal(presented.mode, PLAYER_MODE_TANK);
  const authoritative = { ...presented };
  // Prediction can see a remote eject or new chassis before the next accepted
  // authoritative sample. Rendering that world metadata with the old position
  // made a driver/tank appear to swap independently of its pose.
  client.world.playerMode[remoteSlot] = PLAYER_MODE_INFANTRY;
  client.world.playerGeneration[remoteSlot] += 1;
  client.world.playerChassis[remoteSlot] += 1;
  client.world.playerVelocityX[remoteSlot] = 0;
  client.world.playerActive[remoteSlot] = 0;
  assert.equal(client.samplePlayerTransform(remoteSlot, presented), true);
  assert.deepEqual(presented, authoritative);
  assert.deepEqual(errors, []);
  server.close();
});

test("remote rendered-step telemetry counts same-life jumps but excludes lifecycle snaps", async () => {
  const { client, errors, server } = await join();
  const raw = new Uint8Array(SNAPSHOT_BYTES);
  const network = new Uint8Array(NETWORK_SNAPSHOT_BYTES);
  const frame = new Uint8Array(NETWORK_SNAPSHOT_MESSAGE_BYTES);
  const remoteSlot = client.playerId === 1 ? 1 : 0;
  const presented = transform();

  deliverKeyframe(client, server.world, 3, raw, network, frame);
  client.update(0);
  assert.equal(client.samplePlayerTransform(remoteSlot, presented), true);
  const originalX = presented.x;
  server.world.playerX[remoteSlot] += 40 * 16;
  deliverKeyframe(client, server.world, 6, raw, network, frame);
  client.update(0);
  client.update(60);
  assert.equal(client.samplePlayerTransform(remoteSlot, presented), true);
  assert.equal(presented.x - originalX, 40 * 16);
  assert.equal(client.stats.maximumRemotePresentedStepDistance, 40 * 16);
  assert.equal(client.stats.remotePresentedStepsOverThirtyTwoPixels, 1);

  server.world.playerGeneration[remoteSlot] += 1;
  server.world.playerX[remoteSlot] += 100 * 16;
  deliverKeyframe(client, server.world, 9, raw, network, frame);
  client.update(0);
  assert.equal(client.samplePlayerTransform(remoteSlot, presented), true);
  assert.equal(client.stats.remoteLifecycleHardSnaps, 1);
  assert.equal(client.stats.remotePresentedStepsOverThirtyTwoPixels, 1);
  assert.deepEqual(errors, []);
  server.close();
});

test("a coalesced remote snapshot does not compress a long gap into one cadence", async () => {
  const { client, errors, server } = await join({ snapshotIntervalTicks: 6 });
  const raw = new Uint8Array(SNAPSHOT_BYTES);
  const network = new Uint8Array(NETWORK_SNAPSHOT_BYTES);
  const frame = new Uint8Array(NETWORK_SNAPSHOT_MESSAGE_BYTES);
  const remoteSlot = client.playerId === 1 ? 1 : 0;
  const presented = transform();

  deliverKeyframe(client, server.world, 6, raw, network, frame);
  client.update(0);
  assert.equal(client.samplePlayerTransform(remoteSlot, presented), true);
  const startX = presented.x;
  server.world.playerX[remoteSlot] += 240 * 16;
  server.world.playerVelocityX[remoteSlot] = 0;
  deliverKeyframe(client, server.world, 30, raw, network, frame);
  client.update(0);

  let previousX = startX;
  for (let tick = 0; tick < 16; tick += 1) {
    client.update(TICK_MILLISECONDS);
    assert.equal(client.samplePlayerTransform(remoteSlot, presented), true);
    assert.ok(presented.x >= previousX, "the remote actor does not reverse during catch-up");
    assert.ok(presented.x - previousX <= 16 * 16 + 1, "one render tick stays within the presentation speed cap");
    previousX = presented.x;
  }
  assert.equal(presented.x, server.world.playerX[remoteSlot], "a stable target is eventually reached");
  assert.equal(client.stats.remotePresentedStepsOverThirtyTwoPixels, 0);
  assert.deepEqual(errors, []);
  server.close();
});

test("a dead local wreck stays where it was presented until a new lifecycle", async () => {
  const { client, errors, server } = await join();
  const raw = new Uint8Array(SNAPSHOT_BYTES);
  const network = new Uint8Array(NETWORK_SNAPSHOT_BYTES);
  const frame = new Uint8Array(NETWORK_SNAPSHOT_MESSAGE_BYTES);
  const localSlot = client.playerId - 1;
  const presented = transform();

  deliverKeyframe(client, server.world, 3, raw, network, frame);
  client.update(0);
  server.world.playerMode[localSlot] = PLAYER_MODE_DEAD;
  server.world.playerHealth[localSlot] = 0;
  deliverKeyframe(client, server.world, 6, raw, network, frame);
  client.update(0);
  assert.equal(client.samplePlayerTransform(localSlot, presented), true);
  const wreckX = presented.x;

  server.world.playerX[localSlot] += 200 * 16;
  deliverKeyframe(client, server.world, 9, raw, network, frame);
  client.update(0);
  assert.equal(client.samplePlayerTransform(localSlot, presented), true);
  assert.equal(client.world.playerX[localSlot], wreckX + 200 * 16, "authority still updates the simulation");
  assert.equal(presented.x, wreckX, "late corpse correction must not drag the visible wreck or camera");
  assert.ok(client.stats.maximumLocalCorrectionMagnitude >= 200 * 16, "logical disagreement remains observable");
  assert.equal(client.stats.localPresentedStepsOverThirtyTwoPixels, 0);

  server.world.playerGeneration[localSlot] += 1;
  server.world.playerMode[localSlot] = PLAYER_MODE_TANK;
  server.world.playerHealth[localSlot] = 100;
  deliverKeyframe(client, server.world, 12, raw, network, frame);
  client.update(0);
  assert.equal(client.samplePlayerTransform(localSlot, presented), true);
  assert.equal(presented.x, server.world.playerX[localSlot], "new life must use its authoritative spawn pose");
  assert.equal(client.stats.localPresentedStepsOverThirtyTwoPixels, 0, "new lifecycles are not same-life teleports");
  assert.deepEqual(errors, []);
  server.close();
});

test("first-keyframe lead recovery follows the advertised snapshot cadence", async () => {
  for (const elapsedTicks of [10, 18]) {
    const { client, errors, server } = await join({ leadTicks: 2 });
    const raw = new Uint8Array(SNAPSHOT_BYTES);
    const network = new Uint8Array(NETWORK_SNAPSHOT_BYTES);
    const frame = new Uint8Array(NETWORK_SNAPSHOT_MESSAGE_BYTES);
    client.update(TICK_MILLISECONDS * elapsedTicks, elapsedTicks);
    deliverKeyframe(client, server.world, 6, raw, network, frame);
    client.update(0);
    assert.equal(client.stats.snapshotsApplied, 1);
    assert.ok(
      client.leadTicks >= 7,
      `a delayed first frame catches up before later snapshots arrive (lead=${client.leadTicks}, local=${client.world?.tick})`,
    );
    assert.ok(client.stats.inputLeadIncreases >= 5);
    assert.deepEqual(errors, []);
    server.close();
  }
});

test("an overtaking first keyframe restores the future input timeline", async () => {
  const { client, errors, server } = await join({ leadTicks: 8 });
  const raw = new Uint8Array(SNAPSHOT_BYTES);
  const network = new Uint8Array(NETWORK_SNAPSHOT_BYTES);
  const frame = new Uint8Array(NETWORK_SNAPSHOT_MESSAGE_BYTES);
  const snapshotTick = (client.world.tick + 1) >>> 0;
  deliverKeyframe(client, server.world, snapshotTick, raw, network, frame);
  client.update(0);
  assert.equal(client.stats.snapshotsApplied, 1);
  assert.ok(
    client.world.tick >= snapshotTick + client.leadTicks + 1,
    "an overtaking keyframe must leave the next command on a future authoritative tick",
  );
  assert.equal(client.leadTicks, 8, "a snapshot overtaking welcome must not silently consume the configured lead");
  assert.deepEqual(errors, []);
  server.close();
});

test("one delayed snapshot does not inflate lead, but sustained transit does", async () => {
  const { client, errors, server } = await join({ leadTicks: 8 });
  const raw = new Uint8Array(SNAPSHOT_BYTES);
  const network = new Uint8Array(NETWORK_SNAPSHOT_BYTES);
  const frame = new Uint8Array(NETWORK_SNAPSHOT_MESSAGE_BYTES);
  deliverKeyframe(client, server.world, 3, raw, network, frame);
  client.update(0);
  client.update(TICK_MILLISECONDS * 6, 6);
  deliverKeyframe(client, server.world, client.world.tick - 10, raw, network, frame);
  client.update(0);
  assert.equal(client.leadTicks, 8);

  client.update(TICK_MILLISECONDS * 30, 30);
  deliverKeyframe(client, server.world, client.world.tick - 28, raw, network, frame);
  client.update(0);
  assert.equal(client.leadTicks, 8, "a single late stream must not turn snapshot cadence into input delay");

  for (let sample = 0; sample < 12; sample += 1) {
    client.update(TICK_MILLISECONDS * 6, 6);
    deliverKeyframe(client, server.world, client.world.tick - 28, raw, network, frame);
    client.update(0);
  }
  assert.ok(client.leadTicks > 8, "a sustained transit increase must eventually grow the future input budget");
  assert.deepEqual(errors, []);
  server.close();
});

test("a nonzero update starts new local and remote smoothing at the currently presented pose", async () => {
  const { client, errors, server } = await join();
  const raw = new Uint8Array(SNAPSHOT_BYTES);
  const network = new Uint8Array(NETWORK_SNAPSHOT_BYTES);
  const frame = new Uint8Array(NETWORK_SNAPSHOT_MESSAGE_BYTES);
  const localSlot = client.playerId - 1;
  const remoteSlot = localSlot === 0 ? 1 : 0;

  server.world.playerX[remoteSlot] = 1_000;
  deliverKeyframe(client, server.world, 3, raw, network, frame);
  client.update(0);
  const firstRemote = transform();
  client.samplePlayerTransform(remoteSlot, firstRemote);

  server.world.playerX[remoteSlot] = 1_100;
  deliverKeyframe(client, server.world, 6, raw, network, frame);
  client.update(0);
  client.update(10);

  server.world.playerX[remoteSlot] = 1_200;
  deliverKeyframe(client, server.world, 9, raw, network, frame);
  client.update(17);
  const rebasedRemote = transform();
  client.samplePlayerTransform(remoteSlot, rebasedRemote);
  assert.equal(rebasedRemote.x, Math.trunc(firstRemote.x + (100 * 27) / 50));
  assert.ok(client.stats.remoteInterpolationRebases > 0);
  assert.ok(client.stats.maximumRemoteInterpolationRebaseDistance > 0);
  assert.equal(client.stats.maximumRemoteInterpolationDiscontinuity, 0);

  client.world.playerX[localSlot] += 600;
  const beforeCorrection = transform();
  client.samplePlayerTransform(localSlot, beforeCorrection);
  const correctionSnapshotTick = client.world.tick;
  deliverKeyframe(client, server.world, correctionSnapshotTick, raw, network, frame);
  client.update(17);
  const correctionFrame = transform();
  client.samplePlayerTransform(localSlot, correctionFrame);
  assert.equal(correctionFrame.x, beforeCorrection.x, "the preceding frame delta must not decay a new correction");
  assert.equal(client.stats.localCorrectionMagnitude, 600);
  assert.equal(client.stats.maximumLocalCorrectionMagnitude, 600);
  assert.equal(client.stats.lastPredictionErrorMagnitude, 600);
  assert.equal(client.stats.maximumPredictionErrorMagnitude, 600);
  assert.equal(client.stats.lastLargeCorrectionMagnitude, 600);
  assert.equal(client.stats.lastLargeCorrectionPredictionErrorMagnitude, 600);
  assert.equal(client.stats.lastLargeCorrectionPredictionComparable, true);
  assert.equal(client.stats.lastLargeCorrectionSnapshotTick, correctionSnapshotTick);
  assert.equal(client.stats.lastLargeCorrectionPredictedX, beforeCorrection.x);
  assert.equal(client.stats.lastLargeCorrectionPresentedX, beforeCorrection.x);
  assert.equal(client.stats.lastLargeCorrectionCorrectedX, beforeCorrection.x - 600);

  // A second same-tick snapshot can arrive while the first visual offset is
  // still decaying. Its unchanged simulation pose is not another prediction
  // miss, even though the presentation still owes the viewer some smoothing.
  client.update(17);
  server.world.playerX[localSlot] = client.world.playerX[localSlot];
  server.world.playerY[localSlot] = client.world.playerY[localSlot];
  deliverKeyframe(client, server.world, client.world.tick, raw, network, frame);
  client.update(0);
  assert.equal(client.stats.lastPredictionErrorMagnitude, 0);
  assert.ok(client.stats.localCorrectionMagnitude > 0);
  assert.equal(client.stats.maximumPredictionErrorMagnitude, 600);

  client.update(100);
  assert.ok(client.stats.localCorrectionMagnitude > 0, "a larger correction remains visually smoothed past 100 ms");
  client.update(300);
  assert.equal(client.stats.localCorrectionMagnitude, 0);
  assert.deepEqual(errors, []);
  server.close();
});

test("remote lifecycle changes hard-snap and directions interpolate across the shortest arc", async () => {
  const { client, errors, server } = await join();
  const raw = new Uint8Array(SNAPSHOT_BYTES);
  const network = new Uint8Array(NETWORK_SNAPSHOT_BYTES);
  const frame = new Uint8Array(NETWORK_SNAPSHOT_MESSAGE_BYTES);
  const remoteSlot = client.playerId === 1 ? 1 : 0;
  const positive = direction(170);
  const negative = direction(-170);

  server.world.playerHullX[remoteSlot] = positive.x;
  server.world.playerHullY[remoteSlot] = positive.y;
  server.world.playerTurretX[remoteSlot] = positive.x;
  server.world.playerTurretY[remoteSlot] = positive.y;
  deliverKeyframe(client, server.world, 3, raw, network, frame);
  client.update(0);

  server.world.playerHullX[remoteSlot] = negative.x;
  server.world.playerHullY[remoteSlot] = negative.y;
  server.world.playerTurretX[remoteSlot] = negative.x;
  server.world.playerTurretY[remoteSlot] = negative.y;
  deliverKeyframe(client, server.world, 6, raw, network, frame);
  client.update(0);
  client.update(25);
  const halfway = transform();
  client.samplePlayerTransform(remoteSlot, halfway);
  assert.ok(halfway.hullX < -250 && Math.abs(halfway.hullY) <= 2, "170° to -170° must pass through 180°");
  assert.ok(halfway.turretX < -250 && Math.abs(halfway.turretY) <= 2);

  server.world.playerGeneration[remoteSlot] += 1;
  server.world.playerX[remoteSlot] += 2_000;
  deliverKeyframe(client, server.world, 9, raw, network, frame);
  client.update(0);
  const respawned = transform();
  client.samplePlayerTransform(remoteSlot, respawned);
  assert.equal(respawned.x, server.world.playerX[remoteSlot]);
  assert.equal(client.stats.remoteLifecycleHardSnaps, 1);
  assert.deepEqual(errors, []);
  server.close();
});

test("a stalled remote snapshot extrapolates one bounded cadence and then freezes", async () => {
  const { client, errors, server } = await join();
  const raw = new Uint8Array(SNAPSHOT_BYTES);
  const network = new Uint8Array(NETWORK_SNAPSHOT_BYTES);
  const frame = new Uint8Array(NETWORK_SNAPSHOT_MESSAGE_BYTES);
  const remoteSlot = client.playerId === 1 ? 1 : 0;

  server.world.playerX[remoteSlot] = 1_000;
  server.world.playerVelocityX[remoteSlot] = 2 * VELOCITY_SCALE;
  deliverKeyframe(client, server.world, 3, raw, network, frame);
  client.update(0);

  server.world.playerX[remoteSlot] = 1_006;
  deliverKeyframe(client, server.world, 6, raw, network, frame);
  client.update(0);
  client.update(TICK_MILLISECONDS * 3);
  const atLatestSnapshot = transform();
  client.samplePlayerTransform(remoteSlot, atLatestSnapshot);
  assert.equal(atLatestSnapshot.x, 1_006);

  client.update(TICK_MILLISECONDS * 1.5);
  const extrapolated = transform();
  client.samplePlayerTransform(remoteSlot, extrapolated);
  assert.equal(extrapolated.x, 1_009, "velocity carries the remote tank through a short snapshot stall");

  client.update(TICK_MILLISECONDS * 30);
  const bounded = transform();
  client.samplePlayerTransform(remoteSlot, bounded);
  assert.equal(bounded.x, 1_012, "extrapolation stops after one advertised snapshot cadence");
  client.update(TICK_MILLISECONDS * 30);
  const stillBounded = transform();
  client.samplePlayerTransform(remoteSlot, stillBounded);
  assert.equal(stillBounded.x, bounded.x);
  assert.deepEqual(errors, []);
  server.close();
});

test("local direction correction uses the shortest arc and decays over the bounded window", async () => {
  const { client, errors, server } = await join();
  const raw = new Uint8Array(SNAPSHOT_BYTES);
  const network = new Uint8Array(NETWORK_SNAPSHOT_BYTES);
  const frame = new Uint8Array(NETWORK_SNAPSHOT_MESSAGE_BYTES);
  const slot = client.playerId - 1;
  const positive = direction(170);
  const negative = direction(-170);

  deliverKeyframe(client, server.world, 3, raw, network, frame);
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

  deliverKeyframe(client, server.world, 6, raw, network, frame);
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
  const network = new Uint8Array(NETWORK_SNAPSHOT_BYTES);
  const frame = new Uint8Array(NETWORK_SNAPSHOT_MESSAGE_BYTES);
  let snapshotTick = 0;

  for (let sample = 0; sample < 6; sample += 1) {
    client.update(TICK_MILLISECONDS * 4, 8);
    snapshotTick += 1;
    deliverKeyframe(client, server.world, snapshotTick, raw, network, frame);
    client.update(0);
  }
  const inflatedLead = client.leadTicks;
  assert.ok(inflatedLead > 3, `expected an inflated lead, got ${inflatedLead}`);

  // An old high-age observation can briefly raise the lead before the
  // twelve-sample window clears. Observe actual recovery, not only the first
  // decrement from that later peak.
  for (
    let sample = 0;
    sample < 192 && (client.stats.inputLeadDecreases === 0 || client.leadTicks >= inflatedLead);
    sample += 1
  ) {
    snapshotTick = ((client.world?.tick ?? snapshotTick) + 1) >>> 0;
    deliverKeyframe(client, server.world, snapshotTick, raw, network, frame);
    client.update(0);
    client.update(TICK_MILLISECONDS);
  }
  assert.ok(client.stats.inputLeadDecreases > 0, "sustained low transit must lower the adaptive lead");
  assert.ok(
    client.leadTicks < inflatedLead,
    `lead ${inflatedLead}->${client.leadTicks}, feedback floor ${client.stats.inputFeedbackLeadTicks}, decreases ${client.stats.inputLeadDecreases}`,
  );
  assert.equal(client.stats.inputLeadCatchdownSkips, client.stats.inputLeadDecreases);
  assert.deepEqual(errors, []);
  server.close();
});
