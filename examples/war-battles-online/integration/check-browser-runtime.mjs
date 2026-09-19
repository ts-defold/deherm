#!/usr/bin/env node
//
// Packaged HTML5 runtime gate for the War Battles port.
//
// This is the browser twin of `check-packaged-runtime.mjs`. It serves the
// bundled `wasm-web` artifact on a scoped loopback port, drives a dedicated
// headless Chrome profile over CDP, and accepts the run only when the engine
// starts, the browser host installs, the archived bundle fingerprint matches
// the one on disk, and every required game-owned marker crosses from browser
// JavaScript into the Wasm engine log.
//
// Nothing here claims visual correctness. The evidence is the marker
// transcript, the CDP-observed page state, and the absence of page errors.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const exampleRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(exampleRoot, "../..");
const bundleDirectory = process.env.DEHERM_WAR_BATTLES_WEB_BUNDLE
  ?? resolve(repositoryRoot, "build/bundle/War Battles");
const bundleResource = resolve(exampleRoot, "defold/deherm/app.dehermc");
const evidencePath = resolve(exampleRoot, "evidence/browser-runtime-wasm-web.json");
const chromeBinary = process.env.DEHERM_CHROME
  ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

// Exact markers the port emits through the host log. Everything before
// `war-battles:` is engine or extension provenance; everything after is the
// tutorial's own behaviour.
export const REQUIRED_ENGINE_MARKERS = Object.freeze([
  "INFO:ENGINE: Defold Engine 1.14.0 (7f0f554)",
  "INFO:DEFOLD_HERMES: Detected Defold runtime profile 'default-legacy-bullet' from 253 generated Lua symbols",
  "INFO:DEFOLD_HERMES: Loaded TypeScript bundle generation 1 from '/deherm/app.dehermc'"
]);

export const REQUIRED_GAME_MARKERS = Object.freeze([
  "war-battles:camera-init:zoom=2.00:view=640x360:cameras=1",
  "war-battles:camera-bounds:x=[8.0,1288.0]:y=[-172.0,908.0]",
  "war-battles:ui-init",
  "war-battles:player-init:560.0:360.0",
  "war-battles:player-fire:560.0:360.0:1.00:0.00",
  "war-battles:rocket-init:1.00:0.00",
  "war-battles:rocket-hit",
  "war-battles:score:100",
  "war-battles:rocket-explosion-done",
  "war-battles:player-moved:1592.0:1072.0"
]);

// Camera samples carry a frame-dependent position, so the gate asserts the
// scroll behaviour rather than one sampled coordinate.
export const REQUIRED_GAME_MARKER_PREFIXES = Object.freeze([
  "war-battles:camera:"
]);
export const REQUIRED_GAME_MARKER_SUBSTRINGS = Object.freeze([
  ":clamped=none",
  ":clamped=x",
  ":clamped=xy"
]);

const argumentSet = new Set(process.argv.slice(2));
for (const argument of argumentSet) {
  if (!["--record-evidence", "--check-evidence", "--keep"].includes(argument)) {
    throw new Error(`Unknown argument: ${argument}`);
  }
}

async function freePort() {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolvePort(port));
    });
  });
}

async function waitFor(predicate, { timeoutMs, intervalMs = 150, what }) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((sleep) => setTimeout(sleep, intervalMs));
  }
  throw new Error(`Timed out waiting for ${what}${lastError ? `: ${lastError.message}` : ""}`);
}

/** Minimal CDP client. One page target, request/response plus event capture. */
async function connect(webSocketDebuggerUrl) {
  const socket = new WebSocket(webSocketDebuggerUrl);
  await new Promise((ready, failed) => {
    socket.addEventListener("open", ready, { once: true });
    socket.addEventListener("error", failed, { once: true });
  });
  let nextId = 1;
  const pending = new Map();
  const waiters = new Map();
  const transcript = [];
  const failures = [];
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data);
    if (message.id) {
      const continuation = pending.get(message.id);
      if (!continuation) return;
      pending.delete(message.id);
      if (message.error) continuation.reject(new Error(message.error.message));
      else continuation.resolve(message.result);
      return;
    }
    const queued = waiters.get(message.method);
    if (queued?.length) {
      waiters.delete(message.method);
      for (const notify of queued) notify(message.params);
    }
    if (message.method === "Runtime.consoleAPICalled") {
      const rendered = message.params.args
        .map((argument) => argument.value ?? argument.description ?? "")
        .join(" ");
      // The browser host prefixes every application log line; engine output
      // arrives as Emscripten's own console lines.
      transcript.push(rendered.replace(/^\[defold-hermes\] /, "").replace(/\n$/, ""));
    } else if (message.method === "Runtime.exceptionThrown") {
      failures.push({ kind: "exception", detail: message.params.exceptionDetails.text });
    } else if (message.method === "Log.entryAdded" && message.params.entry.level === "error") {
      failures.push({
        kind: "log",
        detail: message.params.entry.text,
        url: message.params.entry.url ?? null
      });
    }
  });
  const send = (method, params = {}) => {
    const id = nextId++;
    const result = new Promise((ok, no) => pending.set(id, { resolve: ok, reject: no }));
    socket.send(JSON.stringify({ id, method, params }));
    return result;
  };
  const waitForEvent = (method, timeoutMs = 30_000) => new Promise((ok, no) => {
    const timer = setTimeout(() => no(new Error(`Timed out waiting for CDP event ${method}`)), timeoutMs);
    const queue = waiters.get(method) ?? [];
    queue.push((params) => { clearTimeout(timer); ok(params); });
    waiters.set(method, queue);
  });
  return { socket, send, waitForEvent, transcript, failures };
}

function missing(transcript) {
  const absent = [];
  for (const marker of [...REQUIRED_ENGINE_MARKERS, ...REQUIRED_GAME_MARKERS]) {
    if (!transcript.some((line) => line === marker)) absent.push({ kind: "exact", marker });
  }
  for (const prefix of REQUIRED_GAME_MARKER_PREFIXES) {
    if (!transcript.some((line) => line.startsWith(prefix))) absent.push({ kind: "prefix", marker: prefix });
  }
  for (const part of REQUIRED_GAME_MARKER_SUBSTRINGS) {
    if (!transcript.some((line) => line.startsWith("war-battles:camera:") && line.endsWith(part))) {
      absent.push({ kind: "camera-clamp", marker: part });
    }
  }
  return absent;
}

async function run() {
  const bundleBytes = await readFile(bundleResource);
  const expectedFingerprint = /__DEFOLD_HERMES_BUILD_FINGERPRINT__ = "([0-9a-f]{64})"/
    .exec(bundleBytes.toString("utf8"))?.[1];
  assert.ok(expectedFingerprint, `No build fingerprint in ${bundleResource}`);

  const port = Number.parseInt(process.env.DEHERM_WAR_BATTLES_HTTP_PORT ?? "", 10) || await freePort();
  const debuggingPort = Number.parseInt(process.env.DEHERM_WAR_BATTLES_CDP_PORT ?? "", 10) || await freePort();
  const pageUrl = `http://127.0.0.1:${port}/${encodeURIComponent("index.html")}`;
  const profile = await mkdtemp(join(tmpdir(), "deherm-war-battles-chrome."));

  const server = spawn(process.execPath, [resolve(repositoryRoot, "scripts/serve.mjs")], {
    cwd: bundleDirectory,
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", "ignore", "pipe"]
  });
  const browser = spawn(chromeBinary, [
    "--headless=new",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    `--remote-debugging-port=${debuggingPort}`,
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    pageUrl
  ], { stdio: ["ignore", "ignore", "pipe"] });

  let client;
  try {
    await waitFor(async () => (await fetch(pageUrl)).ok, { timeoutMs: 15_000, what: "the local bundle server" });
    const target = await waitFor(async () => {
      const targets = await (await fetch(`http://127.0.0.1:${debuggingPort}/json/list`)).json();
      return targets.find((candidate) => candidate.type === "page" && candidate.url === pageUrl);
    }, { timeoutMs: 30_000, what: "the headless Chrome page target" });

    client = await connect(target.webSocketDebuggerUrl);
    await client.send("Page.enable");
    await client.send("Runtime.enable");
    await client.send("Log.enable");
    const cleared = client.waitForEvent("Runtime.executionContextsCleared");
    const loaded = client.waitForEvent("Page.loadEventFired");
    await client.send("Page.reload", { ignoreCache: true });
    await cleared;
    // Discard inspector events replayed from the pre-reload document so the
    // transcript belongs to exactly one page load.
    client.transcript.length = 0;
    client.failures.length = 0;
    await loaded;

    const timeoutMs = Number.parseInt(process.env.DEHERM_WAR_BATTLES_BROWSER_TIMEOUT_MS ?? "45000", 10);
    await waitFor(async () => missing(client.transcript).length === 0,
      { timeoutMs, intervalMs: 250, what: `the required marker set (absent: ${JSON.stringify(missing(client.transcript))})` });

    const state = await client.send("Runtime.evaluate", {
      expression: `({
        documentReady: document.readyState,
        engineStarted: Boolean(globalThis.Module && Module.calledRun),
        hostRuntime: globalThis.__defoldHostV1?.runtime ?? null,
        componentsRegistered: Object.keys(globalThis.__defoldComponentsV1 ?? {}).length,
        scriptBridgeInstalled: typeof globalThis.__defoldScriptBridgeV1?.call === "function",
        scriptBridgeTarget: globalThis.__defoldScriptBridgeV1?.target ?? null,
        modules: Object.keys(globalThis.__defoldModulesV1 ?? {}).sort(),
        bundleFingerprint: globalThis.__DEFOLD_HERMES_BUILD_FINGERPRINT__ ?? null,
        canvas: (() => { const node = document.querySelector("canvas"); return node ? { width: node.width, height: node.height } : null; })()
      })`,
      returnByValue: true
    });
    const observed = state.result.value;

    const fatal = client.failures.filter((failure) => !failure.url?.endsWith("/favicon.ico"));
    assert.equal(observed.engineStarted, true, "Defold Emscripten runtime did not start");
    assert.equal(observed.hostRuntime, "browser", "Application did not use the browser host adapter");
    assert.equal(observed.scriptBridgeInstalled, true, "Generated browser script bridge was not installed");
    assert.equal(observed.scriptBridgeTarget, "html5-browser-host", "Script bridge reported the wrong target");
    assert.equal(observed.componentsRegistered, 5, "Component registry did not install all five components");
    assert.equal(observed.bundleFingerprint, expectedFingerprint, "Browser bundle fingerprint does not match the source resource");
    assert.deepEqual(missing(client.transcript), [], "Required browser markers are missing");
    assert.deepEqual(fatal, [], `Browser page errors: ${JSON.stringify(fatal)}`);

    const cameraSamples = client.transcript.filter((line) => line.startsWith("war-battles:camera:"));
    const evidence = {
      schemaVersion: 1,
      scope: "Packaged wasm-web browser execution of the War Battles port. Marker and CDP evidence only; no visual claim.",
      platform: "wasm-web",
      bundleFingerprint: expectedFingerprint,
      bundleSha256: createHash("sha256").update(bundleBytes).digest("hex"),
      state: observed,
      requiredEngineMarkers: [...REQUIRED_ENGINE_MARKERS],
      requiredGameMarkers: [...REQUIRED_GAME_MARKERS],
      observedGameMarkers: client.transcript.filter((line) => line.startsWith("war-battles:") && !line.startsWith("war-battles:camera:")),
      cameraSampleCount: cameraSamples.length,
      cameraClampStates: [...new Set(cameraSamples.map((line) => line.slice(line.lastIndexOf(":clamped=") + 9)))].sort(),
      pageErrors: fatal
    };
    console.log(`war-battles-browser-runtime:ok:${expectedFingerprint}`);
    for (const marker of evidence.observedGameMarkers) console.log(marker);
    if (argumentSet.has("--record-evidence")) {
      await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
      console.log(`war-battles-browser-runtime:evidence:${evidencePath}`);
    }
    if (argumentSet.has("--check-evidence")) {
      const recorded = JSON.parse(await readFile(evidencePath, "utf8"));
      assert.equal(recorded.bundleFingerprint, evidence.bundleFingerprint, "Recorded browser evidence is stale");
      assert.deepEqual(recorded.requiredGameMarkers, evidence.requiredGameMarkers, "Recorded browser marker set is stale");
      console.log(`war-battles-browser-runtime:evidence-fresh:${recorded.bundleFingerprint}`);
    }
    return evidence;
  } finally {
    // Only the three processes this gate created are terminated, and the
    // dedicated Chrome profile is removed.
    try { client?.socket.close(); } catch { /* the socket may already be closed */ }
    for (const child of [browser, server]) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    }
    await new Promise((done) => setTimeout(done, 500));
    for (const child of [browser, server]) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
    if (!argumentSet.has("--keep")) await rm(profile, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error(error.stack ?? error.message);
  process.exitCode = 1;
});
