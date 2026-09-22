import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";

import WebSocket from "ws";

import { createInspectorBridge } from "../packages/cli/src/dev/inspector-bridge.mjs";

function event(target, name) {
  return new Promise((resolve, reject) => {
    target.once(name, resolve);
    target.once("error", reject);
  });
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
