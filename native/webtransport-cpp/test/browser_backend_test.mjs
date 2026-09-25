import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL(
  "../../../extensions/defold-webtransport/defold_webtransport/lib/web/library_defold_webtransport.js",
  import.meta.url), "utf8");

const memory = new ArrayBuffer(1024 * 1024);
const HEAPU8 = new Uint8Array(memory);
const HEAPU16 = new Uint16Array(memory);
const HEAPU32 = new Uint32Array(memory);
const HEAP32 = new Int32Array(memory);
let heap = 4096;
let stack = 768 * 1024;
let library;
const callbacks = new Map();
const encoder = new TextEncoder();
const decoder = new TextDecoder();

class PendingWriter {
  desiredSize = 1;
  writes = [];
  aborted = false;
  write(bytes) {
    this.writes.push(bytes);
    return new Promise(() => {});
  }
  abort() {
    this.aborted = true;
    return Promise.resolve();
  }
}

class EmptyReader {
  cancelled = false;
  read() { return new Promise(() => {}); }
  cancel() { this.cancelled = true; return Promise.resolve(); }
  releaseLock() {}
}

class FakeReadable {
  constructor(reader = new EmptyReader()) { this.reader = reader; this.cancelled = false; }
  getReader() { return this.reader; }
  cancel() { this.cancelled = true; return Promise.resolve(); }
}

class FakeWritable {
  constructor(writer = new PendingWriter()) { this.writer = writer; this.aborted = false; }
  getWriter() { return this.writer; }
  abort() { this.aborted = true; return Promise.resolve(); }
}

class FakeWebTransportError extends Error {
  constructor(message, streamErrorCode) { super(message); this.streamErrorCode = streamErrorCode; }
}

function fakeNativeStream() {
  const readable = new FakeReadable();
  const writable = new FakeWritable();
  return { native: { readable, writable }, readable, writable };
}

class PushReader extends EmptyReader {
  pending = [];
  values = [];
  read() {
    if (this.values.length) return Promise.resolve({ done: false, value: this.values.shift() });
    return new Promise((resolve) => this.pending.push(resolve));
  }
  push(value) {
    const resolve = this.pending.shift();
    if (resolve) resolve({ done: false, value });
    else this.values.push(value);
  }
}

class FakeWebTransport {
  static instances = [];
  constructor(url, options) {
    this.url = url;
    this.options = options;
    this.datagramWriter = new PendingWriter();
    this.datagrams = {
      maxDatagramSize: 1200,
      readable: { getReader: () => new EmptyReader() },
      writable: { getWriter: () => this.datagramWriter }
    };
    this.incomingBidirectionalReader = new PushReader();
    this.incomingUnidirectionalReader = new PushReader();
    this.incomingBidirectionalStreams = { getReader: () => this.incomingBidirectionalReader };
    this.incomingUnidirectionalStreams = { getReader: () => this.incomingUnidirectionalReader };
    this.ready = Promise.resolve();
    this.closed = new Promise(() => {});
    this.pendingBidirectional = [];
    this.pendingUnidirectional = [];
    FakeWebTransport.instances.push(this);
  }
  createBidirectionalStream() {
    return new Promise((resolve) => this.pendingBidirectional.push(resolve));
  }
  createUnidirectionalStream() {
    return new Promise((resolve) => this.pendingUnidirectional.push(resolve));
  }
  close() { this.closeCalled = true; }
}

const context = vm.createContext({
  ArrayBuffer, Map, Math, Promise, Set, String, TextEncoder, Uint8Array, Uint16Array, Uint32Array,
  WebTransport: FakeWebTransport,
  WebTransportError: FakeWebTransportError,
  HEAPU8,
  HEAPU16,
  HEAPU32,
  HEAP32,
  _malloc(size) { const result = heap; heap += size + 7 & ~7; return result; },
  _free() {},
  UTF8ToString(pointer) {
    let end = pointer;
    while (HEAPU8[end] !== 0) ++end;
    return decoder.decode(HEAPU8.subarray(pointer, end));
  },
  lengthBytesUTF8(value) { return encoder.encode(value).length; },
  stringToUTF8(value, pointer, capacity) {
    const bytes = encoder.encode(value).subarray(0, capacity - 1);
    HEAPU8.set(bytes, pointer);
    HEAPU8[pointer + bytes.length] = 0;
  },
  stackSave() { return stack; },
  stackAlloc(size) { const result = stack; stack += size + 7 & ~7; return result; },
  stackRestore(saved) { stack = saved; },
  getWasmTableEntry(index) { return callbacks.get(index); },
  autoAddDeps() {},
  addToLibrary(value) {
    library = value;
    context.DefoldWebTransport = value.$DefoldWebTransport;
  }
});
vm.runInContext(source, context, { filename: "library_defold_webtransport.js" });

function putString(value) {
  const bytes = encoder.encode(value);
  const pointer = context._malloc(bytes.length + 1);
  context.HEAPU8.set(bytes, pointer);
  return pointer;
}

const url = putString("https://example.test/session");
const algorithm = putString("sha-256");
const digest = context._malloc(32);
context.HEAPU8.fill(0x5a, digest, digest + 32);
const hashes = context._malloc(12);
context.HEAPU32[hashes >>> 2] = algorithm;
context.HEAPU32[(hashes + 4) >>> 2] = digest;
context.HEAPU32[(hashes + 8) >>> 2] = 32;
const options = context._malloc(32);
context.HEAPU8.fill(0, options, options + 32);
context.HEAPU32[options >>> 2] = 1;
context.HEAPU32[(options + 4) >>> 2] = 32;
context.HEAPU32[(options + 8) >>> 2] = url;
context.HEAPU32[(options + 12) >>> 2] = hashes;
context.HEAPU32[(options + 16) >>> 2] = 1;
context.HEAPU16[(options + 20) >>> 1] = 7;
context.HEAPU16[(options + 22) >>> 1] = 9;
context.HEAPU32[(options + 24) >>> 2] = 99;
context.HEAPU32[(options + 28) >>> 2] = 123;

const delivered = [];
callbacks.set(99, (userData, eventPointer) => {
  delivered.push({ userData, type: context.HEAPU32[(eventPointer + 4) >>> 2] });
});
const session = library.defold_webtransport_connect(options);
assert.notEqual(session, 0);
await Promise.resolve();
await Promise.resolve();
const transport = FakeWebTransport.instances[0];
assert.equal(transport.options.anticipatedConcurrentIncomingUnidirectionalStreams, 7);
assert.equal(transport.options.anticipatedConcurrentIncomingBidirectionalStreams, 9);
assert.equal(transport.options.serverCertificateHashes[0].value.byteLength, 32);
assert.equal(library.defold_webtransport_pump_callbacks(), 1);
assert.deepEqual(delivered, [{ userData: 123, type: 1 }]);

for (let index = 0; index < 16; ++index) {
  assert.equal(library.defold_webtransport_create_bidirectional_stream(session), 1);
}
assert.equal(library.defold_webtransport_create_bidirectional_stream(session), 0);

const datagramBytes = context._malloc(8);
const datagramData = context._malloc(100);
context.HEAPU32[datagramBytes >>> 2] = datagramData;
context.HEAPU32[(datagramBytes + 4) >>> 2] = 100;
for (let index = 0; index < 16; ++index) {
  assert.equal(library.defold_webtransport_send_datagram(session, datagramBytes), 1);
}
assert.equal(library.defold_webtransport_send_datagram(session, datagramBytes), 0);

library.defold_webtransport_close(session, 1000, 0);
assert.equal(library.defold_webtransport_create_unidirectional_stream(session), 0);
assert.equal(library.defold_webtransport_send_datagram(session, datagramBytes), 0);
const lateCreated = fakeNativeStream();
transport.pendingBidirectional.shift()(lateCreated.native);
await Promise.resolve();
await Promise.resolve();
assert.equal(lateCreated.writable.aborted, true);
assert.equal(lateCreated.readable.cancelled, true);
assert.equal(context.DefoldWebTransport.sessions.get(session).liveStreams, 0);

library.defold_webtransport_destroy(session);
assert.equal(transport.closeCalled, true);
assert.equal(transport.datagramWriter.aborted, true);
assert.equal(library.defold_webtransport_create_unidirectional_stream(session), 0);

const nativeSession = library.defold_webtransport_native_v1_open(url, 28, digest, 32, 64, 8);
assert.equal(FakeWebTransport.instances[1].options.anticipatedConcurrentIncomingUnidirectionalStreams, 64);
assert.equal(FakeWebTransport.instances[1].options.anticipatedConcurrentIncomingBidirectionalStreams, 8);
assert.notEqual(nativeSession, 0);
await Promise.resolve();
await Promise.resolve();
const nativePoll = context._malloc(32 + 128);
assert.equal(library.defold_webtransport_native_v1_poll(nativeSession, nativePoll, 32 + 128), 0);
assert.equal(context.HEAPU32[nativePoll >>> 2], 1);
assert.equal(context.HEAPU32[(nativePoll + 28) >>> 2], 1);
assert.equal(library.defold_webtransport_native_v1_open_bidirectional_stream(nativeSession, 77), 0);
const nativeTransport = FakeWebTransport.instances[1];
nativeTransport.pendingBidirectional.shift()({
  writable: { getWriter: () => new PendingWriter() },
  readable: { getReader: () => new EmptyReader() }
});
await Promise.resolve();
await Promise.resolve();
await Promise.resolve();
await Promise.resolve();
await new Promise((resolve) => setImmediate(resolve));
assert.equal(library.defold_webtransport_native_v1_poll(nativeSession, nativePoll, 32 + 128), 0);
assert.equal(context.HEAPU32[nativePoll >>> 2], 2);
assert.equal(context.HEAPU32[(nativePoll + 12) >>> 2], 77);
const outgoingStreamHandle = context.HEAPU32[(nativePoll + 16) >>> 2];
assert.notEqual(outgoingStreamHandle, 0);
nativeTransport.incomingBidirectionalReader.push({
  writable: { getWriter: () => new PendingWriter() },
  readable: { getReader: () => new EmptyReader() }
});
await Promise.resolve();
await Promise.resolve();
await Promise.resolve();
await Promise.resolve();
assert.equal(library.defold_webtransport_native_v1_poll(nativeSession, nativePoll, 32 + 128), 0);
assert.equal(context.HEAPU32[nativePoll >>> 2], 2);
assert.equal(context.HEAPU32[(nativePoll + 4) >>> 2], 6); // incoming | bidirectional
assert.equal(context.HEAPU32[(nativePoll + 12) >>> 2], 0);
nativeTransport.incomingUnidirectionalReader.push(new FakeReadable());
await Promise.resolve();
await Promise.resolve();
await Promise.resolve();
await Promise.resolve();
assert.equal(library.defold_webtransport_native_v1_poll(nativeSession, nativePoll, 32 + 128), 0);
assert.equal(context.HEAPU32[nativePoll >>> 2], 2);
assert.equal(context.HEAPU32[(nativePoll + 4) >>> 2], 4); // incoming only
assert.equal(context.HEAPU32[(nativePoll + 12) >>> 2], 0);
const nativeStreamHandle = context.HEAPU32[(nativePoll + 16) >>> 2];
const finFailWriter = {
  desiredSize: 1,
  write() { return Promise.resolve(); },
  close() { return Promise.reject(new FakeWebTransportError("FIN rejected", 91)); },
  abort() { return Promise.resolve(); }
};
const finFailStream = context.DefoldWebTransport.stream(
  context.DefoldWebTransport.sessions.get(nativeSession),
  { writable: { getWriter: () => finFailWriter } }, false, false);
assert.equal(library.defold_webtransport_native_v1_write_stream(
  nativeSession, finFailStream.handle, 0, 0, true), 0);
await Promise.resolve();
await Promise.resolve();
await Promise.resolve();
await new Promise((resolve) => setImmediate(resolve));
assert.equal(library.defold_webtransport_native_v1_poll(nativeSession, nativePoll, 32 + 128), 0);
assert.equal(context.HEAPU32[nativePoll >>> 2], 6);
assert.equal(context.HEAP32[(nativePoll + 8) >>> 2], 91);
assert.equal(finFailStream.writeTerminal, true);
const outgoingStream = context.DefoldWebTransport.streams.get(outgoingStreamHandle);
context.DefoldWebTransport.streamWriteFailed(outgoingStream, new FakeWebTransportError("peer stopped", 73));
context.DefoldWebTransport.streamWriteFailed(outgoingStream, new FakeWebTransportError("duplicate", 74));
assert.equal(library.defold_webtransport_native_v1_poll(nativeSession, nativePoll, 32 + 128), 0);
assert.equal(context.HEAPU32[nativePoll >>> 2], 6); // STOP_SENDING
assert.equal(context.HEAP32[(nativePoll + 8) >>> 2], 73);
assert.equal(library.defold_webtransport_native_v1_poll(nativeSession, nativePoll, 32 + 128), 2,
  "one terminal write failure must emit exactly one stop-sending event");
assert.equal(context.DefoldWebTransport.normalizeCloseReason("😀".repeat(300)), "😀".repeat(256));
const pausedSession = {
  callback: 0,
  nativeEvents: new Array(context.DefoldWebTransport.readHighWaterEvents).fill({}),
  nativeEventBytes: 0,
  readCapacityWaiters: []
};
let resumedAtLowWater = false;
const readCapacity = context.DefoldWebTransport.waitForReadCapacity(pausedSession)
  .then(() => { resumedAtLowWater = true; });
await Promise.resolve();
assert.equal(resumedAtLowWater, false);
pausedSession.nativeEvents.length = context.DefoldWebTransport.readLowWaterEvents;
context.DefoldWebTransport.resumeReaders(pausedSession);
await readCapacity;
assert.equal(resumedAtLowWater, true);
assert.equal(library.defold_webtransport_native_v1_close(nativeSession, 1000, 0, 0), 0);
assert.equal(library.defold_webtransport_native_v1_open_bidirectional_stream(nativeSession, 78), -5);
assert.equal(library.defold_webtransport_native_v1_open_unidirectional_stream(nativeSession, 79), -5);
assert.equal(library.defold_webtransport_native_v1_write_stream(
  nativeSession, nativeStreamHandle, 0, 0, false), -5);
assert.equal(library.defold_webtransport_native_v1_try_send_datagram(nativeSession, 0, 0), -5);
assert.equal(library.defold_webtransport_native_v1_destroy(nativeSession), 0);

// Live streams are independently bounded from the pending-create and event
// rings. This includes remotely-created streams, which an untrusted peer can
// otherwise grow without making local API calls.
const boundedSessionHandle = library.defold_webtransport_native_v1_open(url, 28, digest, 32, 0, 0);
await Promise.resolve();
await Promise.resolve();
assert.equal(library.defold_webtransport_native_v1_poll(
  boundedSessionHandle, nativePoll, 32 + 128), 0); // ready
const boundedSession = context.DefoldWebTransport.sessions.get(boundedSessionHandle);
const live = [];
for (let index = 0; index < context.DefoldWebTransport.maximumStreamsPerSession; ++index) {
  const value = fakeNativeStream();
  const stream = context.DefoldWebTransport.stream(boundedSession, value.native, true, true);
  assert.ok(stream);
  live.push(stream);
}
assert.equal(boundedSession.liveStreams, context.DefoldWebTransport.maximumStreamsPerSession);
assert.equal(context.DefoldWebTransport.stream(boundedSession, fakeNativeStream().native, true, true), null);
context.DefoldWebTransport.releaseStream(live.pop());
assert.equal(boundedSession.liveStreams, context.DefoldWebTransport.maximumStreamsPerSession - 1);
assert.ok(context.DefoldWebTransport.stream(boundedSession, fakeNativeStream().native, true, true));
assert.equal(boundedSession.liveStreams, context.DefoldWebTransport.maximumStreamsPerSession);

const boundedTransport = FakeWebTransport.instances[2];
const rejectedRemote = fakeNativeStream();
boundedTransport.incomingBidirectionalReader.push(rejectedRemote.native);
await Promise.resolve();
await Promise.resolve();
await Promise.resolve();
await Promise.resolve();
await Promise.resolve();
await Promise.resolve();
await new Promise((resolve) => setImmediate(resolve));
assert.equal(rejectedRemote.writable.aborted, true);
assert.equal(rejectedRemote.readable.cancelled, true);
assert.equal(boundedSession.state, 5);
assert.equal(boundedSession.closeRequested, true);
assert.equal(boundedTransport.closeCalled, true);
assert.equal(library.defold_webtransport_native_v1_destroy(boundedSessionHandle), 0);

console.log("browser-webtransport-backend: live-stream bounds, post-close rejection, and cleanup verified");
