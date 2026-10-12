#!/usr/bin/env node

import assert from "node:assert/strict";
import { resolve } from "node:path";

import {
  defaultChromeBinary,
  freeLoopbackPort,
  openBundlePage,
  waitFor,
} from "../../../packages/cli/src/dev/browser-host.mjs";
import { decodeRgbaPng } from "../tools/generate-world-art.mjs";

const exampleRoot = resolve(import.meta.dirname, "..");
const bundleDirectory = resolve(exampleRoot, "../../build/bundle/War Battles");
const page = await openBundlePage({
  bundleDirectory,
  port: await freeLoopbackPort(),
  debuggingPort: await freeLoopbackPort(),
  chromeBinary: defaultChromeBinary,
  retain: true,
});

function changedPixels(before, after, { x, y, width, height }) {
  let changed = 0;
  for (let row = y; row < y + height; row += 1) {
    for (let column = x; column < x + width; column += 1) {
      const offset = (row * before.width + column) * 4;
      if (
        before.pixels[offset] !== after.pixels[offset] ||
        before.pixels[offset + 1] !== after.pixels[offset + 1] ||
        before.pixels[offset + 2] !== after.pixels[offset + 2]
      ) {
        changed += 1;
      }
    }
  }
  return changed;
}

function isSea(pixels, offset) {
  const red = pixels[offset];
  const green = pixels[offset + 1];
  const blue = pixels[offset + 2];
  return red < 50 && green >= 60 && green <= 140 && blue >= 80 && blue <= 175 && blue > green + 10;
}

function animatedSeaPixels(before, after) {
  let sampled = 0;
  let changed = 0;
  // The gallery camera may move as the island composition evolves. Classify
  // the rendered cool sea rather than trusting one fixed screen rectangle;
  // require a large sampled area so a few cyan HUD glyphs cannot pass.
  for (let row = 85; row < Math.min(before.height, 670); row += 1) {
    for (let column = 0; column < before.width; column += 1) {
      const offset = (row * before.width + column) * 4;
      if (!isSea(before.pixels, offset) || !isSea(after.pixels, offset)) continue;
      sampled += 1;
      if (
        before.pixels[offset] !== after.pixels[offset] ||
        before.pixels[offset + 1] !== after.pixels[offset + 1] ||
        before.pixels[offset + 2] !== after.pixels[offset + 2]
      )
        changed += 1;
    }
  }
  return { sampled, changed };
}

function staticCoastPixels(before, after) {
  let sampled = 0;
  let changed = 0;
  const changes = [];
  const stride = before.width * 4;
  for (let row = 89; row < Math.min(before.height, 666); row += 1) {
    for (let column = 4; column < before.width - 4; column += 1) {
      const offset = row * stride + column * 4;
      const red = before.pixels[offset];
      const green = before.pixels[offset + 1];
      const blue = before.pixels[offset + 2];
      // Source-colored rock faces are brown pixels beside the cool sea. This
      // follows the irregular shore instead of one old screen coordinate.
      if (!(red >= 50 && red <= 140 && green >= 40 && green <= 120 && blue >= 20 && blue <= 100)) continue;
      if (!(red > green + 5 && green > blue + 8)) continue;
      if (
        ![offset - 4 * 4, offset + 4 * 4, offset - 4 * stride, offset + 4 * stride].some((neighbor) =>
          isSea(before.pixels, neighbor),
        )
      )
        continue;
      sampled += 1;
      if (
        before.pixels[offset] !== after.pixels[offset] ||
        before.pixels[offset + 1] !== after.pixels[offset + 1] ||
        before.pixels[offset + 2] !== after.pixels[offset + 2]
      ) {
        changed += 1;
        if (changes.length < 8) changes.push([column, row, red, green, blue]);
      }
    }
  }
  return { sampled, changed, changes };
}

try {
  const { client } = page;
  client.transcript.length = 0;
  await client.send("Emulation.setDeviceMetricsOverride", {
    width: 1280,
    height: 720,
    deviceScaleFactor: 1,
    mobile: false,
  });
  // The art gallery pins the camera and prevents bot combat from changing the
  // comparison region. Only the material's Defold TIME constant should move.
  await client.send("Page.addScriptToEvaluateOnNewDocument", {
    source: "globalThis.__warBattlesConfigV1 = { artGallery: true };",
  });
  const cleared = client.waitForEvent("Runtime.executionContextsCleared");
  const loaded = client.waitForEvent("Page.loadEventFired");
  await client.send("Page.reload", { ignoreCache: true });
  await cleared;
  await loaded;
  await waitFor(() => client.transcript.some((line) => line.startsWith("war-battles:arena-init:")), {
    timeoutMs: 30_000,
    intervalMs: 100,
    what: "the static coast art-gallery scene",
  });
  await client.send("Runtime.evaluate", { expression: 'document.querySelector("canvas")?.focus()' });
  await client.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "w",
    code: "KeyW",
    windowsVirtualKeyCode: 87,
    nativeVirtualKeyCode: 87,
    text: "w",
  });
  await waitFor(() => client.transcript.some((line) => line.startsWith("war-battles:arena-engaged:")), {
    timeoutMs: 3_000,
    intervalMs: 50,
    what: "the gallery's playable arena",
  });
  await client.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "w",
    code: "KeyW",
    windowsVirtualKeyCode: 87,
    nativeVirtualKeyCode: 87,
  });
  // Let the one-frame engagement press and camera ease finish before comparing
  // two frames. The gallery itself stays at a deterministic static layout.
  await new Promise((complete) => setTimeout(complete, 1_000));
  const capture = async () => {
    const result = await client.send("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: false,
    });
    return decodeRgbaPng(Buffer.from(result.data, "base64"));
  };
  const before = await capture();
  await new Promise((complete) => setTimeout(complete, 430));
  const after = await capture();
  assert.deepEqual([before.width, before.height], [1280, 720]);
  assert.deepEqual([after.width, after.height], [1280, 720]);
  const ocean = animatedSeaPixels(before, after);
  const coast = staticCoastPixels(before, after);
  const all = changedPixels(before, after, { x: 0, y: 0, width: 1280, height: 720 });
  const sampleOffset = (600 * before.width + 1240) * 4;
  console.log(
    `war-battles-coast-animation:diagnostic:all=${all}:ocean=${ocean.changed}/${ocean.sampled}:coast=${coast.changed}/${coast.sampled}:coastChanges=${JSON.stringify(coast.changes)}:sample=${[
      ...before.pixels.subarray(sampleOffset, sampleOffset + 4),
    ].join(",")}:after=${[...after.pixels.subarray(sampleOffset, sampleOffset + 4)].join(",")}`,
  );
  assert.ok(ocean.sampled >= 5_000, `gallery did not expose enough sea (${ocean.sampled} pixels)`);
  assert.ok(ocean.changed >= 20, `water material did not visibly advance (${ocean.changed} changed pixels)`);
  assert.ok(coast.sampled >= 20, `gallery did not expose enough source-colored coast (${coast.sampled} pixels)`);
  // This color/adjacency candidate mask also includes a few animated objects
  // overlapping the shore. Reject broad face motion, not those isolated pixels.
  assert.ok(
    coast.changed <= Math.max(6, Math.floor(coast.sampled / 100)),
    `coast faces must not broadly animate with water (${coast.changed}/${coast.sampled} changed pixels)`,
  );
  console.log(
    `war-battles-coast-animation:ok:ocean=${ocean.changed}/${ocean.sampled}:coast=${coast.changed}/${coast.sampled}:delta=430ms`,
  );
} finally {
  await page.close();
}
