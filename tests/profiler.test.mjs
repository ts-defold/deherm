import assert from "node:assert/strict";
import net from "node:net";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import test from "node:test";

import WebSocket from "ws";

import { createInspectorBridge } from "../packages/cli/src/dev/inspector-bridge.mjs";
import { captureCpuProfile, captureHeapSnapshot } from "../packages/cli/src/dev/profiler.mjs";

function event(target, name) {
  return new Promise((resolve, reject) => {
    target.once(name, resolve);
    target.once("error", reject);
  });
}

function recordingEngine(port, respond) {
  const socket = net.createConnection({ host: "127.0.0.1", port });
  let pending = "";
  socket.on("data", (chunk) => {
    pending += chunk.toString("utf8");
    for (;;) {
      const newline = pending.indexOf("\n");
      if (newline < 0) break;
      const message = JSON.parse(pending.slice(0, newline));
      pending = pending.slice(newline + 1);
      for (const reply of respond(message)) socket.write(`${JSON.stringify(reply)}\n`);
    }
  });
  return socket;
}

test("CPU profile capture writes the exact standard CDP profile", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "deherm-cpu-profile-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sessionFile = path.join(root, ".deherm", "dev", "inspector.json");
  const output = path.join(root, "capture.cpuprofile");
  const bridge = await createInspectorBridge({ projectRoot: root, sessionFile });
  const calls = [];
  const engine = recordingEngine(bridge.enginePort, (message) => {
    calls.push(message.method);
    if (message.method === "Profiler.start") return [{ id: message.id, result: {} }];
    if (message.method === "Profiler.stop") return [{
      id: message.id,
      result: { profile: { nodes: [{ id: 1, callFrame: { functionName: "tick" } }], samples: [1], timeDeltas: [10] } }
    }];
    return [];
  });
  await event(engine, "connect");
  const result = await captureCpuProfile({ projectRoot: root, sessionFile, output, durationMs: 1 });
  assert.deepEqual(calls, ["Profiler.start", "Profiler.stop"]);
  assert.equal(result.nodeCount, 1);
  assert.equal(JSON.parse(await readFile(output, "utf8")).nodes[0].callFrame.functionName, "tick");
  engine.destroy();
  await bridge.close();
});

test("heap capture streams every CDP chunk in order without retaining the snapshot", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "deherm-heap-profile-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sessionFile = path.join(root, ".deherm", "dev", "inspector.json");
  const output = path.join(root, "capture.heapsnapshot");
  const bridge = await createInspectorBridge({ projectRoot: root, sessionFile });
  const engine = recordingEngine(bridge.enginePort, (message) => [{
    method: "HeapProfiler.addHeapSnapshotChunk",
    params: { chunk: "{\"snapshot\":" }
  }, {
    method: "HeapProfiler.addHeapSnapshotChunk",
    params: { chunk: "{\"title\":\"déherm\"}}" }
  }, { id: message.id, result: {} }]);
  await event(engine, "connect");
  const result = await captureHeapSnapshot({ projectRoot: root, sessionFile, output });
  assert.equal(result.chunkCount, 2);
  assert.deepEqual(JSON.parse(await readFile(output, "utf8")), { snapshot: { title: "déherm" } });
  engine.destroy();
  await bridge.close();
});

test("profile capture does not silently evict an attached debugger", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "deherm-profile-attached-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sessionFile = path.join(root, ".deherm", "dev", "inspector.json");
  const bridge = await createInspectorBridge({ projectRoot: root, sessionFile });
  const debuggerClient = new WebSocket(bridge.websocketUrl);
  await event(debuggerClient, "open");
  await assert.rejects(
    () => captureCpuProfile({ projectRoot: root, sessionFile, durationMs: 1 }),
    /already attached/
  );
  assert.equal(debuggerClient.readyState, WebSocket.OPEN);
  debuggerClient.close();
  await bridge.close();
});

test("profile capture rejects a descriptor owned by a different project", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "deherm-profile-project-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sessionFile = path.join(root, ".deherm", "dev", "inspector.json");
  const bridge = await createInspectorBridge({ projectRoot: root, sessionFile });
  await assert.rejects(
    () => captureCpuProfile({ projectRoot: path.join(root, "other"), sessionFile, durationMs: 1 }),
    /belongs to a different project/
  );
  await bridge.close();
});
