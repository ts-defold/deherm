#!/usr/bin/env node
// Exercise the real player component's infantry atlas in the frozen browser
// gallery. The sheet samples each pose; the companion video retains the
// compositor frames between pose changes for visual jitter review.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  defaultChromeBinary,
  freeLoopbackPort,
  openBundlePage,
  waitFor,
} from "../../../packages/cli/src/dev/browser-host.mjs";
import { decodeRgbaPng, encodeRgbaPng } from "../tools/generate-world-art.mjs";
import { startBrowserVideo } from "./browser-video.mjs";

const exampleRoot = resolve(import.meta.dirname, "..");
const repositoryRoot = resolve(exampleRoot, "../..");
const character = process.argv[2] ?? "rook";
const selection = JSON.parse(await readFile(resolve(exampleRoot, "art/source/hero-source-selection.json"), "utf8"));
const family = selection.families.find((candidate) => candidate.character === character);
if (process.argv.length > 3 || family === undefined) {
  throw new Error(
    `Usage: node integration/capture-hero-directions.mjs [${selection.families.map((candidate) => candidate.character).join("|")}]`,
  );
}
const bundleDirectory =
  process.env.DEHERM_WAR_BATTLES_WEB_BUNDLE ?? resolve(repositoryRoot, "build/bundle/War Battles");
const outputDirectory = resolve(
  repositoryRoot,
  `build/evidence/hero-directional-runtime${family.variant === 0 ? "" : `-${character}`}`,
);
const directions = ["se", "s", "sw", "w", "e", "nw", "n", "ne"];
// Keep a generous gameplay-background gutter around the upscaled hero. The
// original 72 px crop clipped poses; 112 px still presented some cells tightly.
const cropSize = 144;
const heroRoi = { x: 32, y: 32, size: 80 };
const sheetScale = 2;
const captureCombat = family.hitRequest !== undefined && family.deathSources !== undefined;
const samplesPerDirection = captureCombat ? 15 : 8;
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function evaluate(client, expression) {
  const response = await client.send("Runtime.evaluate", { expression, returnByValue: true });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.text);
  return response.result.value;
}

async function setPose(client, direction, moving, firing = false, hit = false, dead = false) {
  await evaluate(
    client,
    `(() => {
      const config = globalThis.__warBattlesConfigV1;
      config.artGalleryHeroDirection = ${direction};
      config.artGalleryHeroMoving = ${moving};
      config.artGalleryHeroFiring = ${firing};
      config.artGalleryHeroHit = ${hit};
      config.artGalleryHeroDead = ${dead};
    })()`,
  );
}

async function captureCrop(client, clip, name) {
  const response = await client.send("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
    captureBeyondViewport: false,
    clip,
  });
  const bytes = Buffer.from(response.data, "base64");
  const image = decodeRgbaPng(bytes);
  assert.equal(image.width, cropSize);
  assert.equal(image.height, cropSize);
  // The frozen grass can still change in a future material pass. Measure
  // animation only inside the player silhouette's fixed, centered region.
  const heroPixels = Buffer.alloc(heroRoi.size * heroRoi.size * 4);
  for (let y = 0; y < heroRoi.size; y += 1) {
    image.pixels.copy(
      heroPixels,
      y * heroRoi.size * 4,
      ((heroRoi.y + y) * cropSize + heroRoi.x) * 4,
      ((heroRoi.y + y) * cropSize + heroRoi.x + heroRoi.size) * 4,
    );
  }
  const path = resolve(outputDirectory, `${name}.png`);
  await writeFile(path, bytes);
  return { path, sha256: sha256(bytes), heroRoiSha256: sha256(heroPixels), image };
}

function contactSheet(samples) {
  const tile = cropSize * sheetScale;
  const width = directions.length * tile;
  const height = samplesPerDirection * tile;
  const pixels = Buffer.alloc(width * height * 4);
  for (let direction = 0; direction < directions.length; direction += 1) {
    for (let sample = 0; sample < samplesPerDirection; sample += 1) {
      const image = samples[direction * samplesPerDirection + sample].image;
      for (let y = 0; y < cropSize; y += 1) {
        for (let x = 0; x < cropSize; x += 1) {
          const from = (y * cropSize + x) * 4;
          for (let sy = 0; sy < sheetScale; sy += 1) {
            for (let sx = 0; sx < sheetScale; sx += 1) {
              const to = ((sample * tile + y * sheetScale + sy) * width + direction * tile + x * sheetScale + sx) * 4;
              pixels.set(image.pixels.subarray(from, from + 4), to);
            }
          }
        }
      }
    }
  }
  return encodeRgbaPng(width, height, pixels);
}

async function run() {
  const page = await openBundlePage({
    bundleDirectory,
    port: await freeLoopbackPort(),
    debuggingPort: await freeLoopbackPort(),
    chromeBinary: process.env.DEHERM_CHROME ?? defaultChromeBinary,
    retain: true,
  });
  let video;
  try {
    const { client } = page;
    await client.send("Emulation.setDeviceMetricsOverride", {
      width: 1280,
      height: 720,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await client.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `globalThis.__warBattlesConfigV1 = { artGallery: true, artGalleryHeroDirection: 0, artGalleryHeroMoving: false, artGalleryHeroVariant: ${family.variant} };`,
    });
    client.transcript.length = 0;
    const cleared = client.waitForEvent("Runtime.executionContextsCleared");
    const loaded = client.waitForEvent("Page.loadEventFired");
    await client.send("Page.reload", { ignoreCache: true });
    await cleared;
    await loaded;
    await waitFor(() => client.transcript.some((line) => line.startsWith("war-battles:arena-init:")), {
      timeoutMs: 30_000,
      intervalMs: 100,
      what: "the infantry gallery arena",
    });
    const canvas = await evaluate(
      client,
      `(() => {
      const canvas = document.querySelector("canvas");
      if (!canvas) throw new Error("Defold canvas missing");
      canvas.focus();
      const bounds = canvas.getBoundingClientRect();
      return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
    })()`,
    );
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
      what: "the playable infantry gallery",
    });
    await client.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "w",
      code: "KeyW",
      windowsVirtualKeyCode: 87,
      nativeVirtualKeyCode: 87,
    });
    await waitFor(async () => (await evaluate(client, "globalThis.__warBattlesTelemetryV1?.localMode")) === 1, {
      timeoutMs: 3_000,
      intervalMs: 50,
      what: "the player's infantry mode",
    });
    const clip = {
      x: Math.round(canvas.x + canvas.width / 2 - cropSize / 2),
      y: Math.round(canvas.y + canvas.height / 2 - 24 - cropSize / 2),
      width: cropSize,
      height: cropSize,
      scale: 1,
    };
    await mkdir(outputDirectory, { recursive: true });
    const fullViewport = await client.send("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: false,
    });
    const fullViewportBytes = Buffer.from(fullViewport.data, "base64");
    const fullViewportPath = resolve(outputDirectory, "hero-gallery-full.png");
    await writeFile(fullViewportPath, fullViewportBytes);
    video = await startBrowserVideo(client, resolve(outputDirectory, "hero-directions.mp4"));
    const samples = [];
    for (let index = 0; index < directions.length; index += 1) {
      await setPose(client, index, false);
      await sleep(115);
      samples.push({
        direction: directions[index],
        state: "idle",
        ...(await captureCrop(client, clip, `${directions[index]}-idle`)),
      });
      await setPose(client, index, true);
      for (let frame = 0; frame < 4; frame += 1) {
        await sleep(145);
        samples.push({
          direction: directions[index],
          state: `walk-${frame + 1}`,
          ...(await captureCrop(client, clip, `${directions[index]}-walk-${frame + 1}`)),
        });
      }
      await setPose(client, index, false, true);
      for (let frame = 0; frame < 3; frame += 1) {
        await sleep(45);
        samples.push({
          direction: directions[index],
          state: `fire-${frame + 1}`,
          ...(await captureCrop(client, clip, `${directions[index]}-fire-${frame + 1}`)),
        });
      }
      if (captureCombat) {
        await setPose(client, index, false, false, true);
        for (let frame = 0; frame < 3; frame += 1) {
          await sleep(45);
          samples.push({
            direction: directions[index],
            state: `hit-${frame + 1}`,
            ...(await captureCrop(client, clip, `${directions[index]}-hit-${frame + 1}`)),
          });
        }
        await setPose(client, index, false, false, false, true);
        for (let frame = 0; frame < 4; frame += 1) {
          await sleep(75);
          samples.push({
            direction: directions[index],
            state: `death-${frame + 1}`,
            ...(await captureCrop(client, clip, `${directions[index]}-death-${frame + 1}`)),
          });
        }
      }
    }
    const videoEvidence = await video.stop();
    const sheet = contactSheet(samples);
    const sheetPath = resolve(outputDirectory, "hero-directions-contact.png");
    await writeFile(sheetPath, sheet);
    const walkVariation = directions.map((direction, index) => {
      const poses = samples.slice(index * samplesPerDirection, (index + 1) * samplesPerDirection);
      const distinctWalkFrames = new Set(poses.slice(1, 5).map((pose) => pose.heroRoiSha256)).size;
      return {
        direction,
        distinctWalkFrames,
        differsFromIdle: poses.slice(1, 5).some((pose) => pose.heroRoiSha256 !== poses[0].heroRoiSha256),
        fireDiffersFromIdle: poses.slice(5, 8).some((pose) => pose.heroRoiSha256 !== poses[0].heroRoiSha256),
        ...(captureCombat
          ? {
              hitDiffersFromIdle: poses.slice(8, 11).some((pose) => pose.heroRoiSha256 !== poses[0].heroRoiSha256),
              deathDiffersFromIdle: poses.slice(11).some((pose) => pose.heroRoiSha256 !== poses[0].heroRoiSha256),
            }
          : {}),
      };
    });
    const faviconMisses = client.failures.filter((failure) => failure.url?.endsWith("/favicon.ico"));
    assert.deepEqual(
      client.failures.filter((failure) => !faviconMisses.includes(failure)),
      [],
    );
    const report = {
      schemaVersion: 1,
      scope: "packaged-chromium-webgl2-frozen-gallery-eight-hero-directions",
      character,
      variant: family.variant,
      bundleDirectory,
      inputs: {
        heroAtlasSha256: sha256(await readFile(resolve(exampleRoot, "defold/main/hero-sprites.atlas"))),
        heroSourceSelectionSha256: sha256(
          await readFile(resolve(exampleRoot, "art/source/hero-source-selection.json")),
        ),
        projectCompiledBundleSha256: sha256(await readFile(resolve(exampleRoot, "defold/deherm/app.dehermc"))),
      },
      directionOrder: directions,
      rowOrder: [
        "idle",
        "walk-1",
        "walk-2",
        "walk-3",
        "walk-4",
        "fire-1",
        "fire-2",
        "fire-3",
        ...(captureCombat ? ["hit-1", "hit-2", "hit-3", "death-1", "death-2", "death-3", "death-4"] : []),
      ],
      clip,
      heroRoi,
      fullViewport: { path: fullViewportPath, sha256: sha256(fullViewportBytes) },
      sheet: { path: sheetPath, sha256: sha256(sheet) },
      video: videoEvidence,
      walkVariation,
      poseEvents: client.transcript.filter((line) => line.includes("war-battles:hero-pose:")),
      samples: samples.map(({ image: _image, ...sample }) => sample),
    };
    const reportPath = resolve(outputDirectory, "hero-directions.json");
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    assert.deepEqual(
      walkVariation.filter(
        (result) =>
          result.distinctWalkFrames < 2 ||
          !result.differsFromIdle ||
          !result.fireDiffersFromIdle ||
          (captureCombat && (!result.hitDiffersFromIdle || !result.deathDiffersFromIdle)),
      ),
      [],
      "Every selected facing must walk and select its available combat poses in the packaged engine",
    );
    console.log(
      `war-battles-hero-directions:ok:${JSON.stringify({ reportPath, sheet: report.sheet, video: videoEvidence })}`,
    );
  } finally {
    await video?.abort();
    await page.close();
  }
}

run().catch((error) => {
  console.error(error.stack ?? error.message);
  process.exitCode = 1;
});
