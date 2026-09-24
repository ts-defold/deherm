import assert from "node:assert/strict";
import test from "node:test";

import {
  BrowserWebSocketClient,
  TRANSPORT_CHANNEL_CONTROL,
  TRANSPORT_CHANNEL_INPUT_FALLBACK,
  sendTickInput,
} from "../core/index.ts";

class FakeSocket {
  static OPEN = 1;

  readyState = 0;
  bufferedAmount = 0;
  binaryType = "";
  peer;
  listeners = new Map();

  addEventListener(type, listener) {
    const entries = this.listeners.get(type) ?? [];
    entries.push(listener);
    this.listeners.set(type, entries);
  }

  removeEventListener(type, listener) {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((entry) => entry !== listener),
    );
  }

  emit(type, event = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  open() {
    this.readyState = FakeSocket.OPEN;
    this.emit("open");
  }

  send(data) {
    if (this.readyState !== FakeSocket.OPEN) throw new Error("not open");
    const copy = new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
    queueMicrotask(() => this.peer?.emit("message", { data: copy.buffer }));
  }

  close(code = 1000, reason = "closed") {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit("close", { code, reason });
    if (this.peer?.readyState !== 3) this.peer?.close(code, reason);
  }
}

function socketPair() {
  const left = new FakeSocket();
  const right = new FakeSocket();
  left.peer = right;
  right.peer = left;
  left.open();
  right.open();
  return { left, right };
}

function receiver() {
  return {
    reliable: [],
    datagrams: [],
    closed: [],
    onReliable(channel, payload) {
      this.reliable.push({ channel, payload: [...payload] });
    },
    onDatagram(payload) {
      this.datagrams.push([...payload]);
    },
    onClose(code, reason) {
      this.closed.push({ code, reason });
    },
  };
}

function reliableFrame(channel, payload) {
  const frame = new Uint8Array(5 + payload.length);
  const view = new DataView(frame.buffer);
  view.setUint8(0, channel);
  view.setUint32(1, payload.length, true);
  frame.set(payload, 5);
  return frame;
}

test("WebSocket fallback carries reliable control and explicit input-fallback lanes", async () => {
  const pair = socketPair();
  const serverReceiver = receiver();
  const clientReceiver = receiver();
  const ClientConstructor = class {
    constructor() {
      return pair.left;
    }
  };
  const client = await BrowserWebSocketClient.connect("ws://example.test/ws", clientReceiver, ClientConstructor);
  const server = BrowserWebSocketClient.adopt(pair.right, serverReceiver);

  assert.equal(client.capabilities.protocol, "websocket-tcp");
  assert.equal(client.capabilities.reliableStreams, true);
  assert.equal(client.capabilities.datagrams, false);
  assert.equal(await client.sendReliable(TRANSPORT_CHANNEL_CONTROL, Uint8Array.of(1, 2, 3)), "sent");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(serverReceiver.reliable, [{ channel: TRANSPORT_CHANNEL_CONTROL, payload: [1, 2, 3] }]);

  const input = await sendTickInput(client, Uint8Array.of(9, 8, 7));
  assert.deepEqual(input, { route: "reliable-fallback", disposition: "sent" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(serverReceiver.reliable[1], {
    channel: TRANSPORT_CHANNEL_INPUT_FALLBACK,
    payload: [9, 8, 7],
  });
  assert.deepEqual(serverReceiver.datagrams, []);
  client.close(1000, "test complete");
  assert.equal(serverReceiver.closed.length, 1);
  server.close(1000, "test complete");
});

test("WebSocket fallback rejects malformed frames and never relabels them as QUIC", async () => {
  const pair = socketPair();
  const serverReceiver = receiver();
  const server = BrowserWebSocketClient.adopt(pair.right, serverReceiver);
  pair.left.send(Uint8Array.of(TRANSPORT_CHANNEL_CONTROL, 3, 0, 0));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(serverReceiver.reliable.length, 0);
  assert.equal(serverReceiver.closed.length, 1);
  assert.equal(server.capabilities.protocol, "websocket-tcp");
  assert.notEqual(server.capabilities.protocol, "webtransport-h3");
});

test("WebSocket fallback preserves message order across asynchronous Blob conversion", async () => {
  const pair = socketPair();
  const serverReceiver = receiver();
  BrowserWebSocketClient.adopt(pair.right, serverReceiver);
  let releaseFirst;
  class DeferredBlob extends Blob {
    async arrayBuffer() {
      await new Promise((resolve) => {
        releaseFirst = resolve;
      });
      return super.arrayBuffer();
    }
  }
  const first = reliableFrame(TRANSPORT_CHANNEL_CONTROL, Uint8Array.of(1));
  const second = reliableFrame(TRANSPORT_CHANNEL_CONTROL, Uint8Array.of(2));
  pair.right.emit("message", { data: new DeferredBlob([first]) });
  pair.right.emit("message", { data: second.buffer });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(serverReceiver.reliable, []);
  releaseFirst();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    serverReceiver.reliable.map((entry) => entry.payload),
    [[1], [2]],
  );
});

test("WebSocket fallback drops an async conversion completed after close", async () => {
  const pair = socketPair();
  const serverReceiver = receiver();
  const server = BrowserWebSocketClient.adopt(pair.right, serverReceiver);
  let release;
  class DeferredBlob extends Blob {
    async arrayBuffer() {
      await new Promise((resolve) => {
        release = resolve;
      });
      return super.arrayBuffer();
    }
  }
  pair.right.emit("message", { data: new DeferredBlob([reliableFrame(TRANSPORT_CHANNEL_CONTROL, Uint8Array.of(3))]) });
  await new Promise((resolve) => setImmediate(resolve));
  server.close(1000, "closed while decoding");
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(serverReceiver.reliable, []);
});
