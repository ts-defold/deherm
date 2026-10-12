#!/usr/bin/env node
//
// Record a short, deterministic browser gameplay clip from the packaged
// War Battles HTML5 bundle. Chrome supplies composed frames over CDP and
// ffmpeg turns those frames into a broadly playable H.264 MP4. This is visual
// evidence for motion and presentation; the runtime/playability gates remain
// the machine assertions for correctness.

import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  defaultChromeBinary,
  freeLoopbackPort,
  openBundlePage,
  waitFor,
} from "../../../packages/cli/src/dev/browser-host.mjs";
import { startBrowserVideo } from "./browser-video.mjs";

const exampleRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(exampleRoot, "../..");
const bundleDirectory =
  process.env.DEHERM_WAR_BATTLES_WEB_BUNDLE ?? resolve(repositoryRoot, "build/bundle/War Battles");
const outputPath = resolve(
  process.env.DEHERM_WAR_BATTLES_VIDEO ?? resolve(repositoryRoot, "build/evidence/war-battles-gameplay.mp4"),
);

const sleep = (durationMs) => new Promise((done) => setTimeout(done, durationMs));

async function key(client, { type, key: value, code, virtualKeyCode }) {
  // Chrome's headless screencast stream can delay command acknowledgements
  // even though it dispatches the input. The gameplay markers below verify
  // delivery, so keep the command response bounded and the recording moving.
  void client
    .send(
      "Input.dispatchKeyEvent",
      {
        type,
        key: value,
        code,
        windowsVirtualKeyCode: virtualKeyCode,
        nativeVirtualKeyCode: virtualKeyCode,
        ...(type === "keyDown" ? { text: value.length === 1 ? value : "" } : {}),
      },
      { timeoutMs: 1_000 },
    )
    .catch(() => {});
}

async function hold(client, keys, durationMs) {
  for (const input of keys) await key(client, { type: "keyDown", ...input });
  await sleep(durationMs);
  for (const input of keys.toReversed()) await key(client, { type: "keyUp", ...input });
}

async function run() {
  const page = await openBundlePage({
    bundleDirectory,
    port: await freeLoopbackPort(),
    debuggingPort: await freeLoopbackPort(),
    chromeBinary: process.env.DEHERM_CHROME ?? defaultChromeBinary,
    retain: true,
  });
  const { client } = page;
  let video;

  try {
    await waitFor(() => client.transcript.some((line) => line.startsWith("war-battles:player-init:")), {
      timeoutMs: 30_000,
      intervalMs: 100,
      what: "the packaged player component",
    });
    await client.send("Runtime.evaluate", {
      expression: `(() => {
        const canvas = document.querySelector("canvas");
        if (!canvas) throw new Error("Defold did not create a canvas");
        canvas.tabIndex = 0;
        canvas.focus();
      })()`,
    });

    video = await startBrowserVideo(client, outputPath);
    await sleep(500);

    const forward = { key: "w", code: "KeyW", virtualKeyCode: 87 };
    const left = { key: "a", code: "KeyA", virtualKeyCode: 65 };
    const right = { key: "d", code: "KeyD", virtualKeyCode: 68 };
    const fire = { key: " ", code: "Space", virtualKeyCode: 32 };

    await hold(client, [forward], 900);
    await waitFor(() => client.transcript.some((line) => line.startsWith("war-battles:arena-engaged:")), {
      timeoutMs: 3_000,
      intervalMs: 50,
      what: "keyboard input to engage the arena",
    });
    await hold(client, [forward, right], 1_300);
    await hold(client, [forward], 900);
    await hold(client, [fire], 180);
    await hold(client, [forward, left], 1_300);
    await hold(client, [fire], 180);
    await hold(client, [forward], 900);
    await sleep(900);

    const recording = await video.stop();
    const fatal = client.failures.filter((failure) => !failure.url?.endsWith("/favicon.ico"));
    assert.deepEqual(fatal, [], `Browser page errors: ${JSON.stringify(fatal)}`);
    const report = {
      ...recording,
      arenaMarker: client.transcript.find((line) => line.startsWith("war-battles:arena-engaged:")),
      fireEvents: client.transcript.filter((line) => line === "war-battles:sfx:fire").length,
    };
    console.log(`war-battles-browser-video:ok:${JSON.stringify(report)}`);
    return report;
  } finally {
    await video?.abort();
    await page.close();
  }
}

run().catch((error) => {
  console.error(error.stack ?? error.message);
  process.exitCode = 1;
});
