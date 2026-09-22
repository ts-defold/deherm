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
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The server, the scoped loopback ports, the dedicated Chrome profile, the CDP
// client and the teardown are the development browser target's machinery; this
// gate is the other consumer of it rather than a second copy.
import {
  defaultChromeBinary,
  freeLoopbackPort,
  openBundlePage,
  waitFor
} from "../../../packages/cli/src/dev/browser-host.mjs";

import { projectionEnvelope } from "./projections.mjs";

/** The projection this gate observes. */
export const PROJECTION_ID = "browser-wasm-web";

const exampleRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(exampleRoot, "../..");
const bundleDirectory = process.env.DEHERM_WAR_BATTLES_WEB_BUNDLE
  ?? resolve(repositoryRoot, "build/bundle/War Battles");
const bundleResource = resolve(exampleRoot, "defold/deherm/app.dehermc");
const evidencePath = resolve(exampleRoot, "evidence/browser-runtime-wasm-web.json");
const chromeBinary = process.env.DEHERM_CHROME ?? defaultChromeBinary;

// Exact markers the port emits through the host log. Everything before
// `war-battles:` is engine or extension provenance; everything after is the
// tutorial's own behaviour.
export const REQUIRED_ENGINE_MARKERS = Object.freeze([
  "INFO:ENGINE: Defold Engine 1.14.0 (7f0f554)",
  "INFO:DEFOLD_HERMES: Loaded TypeScript bundle generation 1 from '/deherm/app.dehermc'"
]);

// The generated Lua symbol count grows as the mirrored Defold surface grows;
// it is runtime evidence, not a fixed identity. Assert the exact profile and a
// positive measured count without pinning this game gate to yesterday's API.
export const REQUIRED_ENGINE_MARKER_PATTERNS = Object.freeze([
  /^INFO:DEFOLD_HERMES: Detected Defold runtime profile 'default-legacy-bullet' from [1-9][0-9]* generated Lua symbols$/u
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
  "war-battles:player-moved:1592.0:1072.0",
  // The scripted demonstration ends by handing the scene to the arena, which
  // creates the roster, the turrets and the pickup pads. Observing the engage
  // marker is what distinguishes "the tutorial loop ran" from "the game started".
  "war-battles:arena-init:players=8:online=0",
  "war-battles:arena-engaged:players=8:skill=2:seed=1463898690:mode=offline"
]);

/**
 * Components the generated registry must install inside the engine.
 *
 * This is asserted here, in the browser, and separately in
 * `test/integration.test.mjs` against the generated component manifest, so a
 * component that is authored but never registered - or registered but never
 * authored - shows up as a disagreement rather than as a silent pass. It moved
 * from five to eight with the Ultimate Edition: the arena director, the tank
 * hull/turret renderer and the pickup pad joined the four original components
 * and the retained presentation mockup.
 */
export const EXPECTED_COMPONENT_COUNT = 8;

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

function missing(transcript) {
  const absent = [];
  for (const marker of [...REQUIRED_ENGINE_MARKERS, ...REQUIRED_GAME_MARKERS]) {
    if (!transcript.some((line) => line === marker)) absent.push({ kind: "exact", marker });
  }
  for (const pattern of REQUIRED_ENGINE_MARKER_PATTERNS) {
    if (!transcript.some((line) => pattern.test(line))) {
      absent.push({ kind: "pattern", marker: pattern.source });
    }
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

  const port = Number.parseInt(process.env.DEHERM_WAR_BATTLES_HTTP_PORT ?? "", 10) || await freeLoopbackPort();
  const debuggingPort = Number.parseInt(process.env.DEHERM_WAR_BATTLES_CDP_PORT ?? "", 10) || await freeLoopbackPort();

  const page = await openBundlePage({
    bundleDirectory,
    port,
    debuggingPort,
    chromeBinary,
    // This gate asserts over the whole transcript, so it keeps one.
    retain: true,
    keepProfile: argumentSet.has("--keep")
  });
  const { client, pageUrl, profile } = page;

  try {
    // Clear before requesting the reload. Chrome can deliver
    // executionContextsCleared after the new page has already logged its
    // startup; clearing after that event discarded the very run being tested.
    client.transcript.length = 0;
    client.failures.length = 0;
    const cleared = client.waitForEvent("Runtime.executionContextsCleared");
    const loaded = client.waitForEvent("Page.loadEventFired");
    await client.send("Page.reload", { ignoreCache: true });
    await cleared;
    await loaded;

    const timeoutMs = Number.parseInt(process.env.DEHERM_WAR_BATTLES_BROWSER_TIMEOUT_MS ?? "45000", 10);
    try {
      await waitFor(async () => missing(client.transcript).length === 0,
        { timeoutMs, intervalMs: 250, what: `the required marker set (absent: ${JSON.stringify(missing(client.transcript))})` });
    } catch (error) {
      const tail = client.transcript.slice(-40);
      throw new Error(`${error.message}\nTranscript tail: ${JSON.stringify(tail)}\nPage failures: ${JSON.stringify(client.failures)}`);
    }

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
    assert.equal(observed.componentsRegistered, EXPECTED_COMPONENT_COUNT,
      `Component registry did not install all ${EXPECTED_COMPONENT_COUNT} components`);
    assert.equal(observed.bundleFingerprint, expectedFingerprint, "Browser bundle fingerprint does not match the source resource");
    assert.deepEqual(missing(client.transcript), [], "Required browser markers are missing");
    assert.deepEqual(fatal, [], `Browser page errors: ${JSON.stringify(fatal)}`);

    const cameraSamples = client.transcript.filter((line) => line.startsWith("war-battles:camera:"));
    const evidence = {
      schemaVersion: 2,
      projection: projectionEnvelope(PROJECTION_ID),
      platform: "wasm-web",
      bundleFingerprint: expectedFingerprint,
      bundleSha256: createHash("sha256").update(bundleBytes).digest("hex"),
      state: observed,
      requiredEngineMarkers: [...REQUIRED_ENGINE_MARKERS],
      requiredEngineMarkerPatterns: REQUIRED_ENGINE_MARKER_PATTERNS.map((pattern) => pattern.source),
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
    // Only what this gate created is released: the CDP socket, the browser, the
    // loopback server, and the dedicated Chrome profile. `--keep` retains the
    // profile for inspection and nothing else.
    await page.close();
    if (argumentSet.has("--keep")) console.log(`war-battles-browser-runtime:profile:${profile}`);
  }
}

// Importing this module must not start a browser: `test/integration.test.mjs`
// reads `EXPECTED_COMPONENT_COUNT` from it to keep the in-engine assertion and
// the generated component manifest from drifting apart.
const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  run().catch((error) => {
    console.error(error.stack ?? error.message);
    process.exitCode = 1;
  });
}
