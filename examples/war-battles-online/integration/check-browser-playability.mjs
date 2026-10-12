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
import { decodeRgbaPng } from "../tools/generate-world-art.mjs";

const exampleRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(exampleRoot, "../..");
const bundleDirectory =
  process.env.DEHERM_WAR_BATTLES_WEB_BUNDLE ?? resolve(repositoryRoot, "build/bundle/War Battles");
const screenshotPath = resolve(
  process.env.DEHERM_WAR_BATTLES_SCREENSHOT ?? resolve(repositoryRoot, "build/evidence/war-battles-html5.png"),
);
const titleScreenshotPath = resolve(
  process.env.DEHERM_WAR_BATTLES_TITLE_SCREENSHOT ??
    resolve(repositoryRoot, "build/evidence/war-battles-title-html5.png"),
);
const scoreboardScreenshotPath = resolve(repositoryRoot, "build/evidence/war-battles-scoreboard-html5.png");
const portraitScreenshotPath = resolve(repositoryRoot, "build/evidence/war-battles-portrait-html5.png");
const viewportOption = process.env.DEHERM_WAR_BATTLES_VIEWPORT;
const viewportMatch = viewportOption?.match(/^(\d{3,4})x(\d{3,4})$/);
if (viewportOption && !viewportMatch) {
  throw new Error("DEHERM_WAR_BATTLES_VIEWPORT must be WIDTHxHEIGHT, for example 1280x720");
}
const TANK_FRAME_HALF_WIDTH = 64;
const TANK_FRAME_HALF_HEIGHT = 64;
const HUD_TOP_SAFE_PIXELS = 96;
const HUD_BOTTOM_SAFE_PIXELS = 76;

function parseCameraSnap(marker) {
  const match =
    /^war-battles:camera-snap:player=(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?):view=(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?):extent=(\d+(?:\.\d+)?),(\d+(?:\.\d+)?)$/.exec(
      marker,
    );
  assert.ok(match, `Malformed camera snap marker: ${marker}`);
  return {
    playerX: Number(match[1]),
    playerY: Number(match[2]),
    viewX: Number(match[3]),
    viewY: Number(match[4]),
    halfWidth: Number(match[5]),
    halfHeight: Number(match[6]),
  };
}

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
    if (viewportMatch) {
      await client.send("Emulation.setDeviceMetricsOverride", {
        width: Number(viewportMatch[1]),
        height: Number(viewportMatch[2]),
        deviceScaleFactor: 1,
        mobile: false,
      });
    }
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
      what: "the player component to initialize",
    });

    const canvas = await evaluate(
      client,
      `(() => {
      const canvas = document.querySelector("canvas");
      if (!canvas) throw new Error("Defold did not create a canvas");
      canvas.tabIndex = 0;
      canvas.focus();
      const bounds = canvas.getBoundingClientRect();
      return {
        focused: document.activeElement === canvas,
        width: canvas.width,
        height: canvas.height,
        bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
        viewport: { width: window.innerWidth, height: window.innerHeight },
        shellText: document.body.innerText,
        shellBackground: getComputedStyle(document.documentElement).backgroundColor,
        portraitPrompt: getComputedStyle(document.querySelector(".canvas-app-container"), "::after").content,
        canvasVisibility: getComputedStyle(document.querySelector("#canvas-container")).visibility
      };
    })()`,
    );
    assert.ok(canvas.width > 0 && canvas.height > 0, "Defold canvas has no drawable extent");
    assert.ok(canvas.bounds.width > 0 && canvas.bounds.height > 0, "Defold title canvas has no visible bounds");
    const fitScale = Math.min(canvas.viewport.width / canvas.width, canvas.viewport.height / canvas.height);
    assert.ok(
      canvas.bounds.width >= canvas.width * fitScale * 0.94 && canvas.bounds.height >= canvas.height * fitScale * 0.94,
      `Defold canvas occupies too little of the browser viewport: ${JSON.stringify(canvas)}`,
    );
    assert.ok(!/Made with Defold|Fullscreen/u.test(canvas.shellText), "Default Defold footer obscures the game");
    assert.notEqual(canvas.shellBackground, "rgb(255, 255, 255)", "HTML5 shell has a white background");

    if (canvas.viewport.height > canvas.viewport.width && canvas.viewport.width <= 700) {
      assert.equal(canvas.canvasVisibility, "hidden", "Portrait phone still exposes an unreadably small game canvas");
      assert.match(canvas.portraitPrompt, /ROTATE TO LANDSCAPE TO PLAY/u);
      const portraitScreenshot = await client.send("Page.captureScreenshot", {
        format: "png",
        fromSurface: true,
        captureBeyondViewport: false,
      });
      const portraitBytes = Buffer.from(portraitScreenshot.data, "base64");
      await mkdir(dirname(portraitScreenshotPath), { recursive: true });
      await writeFile(portraitScreenshotPath, portraitBytes);
      // Rotation must restore the actual game in this same browser session;
      // a portrait-only screenshot cannot establish that media-query exit.
      await client.send("Emulation.setDeviceMetricsOverride", {
        width: 844,
        height: 390,
        deviceScaleFactor: 1,
        mobile: false,
      });
      const rotated = await evaluate(
        client,
        `(() => ({
          canvasVisibility: getComputedStyle(document.querySelector("#canvas-container")).visibility,
          prompt: getComputedStyle(document.querySelector(".canvas-app-container"), "::after").content,
          bounds: (() => { const r = document.querySelector("canvas").getBoundingClientRect(); return { width: r.width, height: r.height }; })()
        }))()`,
      );
      assert.equal(rotated.canvasVisibility, "visible", "Game canvas did not return after landscape rotation");
      assert.equal(rotated.prompt, "none", "Portrait guidance remained over the landscape game");
      assert.ok(rotated.bounds.width > 600 && rotated.bounds.height > 300, "Rotated game canvas stayed tiny");
      const report = {
        viewport: canvas.viewport,
        orientationRequired: "landscape",
        landscapeRestored: rotated.bounds,
        screenshot: {
          path: portraitScreenshotPath,
          sha256: createHash("sha256").update(portraitBytes).digest("hex"),
        },
      };
      console.log(`war-battles-browser-portrait-guidance:ok:${JSON.stringify(report)}`);
      return report;
    }
    assert.equal(canvas.focused, true, "Defold canvas did not accept keyboard focus");

    const titleScreenshot = await client.send("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: false,
      clip: { ...canvas.bounds, scale: 1 },
    });
    const titleScreenshotBytes = Buffer.from(titleScreenshot.data, "base64");
    assert.ok(titleScreenshotBytes.byteLength > 1_024, "Defold title screenshot is unexpectedly empty");
    await mkdir(dirname(titleScreenshotPath), { recursive: true });
    await writeFile(titleScreenshotPath, titleScreenshotBytes);

    const inputAt = Date.now();
    await key(client, { type: "keyDown", key: "w", code: "KeyW", virtualKeyCode: 87 });
    await waitFor(() => client.transcript.some((line) => line.startsWith("war-battles:arena-engaged:")), {
      timeoutMs: 3_000,
      intervalMs: 50,
      what: "keyboard input to engage the arena",
    });
    await waitFor(() => client.transcript.some((line) => line.startsWith("war-battles:camera-snap:")), {
      timeoutMs: 3_000,
      intervalMs: 50,
      what: "the camera to frame the authoritative local tank",
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

    const cameraSnapsBeforeRestart = client.transcript.filter((line) =>
      line.startsWith("war-battles:camera-snap:"),
    ).length;
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
    await waitFor(
      () =>
        client.transcript.filter((line) => line.startsWith("war-battles:camera-snap:")).length >
        cameraSnapsBeforeRestart,
      {
        timeoutMs: 3_000,
        intervalMs: 50,
        what: "the camera to reframe the local tank after restart",
      },
    );
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

    // The expanded roster must be reachable without leaving a large opaque
    // panel over active play. Exercise the real GUI input focus and Tab binding
    // rather than inferring visibility solely from the authored .gui file.
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
    await key(client, { type: "keyDown", key: "Tab", code: "Tab", virtualKeyCode: 9 });
    try {
      await waitFor(() => client.transcript.includes("war-battles:scoreboard:visible=1"), {
        timeoutMs: 5_000,
        intervalMs: 50,
        what: "Tab to expand the in-game scoreboard",
      });
    } catch (error) {
      const focus = await evaluate(client, "document.activeElement?.tagName ?? 'none'");
      throw new Error(`${error.message}; focus=${focus}; recent=${client.transcript.slice(-12).join(" | ")}`);
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 120));
    const scoreboardScreenshot = await client.send("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: false,
      clip: { ...graphics.bounds, scale: 1 },
    });
    const scoreboardBytes = Buffer.from(scoreboardScreenshot.data, "base64");
    await writeFile(scoreboardScreenshotPath, scoreboardBytes);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
    await key(client, { type: "keyUp", key: "Tab", code: "Tab", virtualKeyCode: 9 });
    await evaluate(client, "document.activeElement?.tagName ?? 'none'");
    try {
      await waitFor(() => client.transcript.includes("war-battles:scoreboard:visible=0"), {
        timeoutMs: 5_000,
        intervalMs: 50,
        what: "releasing Tab to restore the unobstructed battlefield",
      });
    } catch (error) {
      const focus = await evaluate(client, "document.activeElement?.tagName ?? 'none'");
      throw new Error(`${error.message}; focus=${focus}; recent=${client.transcript.slice(-12).join(" | ")}`);
    }
    const collapsedImage = decodeRgbaPng(screenshotBytes);
    const expandedImage = decodeRgbaPng(scoreboardBytes);
    assert.deepEqual([collapsedImage.width, collapsedImage.height], [expandedImage.width, expandedImage.height]);
    let changedScoreboardPixels = 0;
    for (let y = 20; y < Math.min(170, collapsedImage.height); y += 1) {
      for (let x = Math.max(0, collapsedImage.width - 245); x < collapsedImage.width - 20; x += 1) {
        const pixel = (y * collapsedImage.width + x) * 4;
        if (
          Math.abs(collapsedImage.pixels[pixel] - expandedImage.pixels[pixel]) > 24 ||
          Math.abs(collapsedImage.pixels[pixel + 1] - expandedImage.pixels[pixel + 1]) > 24 ||
          Math.abs(collapsedImage.pixels[pixel + 2] - expandedImage.pixels[pixel + 2]) > 24
        ) {
          changedScoreboardPixels += 1;
        }
      }
    }
    const minimumChangedScoreboardPixels = Math.max(
      1_000,
      Math.round(collapsedImage.width * collapsedImage.height * 0.01),
    );
    assert.ok(
      changedScoreboardPixels > minimumChangedScoreboardPixels,
      `scoreboard did not visibly change its panel: ${changedScoreboardPixels}`,
    );

    // The center ribbon is the pointer/touch affordance. Exercise its actual
    // GUI hit test in the packaged engine, not only the Tab binding.
    const pointerOpenCount = client.transcript.filter((line) => line === "war-battles:scoreboard:visible=1").length;
    const ribbonX = graphics.bounds.x + graphics.bounds.width / 2;
    // The GUI's leader_back is y=680..712 in its authored 720-pixel space,
    // so its centre is 24 logical pixels below the top. CDP wants CSS pixels:
    // a fixed 24px click misses the ribbon when the canvas is scaled down.
    const ribbonY = graphics.bounds.y + (graphics.bounds.height * 24) / 720;
    // Defold samples pointer position from movement packets. A synthetic CDP
    // press alone can retain the HID's initial (0, 0) position.
    await client.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: ribbonX,
      y: ribbonY,
      button: "none",
    });
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 400));
    await client.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: ribbonX,
      y: ribbonY,
      button: "left",
      clickCount: 1,
    });
    // A down/up pair in the same engine frame can collapse before Defold's
    // input poll, just like a zero-duration synthetic key press.
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 120));
    await client.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: ribbonX,
      y: ribbonY,
      button: "left",
      clickCount: 1,
    });
    await evaluate(client, "document.activeElement?.tagName ?? 'none'");
    try {
      await waitFor(
        () => client.transcript.filter((line) => line === "war-battles:scoreboard:visible=1").length > pointerOpenCount,
        { timeoutMs: 5_000, intervalMs: 50, what: "clicking the leader ribbon to expand the scoreboard" },
      );
    } catch (error) {
      const target = await evaluate(
        client,
        `(() => { const node = document.elementFromPoint(${ribbonX}, ${ribbonY}); return { tag: node?.tagName, id: node?.id, focused: document.activeElement?.tagName }; })()`,
      );
      throw new Error(
        `${error.message}; pointer=${JSON.stringify({ x: ribbonX, y: ribbonY, bounds: graphics.bounds })}; target=${JSON.stringify(target)}; recent=${client.transcript.slice(-14).join(" | ")}; failures=${JSON.stringify(client.failures.slice(-4))}`,
      );
    }
    const touchCloseCount = client.transcript.filter((line) => line === "war-battles:scoreboard:visible=0").length;
    await client.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
    await client.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: ribbonX, y: ribbonY, id: 1 }],
    });
    await waitFor(
      () => client.transcript.filter((line) => line === "war-battles:scoreboard:visible=0").length > touchCloseCount,
      { timeoutMs: 5_000, intervalMs: 50, what: "touching the leader ribbon to collapse the scoreboard" },
    );
    // Holding a finger over the ribbon must not repeatedly toggle it while
    // the touch remains active.
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 400));
    assert.equal(
      client.transcript.filter((line) => line.startsWith("war-battles:scoreboard:visible=")).at(-1),
      "war-battles:scoreboard:visible=0",
      "held touch repeatedly toggled the scoreboard",
    );
    await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
    assert.equal(
      client.transcript.filter((line) => line.startsWith("war-battles:scoreboard:visible=")).at(-1),
      "war-battles:scoreboard:visible=0",
      `touch release unexpectedly reopened the scoreboard; recent=${client.transcript
        .filter((line) => line.startsWith("war-battles:scoreboard:"))
        .slice(-30)
        .join(" | ")}`,
    );
    const touchReopenCount = client.transcript.filter((line) => line === "war-battles:scoreboard:visible=1").length;
    await client.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: ribbonX, y: ribbonY, id: 2 }],
    });
    await waitFor(
      () => client.transcript.filter((line) => line === "war-battles:scoreboard:visible=1").length > touchReopenCount,
      { timeoutMs: 5_000, intervalMs: 50, what: "second touch reopening the scoreboard" },
    );
    await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
    assert.equal(
      client.transcript.filter((line) => line.startsWith("war-battles:scoreboard:visible=")).at(-1),
      "war-battles:scoreboard:visible=1",
      "second touch release unexpectedly collapsed the scoreboard",
    );
    await client.send("Emulation.setTouchEmulationEnabled", { enabled: false });

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
    const cameraSnapMarker = client.transcript.filter((line) => line.startsWith("war-battles:camera-snap:")).at(-1);
    assert.ok(cameraSnapMarker, "No authoritative camera framing marker was emitted");
    const cameraSnap = parseCameraSnap(cameraSnapMarker);
    const screenScaleX = graphics.canvas.width / (cameraSnap.halfWidth * 2);
    const screenScaleY = graphics.canvas.height / (cameraSnap.halfHeight * 2);
    const tankFrame = {
      left:
        graphics.canvas.width / 2 +
        (cameraSnap.playerX - cameraSnap.viewX) * screenScaleX -
        TANK_FRAME_HALF_WIDTH * screenScaleX,
      right:
        graphics.canvas.width / 2 +
        (cameraSnap.playerX - cameraSnap.viewX) * screenScaleX +
        TANK_FRAME_HALF_WIDTH * screenScaleX,
      top:
        graphics.canvas.height / 2 -
        (cameraSnap.playerY - cameraSnap.viewY) * screenScaleY -
        TANK_FRAME_HALF_HEIGHT * screenScaleY,
      bottom:
        graphics.canvas.height / 2 -
        (cameraSnap.playerY - cameraSnap.viewY) * screenScaleY +
        TANK_FRAME_HALF_HEIGHT * screenScaleY,
    };
    assert.ok(tankFrame.left >= 0 && tankFrame.right <= graphics.canvas.width, "Local tank is clipped horizontally");
    assert.ok(
      tankFrame.top >= HUD_TOP_SAFE_PIXELS,
      `Local tank is hidden behind the upper HUD: ${JSON.stringify(tankFrame)}`,
    );
    assert.ok(
      tankFrame.bottom <= graphics.canvas.height - HUD_BOTTOM_SAFE_PIXELS,
      `Local tank is hidden behind the lower HUD: ${JSON.stringify(tankFrame)}`,
    );
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
      scoreboard: {
        path: scoreboardScreenshotPath,
        bytes: scoreboardBytes.byteLength,
        sha256: createHash("sha256").update(scoreboardBytes).digest("hex"),
        changedPixels: changedScoreboardPixels,
        inputPaths: ["keyboard", "pointer", "emulated-touch"],
      },
      titleScreenshot: {
        path: titleScreenshotPath,
        bytes: titleScreenshotBytes.byteLength,
        sha256: createHash("sha256").update(titleScreenshotBytes).digest("hex"),
      },
      arenaMarker: client.transcript.find((line) => line.startsWith("war-battles:arena-engaged:")),
      restartMarker: client.transcript.find((line) => line.startsWith("war-battles:arena-restart:")),
      cameraSnap,
      cameraTrace: client.transcript.filter((line) => line.startsWith("war-battles:camera:")).slice(-4),
      tankFrame,
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
