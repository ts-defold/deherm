import assert from "node:assert/strict";
import test from "node:test";

import {
  MatchServer,
  SNAPSHOT_BYTES,
  SNAPSHOT_NORMAL_MAX_BYTES,
  SNAPSHOT_RECOVERY_MAX_BYTES,
  TRANSPORT_CHANNEL_SNAPSHOT,
  adoptServerWebTransportSession,
  readSnapshotTick,
} from "../core/index.ts";

function receiver() {
  return {
    onReliable() {},
    onDatagram() {},
    onClose() {},
  };
}

async function settleUntil(predicate, label) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(`timed out waiting for ${label}`);
}

class BackpressuredSnapshotSession {
  ready = Promise.resolve();
  incomingUnidirectionalStreams = new ReadableStream();
  incomingBidirectionalStreams = new ReadableStream();
  outgoing = [];
  closeCalls = 0;
  closeResolve;
  closed = new Promise((resolve) => {
    this.closeResolve = resolve;
  });
  datagrams = {
    maxDatagramSize: 1_200,
    readable: new ReadableStream(),
    writable: {
      getWriter() {
        return {
          desiredSize: 1,
          ready: Promise.resolve(),
          write: async () => {},
          close: async () => {},
          abort: async () => {},
          releaseLock() {},
        };
      },
    },
  };

  async createUnidirectionalStream() {
    const record = { chunks: [], aborts: 0, closes: 0, releases: 0 };
    const blocked = this.outgoing.length === 0;
    const ready = blocked ? new Promise(() => {}) : Promise.resolve();
    this.outgoing.push(record);
    return {
      getWriter() {
        return {
          desiredSize: blocked ? 0 : 1,
          ready,
          write: async (chunk) => {
            record.chunks.push(chunk.slice());
          },
          close: async () => {
            record.closes += 1;
          },
          abort: async () => {
            record.aborts += 1;
          },
          releaseLock() {
            record.releases += 1;
          },
        };
      },
    };
  }

  createBidirectionalStream() {
    throw new Error("the server snapshot path does not create bidirectional streams");
  }

  close(options = {}) {
    this.closeCalls += 1;
    this.closeResolve({ closeCode: options.closeCode, reason: options.reason });
  }
}

test("two snapshots pipeline across a blocked stream and the bounded window coalesces newer state", async () => {
  const host = new BackpressuredSnapshotSession();
  const transport = await adoptServerWebTransportSession(host, receiver());
  const server = new MatchServer({ rosterSize: 2, nowMilliseconds: () => 0 });
  const session = server.createSession();
  session.attach(transport);

  session.sendSnapshot(new Uint8Array(SNAPSHOT_BYTES), 3);
  await settleUntil(() => host.outgoing.length === 1, "the first blocked snapshot stream");
  assert.deepEqual(host.outgoing[0].chunks, []);

  session.sendSnapshot(new Uint8Array(SNAPSHOT_BYTES), 6);
  await settleUntil(
    () => host.outgoing.length === 2 && host.outgoing[1].chunks.length === 2,
    "the pipelined snapshot payload",
  );

  assert.equal(host.outgoing[0].aborts, 0, "the first stream must be allowed to establish a usable state base");
  assert.equal(host.outgoing[0].releases, 0);
  assert.equal(host.outgoing[1].closes, 1);
  assert.equal(host.outgoing[1].chunks[0][0], TRANSPORT_CHANNEL_SNAPSHOT);
  assert.equal(readSnapshotTick(host.outgoing[1].chunks[1]), 6);
  assert.equal(host.closeCalls, 0, "snapshot coalescing must not close the WebTransport session");

  server.close();
  assert.equal(host.closeCalls, 1);
});

test("settled snapshot sends never consume the fixed unfinished-work slots", async () => {
  const frames = [];
  const signals = [];
  const server = new MatchServer({ rosterSize: 2, nowMilliseconds: () => 0 });
  const session = server.createSession();
  session.attach({
    capabilities: { protocol: "in-memory", reliableStreams: true, datagrams: false, maxDatagramBytes: 0 },
    sendReliable(channel, payload, signal) {
      assert.equal(channel, TRANSPORT_CHANNEL_SNAPSHOT);
      frames.push(payload.slice());
      signals.push(signal);
      return Promise.resolve("sent");
    },
    trySendDatagram: async () => "closed",
    close() {},
  });

  const source = new Uint8Array(SNAPSHOT_BYTES);
  for (let index = 1; index <= 20; index += 1) {
    session.sendSnapshot(source, index * 3);
    await Promise.resolve();
  }

  assert.equal(frames.length, 20, "more than eight settled frames must remain current without clock expiry");
  assert.equal(
    signals.every((signal) => !signal.aborted),
    true,
    "settled operations leave no stale abort target",
  );
  assert.equal(readSnapshotTick(frames.at(-1)), 60);
  server.close();
});

test("unfinished ordinary snapshots are bounded to a two-stream bandwidth-delay window", () => {
  const frames = [];
  const server = new MatchServer({ rosterSize: 2, nowMilliseconds: () => 0 });
  const session = server.createSession();
  session.attach({
    capabilities: { protocol: "in-memory", reliableStreams: true, datagrams: false, maxDatagramBytes: 0 },
    sendReliable(channel, payload) {
      assert.equal(channel, TRANSPORT_CHANNEL_SNAPSHOT);
      frames.push(payload.slice());
      return new Promise(() => {});
    },
    trySendDatagram: async () => "closed",
    close() {},
  });
  const source = new Uint8Array(SNAPSHOT_BYTES);
  assert.equal(session.sendSnapshot(source, 3), true);
  assert.equal(session.sendSnapshot(source, 6), true);
  assert.equal(session.sendSnapshot(source, 9), false);
  assert.equal(frames.length, 2);
  assert.deepEqual(frames.map(readSnapshotTick), [3, 6]);
  assert.equal(server.stats.snapshotFramesSkippedByBudget, 1);
  server.close();
});

test("large recovery frames have one-per-second credit without cancelling the last admitted state", () => {
  let nowMilliseconds = 0;
  const frames = [];
  const signals = [];
  const server = new MatchServer({ rosterSize: 32, nowMilliseconds: () => nowMilliseconds });
  const session = server.createSession();
  session.attach({
    capabilities: { protocol: "in-memory", reliableStreams: true, datagrams: false, maxDatagramBytes: 0 },
    sendReliable(channel, payload, signal) {
      assert.equal(channel, TRANSPORT_CHANNEL_SNAPSHOT);
      frames.push(payload.slice());
      signals.push(signal);
      return new Promise(() => {});
    },
    trySendDatagram: async () => "closed",
    close() {},
  });
  const source = new Uint8Array(SNAPSHOT_BYTES);
  for (let slot = 0; slot < 128; slot += 1) {
    server.world.projectileActive[slot] = 1;
    server.world.projectileGeneration[slot] = 1;
    server.world.projectileOwner[slot] = (slot % 32) + 1;
    server.world.projectileWeapon[slot] = 1;
    server.world.projectileDamage[slot] = 30;
    server.world.projectileDirectionX[slot] = 256;
    server.world.projectileLife[slot] = 75;
    server.world.projectileSpeed[slot] = 176;
    server.world.projectileRadius[slot] = 80;
  }
  server.world.writeSnapshot(source);

  assert.equal(session.sendSnapshot(source, 4), true);
  assert.ok(frames[0].byteLength > SNAPSHOT_NORMAL_MAX_BYTES);
  assert.ok(frames[0].byteLength <= SNAPSHOT_RECOVERY_MAX_BYTES);
  assert.equal(server.stats.snapshotRecoveryFramesSent, 1);

  nowMilliseconds = 250;
  assert.equal(session.sendSnapshot(source, 8), false);
  assert.equal(frames.length, 1);
  assert.equal(signals[0].aborted, false, "denied recovery must preserve the last admitted state");
  assert.equal(server.stats.snapshotFramesSkippedByBudget, 1);

  nowMilliseconds = 1_000;
  assert.equal(session.sendSnapshot(source, 12), true);
  assert.equal(frames.length, 2);
  assert.equal(signals[0].aborted, false, "a valid capped-link recovery retains its serialization budget");
  assert.equal(server.stats.snapshotRecoveryFramesSent, 2);
  nowMilliseconds = 2_000;
  assert.equal(session.sendSnapshot(source, 16), false);
  assert.equal(frames.length, 2);
  assert.equal(signals[1].aborted, false);
  assert.equal(server.stats.snapshotFramesSkippedByBudget, 2);
  nowMilliseconds = 10_000;
  assert.equal(session.sendSnapshot(source, 20), true);
  assert.equal(frames.length, 3);
  assert.equal(signals[0].aborted, true, "the size-aware watchdog still retires a genuinely stuck stream");
  assert.equal(signals[1].aborted, true, "the bounded second stream also expires after its byte budget");
  server.close();
});

test("a recovery frame slower than 300 ms crosses the supported capped link", async () => {
  let nowMilliseconds = 0;
  let serializationTail = 0;
  let firstDue = -1;
  let firstLength = -1;
  let delivered = 0;
  const pending = [];
  const server = new MatchServer({ rosterSize: 32, nowMilliseconds: () => nowMilliseconds });
  const session = server.createSession();
  session.attach({
    capabilities: { protocol: "in-memory", reliableStreams: true, datagrams: false, maxDatagramBytes: 0 },
    sendReliable(channel, payload, signal) {
      assert.equal(channel, TRANSPORT_CHANNEL_SNAPSHOT);
      const serializationStart = Math.max(nowMilliseconds, serializationTail);
      serializationTail = serializationStart + (payload.byteLength * 8 * 1_000) / 128_000;
      const due = serializationTail + 70;
      if (firstDue < 0) {
        firstDue = due;
        firstLength = payload.byteLength;
      }
      return new Promise((resolve) => pending.push({ due, signal, resolve }));
    },
    trySendDatagram: async () => "closed",
    close() {},
  });
  const source = new Uint8Array(SNAPSHOT_BYTES);
  for (let slot = 0; slot < 200; slot += 1) {
    server.world.projectileActive[slot] = 1;
    server.world.projectileGeneration[slot] = 1;
    server.world.projectileOwner[slot] = (slot % 32) + 1;
    server.world.projectileWeapon[slot] = 1;
    server.world.projectileDamage[slot] = 30;
    server.world.projectileDirectionX[slot] = 256;
    server.world.projectileLife[slot] = 75;
    server.world.projectileSpeed[slot] = 176;
    server.world.projectileRadius[slot] = 80;
  }
  server.world.writeSnapshot(source);
  assert.equal(session.sendSnapshot(source, 4), true);
  assert.ok(firstLength > 3_680, `fixture must cross the old edge-profile cliff (${firstLength} bytes)`);
  assert.ok(firstDue > 300, `fixture must need more than the old stale deadline (${firstDue} ms)`);

  nowMilliseconds = 301;
  assert.equal(
    session.sendSnapshot(source, 8),
    false,
    "recovery credit coalesces instead of cancelling the first frame",
  );
  assert.equal(pending[0].signal.aborted, false);

  nowMilliseconds = firstDue;
  for (const packet of pending) {
    if (packet.due > nowMilliseconds) continue;
    if (!packet.signal.aborted) delivered += 1;
    packet.resolve(packet.signal.aborted ? "backpressured" : "sent");
  }
  await Promise.resolve();
  assert.equal(delivered, 1);
  assert.equal(pending[0].signal.aborted, false);
  server.close();
});

test("a transport-rejected recovery frame retains its one-second retry credit", async () => {
  let nowMilliseconds = 0;
  let attempts = 0;
  const server = new MatchServer({ rosterSize: 32, nowMilliseconds: () => nowMilliseconds });
  const session = server.createSession();
  session.attach({
    capabilities: { protocol: "in-memory", reliableStreams: true, datagrams: false, maxDatagramBytes: 0 },
    sendReliable(channel, payload) {
      assert.equal(channel, TRANSPORT_CHANNEL_SNAPSHOT);
      assert.ok(payload.byteLength > SNAPSHOT_NORMAL_MAX_BYTES);
      attempts += 1;
      return Promise.resolve("backpressured");
    },
    trySendDatagram: async () => "closed",
    close() {},
  });
  const source = new Uint8Array(SNAPSHOT_BYTES);
  for (let slot = 0; slot < 128; slot += 1) {
    server.world.projectileActive[slot] = 1;
    server.world.projectileGeneration[slot] = 1;
    server.world.projectileOwner[slot] = (slot % 32) + 1;
    server.world.projectileWeapon[slot] = 1;
    server.world.projectileDamage[slot] = 30;
    server.world.projectileDirectionX[slot] = 256;
    server.world.projectileLife[slot] = 75;
    server.world.projectileSpeed[slot] = 176;
    server.world.projectileRadius[slot] = 80;
  }
  server.world.writeSnapshot(source);

  assert.equal(session.sendSnapshot(source, 4), true);
  await Promise.resolve();
  nowMilliseconds = 67;
  assert.equal(session.sendSnapshot(source, 8), false);
  assert.equal(attempts, 1, "backpressure must not turn a recovery frame into a 10 Hz retry loop");
  nowMilliseconds = 1_000;
  assert.equal(session.sendSnapshot(source, 12), true);
  assert.equal(attempts, 2);
  server.close();
});
