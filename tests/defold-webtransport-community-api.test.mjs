import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import vm from "node:vm";

import { transform } from "esbuild";
import YAML from "yaml";

import {
  generateCommunityApi,
  repositoryRoot
} from "../scripts/generate-defold-webtransport-community-api.mjs";

const extensionRoot = path.join(repositoryRoot, "extensions/defold-webtransport/defold_webtransport");
const facadePath = path.join(extensionRoot, "webtransport/typescript/WebTransport.ts");
const nativePath = path.join(extensionRoot, "webtransport/typescript/NativeWebTransport.ts");

async function scratch(t) {
  const root = await mkdtemp(path.join(tmpdir(), "defold-webtransport-community-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("community surfaces are deterministic projections of compatibility and bridge schemas", async () => {
  const generated = await generateCommunityApi();
  assert.equal(generated.size, 6);
  const hashes = new Set();
  for (const [file, expected] of generated) {
    assert.equal(await readFile(file, "utf8"), expected, `${path.relative(repositoryRoot, file)} is stale`);
    const match = /Input SHA-256: ([a-f0-9]{64})/u.exec(expected);
    assert.ok(match, `${file} has no input identity`);
    hashes.add(match[1]);
  }
  assert.equal(hashes.size, 1, "all surfaces must identify the same schema pair");
});

test("ordinary public C and Lua surfaces expose sessions, streams, and events without bridge machinery", async () => {
  const headerPath = path.join(extensionRoot, "include/defold_webtransport/client.h");
  const scriptApiPath = path.join(extensionRoot, "script/defold_webtransport.script_api");
  const [header, scriptApi] = await Promise.all([readFile(headerPath, "utf8"), readFile(scriptApiPath, "utf8")]);
  for (const [label, source] of [["C", header], ["Lua", scriptApi]]) {
    assert.doesNotMatch(source, /\b(?:handle|poll|provider|NativeWebTransport|pump)\b/iu, `${label} leaked the internal bridge`);
  }
  assert.match(header, /typedef struct DefoldWebTransportSession DefoldWebTransportSession;/u);
  assert.match(header, /#define DEFOLD_WEBTRANSPORT_MAX_CERTIFICATE_HASHES 8u/u);
  assert.match(header, /defold_webtransport_destroy\(DefoldWebTransportSession\* session\)/u);
  assert.match(header, /defold_webtransport_stream_release\(DefoldWebTransportStream\* stream\)/u);
  assert.match(header, /bool defold_webtransport_stream_reset\(DefoldWebTransportStream\* stream, uint32_t code\)/u);
  assert.match(header, /bool defold_webtransport_stream_stop_sending\(DefoldWebTransportStream\* stream, uint32_t code\)/u);
  assert.match(header, /borrowed and remains valid only during the callback/u);
  const parsed = YAML.parse(scriptApi);
  assert.equal(parsed[0].name, "defold_webtransport");
  assert.deepEqual(parsed[0].members.map(({ name }) => name), [
    "connect", "close", "create_bidirectional_stream", "create_unidirectional_stream", "write",
    "reset_stream", "stop_sending", "send_datagram", "max_datagram_size"
  ]);
  execFileSync("clang", ["-std=c11", "-fsyntax-only", "-x", "c", headerPath], { stdio: "pipe" });
});

test("the ergonomic client header and common HTML5 backend export the same symbols", async () => {
  const [header, backend] = await Promise.all([
    readFile(path.join(extensionRoot, "include/defold_webtransport/client.h"), "utf8"),
    readFile(path.join(extensionRoot, "lib/web/library_defold_webtransport.js"), "utf8")
  ]);
  const headerSymbols = new Set(Array.from(
    header.matchAll(/\b(defold_webtransport_[a-z0-9_]+)\s*\(/gu),
    (match) => match[1]
  ));
  const backendSymbols = new Set(Array.from(
    backend.matchAll(/^\s{2}(defold_webtransport_[a-z0-9_]+):\s*function\b/gmu),
    (match) => match[1]
  ));
  assert.deepEqual(
    [...headerSymbols].sort(),
    [...backendSymbols].filter((name) => !name.includes("_native_v1_") && name !== "defold_webtransport_pump_callbacks").sort()
  );
  assert.ok(backendSymbols.has("defold_webtransport_stream_release"));

  let library;
  const freed = [];
  const sandbox = {
    Map, Set, Uint8Array, TextEncoder,
    _free(handle) { freed.push(handle); },
    autoAddDeps() {},
    addToLibrary(value) { library = value; }
  };
  vm.runInNewContext(backend, sandbox, { filename: "library_defold_webtransport.js" });
  const runtime = library.$DefoldWebTransport;
  sandbox.DefoldWebTransport = runtime;
  const session = { streams: new Set([41]) };
  const stream = { handle: 41, session, released: false };
  runtime.streams = new Map([[41, stream]]);
  library.defold_webtransport_stream_release(41);
  assert.equal(runtime.streams.has(41), false);
  assert.equal(session.streams.has(41), false);
  assert.deepEqual(freed, [41]);
  assert.equal(stream.released, true);
  assert.equal(stream.handle, 0);
});

test("the Lua adapter preserves instance callbacks and tracks stream halves independently", async () => {
  const source = await readFile(path.join(extensionRoot, "src/extension.cpp"), "utf8");
  const compatibility = JSON.parse(await readFile(path.join(extensionRoot, "webtransport/public-api-compatibility.json"), "utf8"));
  assert.equal(compatibility.generation.outputs.luaRegistration, "include/defold_webtransport/generated_lua_methods.inc");
  assert.match(source, /#include <defold_webtransport\/generated_lua_methods\.inc>/u);
  assert.match(source, /dmScript::LuaCallbackInfo\* callback/u);
  assert.match(source, /dmScript::CreateCallback\(state, callback_index\)/u);
  assert.match(source, /dmScript::SetupCallback\(context->callback\)/u);
  assert.match(source, /dmScript::PCall\(state, 2, 0\).*self \+ event/u);
  assert.match(source, /dmScript::TeardownCallback\(context->callback\)/u);
  assert.match(source, /dmScript::DestroyCallback\(value->context->callback\)/u);
  assert.match(source, /callback_depth[\s\S]*destroy_callback_pending/u);
  assert.match(source, /callback_depth == 0 && context->destroy_callback_pending[\s\S]*DestroyCallback/u);
  assert.doesNotMatch(source, /callback_ref|context->state/u);
  assert.match(source, /bool read_open = false;[\s\S]*bool write_open = false;/u);
  assert.match(source, /\(event->type == DEFOLD_WEBTRANSPORT_EVENT_DATA && event->fin\) \|\|[\s\S]*DEFOLD_WEBTRANSPORT_EVENT_STREAM_RESET,[\s\S]*DEFOLD_WEBTRANSPORT_EVENT_STOP_SENDING/u);
  assert.match(source, /accepted && fin\) MarkStreamTerminal\([^;]+false, true\)/u);
  assert.match(source, /const bool accepted = defold_webtransport_stream_reset[\s\S]*if \(accepted\) MarkStreamTerminal/u);
  assert.match(source, /const bool accepted = defold_webtransport_stream_stop_sending[\s\S]*if \(accepted\) MarkStreamTerminal/u);
  assert.match(source, /has_options \|\| lua_isnoneornil\(state, 2\) \? 3 : 2/u);
  assert.match(source, /!std::isfinite\(static_cast<double>\(value\)\)/u);
});

test("certificate arrays and numeric codes fail closed at native and HTML5 boundaries", async () => {
  const [nativePublic, html5, luaAdapter] = await Promise.all([
    readFile(path.join(repositoryRoot, "native/webtransport-cpp/src/public_api.cpp"), "utf8"),
    readFile(path.join(extensionRoot, "lib/web/library_defold_webtransport.js"), "utf8"),
    readFile(path.join(extensionRoot, "src/extension.cpp"), "utf8")
  ]);
  assert.match(nativePublic, /certificate_hash_count != 0 && options->certificate_hashes == nullptr/u);
  assert.match(nativePublic, /certificate_hash_count > DEFOLD_WEBTRANSPORT_MAX_CERTIFICATE_HASHES/u);
  assert.match(html5, /var hashCount = HEAPU32\[\(options \+ 16\) >>> 2\];[\s\S]*if \(hashCount > 8\) return 0;/u);
  assert.doesNotMatch(html5, /Math\.min\(HEAPU32\[\(options \+ 16\) >>> 2\], 8\)/u);
  assert.match(html5, /if \(hashCount && !hashesPointer\) return 0;/u);
  assert.match(luaAdapter, /!std::isfinite\(static_cast<double>\(value\)\)/u);
  assert.match(luaAdapter, /value != static_cast<std::uint32_t>\(value\)/u);
  assert.match(luaAdapter, /count > hashes\.size\(\)[\s\S]*server_certificate_hashes exceeds the bounded limit/u);
  assert.match(luaAdapter, /server_certificate_hashes must be a table/u);
  assert.match(luaAdapter, /anticipated incoming unidirectional streams must be a number/u);
  assert.match(luaAdapter, /anticipated incoming bidirectional streams must be a number/u);
});

test("the HTML5 event bound closes once instead of dropping overflow and continuing", async () => {
  const source = await readFile(path.join(extensionRoot, "lib/web/library_defold_webtransport.js"), "utf8");
  let library;
  const sandbox = {
    Map, Set, Uint8Array, TextEncoder,
    autoAddDeps() {},
    addToLibrary(value) { library = value; }
  };
  vm.runInNewContext(source, sandbox, { filename: "library_defold_webtransport.js" });
  const runtime = library.$DefoldWebTransport;
  sandbox.DefoldWebTransport = runtime;
  runtime.events = [];
  runtime.eventBytes = 0;
  let closes = 0;
  const session = {
    callback: 1,
    destroyed: false,
    closeEmitted: false,
    closeRequested: false,
    overflowed: false,
    ready: true,
    state: 2,
    nativeEvents: [],
    nativeEventBytes: 0,
    transport: { close() { ++closes; } }
  };
  for (let index = 0; index < runtime.maximumEvents - 1; ++index) {
    runtime.enqueue(session, { type: 4, bytes: new Uint8Array([index]) });
  }
  runtime.enqueue(session, { type: 4, bytes: new Uint8Array([255]) });
  assert.equal(session.state, 5);
  assert.equal(session.closeRequested, true);
  assert.equal(session.closeEmitted, true);
  assert.equal(closes, 1);
  assert.equal(runtime.events.length, 1);
  assert.equal(runtime.events[0].type, 7);
  assert.match(runtime.events[0].reason, /queue is full/u);
  runtime.enqueue(session, { type: 4, bytes: new Uint8Array([1]) });
  runtime.failSession(session, "second failure");
  assert.equal(closes, 1, "terminal overflow/connect failure must request only one close");
  assert.equal(runtime.events.length, 1, "no payload may be delivered after terminal overflow");
});

test("advanced native_v1 header is the only public low-level handle and poll ABI", async () => {
  const nativeHeaderPath = path.join(extensionRoot, "include/defold_webtransport/native_v1.h");
  const nativeHeader = await readFile(nativeHeaderPath, "utf8");
  assert.match(nativeHeader, /DEFOLD_WEBTRANSPORT_NATIVE_V1_ABI_VERSION 1u/u);
  assert.match(nativeHeader, /DefoldWebTransportNativeV1PollHeader/u);
  assert.match(nativeHeader, /DEFOLD_WEBTRANSPORT_NATIVE_V1_POLL_HEADER_BYTES 32u/u);
  assert.equal((nativeHeader.match(/\bdefold_webtransport_native_v1_[a-z_]+\s*\(/gu) ?? []).length, 12);
  assert.match(nativeHeader, /defold_webtransport_native_v1_poll\(uint32_t handle, uint8_t\* output, uint32_t output_length\)/u);
  execFileSync("clang", ["-std=c11", "-fsyntax-only", "-x", "c", nativeHeaderPath], { stdio: "pipe" });
});

test("TypeScript public contract is WebTransport-shaped and its native machinery stays private", async () => {
  const source = await readFile(facadePath, "utf8");
  const publicContract = /BEGIN PUBLIC WEBTRANSPORT CONTRACT([\s\S]*?)END PUBLIC WEBTRANSPORT CONTRACT/u.exec(source)?.[1];
  assert.ok(publicContract);
  assert.doesNotMatch(publicContract, /\b(?:handle|poll|provider|pump|NativeWebTransport)\b/iu);
  assert.doesNotMatch(source, /(?:new|globalThis\.)\s*(?:ReadableStream|WritableStream)\b/u);
  assert.match(source, /const nativePumpSessions = new Set<NativePumpSession>\(\)/u);
  assert.match(source, /unregisterNativePump = registerNativeModulePump/u);
  assert.equal((source.match(/registerNativeModulePump\(/gu) ?? []).length, 1, "facade must register one module pump");
  assert.match(source, /MAXIMUM_NATIVE_SESSIONS = 32/u);
  assert.match(source, /this\.waiting\.length >= MAXIMUM_QUEUED_ITEMS/u);
  assert.match(source, /MAXIMUM_PAYLOAD_BYTES = 1048576/u);
});

test("compiler-private Static Hermes facade preserves the public Uint8Array contract while adapting internal bytes", async () => {
  const [dynamicSource, source] = await Promise.all([
    readFile(facadePath, "utf8"),
    readFile(path.join(extensionRoot, "webtransport/static/WebTransport.ts"), "utf8")
  ]);
  const contractPattern = /BEGIN PUBLIC WEBTRANSPORT CONTRACT([\s\S]*?)END PUBLIC WEBTRANSPORT CONTRACT/u;
  const dynamicContract = contractPattern.exec(dynamicSource)?.[1];
  const publicContract = contractPattern.exec(source)?.[1];
  assert.ok(publicContract && dynamicContract);
  assert.equal(publicContract, dynamicContract, "browser/dynamic and Static targets must expose one logical contract");
  assert.match(publicContract, /export type WebTransportBytes = Uint8Array/u);
  assert.match(publicContract, /export type WebTransportBufferSource = ArrayBuffer \| ArrayBufferView/u);
  assert.match(source, /type StaticWebTransportBytes = number\[\]/u);
  assert.match(source, /type RuntimeWebTransportBytes = StaticWebTransportBytes/u);
  assert.doesNotMatch(source, /new Uint8Array/u);
  assert.match(source, /sha-256 certificate hash must be byte-addressable/u);
  assert.match(source, /export const WebTransport = NativeSession as unknown as WebTransportConstructor/u);
  assert.match(source, /from "\.\/NativeWebTransport\.js"/u);
});

async function transpile(source, fileName) {
  const result = await transform(source, { loader: "ts", format: "esm", target: "es2022", sourcefile: fileName });
  return result.code
    .replaceAll('"@deherm/project/module-runtime"', '"./module-runtime.js"')
    .replaceAll('"./NativeWebTransport.ts"', '"./NativeWebTransport.js"');
}

async function runtimeModule(t) {
  const root = await scratch(t);
  const [facade, native] = await Promise.all([readFile(facadePath, "utf8"), readFile(nativePath, "utf8")]);
  await writeFile(path.join(root, "package.json"), '{"type":"module"}\n');
  await writeFile(path.join(root, "WebTransport.js"), await transpile(facade, "WebTransport.ts"));
  await writeFile(path.join(root, "NativeWebTransport.js"), await transpile(native, "NativeWebTransport.ts"));
  await writeFile(path.join(root, "module-runtime.js"), `
export function requireDefoldModule(name) {
  if (name !== "NativeWebTransport") throw new Error("unexpected module " + name);
  return globalThis.__testNativeWebTransport;
}
export function registerNativeModulePump(pump) {
  globalThis.__testNativePumpRegistrations = (globalThis.__testNativePumpRegistrations ?? 0) + 1;
  globalThis.__testNativePump = pump;
  return () => { globalThis.__testNativePumpUnregisters = (globalThis.__testNativePumpUnregisters ?? 0) + 1; };
}
`);
  return import(`${pathToFileURL(path.join(root, "WebTransport.js")).href}?test=${Date.now()}`);
}

function fakeProvider() {
  let nextSession = 1;
  const events = new Map();
  const states = new Map();
  const writes = [];
  const destroys = [];
  const opens = [];
  const push = (session, event) => events.get(session).push(event);
  const provider = {
    open(url, certificate, anticipatedUnidirectional, anticipatedBidirectional) {
      const session = nextSession++; opens.push({ url, certificate: [...certificate], anticipatedUnidirectional, anticipatedBidirectional });
      events.set(session, []); states.set(session, 2); push(session, { kind: 1 }); return session;
    },
    state(session) { return states.get(session) ?? 4; },
    maxDatagramBytes() { return 100000; },
    openBidirectionalStream(session, request) { push(session, { kind: 2, flags: 2, request, stream: request + 100 }); return 0; },
    openUnidirectionalStream(session, request) { push(session, { kind: 2, request, stream: request + 100 }); return 0; },
    writeStream(session, stream, bytes, fin) { writes.push({ session, stream, bytes: [...bytes], fin, datagram: false }); return 0; },
    resetStream() { return 0; },
    stopSending() { return 0; },
    trySendDatagram(session, bytes) { writes.push({ session, bytes: [...bytes], datagram: true }); return 0; },
    poll(session, output) {
      const event = events.get(session)?.[0];
      if (!event) return 2;
      const payload = event.payload ?? new Uint8Array(0);
      const view = new DataView(output.buffer, output.byteOffset, output.byteLength);
      if (payload.byteLength > output.byteLength - 32) { view.setUint32(20, payload.byteLength, true); return -4; }
      events.get(session).shift();
      view.setUint32(0, event.kind, true); view.setUint32(4, event.flags ?? 0, true);
      view.setInt32(8, event.code ?? 0, true); view.setUint32(12, event.request ?? 0, true);
      view.setUint32(16, event.stream ?? 0, true); view.setUint32(20, payload.byteLength, true);
      view.setUint32(24, 0, true); view.setUint32(28, 1, true); output.set(payload, 32); return 0;
    },
    close(session, code, reason) { push(session, { kind: 7, code, payload: new TextEncoder().encode(reason) }); return 0; },
    destroy(session) { destroys.push(session); states.set(session, 4); return 0; }
  };
  return { provider, events, states, writes, destroys, opens, push };
}

function nativeOptions() {
  return { serverCertificateHashes: [{ algorithm: "sha-256", value: new Uint8Array(32) }] };
}

test("native structural streams run without DOM stream globals and share one automatic pump", async (t) => {
  const savedReadable = globalThis.ReadableStream;
  const savedWritable = globalThis.WritableStream;
  const savedWebTransport = globalThis.WebTransport;
  const fake = fakeProvider();
  globalThis.__testNativeWebTransport = fake.provider;
  globalThis.__testNativePumpRegistrations = 0;
  delete globalThis.ReadableStream;
  delete globalThis.WritableStream;
  delete globalThis.WebTransport;
  t.after(() => {
    globalThis.ReadableStream = savedReadable; globalThis.WritableStream = savedWritable;
    globalThis.WebTransport = savedWebTransport;
    delete globalThis.__testNativeWebTransport; delete globalThis.__testNativePump;
    delete globalThis.__testNativePumpRegistrations; delete globalThis.__testNativePumpUnregisters;
  });
  const { WebTransport } = await runtimeModule(t);
  const first = new WebTransport("https://example.test/one", nativeOptions());
  const second = new WebTransport("https://example.test/two", nativeOptions());
  assert.equal(globalThis.__testNativePumpRegistrations, 1);
  globalThis.__testNativePump(1 / 60);
  await Promise.all([first.ready, second.ready]);

  const writer = first.datagrams.writable.getWriter();
  assert.equal(writer.desiredSize, 1);
  await writer.write(new Uint8Array([1, 2, 3]));
  assert.deepEqual(fake.writes.at(-1), { session: 1, bytes: [1, 2, 3], datagram: true });

  const large = new Uint8Array(70000).fill(7);
  fake.push(1, { kind: 4, payload: large });
  const read = first.datagrams.readable.getReader().read();
  globalThis.__testNativePump(1 / 60);
  assert.deepEqual(await read, { done: false, value: large });

  first.close({ closeCode: 9, reason: "done" });
  second.close({ closeCode: 10, reason: "done too" });
  globalThis.__testNativePump(1 / 60);
  assert.deepEqual(await first.closed, { closeCode: 9, reason: "done" });
  assert.deepEqual(await second.closed, { closeCode: 10, reason: "done too" });
  assert.deepEqual(fake.destroys, [1, 2]);
  assert.equal(globalThis.__testNativePumpUnregisters, 1, "the generation pump must release when its last session closes");
});

test("browser delegation registers no native pump", async (t) => {
  const fake = fakeProvider();
  class BrowserWebTransport { constructor(url, options) { this.url = url; this.options = options; } }
  globalThis.WebTransport = BrowserWebTransport;
  globalThis.__testNativeWebTransport = fake.provider;
  globalThis.__testNativePumpRegistrations = 0;
  t.after(() => { delete globalThis.WebTransport; delete globalThis.__testNativeWebTransport; delete globalThis.__testNativePumpRegistrations; });
  const { WebTransport } = await runtimeModule(t);
  assert.equal(WebTransport, BrowserWebTransport);
  const instance = new WebTransport("https://example.test/browser", {});
  assert.ok(instance instanceof BrowserWebTransport);
  assert.equal(globalThis.__testNativePumpRegistrations, 0);
});

test("native trust is explicit and writer ready waits for provider backpressure to clear", async (t) => {
  const fake = fakeProvider();
  globalThis.__testNativeWebTransport = fake.provider;
  delete globalThis.WebTransport;
  t.after(() => { delete globalThis.__testNativeWebTransport; delete globalThis.__testNativePump; });
  const { WebTransport } = await runtimeModule(t);
  assert.throws(
    () => new WebTransport("https://example.test/no-hash"),
    /requires exactly one sha-256 serverCertificateHash/u
  );
  const session = new WebTransport("https://example.test/backpressure", {
    ...nativeOptions(),
    anticipatedConcurrentIncomingUnidirectionalStreams: 64,
    anticipatedConcurrentIncomingBidirectionalStreams: 8
  });
  assert.deepEqual(fake.opens.at(-1), {
    url: "https://example.test/backpressure",
    certificate: new Array(32).fill(0),
    anticipatedUnidirectional: 64,
    anticipatedBidirectional: 8
  });
  globalThis.__testNativePump(1 / 60);
  await session.ready;
  let blocked = true;
  fake.provider.trySendDatagram = (handle, bytes) => {
    if (blocked) { blocked = false; return 1; }
    fake.writes.push({ session: handle, bytes: [...bytes], datagram: true }); return 0;
  };
  const writer = session.datagrams.writable.getWriter();
  const write = writer.write(new Uint8Array([4, 5]));
  assert.equal(writer.desiredSize, 0);
  let readyResolved = false;
  const ready = writer.ready.then(() => { readyResolved = true; });
  await Promise.resolve();
  assert.equal(readyResolved, false);
  globalThis.__testNativePump(1 / 60);
  await Promise.all([ready, write]);
  assert.equal(writer.desiredSize, 1);
  session.close(); globalThis.__testNativePump(1 / 60); await session.closed;
});

test("pre-ready stream opens and datagrams wait for the ready event", async (t) => {
  const fake = fakeProvider();
  let streamCalls = 0, datagramCalls = 0;
  fake.provider.openBidirectionalStream = (session, request) => {
    streamCalls += 1; fake.push(session, { kind: 2, flags: 2, request, stream: request + 100 }); return 0;
  };
  fake.provider.trySendDatagram = (session, bytes) => {
    datagramCalls += 1; fake.writes.push({ session, bytes: [...bytes], datagram: true }); return 0;
  };
  globalThis.__testNativeWebTransport = fake.provider;
  delete globalThis.WebTransport;
  t.after(() => { delete globalThis.__testNativeWebTransport; delete globalThis.__testNativePump; });
  const { WebTransport } = await runtimeModule(t);
  const session = new WebTransport("https://example.test/pre-ready", nativeOptions());
  fake.events.get(1).length = 0;
  const stream = session.createBidirectionalStream();
  const write = session.datagrams.writable.getWriter().write(new Uint8Array([4, 2]));
  assert.equal(streamCalls, 0);
  assert.equal(datagramCalls, 0);
  fake.push(1, { kind: 1 });
  globalThis.__testNativePump(1 / 60);
  await Promise.all([session.ready, stream, write]);
  assert.equal(streamCalls, 1);
  assert.equal(datagramCalls, 1);
  session.close(); globalThis.__testNativePump(1 / 60); await session.closed;
});

test("a rejected reliable write resets once and discards queued writes", async (t) => {
  const fake = fakeProvider();
  const statuses = [1, -2];
  let resets = 0;
  fake.provider.writeStream = () => statuses.shift() ?? 0;
  fake.provider.resetStream = () => { resets += 1; return 0; };
  globalThis.__testNativeWebTransport = fake.provider;
  delete globalThis.WebTransport;
  t.after(() => { delete globalThis.__testNativeWebTransport; delete globalThis.__testNativePump; });
  const { WebTransport } = await runtimeModule(t);
  const session = new WebTransport("https://example.test/write-failure", nativeOptions());
  globalThis.__testNativePump(1 / 60); await session.ready;
  const opening = session.createUnidirectionalStream(); globalThis.__testNativePump(1 / 60);
  const writer = (await opening).getWriter();
  const closed = writer.closed.catch((error) => error);
  const first = writer.write(new Uint8Array([1]));
  const second = writer.write(new Uint8Array([2]));
  globalThis.__testNativePump(1 / 60);
  await assert.rejects(first, /write failed with status -2/u);
  await assert.rejects(second, /write failed with status -2/u);
  assert.match((await closed).message, /write failed with status -2/u);
  assert.equal(resets, 1);
  await assert.rejects(writer.write(new Uint8Array([3])), /write failed with status -2/u);
  session.close(); globalThis.__testNativePump(1 / 60); await session.closed;
});

test("aborting a stream discards writes still queued behind provider backpressure", async (t) => {
  const fake = fakeProvider();
  fake.provider.writeStream = () => 1;
  let resets = 0;
  fake.provider.resetStream = () => { resets += 1; return 0; };
  globalThis.__testNativeWebTransport = fake.provider;
  delete globalThis.WebTransport;
  t.after(() => { delete globalThis.__testNativeWebTransport; delete globalThis.__testNativePump; });
  const { WebTransport } = await runtimeModule(t);
  const session = new WebTransport("https://example.test/abort-queued", nativeOptions());
  globalThis.__testNativePump(1 / 60); await session.ready;
  const opening = session.createUnidirectionalStream(); globalThis.__testNativePump(1 / 60);
  const writer = (await opening).getWriter();
  const closed = writer.closed.catch((error) => error);
  const queued = writer.write(new Uint8Array([1, 2, 3]));
  await writer.abort(new Error("discard queued"));
  await assert.rejects(queued, /discard queued/u);
  assert.match((await closed).message, /discard queued/u);
  assert.equal(resets, 1);
  session.close(); globalThis.__testNativePump(1 / 60); await session.closed;
});

test("late terminal peer events are consumed for still-known streams", async (t) => {
  const fake = fakeProvider();
  globalThis.__testNativeWebTransport = fake.provider;
  delete globalThis.WebTransport;
  t.after(() => { delete globalThis.__testNativeWebTransport; delete globalThis.__testNativePump; });
  const { WebTransport } = await runtimeModule(t);
  const session = new WebTransport("https://example.test/late-terminal", nativeOptions());
  globalThis.__testNativePump(1 / 60); await session.ready;
  const opening = session.createBidirectionalStream(); globalThis.__testNativePump(1 / 60);
  const stream = await opening;
  await stream.readable.cancel();
  fake.push(1, { kind: 5, stream: 101, code: 11 });
  globalThis.__testNativePump(1 / 60);
  const secondOpening = session.createBidirectionalStream(); globalThis.__testNativePump(1 / 60);
  const second = await secondOpening;
  await second.writable.abort(new Error("local terminal"));
  fake.push(1, { kind: 6, stream: 102, code: 12 });
  globalThis.__testNativePump(1 / 60);
  session.close(); globalThis.__testNativePump(1 / 60);
  assert.deepEqual(await session.closed, { closeCode: 0, reason: "" });
});

test("releaseLock rejects pending reads and permits a replacement reader", async (t) => {
  const fake = fakeProvider();
  globalThis.__testNativeWebTransport = fake.provider;
  delete globalThis.WebTransport;
  t.after(() => { delete globalThis.__testNativeWebTransport; delete globalThis.__testNativePump; });
  const { WebTransport } = await runtimeModule(t);
  const session = new WebTransport("https://example.test/pending-read", nativeOptions());
  globalThis.__testNativePump(1 / 60); await session.ready;
  const opening = session.createBidirectionalStream(); globalThis.__testNativePump(1 / 60);
  const stream = await opening;
  const reader = stream.readable.getReader();
  const pending = reader.read();
  reader.releaseLock();
  await assert.rejects(pending, /Reader lock was released/u);
  const replacement = stream.readable.getReader();
  fake.push(1, { kind: 3, stream: 101, payload: new Uint8Array([9]) });
  globalThis.__testNativePump(1 / 60);
  assert.deepEqual(await replacement.read(), { done: false, value: new Uint8Array([9]) });
  session.close(); globalThis.__testNativePump(1 / 60); await session.closed;
});

test("cancelled incoming collections retire queued and later peer streams", async (t) => {
  const fake = fakeProvider();
  let stops = 0;
  fake.provider.stopSending = () => { stops += 1; return 0; };
  globalThis.__testNativeWebTransport = fake.provider;
  delete globalThis.WebTransport;
  t.after(() => { delete globalThis.__testNativeWebTransport; delete globalThis.__testNativePump; });
  const { WebTransport } = await runtimeModule(t);
  const session = new WebTransport("https://example.test/cancel-incoming", nativeOptions());
  globalThis.__testNativePump(1 / 60); await session.ready;
  fake.push(1, { kind: 2, flags: 4, stream: 701 });
  globalThis.__testNativePump(1 / 60);
  await session.incomingUnidirectionalStreams.cancel();
  assert.equal(stops, 1);
  fake.push(1, { kind: 2, flags: 4, stream: 701 });
  globalThis.__testNativePump(1 / 60);
  assert.equal(stops, 2, "retired streams must not leak handles in the facade registry");
  session.close(); globalThis.__testNativePump(1 / 60); await session.closed;
});

test("native close reasons are capped to 1024 UTF-8 bytes on a code-point boundary", async (t) => {
  const fake = fakeProvider();
  let closeReason = "";
  fake.provider.close = (session, code, reason) => {
    closeReason = reason; fake.push(session, { kind: 7, code, payload: new TextEncoder().encode(reason) }); return 0;
  };
  globalThis.__testNativeWebTransport = fake.provider;
  delete globalThis.WebTransport;
  t.after(() => { delete globalThis.__testNativeWebTransport; delete globalThis.__testNativePump; });
  const { WebTransport } = await runtimeModule(t);
  const session = new WebTransport("https://example.test/close-bound", nativeOptions());
  globalThis.__testNativePump(1 / 60); await session.ready;
  session.close({ reason: "😀".repeat(300) }); globalThis.__testNativePump(1 / 60);
  assert.equal(new TextEncoder().encode(closeReason).byteLength, 1024);
  assert.equal(closeReason, "😀".repeat(256));
  await session.closed;
});

test("remote stop-sending terminally errors its writer without issuing another reset", async (t) => {
  const fake = fakeProvider();
  let resets = 0;
  fake.provider.resetStream = () => { resets += 1; return 0; };
  globalThis.__testNativeWebTransport = fake.provider;
  delete globalThis.WebTransport;
  t.after(() => { delete globalThis.__testNativeWebTransport; delete globalThis.__testNativePump; });
  const { WebTransport } = await runtimeModule(t);
  const session = new WebTransport("https://example.test/stream", nativeOptions());
  globalThis.__testNativePump(1 / 60); await session.ready;
  const streamPromise = session.createUnidirectionalStream();
  globalThis.__testNativePump(1 / 60);
  const stream = await streamPromise;
  const writer = stream.getWriter();
  fake.push(1, { kind: 6, stream: 101, code: 17 });
  globalThis.__testNativePump(1 / 60);
  await assert.rejects(writer.write(new Uint8Array([1])), /Stop sending: 17/u);
  assert.equal(resets, 0);
  session.close(); globalThis.__testNativePump(1 / 60); await session.closed;
});

test("rejected stop-sending and reset operations preserve both JavaScript stream halves for retry", async (t) => {
  const fake = fakeProvider();
  const stopStatuses = [-2, 0];
  const resetStatuses = [1, 0];
  let stopCalls = 0, resetCalls = 0;
  fake.provider.stopSending = () => { stopCalls += 1; return stopStatuses.shift(); };
  fake.provider.resetStream = () => { resetCalls += 1; return resetStatuses.shift(); };
  globalThis.__testNativeWebTransport = fake.provider;
  delete globalThis.WebTransport;
  t.after(() => { delete globalThis.__testNativeWebTransport; delete globalThis.__testNativePump; });
  const { WebTransport } = await runtimeModule(t);
  const session = new WebTransport("https://example.test/control-retry", nativeOptions());
  globalThis.__testNativePump(1 / 60); await session.ready;
  const streamPromise = session.createBidirectionalStream();
  globalThis.__testNativePump(1 / 60);
  const stream = await streamPromise;
  const reader = stream.readable.getReader();
  const writer = stream.writable.getWriter();
  const writerClosed = writer.closed.catch((error) => error);

  await assert.rejects(reader.cancel("rejected"), /stopSending failed with status -2/u);
  const read = reader.read();
  fake.push(1, { kind: 3, stream: 101, payload: new Uint8Array([7, 8]) });
  globalThis.__testNativePump(1 / 60);
  assert.deepEqual(await read, { done: false, value: new Uint8Array([7, 8]) },
    "failed stopSending must not retire or drain the readable half");

  await assert.rejects(writer.abort(new Error("retry later")), /resetStream failed with status 1/u);
  await writer.write(new Uint8Array([9]));
  assert.deepEqual(fake.writes.at(-1), { session: 1, stream: 101, bytes: [9], fin: false, datagram: false },
    "would-block reset must leave the writable half usable");

  await reader.cancel("accepted");
  await writer.abort(new Error("accepted abort"));
  assert.equal((await writerClosed).message, "accepted abort");
  assert.equal(stopCalls, 2);
  assert.equal(resetCalls, 2);
  session.close(); globalThis.__testNativePump(1 / 60); await session.closed;
});

test("released reader and writer locks reject every operation owned by the released lock", async (t) => {
  const fake = fakeProvider();
  globalThis.__testNativeWebTransport = fake.provider;
  delete globalThis.WebTransport;
  t.after(() => { delete globalThis.__testNativeWebTransport; delete globalThis.__testNativePump; });
  const { WebTransport } = await runtimeModule(t);
  const session = new WebTransport("https://example.test/released-locks", nativeOptions());
  globalThis.__testNativePump(1 / 60); await session.ready;
  const streamPromise = session.createBidirectionalStream();
  globalThis.__testNativePump(1 / 60);
  const stream = await streamPromise;
  const reader = stream.readable.getReader();
  const writer = stream.writable.getWriter();
  reader.releaseLock();
  writer.releaseLock();
  await assert.rejects(reader.read(), /Reader lock was released/u);
  await assert.rejects(reader.cancel(), /Reader lock was released/u);
  await assert.rejects(writer.ready, /Writer lock was released/u);
  await assert.rejects(writer.write(new Uint8Array([1])), /Writer lock was released/u);
  await assert.rejects(writer.close(), /Writer lock was released/u);
  await assert.rejects(writer.abort(), /Writer lock was released/u);
  session.close(); globalThis.__testNativePump(1 / 60); await session.closed;
});

test("native terminal state without a close record rejects promises and releases the provider slot", async (t) => {
  const fake = fakeProvider();
  globalThis.__testNativeWebTransport = fake.provider;
  delete globalThis.WebTransport;
  t.after(() => { delete globalThis.__testNativeWebTransport; delete globalThis.__testNativePump; });
  const { WebTransport } = await runtimeModule(t);
  const session = new WebTransport("https://example.test/lost-close", nativeOptions());
  const ready = session.ready.catch((error) => error);
  const closed = session.closed.catch((error) => error);
  fake.events.get(1).length = 0;
  fake.states.set(1, 5);
  globalThis.__testNativePump(1 / 60);
  assert.match((await ready).message, /terminated without a close event/u);
  assert.match((await closed).message, /terminated without a close event/u);
  assert.deepEqual(fake.destroys, [1]);
});

test("native close reasons decode lossily instead of turning closure into a transport failure", async (t) => {
  const fake = fakeProvider();
  globalThis.__testNativeWebTransport = fake.provider;
  delete globalThis.WebTransport;
  t.after(() => { delete globalThis.__testNativeWebTransport; delete globalThis.__testNativePump; });
  const { WebTransport } = await runtimeModule(t);
  const session = new WebTransport("https://example.test/invalid-close-reason", nativeOptions());
  globalThis.__testNativePump(1 / 60);
  await session.ready;
  fake.states.set(1, 4);
  fake.push(1, { kind: 7, code: 0, payload: new Uint8Array([0xe2, 0x41]) });
  globalThis.__testNativePump(1 / 60);
  assert.deepEqual(await session.closed, { closeCode: 0, reason: "�A" },
    "malformed UTF-8 must not consume a following valid non-continuation byte");
});

test("remote stream and aggregate-byte floods fail closed without polling after destroy", async (t) => {
  const fake = fakeProvider();
  let pollsAfterDestroy = 0;
  const originalPoll = fake.provider.poll;
  fake.provider.poll = (session, output) => {
    if (fake.destroys.includes(session)) { pollsAfterDestroy += 1; return -6; }
    return originalPoll(session, output);
  };
  globalThis.__testNativeWebTransport = fake.provider;
  delete globalThis.WebTransport;
  t.after(() => { delete globalThis.__testNativeWebTransport; delete globalThis.__testNativePump; });
  const { WebTransport } = await runtimeModule(t);
  const session = new WebTransport("https://example.test/flood", nativeOptions());
  const closed = session.closed.catch((error) => error);
  globalThis.__testNativePump(1 / 60); await session.ready;
  for (let stream = 1; stream <= 64; stream += 1) fake.push(1, { kind: 2, flags: 4, stream });
  fake.push(1, { kind: 2, flags: 4, stream: 65 });
  globalThis.__testNativePump(1 / 60);
  globalThis.__testNativePump(1 / 60);
  assert.match((await closed).message, /stream limit exceeded/u);
  assert.equal(pollsAfterDestroy, 0);

  const aggregate = new WebTransport("https://example.test/aggregate", nativeOptions());
  const aggregateClosed = aggregate.closed.catch((error) => error);
  globalThis.__testNativePump(1 / 60); await aggregate.ready;
  fake.push(2, { kind: 2, flags: 4, stream: 201 });
  fake.push(2, { kind: 3, stream: 201, payload: new Uint8Array(600000) });
  fake.push(2, { kind: 2, flags: 4, stream: 202 });
  fake.push(2, { kind: 3, stream: 202, payload: new Uint8Array(600000) });
  globalThis.__testNativePump(1 / 60);
  assert.match((await aggregateClosed).message, /byte queue overflow/u);
  assert.equal(pollsAfterDestroy, 0);
});
