#!/usr/bin/env node
//
// Record a short, deterministic browser gameplay clip from the packaged
// War Battles HTML5 bundle. Chrome supplies composed frames over CDP and
// ffmpeg turns those frames into a broadly playable H.264 MP4. This is visual
// evidence for motion and presentation; the runtime/playability gates remain
// the machine assertions for correctness.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  defaultChromeBinary,
  freeLoopbackPort,
  openBundlePage,
  waitFor,
} from "../../../packages/cli/src/dev/browser-host.mjs";

const exampleRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(exampleRoot, "../..");
const bundleDirectory =
  process.env.DEHERM_WAR_BATTLES_WEB_BUNDLE ?? resolve(repositoryRoot, "build/bundle/War Battles");
const outputPath = resolve(
  process.env.DEHERM_WAR_BATTLES_VIDEO ?? resolve(repositoryRoot, "build/evidence/war-battles-gameplay.mp4"),
);
const frameRate = 30;

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

function runFfmpeg(frameDirectory, capturedFps) {
  return new Promise((done, failed) => {
    const child = spawn(
      process.env.FFMPEG ?? "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-framerate",
        capturedFps.toFixed(3),
        "-start_number",
        "1",
        "-i",
        resolve(frameDirectory, "frame-%06d.jpg"),
        "-vf",
        "scale=trunc(iw/2)*2:trunc(ih/2)*2",
        "-c:v",
        "libx264",
        "-preset",
        "medium",
        "-crf",
        "20",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        "-r",
        String(frameRate),
        outputPath,
      ],
      { stdio: ["ignore", "inherit", "inherit"] },
    );
    child.once("error", failed);
    child.once("exit", (code, signal) => {
      if (code === 0) done();
      else failed(new Error(`ffmpeg exited ${code ?? signal}`));
    });
  });
}

async function run() {
  const frameDirectory = await mkdtemp(resolve(tmpdir(), "war-battles-video."));
  const page = await openBundlePage({
    bundleDirectory,
    port: await freeLoopbackPort(),
    debuggingPort: await freeLoopbackPort(),
    chromeBinary: process.env.DEHERM_CHROME ?? defaultChromeBinary,
    retain: true,
  });
  const { client } = page;
  const frameBuffers = [];
  let recording = false;
  const removeFrameListener = client.onEvent("Page.screencastFrame", ({ data, sessionId }) => {
    // ACK immediately so Chrome's compositor never waits on filesystem I/O.
    void client.send("Page.screencastFrameAck", { sessionId }, { timeoutMs: 1_000 }).catch(() => {});
    if (recording) frameBuffers.push(Buffer.from(data, "base64"));
  });

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

    recording = true;
    const captureStartedAt = Date.now();
    // Chrome 154's headless compositor starts delivering frames but does not
    // always answer this command while a SwiftShader WebGL canvas is active.
    // Bound the response independently; the first-frame event is authoritative
    // evidence that capture actually started.
    void client
      .send(
        "Page.startScreencast",
        { format: "jpeg", quality: 90, maxWidth: 960, maxHeight: 540, everyNthFrame: 1 },
        { timeoutMs: 2_000 },
      )
      .catch(() => {});
    await waitFor(() => frameBuffers.length > 0, {
      timeoutMs: 3_000,
      intervalMs: 25,
      what: "the first Chrome compositor video frame",
    });
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

    recording = false;
    await client.send("Page.stopScreencast", {}, { timeoutMs: 2_000 }).catch(() => {});
    const captureSeconds = (Date.now() - captureStartedAt) / 1_000;
    const capturedFps = frameBuffers.length / captureSeconds;
    assert.ok(frameBuffers.length >= 90, `Gameplay recording captured only ${frameBuffers.length} frames`);
    assert.ok(capturedFps >= 12, `Gameplay recording captured only ${capturedFps.toFixed(2)} frames per second`);
    const fatal = client.failures.filter((failure) => !failure.url?.endsWith("/favicon.ico"));
    assert.deepEqual(fatal, [], `Browser page errors: ${JSON.stringify(fatal)}`);

    await mkdir(dirname(outputPath), { recursive: true });
    await Promise.all(
      frameBuffers.map((bytes, index) =>
        writeFile(resolve(frameDirectory, `frame-${String(index + 1).padStart(6, "0")}.jpg`), bytes),
      ),
    );
    await runFfmpeg(frameDirectory, capturedFps);
    const bytes = await readFile(outputPath);
    const report = {
      path: outputPath,
      bytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      frames: frameBuffers.length,
      capturedFps: Number(capturedFps.toFixed(2)),
      encodedFps: frameRate,
      encodedSeconds: Number(captureSeconds.toFixed(2)),
      arenaMarker: client.transcript.find((line) => line.startsWith("war-battles:arena-engaged:")),
      fireEvents: client.transcript.filter((line) => line === "war-battles:sfx:fire").length,
    };
    console.log(`war-battles-browser-video:ok:${JSON.stringify(report)}`);
    return report;
  } finally {
    recording = false;
    removeFrameListener();
    await page.close();
    await rm(frameDirectory, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error(error.stack ?? error.message);
  process.exitCode = 1;
});
