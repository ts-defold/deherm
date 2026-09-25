#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseNativeModuleDescriptorJson } from "../packages/compiler/src/native-module-provider-generator.mjs";

export const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extensionRoot = path.join(repositoryRoot, "extensions/defold-webtransport/defold_webtransport");
const compatibilityPath = path.join(extensionRoot, "webtransport/public-api-compatibility.json");

function fail(message) {
  throw new Error(`defold-webtransport community API: ${message}`);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function method(module, name, args, returns) {
  const candidate = module.methods.find((entry) => entry.name === name);
  if (!candidate) fail(`bridge descriptor has no ${name} capability`);
  const actual = candidate.args.map((argument) => argument.type);
  if (JSON.stringify(actual) !== JSON.stringify(args) || candidate.returns !== returns) {
    fail(`${name} bridge shape is ${actual.join(",")} -> ${candidate.returns}, expected ${args.join(",")} -> ${returns}`);
  }
  return candidate.name;
}

function validateInputs(compatibility, descriptor) {
  if (compatibility.schemaVersion !== 1 || compatibility.generation?.recipe !== "webtransport-community-v1") {
    fail("unsupported public compatibility generation recipe");
  }
  const streams = compatibility.generation.nativeStreams;
  if (streams?.implementation !== "extension-local-bounded-structural" ||
      streams.requiresGlobalReadableStream !== false || streams.requiresGlobalWritableStream !== false ||
      !Number.isInteger(streams.maximumQueuedItemsPerQueue) || streams.maximumQueuedItemsPerQueue < 1 ||
      !Number.isInteger(streams.maximumStreamsPerSession) || streams.maximumStreamsPerSession < 1 ||
      !Number.isInteger(streams.maximumQueuedBytesPerSession) || streams.maximumQueuedBytesPerSession < 1) {
    fail("native community facade must own bounded structural streams without DOM globals");
  }
  if (compatibility.generation.nativeTrust?.mode !== "single-sha-256-certificate-hash-required" ||
      compatibility.generation.nativeTrust.browserMayUseRootTrust !== true) {
    fail("native 0.1 trust policy must require one sha-256 certificate hash without constraining browsers");
  }
  if (compatibility.generation.nativePump?.registration !== "registerNativeModulePump" ||
      compatibility.generation.nativePump.public !== false ||
      compatibility.generation.nativePump.browserRegistration !== false ||
      compatibility.generation.nativePump.lifetime !== "module-singleton" ||
      !Number.isInteger(compatibility.generation.nativePump.maximumSessions) ||
      compatibility.generation.nativePump.maximumSessions < 1) {
    fail("native pump must be private, browser-free, module-singleton, and bounded");
  }
  if (descriptor.schemaVersion !== 1 || descriptor.nativeModules?.length !== 1) {
    fail("expected one versioned native module descriptor");
  }
  const module = descriptor.nativeModules[0];
  if (module.name !== "NativeWebTransport" || module.abiVersion !== 1) fail("unsupported native module identity");
  const capabilities = {
    open: method(module, "open", ["utf8", "bytes", "u32", "u32"], "u32"),
    state: method(module, "state", ["u32"], "u32"),
    maxDatagramBytes: method(module, "maxDatagramBytes", ["u32"], "u32"),
    openBidirectionalStream: method(module, "openBidirectionalStream", ["u32", "u32"], "status"),
    openUnidirectionalStream: method(module, "openUnidirectionalStream", ["u32", "u32"], "status"),
    writeStream: method(module, "writeStream", ["u32", "u32", "bytes", "bool"], "status"),
    resetStream: method(module, "resetStream", ["u32", "u32", "u32"], "status"),
    stopSending: method(module, "stopSending", ["u32", "u32", "u32"], "status"),
    trySendDatagram: method(module, "trySendDatagram", ["u32", "bytes"], "status"),
    poll: method(module, "poll", ["u32", "mutableBytes"], "status"),
    close: method(module, "close", ["u32", "u32", "utf8"], "status"),
    destroy: method(module, "destroy", ["u32"], "status")
  };
  const poll = module.constants?.pollEvent;
  const fields = Object.fromEntries((poll?.fields ?? []).map((field) => [field.name, field]));
  const expectedFields = {
    kind: [0, "u32le"], flags: [4, "u32le"], code: [8, "i32le"], requestId: [12, "u32le"],
    streamHandle: [16, "u32le"], payloadLength: [20, "u32le"], reserved: [24, "u32le"],
    headerVersion: [28, "u32le"]
  };
  if (module.constants.pollHeaderBytes !== 32 || poll?.headerVersion !== 1 ||
      poll?.retainsEventOnBufferTooSmall !== true ||
      poll?.bufferTooSmallStatus !== module.constants.status?.bufferTooSmall ||
      !Number.isInteger(poll?.initialPayloadBytes) || poll.initialPayloadBytes < 1 ||
      !Number.isInteger(poll?.maximumPayloadBytes) || poll.maximumPayloadBytes < poll.initialPayloadBytes) {
    fail("unsupported poll event ownership contract");
  }
  for (const [name, [offset, type]] of Object.entries(expectedFields)) {
    if (fields[name]?.offset !== offset || fields[name]?.type !== type) fail(`unsupported poll field ${name}`);
  }
  return { module, capabilities, poll, streams, pump: compatibility.generation.nativePump };
}

function banner(kind, inputHash) {
  const prefix = kind === "c" ? "//" : kind === "typescript" ? "//" : "#";
  return `${prefix} Generated by scripts/generate-defold-webtransport-community-api.mjs. Do not edit.\n${prefix} Input SHA-256: ${inputHash}\n`;
}

function renderLua(inputHash) {
  return `${banner("lua", inputHash)}- name: defold_webtransport
  type: table
  desc: Event-driven WebTransport sessions, streams, and datagrams. Session and stream values are opaque userdata.
  members:
    - name: connect
      type: function
      desc: Start an HTTPS WebTransport session. Events are delivered to callback on the Defold main thread.
      parameters:
        - { name: url, type: string, desc: HTTPS WebTransport URL. }
        - { name: "options[optional]", type: table, desc: Certificate hashes and anticipated incoming stream counts; may be nil when passing callback as the third argument. }
        - { name: callback, type: function, desc: Receives self plus ready, stream, data, datagram, reset, stop_sending, and close event tables in the originating script instance context. }
      returns:
        - { name: session, type: userdata, desc: Opaque WebTransport session. }
    - name: close
      type: function
      desc: Request a clean session close.
      parameters:
        - { name: session, type: userdata, desc: Session returned by connect. }
        - { name: "close_code[optional]", type: number, desc: Unsigned application close code. }
        - { name: "reason[optional]", type: string, desc: UTF-8 close reason. }
    - name: create_bidirectional_stream
      type: function
      desc: Request a bidirectional byte stream. Completion is reported by a stream event.
      parameters:
        - { name: session, type: userdata, desc: Open session. }
    - name: create_unidirectional_stream
      type: function
      desc: Request an outgoing unidirectional byte stream. Completion is reported by a stream event.
      parameters:
        - { name: session, type: userdata, desc: Open session. }
    - name: write
      type: function
      desc: Queue bytes on an outgoing stream; fin closes its sending direction.
      parameters:
        - { name: stream, type: userdata, desc: Opaque writable stream. }
        - { name: bytes, type: string, desc: Binary byte string. }
        - { name: "fin[optional]", type: boolean, desc: Finish the sending direction after these bytes. }
      returns:
        - { name: accepted, type: boolean, desc: False when bounded native backpressure refuses the write. }
    - name: reset_stream
      type: function
      desc: Abort the sending direction with an application stream error code.
      parameters:
        - { name: stream, type: userdata, desc: Writable stream. }
        - { name: "code[optional]", type: number, desc: Unsigned stream error code. }
      returns:
        - { name: accepted, type: boolean, desc: False when the reset could not be queued; the stream remains writable. }
    - name: stop_sending
      type: function
      desc: Request that the peer stop its sending direction.
      parameters:
        - { name: stream, type: userdata, desc: Readable stream. }
        - { name: "code[optional]", type: number, desc: Unsigned stream error code. }
      returns:
        - { name: accepted, type: boolean, desc: False when the request could not be queued; the stream remains readable. }
    - name: send_datagram
      type: function
      desc: Queue one unreliable datagram without message-level retransmission.
      parameters:
        - { name: session, type: userdata, desc: Open session. }
        - { name: bytes, type: string, desc: Datagram bytes. }
      returns:
        - { name: accepted, type: boolean, desc: False for backpressure or an oversized datagram. }
    - name: max_datagram_size
      type: function
      desc: Return the current maximum outgoing datagram size in bytes.
      parameters:
        - { name: session, type: userdata, desc: Session. }
      returns:
        - { name: bytes, type: number, desc: Zero until ready or when datagrams are unavailable. }
`;
}

function renderHeader(inputHash) {
  return `${banner("c", inputHash)}#ifndef DEFOLD_WEBTRANSPORT_CLIENT_H
#define DEFOLD_WEBTRANSPORT_CLIENT_H
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif

#define DEFOLD_WEBTRANSPORT_CLIENT_ABI_VERSION 1u
#define DEFOLD_WEBTRANSPORT_MAX_CERTIFICATE_HASHES 8u

typedef struct DefoldWebTransportSession DefoldWebTransportSession;
typedef struct DefoldWebTransportStream DefoldWebTransportStream;

typedef struct DefoldWebTransportBytes {
  const uint8_t* data;
  size_t size;
} DefoldWebTransportBytes;

typedef struct DefoldWebTransportCertificateHash {
  const char* algorithm;
  DefoldWebTransportBytes value;
} DefoldWebTransportCertificateHash;

typedef enum DefoldWebTransportEventType {
  DEFOLD_WEBTRANSPORT_EVENT_READY = 1,
  DEFOLD_WEBTRANSPORT_EVENT_STREAM = 2,
  DEFOLD_WEBTRANSPORT_EVENT_DATA = 3,
  DEFOLD_WEBTRANSPORT_EVENT_DATAGRAM = 4,
  DEFOLD_WEBTRANSPORT_EVENT_STREAM_RESET = 5,
  DEFOLD_WEBTRANSPORT_EVENT_STOP_SENDING = 6,
  DEFOLD_WEBTRANSPORT_EVENT_CLOSE = 7
} DefoldWebTransportEventType;

typedef struct DefoldWebTransportEvent {
  uint32_t struct_size;
  DefoldWebTransportEventType type;
  DefoldWebTransportSession* session;
  DefoldWebTransportStream* stream;
  DefoldWebTransportBytes bytes;
  uint32_t code;
  const char* reason;
  bool fin;
  bool bidirectional;
  bool incoming;
} DefoldWebTransportEvent;

/* Event, bytes, and reason storage is borrowed and remains valid only during the callback. */
typedef void (*DefoldWebTransportEventCallback)(void* user_data, const DefoldWebTransportEvent* event);

typedef struct DefoldWebTransportOptions {
  uint32_t abi_version;
  uint32_t struct_size;
  const char* url;
  const DefoldWebTransportCertificateHash* certificate_hashes;
  size_t certificate_hash_count;
  uint16_t anticipated_incoming_unidirectional_streams;
  uint16_t anticipated_incoming_bidirectional_streams;
  DefoldWebTransportEventCallback callback;
  void* user_data;
} DefoldWebTransportOptions;

DefoldWebTransportSession* defold_webtransport_connect(const DefoldWebTransportOptions* options);
/* One-shot ownership release. Stops if needed; invalidates all session-owned stream pointers.
 * Calls made reentrantly from an event callback are deferred until callback dispatch returns. */
void defold_webtransport_destroy(DefoldWebTransportSession* session);
void defold_webtransport_close(DefoldWebTransportSession* session, uint32_t close_code, const char* reason);
bool defold_webtransport_create_bidirectional_stream(DefoldWebTransportSession* session);
bool defold_webtransport_create_unidirectional_stream(DefoldWebTransportSession* session);
bool defold_webtransport_stream_write(DefoldWebTransportStream* stream, DefoldWebTransportBytes bytes, bool fin);
bool defold_webtransport_stream_reset(DefoldWebTransportStream* stream, uint32_t code);
bool defold_webtransport_stream_stop_sending(DefoldWebTransportStream* stream, uint32_t code);
/* Releases only the wrapper pointer; the native stream remains session-owned. */
void defold_webtransport_stream_release(DefoldWebTransportStream* stream);
bool defold_webtransport_send_datagram(DefoldWebTransportSession* session, DefoldWebTransportBytes bytes);
size_t defold_webtransport_max_datagram_size(const DefoldWebTransportSession* session);

#ifdef __cplusplus
}
#endif
#endif
`;
}

function renderLuaRegistration(inputHash) {
  return `${banner("c", inputHash)}{ "connect", LuaConnect },
{ "close", LuaClose },
{ "create_bidirectional_stream", LuaCreateBidirectionalStream },
{ "create_unidirectional_stream", LuaCreateUnidirectionalStream },
{ "write", LuaWrite },
{ "reset_stream", LuaResetStream },
{ "stop_sending", LuaStopSending },
{ "send_datagram", LuaSendDatagram },
{ "max_datagram_size", LuaMaxDatagramSize },
{ nullptr, nullptr },
`;
}

function cConstantName(value) {
  return value.replace(/([a-z0-9])([A-Z])/gu, "$1_$2").toUpperCase();
}

function renderNativeHeader(inputHash, contract) {
  const { module } = contract;
  const constants = (prefix, values) => Object.entries(values)
    .map(([name, value]) => `  DEFOLD_WEBTRANSPORT_NATIVE_V1_${prefix}_${cConstantName(name)} = ${value}`)
    .join(",\n");
  return `${banner("c", inputHash)}#ifndef DEFOLD_WEBTRANSPORT_NATIVE_V1_H
#define DEFOLD_WEBTRANSPORT_NATIVE_V1_H
#include <stdbool.h>
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif

#define DEFOLD_WEBTRANSPORT_NATIVE_V1_ABI_VERSION ${module.abiVersion}u
#define DEFOLD_WEBTRANSPORT_NATIVE_V1_POLL_HEADER_BYTES ${module.constants.pollHeaderBytes}u
#define DEFOLD_WEBTRANSPORT_NATIVE_V1_POLL_HEADER_VERSION ${module.constants.pollEvent.headerVersion}u
#define DEFOLD_WEBTRANSPORT_NATIVE_V1_INITIAL_PAYLOAD_BYTES ${module.constants.pollEvent.initialPayloadBytes}u
#define DEFOLD_WEBTRANSPORT_NATIVE_V1_MAXIMUM_PAYLOAD_BYTES ${module.constants.pollEvent.maximumPayloadBytes}u

typedef enum DefoldWebTransportNativeV1Status {
${constants("STATUS", module.constants.status)}
} DefoldWebTransportNativeV1Status;
typedef enum DefoldWebTransportNativeV1State {
${constants("STATE", module.constants.state)}
} DefoldWebTransportNativeV1State;
typedef enum DefoldWebTransportNativeV1EventKind {
${constants("EVENT", module.constants.eventKind)}
} DefoldWebTransportNativeV1EventKind;
typedef enum DefoldWebTransportNativeV1EventFlag {
${constants("FLAG", module.constants.eventFlag)}
} DefoldWebTransportNativeV1EventFlag;

typedef struct DefoldWebTransportNativeV1PollHeader {
  uint32_t kind;
  uint32_t flags;
  int32_t code;
  uint32_t request_id;
  uint32_t stream_handle;
  uint32_t payload_length;
  uint32_t reserved;
  uint32_t header_version;
} DefoldWebTransportNativeV1PollHeader;

#if defined(__cplusplus)
static_assert(sizeof(DefoldWebTransportNativeV1PollHeader) == DEFOLD_WEBTRANSPORT_NATIVE_V1_POLL_HEADER_BYTES, "poll header ABI");
#elif defined(__STDC_VERSION__) && __STDC_VERSION__ >= 201112L
_Static_assert(sizeof(DefoldWebTransportNativeV1PollHeader) == DEFOLD_WEBTRANSPORT_NATIVE_V1_POLL_HEADER_BYTES, "poll header ABI");
#endif

uint32_t defold_webtransport_native_v1_open(const char* url, uint32_t url_length, const uint8_t* certificate_sha256, uint32_t certificate_sha256_length, uint32_t anticipated_incoming_unidirectional_streams, uint32_t anticipated_incoming_bidirectional_streams);
uint32_t defold_webtransport_native_v1_state(uint32_t handle);
uint32_t defold_webtransport_native_v1_max_datagram_bytes(uint32_t handle);
int32_t defold_webtransport_native_v1_open_bidirectional_stream(uint32_t handle, uint32_t request_id);
int32_t defold_webtransport_native_v1_open_unidirectional_stream(uint32_t handle, uint32_t request_id);
int32_t defold_webtransport_native_v1_write_stream(uint32_t handle, uint32_t stream_handle, const uint8_t* bytes, uint32_t bytes_length, bool fin);
int32_t defold_webtransport_native_v1_reset_stream(uint32_t handle, uint32_t stream_handle, uint32_t code);
int32_t defold_webtransport_native_v1_stop_sending(uint32_t handle, uint32_t stream_handle, uint32_t code);
int32_t defold_webtransport_native_v1_try_send_datagram(uint32_t handle, const uint8_t* bytes, uint32_t bytes_length);
int32_t defold_webtransport_native_v1_poll(uint32_t handle, uint8_t* output, uint32_t output_length);
int32_t defold_webtransport_native_v1_close(uint32_t handle, uint32_t error_code, const char* reason, uint32_t reason_length);
int32_t defold_webtransport_native_v1_destroy(uint32_t handle);

#ifdef __cplusplus
}
#endif
#endif
`;
}

function renderTypeScript(inputHash, contract, target = "dynamic") {
  const { module, capabilities: m, poll, streams, pump } = contract;
  const staticTarget = target === "static";
  const byteType = "Uint8Array";
  const bufferSourceType = "ArrayBuffer | ArrayBufferView";
  // Hermes' TypeScript stripping frontend accepts the equivalent generic form
  // but not the `readonly T[]` shorthand.
  const hashArrayType = "ReadonlyArray<WebTransportHash>";
  const runtimeByteType = staticTarget ? "StaticWebTransportBytes" : "WebTransportBytes";
  const byteFactory = staticTarget
    ? "new Array<number>(length).fill(0)"
    : "new Uint8Array(length)";
  const byteGuard = staticTarget
    ? "Array.isArray(value) && value.every((entry) => Number.isInteger(entry) && entry >= 0 && entry <= 255)"
    : "value instanceof Uint8Array";
  const certificateConversion = staticTarget
    ? `const source = value as unknown as { readonly length?: number; readonly byteLength?: number; readonly [index: number]: number };\n  const length = typeof source.length === "number" ? source.length : source.byteLength;\n  if (length !== 32) throw new RangeError("sha-256 certificate hash must contain 32 bytes");\n  const bytes = makeBytes(32);\n  for (let index = 0; index < 32; index += 1) {\n    const byte = source[index];\n    if (!Number.isInteger(byte) || byte! < 0 || byte! > 255) throw new TypeError("sha-256 certificate hash must be byte-addressable");\n    bytes[index] = byte!;\n  }\n  return bytes;`
    : `const bytes = value instanceof ArrayBuffer\n    ? new Uint8Array(value)\n    : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);\n  if (bytes.length !== 32) throw new RangeError("sha-256 certificate hash must contain 32 bytes");\n  return bytes.slice();`;
  const constructorExport = staticTarget
    ? "export const WebTransport = NativeSession as unknown as WebTransportConstructor;"
    : "export const WebTransport = ((globalThis as typeof globalThis & { WebTransport?: WebTransportConstructor }).WebTransport ?? NativeSession) as WebTransportConstructor;";
  const status = JSON.stringify(module.constants.status);
  const states = JSON.stringify(module.constants.state);
  const events = JSON.stringify(module.constants.eventKind);
  const flags = JSON.stringify(module.constants.eventFlag);
  const publicContract = `
export type WebTransportBytes = ${byteType};
export type WebTransportBufferSource = ${bufferSourceType};
export type WebTransportUrl = string | { toString(): string };
export interface WebTransportHash { readonly algorithm: string; readonly value: WebTransportBufferSource; }
export interface WebTransportOptions {
  readonly serverCertificateHashes?: ${hashArrayType};
  readonly anticipatedConcurrentIncomingUnidirectionalStreams?: number;
  readonly anticipatedConcurrentIncomingBidirectionalStreams?: number;
}
export interface WebTransportCloseInfo { readonly closeCode?: number; readonly reason?: string; }
export type WebTransportReadResult<T> =
  | { readonly done: true; readonly value?: undefined }
  | { readonly done: false; readonly value: T };
export interface WebTransportReadableStreamReader<T> {
  readonly closed: Promise<void>;
  read(): Promise<WebTransportReadResult<T>>;
  cancel(reason?: unknown): Promise<void>;
  releaseLock(): void;
}
export interface WebTransportReadableStream<T> {
  readonly locked: boolean;
  cancel(reason?: unknown): Promise<void>;
  getReader(): WebTransportReadableStreamReader<T>;
}
export interface WebTransportWritableStreamWriter<T> {
  readonly closed: Promise<void>;
  readonly ready: Promise<void>;
  readonly desiredSize: number | null;
  write(chunk: T): Promise<void>;
  close(): Promise<void>;
  abort(reason?: unknown): Promise<void>;
  releaseLock(): void;
}
export interface WebTransportWritableStream<T> {
  readonly locked: boolean;
  abort(reason?: unknown): Promise<void>;
  close(): Promise<void>;
  getWriter(): WebTransportWritableStreamWriter<T>;
}
export interface WebTransportDatagramDuplexStream {
  readonly readable: WebTransportReadableStream<WebTransportBytes>;
  readonly writable: WebTransportWritableStream<WebTransportBytes>;
  readonly maxDatagramSize: number;
}
export interface WebTransportSendStream extends WebTransportWritableStream<WebTransportBytes> {}
export interface WebTransportReceiveStream extends WebTransportReadableStream<WebTransportBytes> {}
export interface WebTransportBidirectionalStream {
  readonly readable: WebTransportReceiveStream;
  readonly writable: WebTransportSendStream;
}
export type WebTransportSendStreamOptions = Readonly<Record<string, never>>;
export interface WebTransportSession {
  readonly ready: Promise<void>;
  readonly closed: Promise<WebTransportCloseInfo>;
  readonly datagrams: WebTransportDatagramDuplexStream;
  readonly incomingBidirectionalStreams: WebTransportReadableStream<WebTransportBidirectionalStream>;
  readonly incomingUnidirectionalStreams: WebTransportReadableStream<WebTransportReceiveStream>;
  createBidirectionalStream(options?: WebTransportSendStreamOptions): Promise<WebTransportBidirectionalStream>;
  createUnidirectionalStream(options?: WebTransportSendStreamOptions): Promise<WebTransportSendStream>;
  close(closeInfo?: WebTransportCloseInfo): void;
}
export interface WebTransportConstructor {
  new (url: WebTransportUrl, options?: WebTransportOptions): WebTransportSession;
}
`;
  const source = `${banner("typescript", inputHash)}import { registerNativeModulePump } from "@deherm/project/module-runtime";
import { NativeWebTransport, type NativeWebTransportSpec } from "./NativeWebTransport.js";

// BEGIN PUBLIC WEBTRANSPORT CONTRACT
${publicContract}
// END PUBLIC WEBTRANSPORT CONTRACT

${staticTarget ? "type StaticWebTransportBytes = number[];" : ""}
type RuntimeWebTransportBytes = ${runtimeByteType};
type RuntimeWebTransportSendStream = WebTransportWritableStream<RuntimeWebTransportBytes>;
type RuntimeWebTransportReceiveStream = WebTransportReadableStream<RuntimeWebTransportBytes>;
interface RuntimeWebTransportBidirectionalStream {
  readonly readable: RuntimeWebTransportReceiveStream;
  readonly writable: RuntimeWebTransportSendStream;
}
interface RuntimeWebTransportDatagramDuplexStream {
  readonly readable: WebTransportReadableStream<RuntimeWebTransportBytes>;
  readonly writable: WebTransportWritableStream<RuntimeWebTransportBytes>;
  readonly maxDatagramSize: number;
}

const STATUS = Object.freeze(${status}) as Readonly<Record<string, number>>;
const STATE = Object.freeze(${states}) as Readonly<Record<string, number>>;
const EVENT = Object.freeze(${events}) as Readonly<Record<string, number>>;
const FLAG = Object.freeze(${flags}) as Readonly<Record<string, number>>;
const HEADER_BYTES = ${module.constants.pollHeaderBytes};
const HEADER_VERSION = ${poll.headerVersion};
const INITIAL_PAYLOAD_BYTES = ${poll.initialPayloadBytes};
const MAXIMUM_PAYLOAD_BYTES = ${poll.maximumPayloadBytes};
const MAXIMUM_QUEUED_ITEMS = ${streams.maximumQueuedItemsPerQueue};
const MAXIMUM_STREAMS_PER_SESSION = ${streams.maximumStreamsPerSession};
const MAXIMUM_QUEUED_BYTES_PER_SESSION = ${streams.maximumQueuedBytesPerSession};
const MAXIMUM_NATIVE_SESSIONS = ${pump.maximumSessions};
const STREAM_EVENT_FLAGS = FLAG.streamFin | FLAG.streamBidirectional | FLAG.streamIncoming;

interface Deferred<T> { promise: Promise<T>; resolve(value: T): void; reject(reason: unknown): void; settled: boolean; }
function deferred<T>(): Deferred<T> {
  let resolvePromise: (value: T) => void = () => { throw new Error("Deferred resolve used before initialization"); };
  let rejectPromise: (reason: unknown) => void = () => { throw new Error("Deferred reject used before initialization"); };
  const result: Deferred<T> = {
    promise: new Promise<T>((resolve, reject) => { resolvePromise = resolve; rejectPromise = reject; }),
    resolve(value: T) { if (!result.settled) { result.settled = true; resolvePromise(value); } },
    reject(reason: unknown) { if (!result.settled) { result.settled = true; rejectPromise(reason); } },
    settled: false
  };
  return result;
}

function asError(reason: unknown, fallback: string): Error {
  return reason instanceof Error ? reason : new Error(reason === undefined ? fallback : String(reason));
}
function nativeStatus(status: number, operation: string): Promise<void> {
  return status === STATUS.ok ? Promise.resolve() : Promise.reject(new Error(operation + " failed with status " + status));
}
function makeBytes(length: number): ${runtimeByteType} { return ${byteFactory}; }
function isBytes(value: unknown): value is ${runtimeByteType} { return ${byteGuard}; }
function readU32(bytes: ${runtimeByteType}, offset: number): number {
  return ((bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16) | (bytes[offset + 3]! << 24)) >>> 0);
}
function readI32(bytes: ${runtimeByteType}, offset: number): number { return readU32(bytes, offset) | 0; }

class SessionByteBudget {
  private used = 0;
  canReserve(bytes = 1): boolean { return bytes >= 0 && this.used + bytes <= MAXIMUM_QUEUED_BYTES_PER_SESSION; }
  reserve(bytes: number): boolean {
    if (!this.canReserve(bytes)) return false;
    this.used += bytes; return true;
  }
  release(bytes: number): void { this.used = Math.max(0, this.used - bytes); }
}

class BoundedReadable<T> implements WebTransportReadableStream<T> {
  private readonly queue: Array<{ value: T; bytes: number }> = [];
  private readonly waiting: Array<Deferred<WebTransportReadResult<T>>> = [];
  private readonly completion = deferred<void>();
  private queuedBytes = 0;
  private terminalError: Error | undefined;
  private ended = false;
  private readonly budget: SessionByteBudget;
  private readonly onCancel: (reason: unknown) => Promise<void>;
  private readonly onOverflow: () => void;
  private readonly onTerminal: () => void;
  private readonly onDiscard: (value: T) => void;
  locked = false;
  constructor(
    budget: SessionByteBudget,
    onCancel: (reason: unknown) => Promise<void>,
    onOverflow: () => void,
    onTerminal: () => void = () => undefined,
    onDiscard: (value: T) => void = () => undefined
  ) {
    this.budget = budget; this.onCancel = onCancel; this.onOverflow = onOverflow; this.onTerminal = onTerminal; this.onDiscard = onDiscard;
    void this.completion.promise.catch(() => undefined);
  }
  enqueue(value: T, bytes = 0): boolean {
    // Bytes already in flight after cancel/STOP_SENDING are intentionally
    // discarded.  They must not stall every other stream in this session.
    if (this.ended) return true;
    const reader = this.waiting.shift();
    if (reader) { reader.resolve({ done: false, value }); return true; }
    if (this.queue.length >= MAXIMUM_QUEUED_ITEMS || !this.budget.reserve(bytes)) {
      this.onOverflow(); return false;
    }
    this.queue.push({ value, bytes }); this.queuedBytes += bytes; return true;
  }
  close(): void {
    if (this.ended) return;
    this.ended = true;
    for (const reader of this.waiting.splice(0)) reader.resolve({ done: true });
    this.completion.resolve(undefined); this.onTerminal();
  }
  error(reason: unknown): void {
    if (this.ended) return;
    this.ended = true; this.terminalError = asError(reason, "WebTransport stream failed");
    this.queue.length = 0; this.budget.release(this.queuedBytes); this.queuedBytes = 0;
    for (const reader of this.waiting.splice(0)) reader.reject(this.terminalError);
    this.completion.reject(this.terminalError); this.onTerminal();
  }
  cancel(reason?: unknown): Promise<void> {
    if (this.terminalError) return Promise.resolve();
    if (this.ended) return Promise.resolve();
    let cancellation: Promise<void>;
    try { cancellation = this.onCancel(reason); }
    catch (error) { return Promise.reject(error); }
    return cancellation.then(() => {
      if (this.ended) return;
      for (const queued of this.queue.splice(0)) this.onDiscard(queued.value);
      this.budget.release(this.queuedBytes); this.queuedBytes = 0;
      this.close();
    });
  }
  getReader(): WebTransportReadableStreamReader<T> {
    if (this.locked) throw new TypeError("Readable stream is locked");
    this.locked = true;
    let released = false;
    return {
      closed: this.completion.promise,
      read: () => {
        if (released) return Promise.reject(new TypeError("Reader lock was released"));
        const queued = this.queue.shift();
        if (queued) { this.queuedBytes -= queued.bytes; this.budget.release(queued.bytes); return Promise.resolve({ done: false, value: queued.value }); }
        if (this.terminalError) return Promise.reject(this.terminalError);
        if (this.ended) return Promise.resolve({ done: true });
        if (this.waiting.length >= MAXIMUM_QUEUED_ITEMS) {
          this.onOverflow(); return Promise.reject(new Error("WebTransport pending read queue is full"));
        }
        const pending = deferred<WebTransportReadResult<T>>(); this.waiting.push(pending); return pending.promise;
      },
      cancel: (reason?: unknown) => released
        ? Promise.reject(new TypeError("Reader lock was released"))
        : this.cancel(reason),
      releaseLock: () => {
        if (released) return;
        const error = new TypeError("Reader lock was released");
        for (const pending of this.waiting.splice(0)) pending.reject(error);
        released = true; this.locked = false;
      }
    };
  }
}

interface WritableSink<T> {
  write(value: T): Promise<void>;
  close(): Promise<void>;
  abort(reason: unknown): Promise<void>;
  ready(): Promise<void>;
  desiredSize(): number | null;
}
class BoundedWritable<T> implements WebTransportWritableStream<T> {
  private readonly completion = deferred<void>();
  private terminalError: Error | undefined;
  private ended = false;
  private terminalOperationPending = false;
  private readonly sink: WritableSink<T>;
  private readonly onTerminal: () => void;
  locked = false;
  constructor(sink: WritableSink<T>, onTerminal: () => void = () => undefined) {
    this.sink = sink; this.onTerminal = onTerminal;
    void this.completion.promise.catch(() => undefined);
  }
  error(reason: unknown): void {
    if (this.ended) return;
    this.ended = true; this.terminalError = asError(reason, "WebTransport writable stream failed");
    this.completion.reject(this.terminalError); this.onTerminal();
  }
  abort(reason?: unknown): Promise<void> {
    if (this.ended) return this.terminalError ? Promise.reject(this.terminalError) : Promise.resolve();
    if (this.terminalOperationPending) return Promise.reject(new Error("WebTransport terminal operation is already pending"));
    let operation: Promise<void>;
    try { operation = this.sink.abort(reason); }
    catch (error) { return Promise.reject(error); }
    this.terminalOperationPending = true;
    return operation.then(
      () => {
        this.terminalOperationPending = false;
        if (this.ended) return;
        this.ended = true; this.terminalError = asError(reason, "WebTransport stream aborted");
        this.completion.reject(this.terminalError); this.onTerminal();
      },
      (error) => { this.terminalOperationPending = false; throw asError(error, "WebTransport abort failed"); }
    );
  }
  close(): Promise<void> {
    if (this.ended) return this.terminalError ? Promise.reject(this.terminalError) : Promise.resolve();
    if (this.terminalOperationPending) return Promise.reject(new Error("WebTransport terminal operation is already pending"));
    this.ended = true;
    return this.sink.close().then(
      () => { this.completion.resolve(undefined); this.onTerminal(); },
      (error) => { this.terminalError = asError(error, "WebTransport close failed"); this.completion.reject(this.terminalError); this.onTerminal(); throw this.terminalError; }
    );
  }
  private write(chunk: T): Promise<void> {
    if (this.ended) return Promise.reject(this.terminalError ?? new TypeError("WebTransport writable stream is closed"));
    return this.sink.write(chunk);
  }
  private ready(): Promise<void> {
    if (this.terminalError) return Promise.reject(this.terminalError);
    if (this.ended) return Promise.resolve();
    return this.sink.ready();
  }
  getWriter(): WebTransportWritableStreamWriter<T> {
    if (this.locked) throw new TypeError("Writable stream is locked");
    this.locked = true;
    let released = false;
    const owner = this;
    return {
      closed: owner.completion.promise,
      get ready() { return released ? Promise.reject(new TypeError("Writer lock was released")) : owner.ready(); },
      get desiredSize() { return released ? null : owner.sink.desiredSize(); },
      write: (chunk: T) => released ? Promise.reject(new TypeError("Writer lock was released")) : owner.write(chunk),
      close: () => released ? Promise.reject(new TypeError("Writer lock was released")) : owner.close(),
      abort: (reason?: unknown) => released ? Promise.reject(new TypeError("Writer lock was released")) : owner.abort(reason),
      releaseLock: () => { if (!released) { released = true; owner.locked = false; } }
    } as WebTransportWritableStreamWriter<T>;
  }
}

interface PendingWrite { stream: number; bytes: ${runtimeByteType}; fin: boolean; datagram: boolean; done: Deferred<void>; }
interface PendingOpen { bidirectional: boolean; submitted: boolean; done: Deferred<RuntimeWebTransportBidirectionalStream | RuntimeWebTransportSendStream>; }
interface NativeStreamState {
  readable?: BoundedReadable<${runtimeByteType}>;
  writable?: BoundedWritable<${runtimeByteType}>;
  readTerminal: boolean;
  writeTerminal: boolean;
  incoming: boolean;
  exposed?: unknown;
}
interface NativePumpSession { pumpNativeFrame(): void; failNativePump(reason: unknown): void; }

const nativePumpSessions = new Set<NativePumpSession>();
let nativePumpRegistered = false;
let unregisterNativePump: (() => void) | undefined;
function attachNativePumpSession(session: NativePumpSession): () => void {
  if (nativePumpSessions.size >= MAXIMUM_NATIVE_SESSIONS) throw new Error("Native WebTransport session limit reached");
  nativePumpSessions.add(session);
  if (!nativePumpRegistered) {
    unregisterNativePump = registerNativeModulePump(() => {
      for (const active of nativePumpSessions) {
        try { active.pumpNativeFrame(); } catch (error) { active.failNativePump(error); }
      }
    });
    nativePumpRegistered = true;
  }
  let attached = true;
  return () => {
    if (!attached) return;
    attached = false; nativePumpSessions.delete(session);
    if (nativePumpSessions.size === 0) {
      if (unregisterNativePump) unregisterNativePump();
      unregisterNativePump = undefined; nativePumpRegistered = false;
    }
  };
}

class NativeSession ${staticTarget ? "implements NativePumpSession" : "implements WebTransportSession, NativePumpSession"} {
  readonly ready: Promise<void>;
  readonly closed: Promise<WebTransportCloseInfo>;
  readonly datagrams: RuntimeWebTransportDatagramDuplexStream;
  readonly incomingBidirectionalStreams: BoundedReadable<RuntimeWebTransportBidirectionalStream>;
  readonly incomingUnidirectionalStreams: BoundedReadable<RuntimeWebTransportReceiveStream>;
  private readonly readyDeferred = deferred<void>();
  private readonly closedDeferred = deferred<WebTransportCloseInfo>();
  private readonly session: number;
  private readonly streams = new Map<number, NativeStreamState>();
  private readonly opens = new Map<number, PendingOpen>();
  private readonly writes: PendingWrite[] = [];
  private readonly budget = new SessionByteBudget();
  private writeReadyDeferred: Deferred<void> | undefined;
  private readonly native: NativeWebTransportSpec;
  private readonly datagramReadable: BoundedReadable<${runtimeByteType}>;
  private readonly datagramWritable: BoundedWritable<${runtimeByteType}>;
  private detachPump: (() => void) | undefined;
  private nextRequest = 1;
  private terminal = false;
  private nativeBackpressured = false;
  private maximumDatagramSize = 0;
  private connected = false;
  private acceptIncomingBidirectional = true;
  private acceptIncomingUnidirectional = true;
  private pollBuffer = makeBytes(HEADER_BYTES + INITIAL_PAYLOAD_BYTES);
  constructor(url: WebTransportUrl, options: WebTransportOptions = {}, native: NativeWebTransportSpec = NativeWebTransport) {
    this.native = native;
    const digest = certificateDigest(options.serverCertificateHashes ?? []);
    const anticipatedUnidirectional = validateAnticipated(options.anticipatedConcurrentIncomingUnidirectionalStreams, "anticipatedConcurrentIncomingUnidirectionalStreams");
    const anticipatedBidirectional = validateAnticipated(options.anticipatedConcurrentIncomingBidirectionalStreams, "anticipatedConcurrentIncomingBidirectionalStreams");
    const session = native.${m.open}(String(url), digest, anticipatedUnidirectional, anticipatedBidirectional);
    if (!Number.isInteger(session) || session <= 0) throw new Error("Native WebTransport session creation failed");
    this.session = session;
    this.ready = this.readyDeferred.promise;
    this.closed = this.closedDeferred.promise;
    this.incomingBidirectionalStreams = new BoundedReadable(this.budget,
      () => { this.acceptIncomingBidirectional = false; return Promise.resolve(); },
      () => this.fail("incoming bidirectional stream queue overflow"), () => undefined,
      (value) => this.retireIncomingValue(value));
    this.incomingUnidirectionalStreams = new BoundedReadable(this.budget,
      () => { this.acceptIncomingUnidirectional = false; return Promise.resolve(); },
      () => this.fail("incoming unidirectional stream queue overflow"), () => undefined,
      (value) => this.retireIncomingValue(value));
    this.datagramReadable = new BoundedReadable<${runtimeByteType}>(this.budget, () => Promise.resolve(), () => this.fail("incoming datagram queue overflow"));
    this.datagramWritable = new BoundedWritable<${runtimeByteType}>({
      write: (bytes) => this.queueWrite(0, bytes, false, true), close: () => Promise.resolve(),
      abort: (reason) => { this.rejectQueuedWrites((write) => write.datagram, asError(reason, "WebTransport datagram writer aborted")); return Promise.resolve(); },
      ready: () => this.writeReady(), desiredSize: () => this.writeDesiredSize()
    });
    const self = this;
    this.datagrams = { readable: this.datagramReadable, writable: this.datagramWritable, get maxDatagramSize() { return self.maximumDatagramSize; } };
    try { this.detachPump = attachNativePumpSession(this); }
    catch (error) { this.terminal = true; this.native.${m.destroy}(this.session); throw error; }
  }
  createBidirectionalStream(options: WebTransportSendStreamOptions = {}): Promise<RuntimeWebTransportBidirectionalStream> {
    assertEmptyOptions(options); return this.requestStream(true) as Promise<RuntimeWebTransportBidirectionalStream>;
  }
  createUnidirectionalStream(options: WebTransportSendStreamOptions = {}): Promise<RuntimeWebTransportSendStream> {
    assertEmptyOptions(options); return this.requestStream(false) as Promise<RuntimeWebTransportSendStream>;
  }
  close(closeInfo: WebTransportCloseInfo = {}): void {
    if (this.terminal) return;
    const code = u32(closeInfo.closeCode ?? 0, "closeCode");
    try {
      const status = this.native.${m.close}(this.session, code, normalizeCloseReason(closeInfo.reason ?? ""));
      if (status !== STATUS.ok && status !== STATUS.closed) this.fail("native WebTransport close failed with status " + status);
    } catch (error) { this.failNativePump(error); }
  }
  private requestStream(bidirectional: boolean): Promise<RuntimeWebTransportBidirectionalStream | RuntimeWebTransportSendStream> {
    if (this.terminal) return Promise.reject(new Error("WebTransport session is closed"));
    if (this.opens.size + this.streams.size >= MAXIMUM_STREAMS_PER_SESSION) {
      return Promise.reject(new Error("WebTransport stream limit reached"));
    }
    const request = this.nextRequest++ >>> 0;
    if (request === 0 || this.opens.has(request)) return Promise.reject(new Error("WebTransport request id exhausted"));
    const done = deferred<RuntimeWebTransportBidirectionalStream | RuntimeWebTransportSendStream>();
    this.opens.set(request, { bidirectional, submitted: false, done });
    try { this.flushOpens(); } catch (error) { this.failNativePump(error); }
    return done.promise;
  }
  private flushOpens(): void {
    if (!this.connected) return;
    for (const [request, pending] of this.opens) {
      if (pending.submitted) continue;
      const status = pending.bidirectional
        ? this.native.${m.openBidirectionalStream}(this.session, request)
        : this.native.${m.openUnidirectionalStream}(this.session, request);
      if (status === STATUS.wouldBlock) return;
      if (status !== STATUS.ok) { this.opens.delete(request); pending.done.reject(new Error("Stream creation failed with status " + status)); continue; }
      pending.submitted = true;
    }
  }
  private queueWrite(stream: number, input: ${runtimeByteType}, fin: boolean, datagram: boolean): Promise<void> {
    if (this.terminal) return Promise.reject(new Error("WebTransport session is closed"));
    if (!isBytes(input)) return Promise.reject(new TypeError("WebTransport writes require byte-array chunks"));
    if (datagram && this.connected && input.length > this.maximumDatagramSize) {
      return Promise.reject(new RangeError("Datagram exceeds maxDatagramSize"));
    }
    if (this.writes.length >= MAXIMUM_QUEUED_ITEMS || !this.budget.reserve(input.length)) {
      return Promise.reject(new Error("WebTransport write queue is full"));
    }
    let bytes: ${runtimeByteType};
    try { bytes = input.slice(); } catch (error) { this.budget.release(input.length); return Promise.reject(error); }
    const done = deferred<void>(); this.writes.push({ stream, bytes, fin, datagram, done });
    try { this.flushWrites(); } catch (error) { this.failNativePump(error); }
    return done.promise;
  }
  private writeDesiredSize(): number | null {
    if (this.terminal) return null;
    if (!this.connected) return 0;
    return !this.nativeBackpressured && this.writes.length < MAXIMUM_QUEUED_ITEMS && this.budget.canReserve() ? 1 : 0;
  }
  private writeReady(): Promise<void> {
    if (this.terminal) return Promise.reject(new Error("WebTransport session is closed"));
    if (this.writeDesiredSize()! > 0) return Promise.resolve();
    if (!this.writeReadyDeferred) this.writeReadyDeferred = deferred<void>();
    return this.writeReadyDeferred.promise;
  }
  private notifyWriteReady(): void {
    if (this.writeDesiredSize()! <= 0) return;
    if (this.writeReadyDeferred) this.writeReadyDeferred.resolve(undefined);
    this.writeReadyDeferred = undefined;
  }
  private flushWrites(): void {
    if (!this.connected) return;
    while (this.writes.length > 0 && !this.terminal) {
      const write = this.writes[0]!;
      const status = write.datagram
        ? this.native.${m.trySendDatagram}(this.session, write.bytes)
        : this.native.${m.writeStream}(this.session, write.stream, write.bytes, write.fin);
      if (status === STATUS.wouldBlock) { this.nativeBackpressured = true; return; }
      this.nativeBackpressured = false;
      this.writes.shift();
      this.budget.release(write.bytes.length);
      if (status === STATUS.ok) write.done.resolve(undefined);
      else {
        const error = new Error("WebTransport write failed with status " + status);
        write.done.reject(error);
        if (!write.datagram) this.failWritableStream(write.stream, error);
      }
      this.notifyWriteReady();
    }
    if (this.writes.length === 0) { this.nativeBackpressured = false; this.notifyWriteReady(); }
  }
  private rejectQueuedWrites(predicate: (write: PendingWrite) => boolean, error: Error): void {
    const retained: PendingWrite[] = [];
    for (const write of this.writes.splice(0)) {
      if (predicate(write)) { this.budget.release(write.bytes.length); write.done.reject(error); }
      else retained.push(write);
    }
    this.writes.push(...retained);
    this.notifyWriteReady();
  }
  private failWritableStream(stream: number, error: Error): void {
    const state = this.streams.get(stream);
    if (!state?.writable || state.writeTerminal) return;
    try { this.native.${m.resetStream}(this.session, stream, 0); } catch { /* original write error is authoritative */ }
    this.rejectQueuedWrites((write) => !write.datagram && write.stream === stream, error);
    state.writable.error(error);
  }
  private retireIncomingValue(value: unknown): void {
    for (const [stream, state] of this.streams) {
      if (state.incoming && state.exposed === value) { this.retireIncomingStream(stream, state); return; }
    }
  }
  private retireIncomingStream(stream: number, state: NativeStreamState): void {
    const error = new Error("Incoming WebTransport stream collection was cancelled");
    if (state.readable && !state.readTerminal) {
      try { this.native.${m.stopSending}(this.session, stream, 0); } catch { /* local retirement remains authoritative */ }
      state.readable.error(error);
    }
    if (state.writable && !state.writeTerminal) {
      try { this.native.${m.resetStream}(this.session, stream, 0); } catch { /* local retirement remains authoritative */ }
      this.rejectQueuedWrites((write) => !write.datagram && write.stream === stream, error);
      state.writable.error(error);
    }
    if (state.readTerminal && state.writeTerminal) this.streams.delete(stream);
  }
  private makeStream(stream: number, readable: boolean, writable: boolean, incoming = false): NativeStreamState {
    const state: NativeStreamState = { readTerminal: !readable, writeTerminal: !writable, incoming };
    const retire = () => { if (state.readTerminal && state.writeTerminal) this.streams.delete(stream); };
    if (readable) state.readable = new BoundedReadable<${runtimeByteType}>(
      this.budget,
      () => nativeStatus(this.native.${m.stopSending}(this.session, stream, 0), "WebTransport stopSending"),
      () => this.fail("incoming stream byte queue overflow"),
      () => { state.readTerminal = true; retire(); }
    );
    if (writable) state.writable = new BoundedWritable<${runtimeByteType}>({
      write: (bytes) => this.queueWrite(stream, bytes, false, false),
      close: () => this.queueWrite(stream, makeBytes(0), true, false),
      abort: (reason) => {
        const status = this.native.${m.resetStream}(this.session, stream, 0);
        if (status !== STATUS.ok) return nativeStatus(status, "WebTransport resetStream");
        this.rejectQueuedWrites((write) => !write.datagram && write.stream === stream, asError(reason, "WebTransport stream aborted"));
        return Promise.resolve();
      },
      ready: () => this.writeReady(),
      desiredSize: () => this.writeDesiredSize()
    }, () => { state.writeTerminal = true; retire(); });
    this.streams.set(stream, state); return state;
  }
  pumpNativeFrame(): void {
    if (this.terminal) return;
    this.flushOpens(); this.flushWrites();
    let resizeRetries = 0;
    for (let count = 0; count < MAXIMUM_QUEUED_ITEMS; count += 1) {
      const status = this.native.${m.poll}(this.session, this.pollBuffer);
      if (status === STATUS.noEvent) {
        const nativeState = this.native.${m.state}(this.session);
        if (nativeState === STATE.closed || nativeState === STATE.failed) {
          this.finish(undefined, new Error("native WebTransport session terminated without a close event"));
          return;
        }
        break;
      }
      if (status === STATUS.bufferTooSmall) {
        const needed = readU32(this.pollBuffer, 20);
        let capacity = this.pollBuffer.length - HEADER_BYTES;
        resizeRetries += 1;
        if (needed <= capacity || needed > MAXIMUM_PAYLOAD_BYTES || resizeRetries > 8) {
          this.fail("invalid native WebTransport buffer-too-small response"); return;
        }
        while (capacity < needed) capacity = Math.min(MAXIMUM_PAYLOAD_BYTES, Math.max(capacity * 2, 1));
        this.pollBuffer = makeBytes(HEADER_BYTES + capacity); count -= 1; continue;
      }
      if (status !== STATUS.ok) { this.fail("native WebTransport poll failed with status " + status); return; }
      resizeRetries = 0;
      if (!this.deliver()) return;
    }
    this.flushWrites();
  }
  private deliver(): boolean {
    const kind = readU32(this.pollBuffer, 0), flags = readU32(this.pollBuffer, 4), code = readI32(this.pollBuffer, 8);
    const request = readU32(this.pollBuffer, 12), stream = readU32(this.pollBuffer, 16), size = readU32(this.pollBuffer, 20);
    if (readU32(this.pollBuffer, 24) !== 0 || readU32(this.pollBuffer, 28) !== HEADER_VERSION || size > this.pollBuffer.length - HEADER_BYTES) {
      this.fail("invalid native WebTransport event header"); return false;
    }
    const payload = this.pollBuffer.slice(HEADER_BYTES, HEADER_BYTES + size);
    if (kind === EVENT.ready) {
      if (flags !== 0 || code !== 0 || request !== 0 || stream !== 0 || size !== 0) { this.fail("invalid ready event"); return false; }
      const maximum = this.native.${m.maxDatagramBytes}(this.session);
      if (!Number.isInteger(maximum) || maximum < 0) { this.fail("invalid native maxDatagramSize"); return false; }
      this.maximumDatagramSize = maximum; this.connected = true; this.readyDeferred.resolve(undefined);
      this.flushOpens(); this.flushWrites(); this.notifyWriteReady(); return true;
    }
    if (kind === EVENT.streamOpened) {
      if ((flags & ~STREAM_EVENT_FLAGS) !== 0 || (flags & FLAG.streamFin) !== 0 || code !== 0 || stream === 0 || size !== 0) {
        this.fail("invalid stream-open event"); return false;
      }
      const incoming = (flags & FLAG.streamIncoming) !== 0, bidi = (flags & FLAG.streamBidirectional) !== 0;
      if ((incoming && request !== 0) || (!incoming && request === 0)) { this.fail("invalid stream-open request id"); return false; }
      if (this.streams.has(stream)) { this.fail("duplicate native stream handle"); return false; }
      const pending = incoming ? undefined : this.opens.get(request);
      if (!incoming && (!pending || pending.bidirectional !== bidi)) { this.fail("unmatched native stream-open event"); return false; }
      if (incoming && this.streams.size + this.opens.size >= MAXIMUM_STREAMS_PER_SESSION) {
        this.fail("native WebTransport stream limit exceeded"); return false;
      }
      const state = this.makeStream(stream, incoming || bidi, !incoming || bidi, incoming);
      if (incoming) {
        const exposed = bidi ? { readable: state.readable!, writable: state.writable! } : state.readable!;
        state.exposed = exposed;
        if ((bidi && !this.acceptIncomingBidirectional) || (!bidi && !this.acceptIncomingUnidirectional)) {
          this.retireIncomingStream(stream, state); return true;
        }
        const accepted = bidi
          ? this.incomingBidirectionalStreams.enqueue(exposed as RuntimeWebTransportBidirectionalStream)
          : this.incomingUnidirectionalStreams.enqueue(exposed as RuntimeWebTransportReceiveStream);
        if (!accepted || this.terminal) return false;
      } else {
        this.opens.delete(request); pending!.done.resolve(bidi ? { readable: state.readable!, writable: state.writable! } : state.writable!);
      }
      return true;
    }
    if (kind === EVENT.streamData) {
      if ((flags & ~FLAG.streamFin) !== 0 || code !== 0 || request !== 0 || stream === 0) { this.fail("invalid stream-data event"); return false; }
      const state = this.streams.get(stream);
      if (!state?.readable) { this.fail("data for unknown native stream"); return false; }
      if (payload.length > 0 && !state.readable.enqueue(payload, payload.length)) return false;
      if ((flags & FLAG.streamFin) !== 0) state.readable.close();
      return true;
    }
    if (kind === EVENT.datagram) {
      if (flags !== 0 || code !== 0 || request !== 0 || stream !== 0) { this.fail("invalid datagram event"); return false; }
      return this.datagramReadable.enqueue(payload, payload.length) && !this.terminal;
    }
    if (kind === EVENT.streamReset) {
      if (flags !== 0 || request !== 0 || stream === 0 || size !== 0) { this.fail("invalid stream-reset event"); return false; }
      const state = this.streams.get(stream);
      if (!state) { this.fail("reset for unknown native stream"); return false; }
      if (!state.readable || state.readTerminal) return true;
      state.readable.error(new Error("Stream reset: " + code)); return true;
    }
    if (kind === EVENT.streamStopSending) {
      if (flags !== 0 || request !== 0 || stream === 0 || size !== 0) { this.fail("invalid stop-sending event"); return false; }
      const state = this.streams.get(stream);
      if (!state) { this.fail("stop-sending for unknown native stream"); return false; }
      if (!state.writable || state.writeTerminal) return true;
      this.rejectQueuedWrites((write) => !write.datagram && write.stream === stream, new Error("Stop sending: " + code));
      state.writable.error(new Error("Stop sending: " + code)); return true;
    }
    if (kind === EVENT.close) {
      if (flags !== 0 || request !== 0 || stream !== 0) { this.fail("invalid close event"); return false; }
      const reason = decodeUtf8(payload);
      const nativeState = this.native.${m.state}(this.session);
      if (!this.readyDeferred.settled || nativeState === STATE.failed) {
        this.finish(undefined, new Error(reason || "native WebTransport connection failed"));
      } else {
        this.finish({ closeCode: code >>> 0, reason });
      }
      return false;
    }
    this.fail("unknown native WebTransport event kind " + kind); return false;
  }
  failNativePump(reason: unknown): void { this.fail(asError(reason, "native WebTransport provider threw").message); }
  private fail(message: string): void {
    if (this.terminal) return;
    try { this.native.${m.close}(this.session, 1, message); } catch { /* destruction below is authoritative */ }
    this.finish(undefined, new Error(message));
  }
  private finish(info?: WebTransportCloseInfo, error?: Error): void {
    if (this.terminal) return; this.terminal = true;
    if (this.detachPump) this.detachPump();
    this.detachPump = undefined;
    try { this.native.${m.destroy}(this.session); }
    catch (destroyError) { error ??= asError(destroyError, "native WebTransport destruction failed"); }
    for (const pending of this.opens.values()) pending.done.reject(error ?? new Error("WebTransport session closed"));
    this.opens.clear();
    for (const write of this.writes.splice(0)) {
      this.budget.release(write.bytes.length); write.done.reject(error ?? new Error("WebTransport session closed"));
    }
    if (this.writeReadyDeferred) this.writeReadyDeferred.reject(error ?? new Error("WebTransport session closed"));
    this.writeReadyDeferred = undefined;
    if (error) {
      this.datagramReadable.error(error); this.datagramWritable.error(error);
      this.incomingBidirectionalStreams.error(error); this.incomingUnidirectionalStreams.error(error);
      for (const stream of this.streams.values()) {
        if (stream.readable) stream.readable.error(error);
        if (stream.writable) stream.writable.error(error);
      }
    } else {
      this.datagramReadable.close(); this.datagramWritable.error(new Error("WebTransport session closed"));
      this.incomingBidirectionalStreams.close(); this.incomingUnidirectionalStreams.close();
      for (const stream of this.streams.values()) {
        if (stream.readable) stream.readable.close();
        if (stream.writable) stream.writable.error(new Error("WebTransport session closed"));
      }
    }
    this.streams.clear();
    if (error) { this.readyDeferred.reject(error); this.closedDeferred.reject(error); }
    else { if (!this.readyDeferred.settled) this.readyDeferred.reject(new Error("WebTransport closed before ready")); this.closedDeferred.resolve(info ?? {}); }
  }
}

function normalizeCloseReason(reason: string): string {
  let result = "";
  let bytes = 0;
  for (let index = 0; index < reason.length;) {
    const first = reason.charCodeAt(index);
    let width = 1;
    let codePoint = first;
    if (first >= 0xd800 && first <= 0xdbff && index + 1 < reason.length) {
      const second = reason.charCodeAt(index + 1);
      if (second >= 0xdc00 && second <= 0xdfff) {
        codePoint = 0x10000 + ((first - 0xd800) << 10) + (second - 0xdc00); width = 2;
      }
    }
    const encodedBytes = codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
    if (bytes + encodedBytes > 1024) break;
    result += reason.slice(index, index + width); bytes += encodedBytes; index += width;
  }
  return result;
}

function decodeUtf8(bytes: ${runtimeByteType}): string {
  let result = "";
  for (let index = 0; index < bytes.length;) {
    const first = bytes[index++]!;
    let codePoint: number;
    let remaining: number;
    let minimum: number;
    if (first < 0x80) { codePoint = first; remaining = 0; minimum = 0; }
    else if (first >= 0xc2 && first <= 0xdf) { codePoint = first & 0x1f; remaining = 1; minimum = 0x80; }
    else if (first >= 0xe0 && first <= 0xef) { codePoint = first & 0x0f; remaining = 2; minimum = 0x800; }
    else if (first >= 0xf0 && first <= 0xf4) { codePoint = first & 0x07; remaining = 3; minimum = 0x10000; }
    else { result += "�"; continue; }
    let valid = true;
    for (let count = 0; count < remaining; count += 1) {
      if (index >= bytes.length) { valid = false; break; }
      const next = bytes[index]!;
      if ((next & 0xc0) !== 0x80) { valid = false; break; }
      index += 1;
      codePoint = (codePoint << 6) | (next & 0x3f);
    }
    if (!valid || codePoint < minimum || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) { result += "�"; continue; }
    if (codePoint <= 0xffff) result += String.fromCharCode(codePoint);
    else {
      codePoint -= 0x10000;
      result += String.fromCharCode(0xd800 + (codePoint >> 10), 0xdc00 + (codePoint & 0x3ff));
    }
  }
  return result;
}

function certificateDigest(hashes: ${hashArrayType}): ${runtimeByteType} {
  if (hashes.length !== 1 || hashes[0]!.algorithm.toLowerCase() !== "sha-256") {
    throw new TypeError("Native WebTransport 0.1 requires exactly one sha-256 serverCertificateHash; root-store trust is not implemented");
  }
  const value = hashes[0]!.value;
  ${certificateConversion}
}
function validateAnticipated(value: number | undefined, name: string): number { if (value !== undefined && (!Number.isInteger(value) || value < 0 || value > 65535)) throw new RangeError(name + " must be an unsigned 16-bit integer"); return value ?? 0; }
function assertEmptyOptions(options: WebTransportSendStreamOptions): void { if (Object.keys(options).length !== 0) throw new TypeError("Stream send options are reserved but not implemented in version 0.1"); }
function u32(value: number, name: string): number { if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) throw new RangeError(name + " must be an unsigned 32-bit integer"); return value; }

/** Browser delegates to the host WebTransport; native uses the bounded extension facade. */
${constructorExport}
`;
  // Static Hermes' sound-type parser does not implement TypeScript's postfix
  // non-null assertion. Runtime guards above establish every refined value;
  // the generated strict subset carries that same control flow without `!`.
  return staticTarget
    ? source
      .replace(/(?<=[A-Za-z0-9_$\]\)])!(?!=)/gu, "")
      .replace(/\bprivate\s+(?:readonly\s+)?/gu, "")
    : source;
}

export async function generateCommunityApi() {
  const compatibilityRaw = await readFile(compatibilityPath, "utf8");
  const compatibility = JSON.parse(compatibilityRaw);
  const descriptorPath = path.join(extensionRoot, compatibility.generation.descriptor);
  const descriptorRaw = await readFile(descriptorPath, "utf8");
  const descriptor = parseNativeModuleDescriptorJson(descriptorRaw);
  const contract = validateInputs(compatibility, descriptor);
  const inputHash = sha256(`${compatibilityRaw}\0${descriptorRaw}`);
  const outputs = compatibility.generation.outputs;
  return new Map([
    [path.join(extensionRoot, outputs.lua), renderLua(inputHash)],
    [path.join(extensionRoot, outputs.luaRegistration), renderLuaRegistration(inputHash)],
    [path.join(extensionRoot, outputs.c), renderHeader(inputHash)],
    [path.join(extensionRoot, outputs.nativeC), renderNativeHeader(inputHash, contract)],
    [path.join(extensionRoot, outputs.typescript), renderTypeScript(inputHash, contract, "dynamic")],
    [path.join(extensionRoot, outputs.typescriptStatic), renderTypeScript(inputHash, contract, "static")]
  ]);
}

export async function run(argv = process.argv.slice(2)) {
  const check = argv.length === 1 && argv[0] === "--check";
  if (argv.length !== 0 && !check) fail(`unknown arguments: ${argv.join(" ")}`);
  const outputs = await generateCommunityApi();
  for (const [file, content] of outputs) {
    if (check) {
      let actual;
      try { actual = await readFile(file, "utf8"); } catch (error) { if (error?.code === "ENOENT") fail(`${path.relative(repositoryRoot, file)} is missing`); throw error; }
      if (actual !== content) fail(`${path.relative(repositoryRoot, file)} is stale`);
    } else {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, content);
    }
  }
  process.stdout.write(`${check ? "Verified" : "Generated"} ${outputs.size} Defold WebTransport community API surfaces.\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await run();
