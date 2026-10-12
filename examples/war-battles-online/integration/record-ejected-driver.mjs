#!/usr/bin/env node
// Visual evidence only: wait for an actual match ejection, then capture the
// original driver's on-foot idle and walk frames in packaged Chromium/WebGL.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  defaultChromeBinary,
  freeLoopbackPort,
  openBundlePage,
  waitFor,
} from "../../../packages/cli/src/dev/browser-host.mjs";

const exampleRoot = resolve(import.meta.dirname, "..");
const repositoryRoot = resolve(exampleRoot, "../..");
const bundleDirectory =
  process.env.DEHERM_WAR_BATTLES_WEB_BUNDLE ?? resolve(repositoryRoot, "build/bundle/War Battles");
const outputDirectory = resolve(repositoryRoot, "build/evidence");

async function value(client, expression) {
  const result = await client.send("Runtime.evaluate", { expression, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
  return result.result.value;
}

async function key(client, type, letter) {
  const code = `Key${letter.toUpperCase()}`;
  const virtualKeyCode = letter.toUpperCase().charCodeAt(0);
  await client.send("Input.dispatchKeyEvent", {
    type,
    key: letter,
    code,
    windowsVirtualKeyCode: virtualKeyCode,
    nativeVirtualKeyCode: virtualKeyCode,
    ...(type === "keyDown" ? { text: letter } : {}),
  });
}

async function space(client, type) {
  await client.send("Input.dispatchKeyEvent", {
    type,
    key: " ",
    code: "Space",
    windowsVirtualKeyCode: 32,
    nativeVirtualKeyCode: 32,
    ...(type === "keyDown" ? { text: " " } : {}),
  });
}

async function save(client, name) {
  const screenshot = await client.send("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
    captureBeyondViewport: false,
  });
  const bytes = Buffer.from(screenshot.data, "base64");
  assert.ok(bytes.byteLength > 1_024, `${name} screenshot is empty`);
  const path = resolve(outputDirectory, name);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
  return { path, bytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") };
}

const page = await openBundlePage({
  bundleDirectory,
  port: await freeLoopbackPort(),
  debuggingPort: await freeLoopbackPort(),
  chromeBinary: process.env.DEHERM_CHROME ?? defaultChromeBinary,
  retain: true,
});

try {
  const { client } = page;
  await client.send("Emulation.setDeviceMetricsOverride", {
    width: 1280,
    height: 720,
    deviceScaleFactor: 1,
    mobile: false,
  });
  client.transcript.length = 0;
  const cleared = client.waitForEvent("Runtime.executionContextsCleared");
  const loaded = client.waitForEvent("Page.loadEventFired");
  await client.send("Page.reload", { ignoreCache: true });
  await cleared;
  await loaded;
  await waitFor(() => client.transcript.some((line) => line.startsWith("war-battles:player-init:")), {
    timeoutMs: 30_000,
    intervalMs: 100,
    what: "the player component to initialize",
  });
  await value(client, 'document.querySelector("canvas")?.focus()');
  await key(client, "keyDown", "w");
  await waitFor(() => client.transcript.some((line) => line.startsWith("war-battles:arena-engaged:")), {
    timeoutMs: 3_000,
    intervalMs: 50,
    what: "the match to engage",
  });
  await new Promise((done) => setTimeout(done, 180));
  await key(client, "keyUp", "w");

  let onFoot;
  const deadline = Date.now() + 35_000;
  while (Date.now() < deadline) {
    const telemetry = await value(client, "globalThis.__warBattlesTelemetryV1 ?? null");
    if (telemetry?.localMode === 1) {
      onFoot = telemetry;
      break;
    }
    await new Promise((done) => setTimeout(done, 100));
  }
  if (!onFoot) throw new Error("No local tank ejection occurred during 35 seconds of real packaged play");
  const idle = await save(client, "war-battles-ejected-driver-idle.png");
  await key(client, "keyDown", "d");
  await new Promise((done) => setTimeout(done, 400));
  const moving = await value(client, "globalThis.__warBattlesTelemetryV1 ?? null");
  assert.equal(moving?.localMode, 1, "The driver left infantry mode before the walk capture");
  assert.equal(moving.localGeneration, onFoot.localGeneration, "The driver lifecycle changed during the walk capture");
  assert.ok(
    moving.localWorldX !== onFoot.localWorldX || moving.localWorldY !== onFoot.localWorldY,
    "The on-foot driver did not move under directional input",
  );
  const walk = await save(client, "war-battles-ejected-driver-walk.png");
  await key(client, "keyUp", "d");
  await space(client, "keyDown");
  await new Promise((done) => setTimeout(done, 80));
  const fired = await value(client, "globalThis.__warBattlesTelemetryV1 ?? null");
  assert.equal(fired?.localMode, 1, "The on-foot firing capture happened after the pilot died");
  assert.equal(fired.localGeneration, onFoot.localGeneration, "The firing capture crossed a pilot lifecycle change");
  assert.ok(fired.localCooldownTicks > 0, "The pilot did not fire in the authoritative local simulation");
  const firing = await save(client, "war-battles-ejected-driver-fire.png");
  await space(client, "keyUp");
  const faviconMisses = client.failures.filter(
    (failure) => failure.kind === "log" && failure.url?.endsWith("/favicon.ico"),
  );
  const gameFailures = client.failures.filter((failure) => !faviconMisses.includes(failure));
  if (gameFailures.length) throw new Error(`Browser failure during ejection capture: ${JSON.stringify(gameFailures)}`);
  const evidence = {
    schemaVersion: 1,
    marker: "war-battles-ejected-driver",
    scope: "packaged-chromium-webgl2-natural-offline-ejection-one-walk-and-fire-direction",
    bundleDirectory,
    onFoot,
    idle,
    moving,
    walk,
    fired,
    firing,
    faviconMisses: faviconMisses.length,
  };
  const evidencePath = resolve(outputDirectory, "war-battles-ejected-driver.json");
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(JSON.stringify({ evidencePath, ...evidence }));
} finally {
  await page.close();
}
