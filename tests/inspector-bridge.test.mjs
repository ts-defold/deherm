import assert from "node:assert/strict";
import net from "node:net";
import path from "node:path";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import test from "node:test";

import WebSocket from "ws";

import { createInspectorBridge } from "../packages/cli/src/dev/inspector-bridge.mjs";
import {
  createInspectorSession,
  readInspectorSession,
  removeOwnedInspectorSession,
  writeInspectorSession
} from "../packages/cli/src/dev/inspector-session.mjs";

function event(target, name) {
  return new Promise((resolve, reject) => {
    target.once(name, resolve);
    target.once("error", reject);
  });
}

async function reservePorts(count) {
  const servers = [];
  try {
    for (let index = 0; index < count; index += 1) {
      const server = net.createServer();
      servers.push(server);
      server.listen(0, "127.0.0.1");
      await event(server, "listening");
    }
    return servers.map((server) => server.address().port);
  } finally {
    await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
  }
}

test("native NDJSON is projected as a standard CDP discovery and WebSocket endpoint", async () => {
  const bridge = await createInspectorBridge();
  const engine = net.createConnection({ host: "127.0.0.1", port: bridge.enginePort });
  await event(engine, "connect");
  const discovered = await fetch(`${bridge.devtoolsUrl}/json/list`).then((response) => response.json());
  assert.equal(discovered.length, 1);
  assert.equal(discovered[0].webSocketDebuggerUrl, bridge.websocketUrl);

  const frontend = new WebSocket(bridge.websocketUrl);
  await event(frontend, "open");
  const engineCommand = new Promise((resolve) => engine.once("data", (data) => resolve(data.toString("utf8"))));
  frontend.send('{"id":1,"method":"Runtime.enable"}');
  assert.equal(await engineCommand, '{"id":1,"method":"Runtime.enable"}\n');

  const frontendResponse = new Promise((resolve) => frontend.once("message", (data) => resolve(data.toString("utf8"))));
  engine.write('{"id":1,"result":{}}\n');
  assert.equal(await frontendResponse, '{"id":1,"result":{}}');

  frontend.close();
  engine.destroy();
  await bridge.close();
});

test("a frontend command before the engine connects receives a correlated CDP error", async () => {
  const bridge = await createInspectorBridge();
  const frontend = new WebSocket(bridge.websocketUrl);
  await event(frontend, "open");
  const response = new Promise((resolve) => frontend.once("message", (data) => resolve(JSON.parse(data.toString("utf8")))));
  frontend.send('{"id":27,"method":"Runtime.enable"}');
  assert.deepEqual(await response, {
    id: 27,
    error: { code: -32000, message: "Defold Hermes runtime is not connected" }
  });
  frontend.close();
  await bridge.close();
});

test("a second frontend is rejected unless replacement is explicit", async () => {
  const bridge = await createInspectorBridge();
  const first = new WebSocket(bridge.websocketUrl);
  await event(first, "open");
  const rejected = new WebSocket(bridge.websocketUrl);
  await event(rejected, "open");
  const rejectedClose = event(rejected, "close");
  await rejectedClose;
  assert.equal(first.readyState, WebSocket.OPEN);

  const firstClose = event(first, "close");
  const replacement = new WebSocket(`${bridge.websocketUrl}?replace=1`);
  await event(replacement, "open");
  await firstClose;
  assert.equal(replacement.readyState, WebSocket.OPEN);
  replacement.close();
  await bridge.close();
});

test("bridge publishes a private session descriptor and stale owners cannot remove a replacement", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "deherm-inspector-session-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sessionFile = path.join(root, ".deherm", "dev", "inspector.json");
  const first = await createInspectorBridge({ projectRoot: root, sessionFile });
  const firstSession = await readInspectorSession(sessionFile);
  assert.equal(firstSession.websocketUrl, first.websocketUrl);
  if (process.platform !== "win32") assert.equal((await stat(sessionFile)).mode & 0o777, 0o600);

  const second = await createInspectorBridge({ projectRoot: root, sessionFile });
  const secondSession = await readInspectorSession(sessionFile);
  assert.notEqual(secondSession.sessionId, firstSession.sessionId);
  await first.close();
  assert.equal((await readInspectorSession(sessionFile)).sessionId, secondSession.sessionId);
  await second.close();
  await assert.rejects(() => readFile(sessionFile), { code: "ENOENT" });
});

test("owned-session cleanup preserves a different or malformed descriptor", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "deherm-inspector-owner-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sessionFile = path.join(root, "inspector.json");
  const replacement = createInspectorSession({
    projectRoot: root,
    enginePort: 9000,
    devtoolsPort: 9001,
    devtoolsUrl: "http://127.0.0.1:9001",
    websocketUrl: "ws://127.0.0.1:9001/devtools/page/deherm"
  });
  await writeInspectorSession(sessionFile, replacement);
  assert.equal(await removeOwnedInspectorSession(sessionFile, "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"), false);
  assert.equal((await readInspectorSession(sessionFile)).sessionId, replacement.sessionId);

  const malformed = "{ definitely-not-json }\n";
  await writeFile(sessionFile, malformed, { mode: 0o600 });
  await assert.rejects(
    () => removeOwnedInspectorSession(sessionFile, replacement.sessionId),
    /Could not read inspector session/
  );
  assert.equal(await readFile(sessionFile, "utf8"), malformed);
});

test("session descriptors reject non-loopback debugger endpoints", () => {
  assert.throws(() => createInspectorSession({
    projectRoot: process.cwd(),
    enginePort: 9000,
    devtoolsPort: 9001,
    devtoolsUrl: "http://example.com:9001",
    websocketUrl: "ws://example.com:9001/devtools/page/deherm"
  }), /loopback-only/);
  assert.throws(() => createInspectorSession({
    sessionId: "------------------------------------",
    projectRoot: process.cwd(),
    enginePort: 9000,
    devtoolsPort: 9001,
    devtoolsUrl: "http://127.0.0.1:9001",
    websocketUrl: "ws://127.0.0.1:9001/devtools/page/deherm"
  }), /valid sessionId/);
});

test("a failed session publication releases both reserved bridge ports", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "deherm-inspector-startup-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sessionFile = path.join(root, "inspector.json");
  await mkdir(sessionFile);
  const [enginePort, devtoolsPort] = await reservePorts(2);
  await assert.rejects(() => createInspectorBridge({
    projectRoot: root,
    sessionFile,
    enginePort,
    devtoolsPort
  }));
  const replacement = await createInspectorBridge({ enginePort, devtoolsPort });
  await replacement.close();
});
