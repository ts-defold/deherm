import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import {
  buildEvidenceDocument,
  canonicalizeRuntimeTranscript,
  checkedRequiredMarkers,
  firstRejectedDiagnostic,
  observedRequiredMarkers,
  REQUIRED_MARKERS,
  REQUIRED_SHUTDOWN_MARKERS,
  RUNTIME_PROFILE_MARKER_PREFIX,
  runPackagedRuntimeEvidence,
  transcriptEvidence,
} from "../integration/packaged-runtime-evidence.mjs";
import {
  assertSoleEngineListener,
  encodeSystemExit,
  engineServicePort,
  listeningPids,
} from "../integration/graceful-shutdown.mjs";
import { projectionEnvelope } from "../integration/projections.mjs";

// An engine double: it does what the parts of dmengine this gate addresses do,
// and nothing else. It serves an engine-service port the kernel assigned,
// announces that port the way the engine announces it, prints the markers, and
// shuts down on `POST /post/@system/exit`. Using a real listener means the port
// census and the exit post are exercised rather than stubbed.
function engineDouble({
  markers = REQUIRED_MARKERS,
  shutdownMarkers = REQUIRED_SHUTDOWN_MARKERS,
  announcePort = true,
  honourExit = true,
  suffix = "",
  lifetimeMs = 20_000,
} = {}) {
  return `
const http = require("node:http");
const markers = ${JSON.stringify(markers)};
const shutdownMarkers = ${JSON.stringify(shutdownMarkers)};
const runtimeProfileMarkerPrefix = ${JSON.stringify("INFO:DEFOLD_HERMES: Detected Defold runtime profile 'default-legacy-bullet' from ")};
const server = http.createServer((request, response) => {
  if (request.url === "/post/@system/exit" && request.method === "POST") {
    request.resume();
    request.on("end", () => {
      response.writeHead(200).end();
      if (${honourExit ? "true" : "false"}) {
        for (const marker of shutdownMarkers) process.stdout.write(marker + "\\n");
        setTimeout(() => { server.close(); process.exit(0); }, 10);
      }
    });
    return;
  }
  response.writeHead(404).end();
});
server.listen(0, "127.0.0.1", () => {
  if (${announcePort ? "true" : "false"}) {
    process.stdout.write("INFO:ENGINE: Engine service started on port " + server.address().port + "\\n");
  }
  let index = 0;
  const timer = setInterval(() => {
    if (index < markers.length) {
      const marker = markers[index++];
      process.stdout.write((marker === runtimeProfileMarkerPrefix ? marker + "315 generated Lua symbols" : marker) + "\\n");
    }
    else { clearInterval(timer); ${suffix} }
  }, 5);
});
setTimeout(() => { server.close(); process.exit(0); }, ${lifetimeMs});
`;
}

const driveDouble = (options, overrides = {}) => runPackagedRuntimeEvidence({
  command: process.execPath,
  args: ["-e", engineDouble(options)],
  cwd: process.cwd(),
  timeoutMs: 4_000,
  settleMs: 40,
  terminationGraceMs: 2_000,
  ...overrides,
});

test("packaged runtime gate observes every marker, settles, and exits gracefully", async () => {
  const result = await driveDouble();
  const expected = [...REQUIRED_MARKERS];
  expected[expected.indexOf(RUNTIME_PROFILE_MARKER_PREFIX)] += "315 generated Lua symbols";
  assert.deepEqual(result.markers, expected);
  assert.deepEqual(result.shutdownMarkers, [...REQUIRED_SHUTDOWN_MARKERS]);
  assert.equal(result.termination.method, "system-exit");
  assert.equal(result.termination.exitCode, 0);
  assert.equal(result.termination.signal, null);
  assert.ok(Number.isSafeInteger(result.termination.port) && result.termination.port > 0);
});

test("runtime profile evidence keeps the final positive symbol count without pinning it", () => {
  const transcript = [
    `${RUNTIME_PROFILE_MARKER_PREFIX}253 generated Lua symbols`,
    `${RUNTIME_PROFILE_MARKER_PREFIX}315 generated Lua symbols`,
  ].join("\n");
  assert.equal(
    observedRequiredMarkers(transcript, [RUNTIME_PROFILE_MARKER_PREFIX])[0],
    `${RUNTIME_PROFILE_MARKER_PREFIX}315 generated Lua symbols`,
  );
  assert.equal(
    observedRequiredMarkers(`${RUNTIME_PROFILE_MARKER_PREFIX}0 generated Lua symbols`, [RUNTIME_PROFILE_MARKER_PREFIX])[0],
    null,
  );
  const recorded = [...REQUIRED_MARKERS];
  recorded[recorded.indexOf(RUNTIME_PROFILE_MARKER_PREFIX)] += "315 generated Lua symbols";
  assert.deepEqual(checkedRequiredMarkers(recorded), recorded);
  const zero = [...recorded];
  zero[REQUIRED_MARKERS.indexOf(RUNTIME_PROFILE_MARKER_PREFIX)] = `${RUNTIME_PROFILE_MARKER_PREFIX}0 generated Lua symbols`;
  assert.throws(() => checkedRequiredMarkers(zero), /positive generated Lua symbol count/);
  assert.throws(() => checkedRequiredMarkers(recorded.slice(1)), /required marker count/);
  const altered = [...recorded];
  altered[0] = "INFO:ENGINE: not Defold";
  assert.throws(() => checkedRequiredMarkers(altered), /differ from the required marker set/);
});

test("packaged runtime gate fails closed on known diagnostics", async () => {
  await assert.rejects(
    driveDouble({ suffix: `process.stderr.write("ERROR:SCRIPT: RESULT_SCRIPT_ERROR\\n");` }),
    /rejected diagnostic 'error-severity'/,
  );
  assert.equal(firstRejectedDiagnostic("main.gui_script: attempt to index global '_deherm_' (a nil value)")?.id, "missing-lua-provider");
});

test("packaged runtime gate fails closed when a required marker is absent", async () => {
  await assert.rejects(
    driveDouble({ markers: REQUIRED_MARKERS.slice(0, -1) }, { timeoutMs: 400 }),
    /missing markers: INFO:DEFOLD_HERMES: Extension update entered/,
  );
});

// Teardown is the whole reason the gate posts an exit rather than a signal, so
// an engine that shuts down without running `final()` must not pass.
test("packaged runtime gate fails closed when component teardown never ran", async () => {
  await assert.rejects(
    driveDouble({ shutdownMarkers: [] }),
    /shut down without running component teardown; missing markers: INFO:DEFOLD_HERMES: war-battles:player-final/,
  );
});

test("packaged runtime gate refuses to address an engine that never named its service port", async () => {
  await assert.rejects(
    driveDouble({ announcePort: false }),
    /never reported an engine service port/,
  );
});

test("packaged runtime gate fails loudly when the engine ignores a graceful exit", async () => {
  await assert.rejects(
    driveDouble({ honourExit: false }, { terminationGraceMs: 400 }),
    /did not exit within 400ms of a graceful @system\/exit/,
  );
});

test("the engine service port comes from the engine's own transcript", () => {
  assert.equal(engineServicePort("INFO:ENGINE: Engine service started on port 54762"), 54762);
  assert.equal(engineServicePort("INFO:DLIB: Log server started on port 54761"), null);
  assert.equal(engineServicePort(""), null);
  assert.throws(() => engineServicePort("INFO:ENGINE: Engine service started on port 70000"), /unusable port/);
});

// SO_REUSEPORT lets two engines bind one port, and an exit post to a shared
// port can be absorbed by the wrong one. That must be a named failure.
test("a shared engine service port is refused by name rather than posted into", () => {
  assert.deepEqual(assertSoleEngineListener({ port: 8001, pid: 42, pids: [42] }), { port: 8001, pid: 42 });
  assert.throws(
    () => assertSoleEngineListener({ port: 8001, pid: 42, pids: [42, 4242] }),
    /port 8001 is shared by 2 process\(es\) \[42, 4242\].*pid 42.*SO_REUSEPORT/s,
  );
  assert.throws(
    () => assertSoleEngineListener({ port: 8001, pid: 42, pids: [4242] }),
    /shared by 1 process/,
  );
  assert.throws(
    () => assertSoleEngineListener({ port: 8001, pid: 42, pids: [] }),
    /No process is listening on engine service port 8001/,
  );
});

test("a port census that cannot be taken is not a census that found one listener", async () => {
  const missingTool = Object.assign(new Error("spawn lsof ENOENT"), { code: "ENOENT" });
  await assert.rejects(
    listeningPids(8001, { execFile: async () => { throw missingTool; } }),
    /lsof is required/,
  );
  const noMatch = Object.assign(new Error("lsof exited 1"), { code: 1, stdout: "" });
  assert.deepEqual(await listeningPids(8001, { execFile: async () => { throw noMatch; } }), []);
  assert.deepEqual(await listeningPids(8001, { execFile: async () => ({ stdout: "17\n4\n17\n" }) }), [4, 17]);
});

test("the exit message is the pinned system_ddf.Exit encoding", () => {
  assert.deepEqual([...encodeSystemExit(0)], [0x08, 0x00]);
  assert.deepEqual([...encodeSystemExit(1)], [0x08, 0x01]);
  assert.deepEqual([...encodeSystemExit(300)], [0x08, 0xac, 0x02]);
  assert.throws(() => encodeSystemExit(-1), /non-negative int32/);
});

test("evidence is deterministic and keyed only to artifact identities and observations", () => {
  const artifacts = [{ path: "engine", bytes: 3, sha256: "a".repeat(64) }];
  const sourceInputs = [{ path: "source", bytes: 4, sha256: "b".repeat(64) }];
  const transcript = { canonicalLineCount: 5, canonicalSha256: "c".repeat(64) };
  const termination = { method: "system-exit", exitCode: 0, signal: null, port: 54762 };
  const document = {
    artifacts,
    sourceInputs,
    markers: REQUIRED_MARKERS,
    shutdownMarkers: REQUIRED_SHUTDOWN_MARKERS,
    settleMs: 1_500,
    termination,
    transcript,
  };
  const first = buildEvidenceDocument(document);
  const second = buildEvidenceDocument(document);
  assert.deepEqual(first, second);
  assert.equal(first.artifactKey, createHash("sha256").update(JSON.stringify(artifacts)).digest("hex"));
  assert.equal(Object.hasOwn(first, "timestamp"), false);
  assert.deepEqual(first.projection, projectionEnvelope("native-arm64-macos"));
  assert.throws(
    () => buildEvidenceDocument({ ...document, termination: { method: "sigterm", exitCode: null, signal: "SIGTERM" } }),
    /clean @system\/exit shutdown/,
  );
  assert.throws(
    () => buildEvidenceDocument({ ...document, shutdownMarkers: [] }),
    /component-teardown markers/,
  );
});

test("canonical transcript digest removes only known dynamic ports and host identity", () => {
  const first = [
    "INFO:DLIB: Log server started on port 50123",
    "INFO:ENGINE: Target listening with name: first.localdomain - 127.0.0.1 - Darwin",
    "INFO:ENGINE: Engine service started on port 8001",
    "INFO:PROFILER: Initialized Remotery (ws://127.0.0.1:17815/rmt)",
    "INFO:GRAPHICS: Vulkan device selected: Apple M4",
  ].join("\n");
  const second = first
    .replace("50123", "59999")
    .replace("first.localdomain", "second.localdomain")
    .replace("8001", "9123")
    .replace("17815", "18777");
  assert.equal(canonicalizeRuntimeTranscript(first), canonicalizeRuntimeTranscript(second));
  assert.deepEqual(transcriptEvidence(first), transcriptEvidence(second));
  assert.match(canonicalizeRuntimeTranscript(first), /Vulkan device selected: Apple M4/);
});

test("packaged runtime gate preserves the original observation failure after forced cleanup", async () => {
  await assert.rejects(
    driveDouble({ markers: REQUIRED_MARKERS.slice(0, -1), honourExit: false }, { timeoutMs: 400, terminationGraceMs: 200 }),
    /missing markers: INFO:DEFOLD_HERMES: Extension update entered/,
  );
});
