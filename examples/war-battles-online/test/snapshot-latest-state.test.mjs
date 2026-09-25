import assert from "node:assert/strict";
import test from "node:test";

import {
  MatchServer,
  SNAPSHOT_BYTES,
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

test("a newer authoritative snapshot resets a blocked stream and crosses the realistic adapter", async () => {
  const host = new BackpressuredSnapshotSession();
  const transport = await adoptServerWebTransportSession(host, receiver());
  const server = new MatchServer({ rosterSize: 2, nowMilliseconds: () => 0 });
  const session = server.createSession();
  session.attach(transport);

  session.sendSnapshot(new Uint8Array(SNAPSHOT_BYTES).fill(3), 3);
  await settleUntil(() => host.outgoing.length === 1, "the first blocked snapshot stream");
  assert.deepEqual(host.outgoing[0].chunks, []);

  session.sendSnapshot(new Uint8Array(SNAPSHOT_BYTES).fill(6), 6);
  await settleUntil(
    () => host.outgoing.length === 2 && host.outgoing[1].chunks.length === 2,
    "the replacement snapshot payload",
  );

  assert.equal(host.outgoing[0].aborts, 1, "the stale stream is reset rather than left ahead of current state");
  assert.equal(host.outgoing[0].releases, 1);
  assert.equal(host.outgoing[1].closes, 1);
  assert.equal(host.outgoing[1].chunks[0][0], TRANSPORT_CHANNEL_SNAPSHOT);
  assert.equal(readSnapshotTick(host.outgoing[1].chunks[1]), 6);
  assert.equal(host.closeCalls, 0, "stream-local supersession must not close the WebTransport session");

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
