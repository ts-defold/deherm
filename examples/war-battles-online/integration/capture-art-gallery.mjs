#!/usr/bin/env node

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
const bundleDirectory = resolve(repositoryRoot, "build/bundle/War Battles");
const liveGame = process.argv.includes("--live");
const directions = ["se", "s", "sw", "w", "e", "nw", "n", "ne"];
const chassisArguments = process.argv.filter((argument) => argument.startsWith("--chassis="));
if (chassisArguments.length > 1) throw new Error("choose only one --chassis option");
const artGalleryChassis = chassisArguments.length === 0 ? undefined : Number(chassisArguments[0].slice(10));
if (
  artGalleryChassis !== undefined &&
  (!Number.isInteger(artGalleryChassis) || artGalleryChassis < 1 || artGalleryChassis > 4)
) {
  throw new Error("--chassis must be an integer from 1 to 4");
}
function directionOption(name) {
  const options = process.argv.filter((argument) => argument.startsWith(`--${name}=`));
  if (options.length > 1) throw new Error(`choose only one --${name} option`);
  if (options.length === 0) return undefined;
  const direction = options[0].slice(name.length + 3);
  const index = directions.indexOf(direction);
  if (index < 0) throw new Error(`--${name} must be one of ${directions.join(", ")}`);
  return index;
}
const artGalleryHullDirection = directionOption("direction");
const artGalleryTurretDirection = directionOption("turret-direction") ?? artGalleryHullDirection;
const artGalleryHeroDirection = directionOption("hero-direction");
const artGalleryHeroMoving = process.argv.includes("--hero-walk");
if (artGalleryHeroMoving && artGalleryHeroDirection === undefined) {
  throw new Error("--hero-walk requires --hero-direction");
}
if (
  liveGame &&
  (artGalleryChassis !== undefined ||
    artGalleryHullDirection !== undefined ||
    artGalleryTurretDirection !== undefined ||
    artGalleryHeroDirection !== undefined)
) {
  throw new Error("chassis and direction options require art-gallery mode, not --live");
}
const driveSteps = process.argv
  .filter((argument) => argument.startsWith("--drive="))
  .map((argument) => {
    const match = argument.match(/^--drive=([wasd]{1,4}):(\d{1,5})$/u);
    if (!match) throw new Error("--drive expects directions and milliseconds, for example wd:2200");
    const ms = Number(match[2]);
    if (ms > 10_000) throw new Error("--drive is limited to 10000 milliseconds per step");
    return { keys: [...new Set(match[1])], ms };
  });
const output = resolve(
  process.argv.slice(2).find((argument) => !argument.startsWith("--")) ??
    (liveGame
      ? resolve(repositoryRoot, "build/evidence/war-battles-world-wide.png")
      : "/private/tmp/war-battles-landmark-gallery.png"),
);

const page = await openBundlePage({
  bundleDirectory,
  port: await freeLoopbackPort(),
  debuggingPort: await freeLoopbackPort(),
  chromeBinary: defaultChromeBinary,
  retain: true,
});

try {
  const { client } = page;
  client.transcript.length = 0;
  // The usual 756x425 smoke frame is too narrow to judge the one-world
  // composition. Capture a larger playable viewport without zooming sprites.
  await client.send("Emulation.setDeviceMetricsOverride", {
    width: 1280,
    height: 720,
    deviceScaleFactor: 1,
    mobile: false,
  });
  if (!liveGame) {
    await client.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `globalThis.__warBattlesConfigV1 = ${JSON.stringify({
        artGallery: true,
        artGalleryChassis,
        artGalleryHullDirection,
        artGalleryTurretDirection,
        artGalleryHeroDirection,
        ...(artGalleryHeroDirection === undefined ? {} : { artGalleryHeroMoving }),
      })};`,
    });
  }
  const cleared = client.waitForEvent("Runtime.executionContextsCleared");
  const loaded = client.waitForEvent("Page.loadEventFired");
  await client.send("Page.reload", { ignoreCache: true });
  await cleared;
  await loaded;
  await waitFor(() => client.transcript.some((line) => line.startsWith("war-battles:arena-init:")), {
    timeoutMs: 30_000,
    intervalMs: 100,
    what: liveGame ? "live arena" : "arena art gallery",
  });
  if (artGalleryHullDirection !== undefined || artGalleryTurretDirection !== undefined) {
    const facing = `war-battles:art-gallery-facing:hull=${artGalleryHullDirection ?? artGalleryTurretDirection}:turret=${artGalleryTurretDirection ?? artGalleryHullDirection}`;
    await waitFor(() => client.transcript.some((line) => line.startsWith(facing)), {
      timeoutMs: 3_000,
      intervalMs: 50,
      what: facing,
    });
  }
  await client.send("Runtime.evaluate", {
    expression: 'document.querySelector("canvas")?.focus()',
  });
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
    what: "the art gallery's playable arena",
  });
  if (artGalleryHeroDirection !== undefined) {
    await waitFor(
      async () => {
        const response = await client.send("Runtime.evaluate", {
          expression: "globalThis.__warBattlesTelemetryV1?.localMode",
          returnByValue: true,
        });
        return response.result.value === 1;
      },
      { timeoutMs: 3_000, intervalMs: 50, what: "the real player component's infantry gallery pose" },
    );
  }
  await client.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "w",
    code: "KeyW",
    windowsVirtualKeyCode: 87,
    nativeVirtualKeyCode: 87,
  });
  for (const step of driveSteps) {
    for (const direction of step.keys) {
      const keyCode = direction.toUpperCase().charCodeAt(0);
      await client.send("Input.dispatchKeyEvent", {
        type: "keyDown",
        key: direction,
        code: `Key${direction.toUpperCase()}`,
        windowsVirtualKeyCode: keyCode,
        nativeVirtualKeyCode: keyCode,
        text: direction,
      });
    }
    await new Promise((complete) => setTimeout(complete, step.ms));
    for (const direction of step.keys) {
      const keyCode = direction.toUpperCase().charCodeAt(0);
      await client.send("Input.dispatchKeyEvent", {
        type: "keyUp",
        key: direction,
        code: `Key${direction.toUpperCase()}`,
        windowsVirtualKeyCode: keyCode,
        nativeVirtualKeyCode: keyCode,
      });
    }
  }
  await new Promise((complete) => setTimeout(complete, 800));
  const screenshot = await client.send("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
    captureBeyondViewport: false,
  });
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, Buffer.from(screenshot.data, "base64"));
  console.log(`war-battles-${liveGame ? "live-world" : "art-gallery"}:${output}`);
  if (artGalleryHeroDirection !== undefined) {
    console.log(
      `war-battles-art-gallery-hero:${directions[artGalleryHeroDirection]}:${artGalleryHeroMoving ? "walk" : "idle"}`,
    );
  }
  const camera = client.transcript.filter((line) => line.startsWith("war-battles:camera:")).at(-1);
  if (camera) console.log(camera);
} finally {
  await page.close();
}
