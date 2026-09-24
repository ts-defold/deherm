// The HTML5 development target, at the seams a live browser cannot cover.
//
// The end-to-end behaviour is proven against a real packaged bundle and a real
// headless Chrome by
// `examples/war-battles-online/integration/check-browser-hot-reload.mjs`. What
// is asserted here is the part that must hold without a browser: where a bundle
// is found, how the page's report becomes session telemetry, and that a counter
// the browser cannot measure is named rather than filled in.

import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  browserCapabilityGaps,
  browserComponentSnapshotEvent,
  browserTelemetryEvent,
  createBrowserTarget,
  resolveWebBundle
} from "../packages/cli/src/dev/browser-target.mjs";
import { connectCdp, startBundleServer } from "../packages/cli/src/dev/browser-host.mjs";
import { readInspectorSession } from "../packages/cli/src/dev/inspector-session.mjs";
import { applyDevEvent, createDevModel, snapshotDevModel } from "../packages/cli/src/dev/model.mjs";

async function bundleProject() {
  const root = await mkdtemp(path.join(tmpdir(), "deherm-browser-target."));
  const bundle = path.join(root, "build", "bundle", "War Battles");
  await mkdir(bundle, { recursive: true });
  await writeFile(path.join(bundle, "index.html"), "<canvas></canvas>");
  return { root, bundle };
}

test("the newest packaged bundle under the project is the one served", async () => {
  const { root, bundle } = await bundleProject();
  try {
    const resolved = await resolveWebBundle({ projectRoot: root, cwd: root });
    assert.equal(resolved.directory, bundle);
    assert.equal(resolved.index, "index.html");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the configured cache root resolves Bob's nested titled directory", async () => {
  const { root, bundle } = await bundleProject();
  try {
    const explicitRoot = path.join(root, "build", "bundle");
    const resolved = await resolveWebBundle({
      projectRoot: path.join(root, "unrelated-project"),
      bundleDirectory: explicitRoot,
      allowNestedBundleDirectory: true
    });
    assert.equal(resolved.directory, bundle);
    assert.equal(resolved.index, "index.html");
    assert.equal(resolved.source, "cache-root");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an explicit bundle directory cannot guess a nested child", async () => {
  const { root } = await bundleProject();
  try {
    await assert.rejects(() => resolveWebBundle({
      projectRoot: root,
      bundleDirectory: path.join(root, "build", "bundle")
    }), /No index\.html in HTML5 bundle directory/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("browser activation rejects a target replacement after host readiness", async () => {
  const { root, bundle } = await bundleProject();
  const bundleFile = path.join(root, ".deherm", "dev", "app.dehermc");
  await mkdir(path.dirname(bundleFile), { recursive: true });
  await writeFile(bundleFile, "globalThis.__dehermTestBundle = true;");
  let target;
  let activationCalls = 0;
  const targetOptions = {
    projectRoot: root,
    bundleDirectory: bundle,
    bundleFile,
    telemetryIntervalMs: 60_000,
    hostPollIntervalMs: 1,
    hostTimeoutMs: 1_000,
    openBundlePage: async () => ({
      server: { port: 9444 },
      client: {
        async send(_method, request) {
          if (request.expression.startsWith("Boolean(")) {
            await target.stop();
            return { result: { value: true } };
          }
          activationCalls += 1;
          return { result: { value: { status: "activated" } } };
        }
      },
      target: { webSocketDebuggerUrl: "ws://127.0.0.1:9333/devtools/page/browser-fixture" },
      debuggingPort: 9333,
      pageUrl: "http://127.0.0.1:9444/index.html",
      profile: path.join(root, "profile"),
      close: async () => {}
    })
  };
  target = createBrowserTarget(targetOptions);
  try {
    await target.launch();
    await assert.rejects(() => target.activate(8), /browser target changed before bundle activation/u);
    assert.equal(activationCalls, 0);
    assert.equal(target.pushCount(), 0);
  } finally {
    await target.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("a missing bundle is an actionable message, never a guess", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "deherm-browser-empty."));
  try {
    await assert.rejects(() => resolveWebBundle({ projectRoot: root, cwd: root }),
      /No packaged HTML5 bundle found .* wasm-web/s);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the browser target publishes and owns a browser debugger session", async () => {
  const { root, bundle } = await bundleProject();
  const sessionFile = path.join(root, ".deherm", "dev", "browser-inspector.json");
  const sourceMapFile = path.join(root, ".deherm", "dev", "app.dehermc.map");
  const websocketUrl = "ws://127.0.0.1:9333/devtools/page/browser-fixture";
  const target = createBrowserTarget({
    projectRoot: root,
    bundleDirectory: bundle,
    bundleFile: path.join(root, ".deherm", "dev", "app.dehermc"),
    sourceMapFile,
    sessionFile,
    telemetryIntervalMs: 60_000,
    openBundlePage: async () => ({
      server: { port: 9444 },
      client: { send: async () => ({ result: { value: null } }) },
      target: { webSocketDebuggerUrl: websocketUrl },
      debuggingPort: 9333,
      pageUrl: "http://127.0.0.1:9444/index.html",
      profile: path.join(root, "profile"),
      close: async () => {}
    })
  });
  try {
    assert.equal(await target.launch(), true);
    const session = await readInspectorSession(sessionFile);
    assert.equal(session.runtime, "browser");
    assert.equal(session.enginePort, undefined);
    assert.equal(session.websocketUrl, websocketUrl);
    assert.equal(session.bundleUrl, "defold-hermes://app.js");
    assert.equal(session.sourceMapFile, sourceMapFile);
    assert.equal(await target.stop(), true);
    await assert.rejects(() => readFile(sessionFile), { code: "ENOENT" });
  } finally {
    await target.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("browser exception diagnostics retain source location and exception description", async () => {
  const previousWebSocket = globalThis.WebSocket;
  class FakeWebSocket {
    static CLOSED = 3;

    constructor() {
      this.readyState = 1;
      this.listeners = new Map();
      queueMicrotask(() => this.emit("open"));
    }

    addEventListener(type, listener) {
      const group = this.listeners.get(type) ?? [];
      group.push(listener);
      this.listeners.set(type, group);
    }

    send() {}

    close() {
      this.readyState = FakeWebSocket.CLOSED;
      this.emit("close");
    }

    emit(type, value = {}) {
      for (const listener of this.listeners.get(type) ?? []) listener(value);
    }
  }

  globalThis.WebSocket = FakeWebSocket;
  try {
    const failures = [];
    const client = await connectCdp("ws://fixture", { onFailure: (failure) => failures.push(failure) });
    client.socket.emit("message", {
      data: JSON.stringify({
        method: "Runtime.exceptionThrown",
        params: {
          exceptionDetails: {
            text: "Uncaught Error",
            exception: { description: "Error: retained hashLiteral call" },
            url: "http://fixture/app.js",
            lineNumber: 7,
            columnNumber: 11
          }
        }
      })
    });
    assert.deepEqual(failures, [{
      kind: "exception",
      detail: "Error: retained hashLiteral call",
      text: "Uncaught Error",
      url: "http://fixture/app.js",
      line: 8,
      column: 12
    }]);
    assert.deepEqual(client.failures, failures);
    await client.close();
  } finally {
    globalThis.WebSocket = previousWebSocket;
  }
});

test("browser launch releases the page when inspector-session validation fails", async () => {
  const { root, bundle } = await bundleProject();
  let closes = 0;
  const target = createBrowserTarget({
    projectRoot: root,
    bundleDirectory: bundle,
    bundleFile: path.join(root, ".deherm", "dev", "app.dehermc"),
    sourceMapFile: path.join(root, "..", "outside.map"),
    sessionFile: path.join(root, ".deherm", "dev", "browser-inspector.json"),
    openBundlePage: async () => ({
      server: { port: 9444 },
      client: { send: async () => ({ result: { value: null } }) },
      target: { webSocketDebuggerUrl: "ws://127.0.0.1:9333/devtools/page/browser-fixture" },
      debuggingPort: 9333,
      pageUrl: "http://127.0.0.1:9444/index.html",
      profile: path.join(root, "profile"),
      close: async () => { closes += 1; }
    })
  });
  try {
    await assert.rejects(() => target.launch(), /sourceMapFile must be inside projectRoot/u);
    assert.equal(closes, 1);
    assert.equal(target.running(), false);
  } finally {
    await target.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("browser launch does not publish a session for a page that exited while opening", async () => {
  const { root, bundle } = await bundleProject();
  const sessionFile = path.join(root, ".deherm", "dev", "browser-inspector.json");
  let closes = 0;
  const target = createBrowserTarget({
    projectRoot: root,
    bundleDirectory: bundle,
    bundleFile: path.join(root, ".deherm", "dev", "app.dehermc"),
    sourceMapFile: path.join(root, ".deherm", "dev", "app.dehermc.map"),
    sessionFile,
    openBundlePage: async (options) => {
      options.onBrowserExit();
      return {
        server: { port: 9444 },
        client: { send: async () => ({ result: { value: null } }) },
        target: { webSocketDebuggerUrl: "ws://127.0.0.1:9333/devtools/page/browser-fixture" },
        debuggingPort: 9333,
        pageUrl: "http://127.0.0.1:9444/index.html",
        profile: path.join(root, "profile"),
        close: async () => { closes += 1; }
      };
    }
  });
  try {
    await assert.rejects(() => target.launch(), /browser exited while publishing/u);
    assert.equal(closes, 1);
    assert.equal(target.running(), false);
    await assert.rejects(() => readFile(sessionFile), { code: "ENOENT" });
  } finally {
    await target.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("first browser activation waits for Defold to install its host", async () => {
  const { root, bundle } = await bundleProject();
  const bundleFile = path.join(root, ".deherm", "dev", "app.dehermc");
  await mkdir(path.dirname(bundleFile), { recursive: true });
  await writeFile(bundleFile, "globalThis.__dehermTestBundle = true;");
  const events = [];
  let readinessCalls = 0;
  const target = createBrowserTarget({
    projectRoot: root,
    bundleDirectory: bundle,
    bundleFile,
    telemetryIntervalMs: 60_000,
    hostPollIntervalMs: 1,
    hostTimeoutMs: 1_000,
    emit: (event) => events.push(event),
    openBundlePage: async () => ({
      server: { port: 9444 },
      client: {
        async send(_method, request) {
          if (request.expression.startsWith("Boolean(")) {
            readinessCalls += 1;
            return { result: { value: readinessCalls >= 3 } };
          }
          return { result: { value: { status: "activated" } } };
        }
      },
      target: { webSocketDebuggerUrl: "ws://127.0.0.1:9333/devtools/page/browser-fixture" },
      debuggingPort: 9333,
      pageUrl: "http://127.0.0.1:9444/index.html",
      profile: path.join(root, "profile"),
      close: async () => {}
    })
  });
  try {
    await target.launch();
    assert.deepEqual(await target.activate(7), { status: "activated" });
    assert.equal(readinessCalls, 3);
    assert.equal(target.pushCount(), 1);
    assert.ok(events.some(({ type, generation }) => type === "reload-started" && generation === 7));
    assert.ok(events.some(({ type, generation }) => type === "reload-signalled" && generation === 7));
  } finally {
    await target.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("browser activation fails closed when the Defold host never appears", async () => {
  const { root, bundle } = await bundleProject();
  const bundleFile = path.join(root, ".deherm", "dev", "app.dehermc");
  await mkdir(path.dirname(bundleFile), { recursive: true });
  await writeFile(bundleFile, "globalThis.__dehermTestBundle = true;");
  const target = createBrowserTarget({
    projectRoot: root,
    bundleDirectory: bundle,
    bundleFile,
    telemetryIntervalMs: 60_000,
    hostPollIntervalMs: 1,
    hostTimeoutMs: 10,
    openBundlePage: async () => ({
      server: { port: 9444 },
      client: { send: async () => ({ result: { value: false } }) },
      target: { webSocketDebuggerUrl: "ws://127.0.0.1:9333/devtools/page/browser-fixture" },
      debuggingPort: 9333,
      pageUrl: "http://127.0.0.1:9444/index.html",
      profile: path.join(root, "profile"),
      close: async () => {}
    })
  });
  try {
    await target.launch();
    await assert.rejects(() => target.activate(1), /Timed out waiting for the Defold browser host/u);
    assert.equal(target.pushCount(), 0);
  } finally {
    await target.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("a failed activation closes the reload event pair", async () => {
  const { root, bundle } = await bundleProject();
  const bundleFile = path.join(root, ".deherm", "dev", "app.dehermc");
  await mkdir(path.dirname(bundleFile), { recursive: true });
  await writeFile(bundleFile, "globalThis.__dehermTestBundle = true;");
  const events = [];
  const target = createBrowserTarget({
    projectRoot: root,
    bundleDirectory: bundle,
    bundleFile,
    telemetryIntervalMs: 60_000,
    emit: (event) => events.push(event),
    openBundlePage: async () => ({
      server: { port: 9444 },
      client: {
        async send(_method, request) {
          if (request.expression.startsWith("Boolean(")) return { result: { value: true } };
          throw new Error("CDP page closed");
        }
      },
      target: { webSocketDebuggerUrl: "ws://127.0.0.1:9333/devtools/page/browser-fixture" },
      debuggingPort: 9333,
      pageUrl: "http://127.0.0.1:9444/index.html",
      profile: path.join(root, "profile"),
      close: async () => {}
    })
  });
  try {
    await target.launch();
    await assert.rejects(() => target.activate(9), /CDP page closed/u);
    assert.ok(events.some(({ type, generation }) => type === "reload-started" && generation === 9));
    assert.ok(events.some(({ type, generation, diagnostic }) =>
      type === "reload-failed" && generation === 9 && diagnostic === "CDP page closed"));
    assert.equal(target.pushCount(), 0);
  } finally {
    await target.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("browser telemetry reports what the page measured and names what it could not", () => {
  const event = browserTelemetryEvent("browser-host", {
    runtime: "browser",
    generation: 3,
    componentRevision: 1,
    frames: 900,
    available: {
      frameDtMs: 16.5,
      componentInstances: 3,
      componentCapacity: 1024,
      callbackRoots: 2,
      callbackCapacity: 4096,
      jsHeapBytes: 4096,
      jsHeapSizeBytes: 8192,
      jsHeapLimitBytes: 65536
    },
    unavailable: {
      hermesHeapBytes: "The browser runtime embeds no Hermes.",
      luaHandles: "The Lua value registry lives inside the Wasm engine.",
      arenaHighWaterBytes: "No high-water mark is recorded.",
      jsHeapBytesWhenAbsent: null
    }
  });
  assert.equal(event.type, "telemetry");
  assert.equal(event.values.frameDtMs, 16.5);
  assert.equal(event.values.componentInstances, 3);
  // A page heap is not a Hermes heap and must never be presented as one.
  assert.equal(event.values.hermesHeapAvailable, false);
  assert.equal(event.values.jsHeapBytes, 4096);
  assert.equal(event.values.hermesHeapBytes, undefined);
  assert.deepEqual(event.capabilities.map(({ name }) => name).sort(),
    ["arenaHighWaterBytes", "hermesHeapBytes", "luaHandles"]);
  for (const capability of event.capabilities) assert.equal(capability.available, false);
});

test("browser component snapshots receive the target connection epoch without mutation", () => {
  const reported = {
    schemaVersion: 1,
    type: "component-snapshot",
    runtimeId: 12,
    sequence: 8,
    sampledAt: 42,
    complete: true,
    omitted: { instances: 0, properties: 0 },
    instances: [{ properties: [{ name: "health", value: 90 }] }]
  };
  assert.deepEqual(browserComponentSnapshotEvent("browser-host", 3, reported), {
    ...reported,
    id: "browser-host",
    connectionEpoch: 3
  });
  assert.equal(reported.id, undefined);
  assert.equal(reported.connectionEpoch, undefined);
});

test("browser polling obtains telemetry and component state in one CDP tick", async () => {
  const { root, bundle } = await bundleProject();
  const events = [];
  const expressions = [];
  const target = createBrowserTarget({
    projectRoot: root,
    bundleDirectory: bundle,
    bundleFile: path.join(root, ".deherm", "dev", "app.dehermc"),
    telemetryIntervalMs: 20,
    emit: (event) => events.push(event),
    openBundlePage: async () => ({
      server: { port: 9444 },
      client: {
        async send(_method, parameters) {
          expressions.push(parameters.expression);
          return { result: { value: {
            telemetry: { generation: 1, componentRevision: 7, frames: 2, available: {} },
            componentSnapshot: {
              schemaVersion: 1,
              type: "component-snapshot",
              runtimeId: 7,
              sequence: 1,
              complete: true,
              omitted: { instances: 0, properties: 0 },
              instances: []
            }
          } } };
        }
      },
      target: { webSocketDebuggerUrl: "ws://127.0.0.1:9333/devtools/page/browser-fixture" },
      debuggingPort: 9333,
      pageUrl: "http://127.0.0.1:9444/index.html",
      profile: path.join(root, "profile"),
      close: async () => {}
    })
  });
  try {
    await target.launch();
    const deadline = Date.now() + 1_000;
    while (!events.some(({ type }) => type === "component-snapshot") && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.ok(events.some(({ type }) => type === "telemetry"));
    assert.ok(events.some(({ type, connectionEpoch }) => type === "component-snapshot" && connectionEpoch === 1));
    assert.equal(expressions.length, 1);
    assert.match(expressions[0], /telemetry\(\)/u);
    assert.match(expressions[0], /componentSnapshot\(\)/u);
  } finally {
    await target.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("a deferred poll from a closed page cannot populate its replacement epoch", async () => {
  const { root, bundle } = await bundleProject();
  const events = [];
  let pageNumber = 0;
  let releaseOldPoll;
  let oldPollStarted;
  const oldPoll = new Promise((resolve) => { releaseOldPoll = resolve; });
  const started = new Promise((resolve) => { oldPollStarted = resolve; });
  const target = createBrowserTarget({
    projectRoot: root,
    bundleDirectory: bundle,
    bundleFile: path.join(root, ".deherm", "dev", "app.dehermc"),
    telemetryIntervalMs: 5,
    emit: (event) => events.push(event),
    openBundlePage: async () => {
      const current = ++pageNumber;
      return {
        server: { port: 9443 + current },
        client: {
          send: async () => {
            if (current === 1) {
              oldPollStarted();
              return oldPoll;
            }
            return { result: { value: null } };
          }
        },
        target: { webSocketDebuggerUrl: `ws://127.0.0.1:9333/devtools/page/browser-${current}` },
        debuggingPort: 9332 + current,
        pageUrl: `http://127.0.0.1:${9443 + current}/index.html`,
        profile: path.join(root, `profile-${current}`),
        close: async () => {}
      };
    }
  });
  try {
    await target.launch();
    await started;
    await target.stop();
    await target.launch();
    releaseOldPoll({ result: { value: {
      telemetry: { generation: 1, componentRevision: 1, frames: 1, available: {} },
      componentSnapshot: {
        schemaVersion: 1,
        type: "component-snapshot",
        runtimeId: 99,
        sequence: 1,
        instances: []
      }
    } } });
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(events.some(({ type, runtimeId }) => type === "component-snapshot" && runtimeId === 99), false,
      "page A telemetry must not be relabelled with page B's epoch");
    assert.ok(events.some(({ type, connectionEpoch }) => type === "target-connected" && connectionEpoch === 2));
  } finally {
    await target.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("a late exit callback from a replaced page cannot stop its successor", async () => {
  const { root, bundle } = await bundleProject();
  const events = [];
  const exitCallbacks = [];
  let pageNumber = 0;
  const target = createBrowserTarget({
    projectRoot: root,
    bundleDirectory: bundle,
    bundleFile: path.join(root, ".deherm", "dev", "app.dehermc"),
    telemetryIntervalMs: 60_000,
    emit: (event) => events.push(event),
    openBundlePage: async (options) => {
      const current = ++pageNumber;
      exitCallbacks.push(options.onBrowserExit);
      return {
        server: { port: 9443 + current },
        client: { send: async () => ({ result: { value: null } }) },
        target: { webSocketDebuggerUrl: `ws://127.0.0.1:9333/devtools/page/browser-${current}` },
        debuggingPort: 9332 + current,
        pageUrl: `http://127.0.0.1:${9443 + current}/index.html`,
        profile: path.join(root, `profile-${current}`),
        close: async () => {}
      };
    }
  });
  try {
    await target.launch();
    await target.stop();
    await target.launch();
    exitCallbacks[0]();
    assert.equal(target.running(), true);
    assert.equal(target.pageUrl(), "http://127.0.0.1:9445/index.html");
    assert.equal(events.some(({ type, connectionEpoch }) =>
      type === "target-disconnected" && connectionEpoch === 2), false);
  } finally {
    await target.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("browser telemetry polling is single-flight within one connection epoch", async () => {
  const { root, bundle } = await bundleProject();
  let calls = 0;
  let active = 0;
  let maximumActive = 0;
  let releaseFirst;
  let firstStarted;
  const first = new Promise((resolve) => { releaseFirst = resolve; });
  const started = new Promise((resolve) => { firstStarted = resolve; });
  const target = createBrowserTarget({
    projectRoot: root,
    bundleDirectory: bundle,
    bundleFile: path.join(root, ".deherm", "dev", "app.dehermc"),
    telemetryIntervalMs: 5,
    openBundlePage: async () => ({
      server: { port: 9444 },
      client: {
        async send() {
          calls += 1;
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          if (calls === 1) {
            firstStarted();
            await first;
          }
          active -= 1;
          return { result: { value: null } };
        }
      },
      target: { webSocketDebuggerUrl: "ws://127.0.0.1:9333/devtools/page/browser-fixture" },
      debuggingPort: 9333,
      pageUrl: "http://127.0.0.1:9444/index.html",
      profile: path.join(root, "profile"),
      close: async () => {}
    })
  });
  try {
    await target.launch();
    await started;
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(calls, 1, "interval ticks must not overlap an in-flight CDP evaluation");
    releaseFirst();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(calls > 1);
    assert.equal(maximumActive, 1);
  } finally {
    releaseFirst();
    await target.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("a counter the page could not measure is absent from the values, not zero", () => {
  const event = browserTelemetryEvent("browser-host", {
    generation: 1,
    componentRevision: 1,
    frames: 0,
    available: { frameDtMs: null, componentInstances: 0, callbackRoots: 0 },
    unavailable: { frameDtMs: "No application lifecycle is attached." }
  });
  assert.equal("frameDtMs" in event.values, false);
  assert.ok(event.capabilities.some(({ name }) => name === "frameDtMs"));
});

test("declared capability gaps reach a console snapshot with their reasons", () => {
  const model = createDevModel();
  applyDevEvent(model, {
    type: "target-configured",
    id: "browser-host",
    name: "chrome:1234",
    url: "http://127.0.0.1:1234/index.html",
    runtime: "browser"
  });
  applyDevEvent(model, {
    type: "target-capabilities",
    id: "browser-host",
    capabilities: browserCapabilityGaps.map((gap) => ({ ...gap }))
  });
  const [target] = snapshotDevModel(model).targets;
  assert.equal(target.runtime, "browser");
  assert.equal(target.capabilities.length, browserCapabilityGaps.length);
  for (const gap of target.capabilities) {
    assert.equal(gap.available, false);
    assert.ok(gap.reason.length > 20, `${gap.name} must carry a reason`);
  }
  assert.ok(target.capabilities.some(({ name }) => name === "visual-verification"),
    "the console must never be able to imply a visual claim");
});

test("the bundle server binds loopback only and refuses to serve outside its root", async () => {
  const { root, bundle } = await bundleProject();
  const server = await startBundleServer({ root: bundle });
  try {
    assert.match(server.baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
    const index = await fetch(server.pageUrl);
    assert.equal(index.status, 200);
    assert.match(index.headers.get("content-type"), /text\/html/);
    const escape = await fetch(`${server.baseUrl}/../../../etc/hosts`);
    assert.equal(escape.status, 404);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});
