#!/usr/bin/env node
//
// Visual and keyboard playability gate for the packaged War Battles HTML5
// bundle. The marker-oriented runtime gate proves the scripted tutorial. This
// companion opens the same archive in Chrome, interrupts the tutorial with a
// real key event, verifies the arena engages before its idle timeout, inspects
// the WebGL context that Defold owns, samples the composed canvas, and retains
// one screenshot under build/evidence for human inspection.

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

const exampleRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(exampleRoot, "../..");
const bundleDirectory =
  process.env.DEHERM_WAR_BATTLES_WEB_BUNDLE ?? resolve(repositoryRoot, "build/bundle/War Battles");
const screenshotPath = resolve(
  process.env.DEHERM_WAR_BATTLES_SCREENSHOT ?? resolve(repositoryRoot, "build/evidence/war-battles-html5.png"),
);

async function evaluate(client, expression) {
  const result = await client.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  }
  return result.result.value;
}

async function key(client, { type, key: value, code, virtualKeyCode }) {
  await client.send("Input.dispatchKeyEvent", {
    type,
    key: value,
    code,
    windowsVirtualKeyCode: virtualKeyCode,
    nativeVirtualKeyCode: virtualKeyCode,
    ...(type === "keyDown" ? { text: value.length === 1 ? value : "" } : {}),
  });
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

  try {
    client.transcript.length = 0;
    client.failures.length = 0;
    const cleared = client.waitForEvent("Runtime.executionContextsCleared");
    const loaded = client.waitForEvent("Page.loadEventFired");
    await client.send("Page.reload", { ignoreCache: true });
    await cleared;
    await loaded;

    await waitFor(() => client.transcript.includes("war-battles:player-init:560.0:360.0"), {
      timeoutMs: 30_000,
      intervalMs: 100,
      what: "the player component to initialize",
    });

    const canvas = await evaluate(
      client,
      `(() => {
      const canvas = document.querySelector("canvas");
      if (!canvas) throw new Error("Defold did not create a canvas");
      canvas.tabIndex = 0;
      canvas.focus();
      return { focused: document.activeElement === canvas, width: canvas.width, height: canvas.height };
    })()`,
    );
    assert.equal(canvas.focused, true, "Defold canvas did not accept keyboard focus");
    assert.ok(canvas.width > 0 && canvas.height > 0, "Defold canvas has no drawable extent");

    const inputAt = Date.now();
    await key(client, { type: "keyDown", key: "w", code: "KeyW", virtualKeyCode: 87 });
    await waitFor(() => client.transcript.some((line) => line.startsWith("war-battles:arena-engaged:")), {
      timeoutMs: 3_000,
      intervalMs: 50,
      what: "keyboard input to engage the arena",
    });
    const inputToArenaMs = Date.now() - inputAt;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 600));
    await key(client, { type: "keyUp", key: "w", code: "KeyW", virtualKeyCode: 87 });

    // Exercise one weapon selection and one fire press after the arena owns the
    // player. The game continues rendering while these browser events cross
    // Defold's normal input stack into the generated TypeScript component.
    await key(client, { type: "keyDown", key: "3", code: "Digit3", virtualKeyCode: 51 });
    await key(client, { type: "keyUp", key: "3", code: "Digit3", virtualKeyCode: 51 });
    await key(client, { type: "keyDown", key: " ", code: "Space", virtualKeyCode: 32 });
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
    await key(client, { type: "keyUp", key: " ", code: "Space", virtualKeyCode: 32 });
    await waitFor(() => client.transcript.includes("war-battles:sfx:fire"), {
      timeoutMs: 3_000,
      intervalMs: 50,
      what: "the local fire event to play its generated sound",
    });

    await key(client, { type: "keyDown", key: "r", code: "KeyR", virtualKeyCode: 82 });
    // Keep the key down across several browser/engine frames. Sending down and
    // up back-to-back can leave both events in the Emscripten queue before
    // Defold samples input, which tests a zero-duration synthetic pulse rather
    // than the laptop-keyboard interaction this gate is meant to prove.
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    await key(client, { type: "keyUp", key: "r", code: "KeyR", virtualKeyCode: 82 });
    await waitFor(() => client.transcript.includes("war-battles:arena-restart:round=2"), {
      timeoutMs: 3_000,
      intervalMs: 50,
      what: "the public restart control to start round two",
    });
    await waitFor(() => client.transcript.includes("war-battles:sfx:round"), {
      timeoutMs: 3_000,
      intervalMs: 50,
      what: "the round restart cue to play",
    });
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));

    const graphics = await evaluate(
      client,
      `(() => {
      const canvas = document.querySelector("canvas");
      const gl = canvas?.getContext("webgl2") ?? canvas?.getContext("webgl");
      if (!canvas || !gl) return { available: false };
      const debug = gl.getExtension("WEBGL_debug_renderer_info");
      return {
        available: true,
        api: gl instanceof WebGL2RenderingContext ? "webgl2" : "webgl",
        version: gl.getParameter(gl.VERSION),
        shadingLanguageVersion: gl.getParameter(gl.SHADING_LANGUAGE_VERSION),
        vendor: debug ? gl.getParameter(debug.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
        renderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
        contextLost: gl.isContextLost(),
        canvas: { width: canvas.width, height: canvas.height },
        bounds: (() => {
          const bounds = canvas.getBoundingClientRect();
          return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
        })()
      };
    })()`,
    );
    assert.equal(graphics.available, true, "Defold canvas did not expose a WebGL context");
    assert.equal(graphics.contextLost, false, "Defold WebGL context is lost");
    assert.ok(graphics.bounds.width > 0 && graphics.bounds.height > 0, "Defold canvas has no visible bounds");

    const screenshot = await client.send("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: false,
      clip: { ...graphics.bounds, scale: 1 },
    });
    const screenshotBytes = Buffer.from(screenshot.data, "base64");
    await mkdir(dirname(screenshotPath), { recursive: true });
    await writeFile(screenshotPath, screenshotBytes);

    // WebGL is commonly created without preserveDrawingBuffer, so reading or
    // copying its default framebuffer after presentation may correctly yield a
    // cleared frame. Analyze Chrome's composed screenshot instead: those are
    // the pixels a player actually sees, including the Defold canvas and shell.
    graphics.compositedSample = await evaluate(
      client,
      `(async () => {
      const image = new Image();
      image.src = "data:image/png;base64,${screenshot.data}";
      await image.decode();
      const sample = document.createElement("canvas");
      sample.width = 80;
      sample.height = 50;
      const context = sample.getContext("2d", { willReadFrequently: true });
      context.imageSmoothingEnabled = false;
      context.drawImage(image, 0, 0, sample.width, sample.height);
      const pixels = context.getImageData(0, 0, sample.width, sample.height).data;
      const colours = new Set();
      let visiblePixels = 0;
      let brightPixels = 0;
      for (let offset = 0; offset < pixels.length; offset += 4) {
        const red = pixels[offset];
        const green = pixels[offset + 1];
        const blue = pixels[offset + 2];
        const alpha = pixels[offset + 3];
        if (alpha > 0) visiblePixels += 1;
        if (red + green + blue > 48) brightPixels += 1;
        colours.add(((red >> 4) << 8) | ((green >> 4) << 4) | (blue >> 4));
      }
      return {
        width: sample.width,
        height: sample.height,
        visiblePixels,
        brightPixels,
        colourBuckets: colours.size
      };
    })()`,
    );

    const fatal = client.failures.filter((failure) => !failure.url?.endsWith("/favicon.ico"));
    assert.ok(graphics.compositedSample.visiblePixels > 3_500, "Composited browser frame is unexpectedly transparent");
    assert.ok(graphics.compositedSample.brightPixels > 1_000, "Composited browser frame is unexpectedly black");
    assert.ok(graphics.compositedSample.colourBuckets > 24, "Composited browser frame lacks expected colour diversity");
    assert.ok(inputToArenaMs < 3_000, `Keyboard-to-arena latency was ${inputToArenaMs}ms`);
    assert.equal(
      client.transcript.some((line) => line.startsWith("war-battles:player-moved:")),
      false,
      "Arena engaged through the idle demonstration rather than keyboard input",
    );
    assert.deepEqual(fatal, [], `Browser page errors: ${JSON.stringify(fatal)}`);

    const report = {
      inputToArenaMs,
      graphics,
      screenshot: {
        path: screenshotPath,
        bytes: screenshotBytes.byteLength,
        sha256: createHash("sha256").update(screenshotBytes).digest("hex"),
      },
      arenaMarker: client.transcript.find((line) => line.startsWith("war-battles:arena-engaged:")),
      restartMarker: client.transcript.find((line) => line.startsWith("war-battles:arena-restart:")),
      soundMarkers: client.transcript.filter((line) => line.startsWith("war-battles:sfx:")),
    };
    console.log(`war-battles-browser-playability:ok:${JSON.stringify(report)}`);
    return report;
  } finally {
    await page.close();
  }
}

run().catch((error) => {
  console.error(error.stack ?? error.message);
  process.exitCode = 1;
});
