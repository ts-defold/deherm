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
  browserTelemetryEvent,
  createBrowserTarget,
  resolveWebBundle
} from "../packages/cli/src/dev/browser-target.mjs";
import { startBundleServer } from "../packages/cli/src/dev/browser-host.mjs";
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
