#!/usr/bin/env node
/** Packaged HTML5 two-thumb input smoke through Defold's real touch binding. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  defaultChromeBinary,
  freeLoopbackPort,
  openBundlePage,
  waitFor,
} from "../../../packages/cli/src/dev/browser-host.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const bundleDirectory = process.env.DEHERM_WAR_BATTLES_WEB_BUNDLE ?? resolve(root, "build/bundle/War Battles");
const screenshotPath = resolve(
  process.env.DEHERM_WAR_BATTLES_TOUCH_SCREENSHOT ?? resolve(root, "build/evidence/war-battles-touch-html5.png"),
);
const viewport = process.env.DEHERM_WAR_BATTLES_TOUCH_VIEWPORT ?? "1280x720";
const viewportMatch = viewport.match(/^(\d{3,4})x(\d{3,4})$/u);
if (!viewportMatch) throw new Error("DEHERM_WAR_BATTLES_TOUCH_VIEWPORT must be WIDTHxHEIGHT");

async function evaluate(client, expression) {
  const result = await client.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails)
    throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  return result.result.value;
}

const point = (id, x, y) => ({ id, x, y, radiusX: 10, radiusY: 10, force: 1 });
const cameraTarget = (line) => {
  const match = line?.match(/:target=(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?):lead=/u);
  assert.ok(match, `Missing camera target in ${line}`);
  return [Number(match[1]), Number(match[2])];
};

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
    width: Number(viewportMatch[1]),
    height: Number(viewportMatch[2]),
    deviceScaleFactor: 1,
    mobile: true,
  });
  await client.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 2 });
  client.transcript.length = 0;
  client.failures.length = 0;
  const cleared = client.waitForEvent("Runtime.executionContextsCleared");
  const loaded = client.waitForEvent("Page.loadEventFired");
  await client.send("Page.reload", { ignoreCache: true });
  await cleared;
  await loaded;
  await waitFor(() => client.transcript.some((line) => line.startsWith("war-battles:player-init:")), {
    timeoutMs: 30_000,
    intervalMs: 100,
    what: "touch-enabled player initialization",
  });
  const bounds = await evaluate(
    client,
    `(() => { const r = document.querySelector("canvas").getBoundingClientRect(); return { x:r.x, y:r.y, width:r.width, height:r.height }; })()`,
  );
  const left = point(1, bounds.x + bounds.width * 0.23, bounds.y + bounds.height * 0.68);
  const right = point(2, bounds.x + bounds.width * 0.77, bounds.y + bounds.height * 0.68);
  await client.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [left, right] });
  try {
    await waitFor(() => client.transcript.some((line) => line.startsWith("war-battles:arena-engaged:")), {
      timeoutMs: 3_000,
      intervalMs: 50,
      what: "multi-touch to engage the arena",
    });
  } catch (error) {
    throw new Error(
      `${error.message}: ${JSON.stringify({ transcript: client.transcript.slice(-30), failures: client.failures })}`,
    );
  }
  await waitFor(() => client.transcript.filter((line) => line.startsWith("war-battles:camera:")).length >= 2, {
    timeoutMs: 4_000,
    intervalMs: 50,
    what: "two stationary local-player camera samples before thumb movement",
  });
  const cameraBeforeSamples = client.transcript.filter((line) => line.startsWith("war-battles:camera:"));
  const cameraBefore = cameraBeforeSamples.at(-1);
  const [idleX, idleY] = cameraTarget(cameraBeforeSamples.at(-2));
  const [beforeX, beforeY] = cameraTarget(cameraBefore);
  const idleDistance = Math.hypot(beforeX - idleX, beforeY - idleY);
  // Firing and nearby AI can nudge the local body a few units even before
  // the left stick moves; the driven displacement must dominate that baseline.
  assert.ok(
    idleDistance < 20,
    `Local tank moved too far before left-thumb drive: ${cameraBeforeSamples.slice(-2).join(" -> ")}`,
  );
  const cameraSamplesBefore = cameraBeforeSamples.length;
  await client.send("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: [point(1, left.x + 72, left.y - 12), point(2, right.x - 80, right.y - 45)],
  });
  try {
    await waitFor(() => client.transcript.includes("war-battles:sfx:fire"), {
      timeoutMs: 3_000,
      intervalMs: 50,
      what: "right-thumb fire through Defold input",
    });
  } catch (error) {
    throw new Error(
      `${error.message}: ${JSON.stringify({ first: client.transcript.filter((line) => line.startsWith("war-battles:touch-first:")).slice(0, 3), transcript: client.transcript.slice(-15), failures: client.failures })}`,
    );
  }
  await waitFor(
    () => client.transcript.filter((line) => line.startsWith("war-battles:camera:")).length > cameraSamplesBefore,
    { timeoutMs: 3_000, intervalMs: 50, what: "a camera sample after left-thumb driving" },
  );
  const cameraAfter = client.transcript.filter((line) => line.startsWith("war-battles:camera:")).at(-1);
  const [afterX, afterY] = cameraTarget(cameraAfter);
  const driveDistance = Math.hypot(afterX - beforeX, afterY - beforeY);
  assert.ok(
    driveDistance > Math.max(20, idleDistance * 3),
    `Left-thumb drive did not move the local tank: ${cameraBefore} -> ${cameraAfter}`,
  );
  const screenshot = await client.send("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
    captureBeyondViewport: false,
    clip: { ...bounds, scale: 1 },
  });
  const bytes = Buffer.from(screenshot.data, "base64");
  await mkdir(dirname(screenshotPath), { recursive: true });
  await writeFile(screenshotPath, bytes);
  await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  const fatal = client.failures.filter((failure) => !failure.url?.endsWith("/favicon.ico"));
  assert.deepEqual(fatal, []);
  console.log(
    `war-battles-browser-touch:ok:${JSON.stringify({
      arena: client.transcript.find((line) => line.startsWith("war-battles:arena-engaged:")),
      fire: client.transcript.filter((line) => line === "war-battles:sfx:fire").length,
      idleDistance,
      driveDistance,
      viewport,
      screenshot: screenshotPath,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    })}`,
  );
} finally {
  await page.close();
}
