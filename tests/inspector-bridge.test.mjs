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

test("reserved native component snapshots update dev state and never reach CDP", async () => {
  const events = [];
  const bridge = await createInspectorBridge({ emit: (value) => events.push(value) });
  const engine = net.createConnection({ host: "127.0.0.1", port: bridge.enginePort });
  await event(engine, "connect");
  const frontend = new WebSocket(bridge.websocketUrl);
  await event(frontend, "open");
  const payload = {
    schemaVersion: 1,
    type: "component-snapshot",
    runtimeId: 7,
    sequence: 3,
    sampledAt: 100,
    complete: true,
    omitted: { instances: 0, properties: 0 },
    instances: [{
      instanceId: { slot: 2, generation: 4 },
      componentId: "player",
      schemaFingerprint: "abc",
      contextKind: "script",
      properties: [{ name: "health", value: 100 }]
    }]
  };
  const response = new Promise((resolve) => frontend.once("message", (data) => resolve(data.toString("utf8"))));
  engine.write(`${JSON.stringify({ channel: "deherm-dev-v1", payload })}\n`);
  engine.write('{"id":9,"result":{}}\n');
  assert.equal(await response, '{"id":9,"result":{}}');
  assert.deepEqual(events.find(({ type }) => type === "component-snapshot"), {
    ...payload,
    id: "local-engine",
    connectionEpoch: 1
  });

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

test("frontend detach resets the engine transport before a fresh debugger session", async () => {
  const bridge = await createInspectorBridge();
  const firstEngine = net.createConnection({ host: "127.0.0.1", port: bridge.enginePort });
  await event(firstEngine, "connect");
  const firstFrontend = new WebSocket(bridge.websocketUrl);
  await event(firstFrontend, "open");

  const firstEngineClosed = event(firstEngine, "close");
  firstFrontend.close();
  await firstEngineClosed;

  const secondFrontend = new WebSocket(bridge.websocketUrl);
  await event(secondFrontend, "open");
  secondFrontend.send('{"id":2,"method":"Debugger.enable"}');
  const secondEngine = net.createConnection({ host: "127.0.0.1", port: bridge.enginePort });
  const command = new Promise((resolve) => {
    secondEngine.once("data", (data) => resolve(data.toString("utf8")));
  });
  await event(secondEngine, "connect");
  assert.equal(await command, '{"id":2,"method":"Debugger.enable"}\n');

  secondFrontend.close();
  secondEngine.destroy();
  await bridge.close();
});

test("a second frontend is rejected unless replacement is explicit", async () => {
  const bridge = await createInspectorBridge();
  const firstEngine = net.createConnection({ host: "127.0.0.1", port: bridge.enginePort });
  await event(firstEngine, "connect");
  const first = new WebSocket(bridge.websocketUrl);
  await event(first, "open");
  const rejected = new WebSocket(bridge.websocketUrl);
  await event(rejected, "open");
  const rejectedClose = event(rejected, "close");
  await rejectedClose;
  assert.equal(first.readyState, WebSocket.OPEN);

  const firstClose = event(first, "close");
  const firstEngineClose = event(firstEngine, "close");
  const replacement = new WebSocket(`${bridge.websocketUrl}?replace=1`);
  await event(replacement, "open");
  await firstClose;
  await firstEngineClose;
  assert.equal(replacement.readyState, WebSocket.OPEN);
  replacement.send('{"id":3,"method":"Runtime.enable"}');
  const replacementEngine = net.createConnection({ host: "127.0.0.1", port: bridge.enginePort });
  const replacementCommand = new Promise((resolve) => {
    replacementEngine.once("data", (data) => resolve(data.toString("utf8")));
  });
  await event(replacementEngine, "connect");
  assert.equal(await replacementCommand, '{"id":3,"method":"Runtime.enable"}\n');
  replacement.close();
  replacementEngine.destroy();
  await bridge.close();
});

test("bridge publishes a private session descriptor and stale owners cannot remove a replacement", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "deherm-inspector-session-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sessionFile = path.join(root, ".deherm", "dev", "inspector.json");
  const first = await createInspectorBridge({ projectRoot: root, sessionFile });
  const firstSession = await readInspectorSession(sessionFile);
  assert.equal(firstSession.websocketUrl, first.websocketUrl);
  assert.equal(firstSession.stateUrl, `${first.devtoolsUrl}/deherm/dev/v1/snapshot`);
  assert.match(firstSession.authToken, /^[A-Za-z0-9_-]{43,}$/u);
  if (process.platform !== "win32") assert.equal((await stat(sessionFile)).mode & 0o777, 0o600);

  const second = await createInspectorBridge({ projectRoot: root, sessionFile });
  const secondSession = await readInspectorSession(sessionFile);
  assert.notEqual(secondSession.sessionId, firstSession.sessionId);
  await first.close();
  assert.equal((await readInspectorSession(sessionFile)).sessionId, secondSession.sessionId);
  await second.close();
  await assert.rejects(() => readFile(sessionFile), { code: "ENOENT" });
});

test("dev state endpoint requires its descriptor token and supports ETag revalidation", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "deherm-inspector-state-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sessionFile = path.join(root, "inspector.json");
  const state = {
    schemaVersion: 1,
    kind: "deherm-dev-state",
    modelVersion: 4,
    targetId: "local-engine",
    telemetry: { componentInstances: 1 },
    componentSnapshot: { schemaVersion: 1, type: "component-snapshot", instances: [] }
  };
  const bridge = await createInspectorBridge({
    projectRoot: root,
    sessionFile,
    getDevState: () => state
  });
  const session = await readInspectorSession(sessionFile);
  try {
    const unauthorized = await fetch(session.stateUrl);
    assert.equal(unauthorized.status, 401);
    assert.equal(unauthorized.headers.get("access-control-allow-origin"), null);
    assert.equal(unauthorized.headers.get("cache-control"), "no-store");

    const authorized = await fetch(session.stateUrl, {
      headers: { authorization: `Bearer ${session.authToken}` }
    });
    assert.equal(authorized.status, 200);
    assert.equal(authorized.headers.get("cache-control"), "no-store");
    assert.equal(authorized.headers.get("access-control-allow-origin"), null);
    const etag = authorized.headers.get("etag");
    assert.ok(etag);
    const body = await authorized.json();
    assert.deepEqual(body, state);
    assert.equal(JSON.stringify(body).includes(session.authToken), false);

    const unchanged = await fetch(session.stateUrl, {
      headers: {
        authorization: `Bearer ${session.authToken}`,
        "if-none-match": etag
      }
    });
    assert.equal(unchanged.status, 304);
    assert.equal(unchanged.headers.get("cache-control"), "no-store");
  } finally {
    await bridge.close();
  }
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

test("session descriptors carry project-owned maps and runtime-specific bundle URLs", () => {
  const projectRoot = path.resolve("fixture-project");
  const valid = createInspectorSession({
    projectRoot,
    enginePort: 9000,
    devtoolsPort: 9001,
    devtoolsUrl: "http://127.0.0.1:9001",
    websocketUrl: "ws://127.0.0.1:9001/devtools/page/deherm",
    bundleUrl: "deherm:///deherm/app.dehermc",
    sourceMapFile: path.join(projectRoot, ".deherm", "dev", "app.dehermc.map")
  });
  assert.equal(valid.bundleUrl, "deherm:///deherm/app.dehermc");
  assert.throws(() => createInspectorSession({
    ...valid,
    sourceMapFile: path.resolve(projectRoot, "..", "outside.map")
  }), /must be inside projectRoot/);
  assert.throws(() => createInspectorSession({
    ...valid,
    bundleUrl: "https://example.com/app.js"
  }), /must use deherm:/);

  const browser = createInspectorSession({
    runtime: "browser",
    projectRoot,
    devtoolsPort: 9222,
    devtoolsUrl: "http://127.0.0.1:9222",
    websocketUrl: "ws://127.0.0.1:9222/devtools/page/browser",
    bundleUrl: "defold-hermes://app.js",
    sourceMapFile: path.join(projectRoot, ".deherm", "dev", "app.dehermc.map")
  });
  assert.equal(browser.enginePort, undefined);
  assert.equal(browser.runtime, "browser");
  assert.throws(() => createInspectorSession({ ...browser, enginePort: 9223 }), /must not declare enginePort/);
  assert.throws(() => createInspectorSession({ ...browser, bundleUrl: "deherm:///app.js" }), /must use defold-hermes:/);
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
