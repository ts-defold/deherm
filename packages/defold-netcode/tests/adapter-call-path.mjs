// Drives the whole netcode C API from JavaScript, through nothing but the
// exported C symbols and the wasm heap.
//
// This is the adapter's call path, not an imitation of it. On HTML5 the déherm
// web adapter reaches a native extension exactly this way: flat scalar
// arguments, buffers as heap offsets, no struct crossing the boundary, no
// allocation handed back for the caller to free. If the API can be driven to a
// connected netcode session from here, it can be driven from the adapter.
//
// It is also the JS side of the WebTransport bridge under test. The pump below
// moves bytes between the two ends with pop_datagram/push_datagram, which is
// what lib/web/library_defold_netcode.js does with a datagram channel in place
// of a function call. What this does NOT test is WebTransport itself - there is
// no session here, and that boundary is stated in the decision note.

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const require = createRequire(import.meta.url);
const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const modulePath = path.join(packageRoot, "build/wasm/adapter_call_path.js");

// uint64 parameters. Emscripten 4.x compiles with WASM_BIGINT on by default,
// so a wasm i64 is a JavaScript BigInt at the boundary rather than the low/high
// pair older toolchains split it into. That is a property of the toolchain, not
// of this header - the C signature is plain `uint64_t` either way - but the
// adapter has to know which it is talking to, so it is named here rather than
// discovered by a TypeError.
const PROTOCOL_ID = 0x1122334455667788n;
const CLIENT_ID = 0xdeadbeefn;

const TRANSPORT_HOST_DATAGRAM = 1;
const STATE_CONNECTED = 3;
const STATE_DISCONNECTED = 0;
const CONNECT_TOKEN_BYTES = 2048;
const KEY_BYTES = 32;
const USER_DATA_BYTES = 256;
const MAX_PACKET_BYTES = 1200;
const OK = 0;

const PRIVATE_KEY = Uint8Array.from([
  0x60, 0x6a, 0xbe, 0x6e, 0xc9, 0x19, 0x10, 0xea, 0x9a, 0x65, 0x62, 0xf6, 0x6f, 0x2b, 0x30, 0xe4,
  0x43, 0x71, 0xd6, 0x2c, 0xd1, 0x99, 0x27, 0x26, 0x6b, 0x3c, 0x60, 0xf4, 0xb7, 0x15, 0xab, 0xa1,
]);

let failures = 0;
function check(condition, description) {
  if (!condition) {
    console.log(`FAIL ${description}`);
    failures++;
  }
  return condition;
}

const factory = require(modulePath);
const wasm = await factory();

// A tiny arena rather than malloc/free per call. The adapter does the same
// thing for the same reason: a per-call allocation on the hot path is the cost
// this project exists to avoid, and every buffer here has a known upper bound.
class Arena {
  constructor(module, bytes) {
    this.module = module;
    this.base = module._malloc(bytes);
    this.capacity = bytes;
    this.used = 0;
  }
  alloc(bytes) {
    const aligned = (bytes + 7) & ~7;
    if (this.used + aligned > this.capacity) throw new RangeError("adapter arena exhausted");
    const pointer = this.base + this.used;
    this.used += aligned;
    return pointer;
  }
  writeBytes(data) {
    const pointer = this.alloc(data.length);
    this.module.HEAPU8.set(data, pointer);
    return pointer;
  }
  writeString(text) {
    const bytes = new TextEncoder().encode(text);
    const pointer = this.alloc(bytes.length + 1);
    this.module.HEAPU8.set(bytes, pointer);
    this.module.HEAPU8[pointer + bytes.length] = 0;
    return pointer;
  }
  readBytes(pointer, length) {
    return this.module.HEAPU8.slice(pointer, pointer + length);
  }
}

const arena = new Arena(wasm, 64 * 1024);

const call = (name, ...args) => wasm[`_${name}`](...args);

check(call("deherm_netcode_init") === OK, "deherm_netcode_init returns OK");

const serverAddress = arena.writeString("127.0.0.1:40000");
const clientAddress = arena.writeString("127.0.0.1:50000");
const keyPointer = arena.writeBytes(PRIVATE_KEY);

const server = wasm._deherm_netcode_server_create(
  serverAddress,
  PROTOCOL_ID,
  keyPointer,
  KEY_BYTES,
  TRANSPORT_HOST_DATAGRAM,
);
check(server !== 0, "server_create returns a handle");
check(call("deherm_netcode_server_set_peer_address", server, clientAddress) === OK, "server_set_peer_address");
check(call("deherm_netcode_server_start", server, 4) === OK, "server_start");
check(call("deherm_netcode_server_running", server) === 1, "server_running");

const client = call("deherm_netcode_client_create", clientAddress, TRANSPORT_HOST_DATAGRAM);
check(client !== 0, "client_create returns a handle");

const userData = arena.writeBytes(new Uint8Array(USER_DATA_BYTES).fill(0x5a));
const tokenPointer = arena.alloc(CONNECT_TOKEN_BYTES);
const generated = wasm._deherm_netcode_generate_connect_token(
  serverAddress,
  CLIENT_ID,
  PROTOCOL_ID,
  keyPointer,
  KEY_BYTES,
  30,
  5,
  userData,
  USER_DATA_BYTES,
  tokenPointer,
  CONNECT_TOKEN_BYTES,
);
check(generated === OK, "generate_connect_token returns OK");

check(
  call("deherm_netcode_client_connect", client, tokenPointer, CONNECT_TOKEN_BYTES) === OK,
  "client_connect returns OK",
);

// The datagram scratch buffer is sized for netcode's largest packet - the
// connection request carrying a 2048-byte connect token - not its payload limit.
const datagram = arena.alloc(2560);
const sequenceOut = arena.alloc(8);

function pump() {
  let moved = 0;
  for (;;) {
    const bytes = call("deherm_netcode_client_pop_datagram", client, datagram, 2560);
    if (bytes <= 0) break;
    check(call("deherm_netcode_server_push_datagram", server, datagram, bytes) === OK, "server push");
    moved++;
  }
  for (;;) {
    const bytes = call("deherm_netcode_server_pop_datagram", server, datagram, 2560);
    if (bytes <= 0) break;
    check(call("deherm_netcode_client_push_datagram", client, datagram, bytes) === OK, "client push");
    moved++;
  }
  return moved;
}

let time = 0;
const delta = 1 / 60;
let ticks = 0;
while (call("deherm_netcode_client_state", client) !== STATE_CONNECTED) {
  if (!check(call("deherm_netcode_client_state", client) > STATE_DISCONNECTED, "client did not fail to connect")) break;
  if (!check(ticks++ < 4000, "handshake completed within 4000 ticks")) break;
  call("deherm_netcode_client_update", client, time);
  call("deherm_netcode_server_update", server, time);
  pump();
  time += delta;
}

const clientIndex = call("deherm_netcode_client_index", client);
console.log(`  connected after ${ticks} ticks, client_index=${clientIndex}`);
check(call("deherm_netcode_server_num_connected_clients", server) === 1, "server sees one connected client");
// The one value that has to survive the boundary as a real 64-bit quantity: it
// went in as a BigInt, through the connect token's encryption, and comes back
// from the server's client slot.
check(
  call("deherm_netcode_server_client_id", server, clientIndex) === CLIENT_ID,
  "client id round-trips as a uint64 through the connect token",
);

const payload = new Uint8Array(MAX_PACKET_BYTES);
for (let i = 0; i < payload.length; i++) payload[i] = i & 0xff;
const payloadPointer = arena.writeBytes(payload);
const receivePointer = arena.alloc(MAX_PACKET_BYTES);

let serverReceived = 0;
let clientReceived = 0;
const frames = 120;
for (let frame = 0; frame < frames; frame++) {
  check(call("deherm_netcode_client_send", client, payloadPointer, MAX_PACKET_BYTES) === OK, "client_send");
  check(
    call("deherm_netcode_server_send", server, clientIndex, payloadPointer, MAX_PACKET_BYTES) === OK,
    "server_send",
  );

  call("deherm_netcode_client_update", client, time);
  call("deherm_netcode_server_update", server, time);
  pump();
  time += delta;

  for (;;) {
    const bytes = call(
      "deherm_netcode_server_receive", server, clientIndex, receivePointer, MAX_PACKET_BYTES, sequenceOut);
    if (bytes <= 0) break;
    check(bytes === MAX_PACKET_BYTES, "server payload length");
    const got = arena.readBytes(receivePointer, bytes);
    check(got.every((value, index) => value === payload[index]), "server payload bytes match");
    serverReceived++;
  }
  for (;;) {
    const bytes = call("deherm_netcode_client_receive", client, receivePointer, MAX_PACKET_BYTES, sequenceOut);
    if (bytes <= 0) break;
    check(bytes === MAX_PACKET_BYTES, "client payload length");
    const got = arena.readBytes(receivePointer, bytes);
    check(got.every((value, index) => value === payload[index]), "client payload bytes match");
    clientReceived++;
  }
}

console.log(`  payloads over ${frames} frames: server received ${serverReceived}, client received ${clientReceived}`);
check(serverReceived >= frames - 4, "server received nearly every payload");
check(clientReceived >= frames - 4, "client received nearly every payload");

call("deherm_netcode_client_destroy", client);
call("deherm_netcode_server_destroy", server);
call("deherm_netcode_term");

if (failures) {
  console.log(`FAILED (${failures} checks)`);
  process.exit(1);
}
console.log("PASS: the netcode C API drives a connected session from JavaScript through exported symbols alone");
