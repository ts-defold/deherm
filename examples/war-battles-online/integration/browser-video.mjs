// Capture a real packaged Chromium compositor stream and encode it to a
// playable H.264 artifact. This is visual evidence, not a timing benchmark:
// screencast collection itself can perturb the game loop.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { waitFor } from "../../../packages/cli/src/dev/browser-host.mjs";

const ENCODED_FRAMES_PER_SECOND = 30;
const MAX_CAPTURED_FRAMES = 2_400;

function encodeFrames(directory, outputPath, capturedFps) {
  return new Promise((resolve, reject) => {
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
        join(directory, "frame-%06d.jpg"),
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
        String(ENCODED_FRAMES_PER_SECOND),
        outputPath,
      ],
      { stdio: ["ignore", "inherit", "inherit"] },
    );
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code ?? signal}`));
    });
  });
}

/** Start recording after the packaged page has entered the desired state. */
export async function startBrowserVideo(client, outputPath, options = {}) {
  const frames = [];
  let recording = true;
  let stopped = false;
  const removeFrameListener = client.onEvent("Page.screencastFrame", ({ data, sessionId }) => {
    // ACK before touching disk so the compositor never waits on filesystem I/O.
    void client.send("Page.screencastFrameAck", { sessionId }, { timeoutMs: 1_000 }).catch(() => {});
    if (recording && frames.length < MAX_CAPTURED_FRAMES) frames.push(Buffer.from(data, "base64"));
  });
  const captureStartedAt = Date.now();
  try {
    // Some headless Chrome/WebGL builds dispatch frames but do not answer the
    // command promptly. A real first frame, not command ACK, starts evidence.
    void client
      .send(
        "Page.startScreencast",
        {
          format: "jpeg",
          quality: 90,
          maxWidth: options.maxWidth ?? 960,
          maxHeight: options.maxHeight ?? 540,
          everyNthFrame: 1,
        },
        { timeoutMs: 2_000 },
      )
      .catch(() => {});
    await waitFor(() => frames.length > 0, {
      timeoutMs: 3_000,
      intervalMs: 25,
      what: "the first Chrome compositor video frame",
    });
  } catch (error) {
    recording = false;
    removeFrameListener();
    await client.send("Page.stopScreencast", {}, { timeoutMs: 2_000 }).catch(() => {});
    throw error;
  }

  const abort = async () => {
    if (stopped) return;
    stopped = true;
    recording = false;
    removeFrameListener();
    await client.send("Page.stopScreencast", {}, { timeoutMs: 2_000 }).catch(() => {});
  };
  return {
    abort,
    async stop() {
      const captureSeconds = (Date.now() - captureStartedAt) / 1_000;
      await abort();
      const capturedFps = frames.length / captureSeconds;
      assert.ok(frames.length >= (options.minimumFrames ?? 90), `Captured only ${frames.length} video frames`);
      assert.ok(capturedFps >= (options.minimumFps ?? 12), `Captured only ${capturedFps.toFixed(2)} frames/s`);
      assert.ok(frames.length < MAX_CAPTURED_FRAMES, "Video frame cap reached before capture ended");
      const frameDirectory = await mkdtemp(join(tmpdir(), "war-battles-video."));
      try {
        await mkdir(dirname(outputPath), { recursive: true });
        for (let offset = 0; offset < frames.length; offset += 64) {
          await Promise.all(
            frames
              .slice(offset, offset + 64)
              .map((bytes, index) =>
                writeFile(join(frameDirectory, `frame-${String(offset + index + 1).padStart(6, "0")}.jpg`), bytes),
              ),
          );
        }
        await encodeFrames(frameDirectory, outputPath, capturedFps);
        const bytes = await readFile(outputPath);
        return {
          path: outputPath,
          bytes: bytes.byteLength,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          frames: frames.length,
          capturedFps: Number(capturedFps.toFixed(2)),
          encodedFps: ENCODED_FRAMES_PER_SECOND,
          encodedSeconds: Number(captureSeconds.toFixed(2)),
        };
      } finally {
        await rm(frameDirectory, { recursive: true, force: true });
      }
    },
  };
}
