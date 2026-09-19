import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import {
  buildEvidenceDocument,
  canonicalizeRuntimeTranscript,
  firstRejectedDiagnostic,
  REQUIRED_MARKERS,
  runPackagedRuntimeEvidence,
  transcriptEvidence,
} from "../integration/packaged-runtime-evidence.mjs";

function fixtureSource({ markers = REQUIRED_MARKERS, suffix = "", lifetimeMs = 2_000 } = {}) {
  return `
const markers = ${JSON.stringify(markers)};
let index = 0;
const timer = setInterval(() => {
  if (index < markers.length) process.stdout.write(markers[index++] + "\\n");
  else { clearInterval(timer); ${suffix} }
}, 5);
setTimeout(() => {}, ${lifetimeMs});
`;
}

test("packaged runtime gate observes every marker, settles, and terminates", async () => {
  const result = await runPackagedRuntimeEvidence({
    command: process.execPath,
    args: ["-e", fixtureSource()],
    cwd: process.cwd(),
    timeoutMs: 1_000,
    settleMs: 40,
    terminationGraceMs: 500,
  });
  assert.deepEqual(result.markers, REQUIRED_MARKERS);
  assert.deepEqual(result.termination, { method: "sigterm", exitCode: null, signal: "SIGTERM" });
});

test("packaged runtime gate fails closed on known diagnostics", async () => {
  await assert.rejects(
    runPackagedRuntimeEvidence({
      command: process.execPath,
      args: ["-e", fixtureSource({ suffix: `process.stderr.write("ERROR:SCRIPT: RESULT_SCRIPT_ERROR\\n");` })],
      cwd: process.cwd(),
      timeoutMs: 1_000,
      settleMs: 100,
      terminationGraceMs: 500,
    }),
    /rejected diagnostic 'error-severity'/,
  );
  assert.equal(firstRejectedDiagnostic("main.gui_script: attempt to index global '_deherm_' (a nil value)")?.id, "missing-lua-provider");
});

test("packaged runtime gate fails closed when a required marker is absent", async () => {
  await assert.rejects(
    runPackagedRuntimeEvidence({
      command: process.execPath,
      args: ["-e", fixtureSource({ markers: REQUIRED_MARKERS.slice(0, -1), lifetimeMs: 2_000 })],
      cwd: process.cwd(),
      timeoutMs: 120,
      settleMs: 40,
      terminationGraceMs: 500,
    }),
    /missing markers: INFO:DEFOLD_HERMES: Extension update entered/,
  );
});

test("evidence is deterministic and keyed only to artifact identities and observations", () => {
  const artifacts = [{ path: "engine", bytes: 3, sha256: "a".repeat(64) }];
  const sourceInputs = [{ path: "source", bytes: 4, sha256: "b".repeat(64) }];
  const transcript = { canonicalLineCount: 5, canonicalSha256: "c".repeat(64) };
  const termination = { method: "sigterm", exitCode: null, signal: "SIGTERM" };
  const first = buildEvidenceDocument({ artifacts, sourceInputs, markers: REQUIRED_MARKERS, settleMs: 1_500, termination, transcript });
  const second = buildEvidenceDocument({ artifacts, sourceInputs, markers: REQUIRED_MARKERS, settleMs: 1_500, termination, transcript });
  assert.deepEqual(first, second);
  assert.equal(first.artifactKey, createHash("sha256").update(JSON.stringify(artifacts)).digest("hex"));
  assert.equal(Object.hasOwn(first, "timestamp"), false);
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

test("packaged runtime gate waits for actual termination and rejects SIGKILL cleanup", async () => {
  const source = fixtureSource({
    suffix: `process.on("SIGTERM", () => {});`,
    lifetimeMs: 2_000,
  });
  await assert.rejects(
    runPackagedRuntimeEvidence({
      command: process.execPath,
      args: ["-e", source],
      cwd: process.cwd(),
      timeoutMs: 1_000,
      settleMs: 40,
      terminationGraceMs: 50,
    }),
    /did not terminate from SIGTERM.*sigkill-after-timeout/s,
  );
});

test("packaged runtime gate preserves the original observation failure after forced cleanup", async () => {
  const source = fixtureSource({
    markers: REQUIRED_MARKERS.slice(0, -1),
    suffix: `process.on("SIGTERM", () => {});`,
    lifetimeMs: 2_000,
  });
  await assert.rejects(
    runPackagedRuntimeEvidence({
      command: process.execPath,
      args: ["-e", source],
      cwd: process.cwd(),
      timeoutMs: 120,
      settleMs: 40,
      terminationGraceMs: 50,
    }),
    /missing markers: INFO:DEFOLD_HERMES: Extension update entered/,
  );
});
