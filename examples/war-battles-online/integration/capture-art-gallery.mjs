#!/usr/bin/env node

import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  defaultChromeBinary,
  freeLoopbackPort,
  openBundlePage,
  waitFor,
} from "../../../packages/cli/src/dev/browser-host.mjs";

const exampleRoot = resolve(import.meta.dirname, "..");
const repositoryRoot = resolve(exampleRoot, "../..");
const bundleDirectory = resolve(repositoryRoot, "build/bundle/War Battles");
const output = resolve(process.argv[2] ?? "/private/tmp/war-battles-landmark-gallery.png");

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
    what: "arena art gallery",
  });
  await new Promise((complete) => setTimeout(complete, 1_000));
  const screenshot = await client.send("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
    captureBeyondViewport: false,
  });
  await writeFile(output, Buffer.from(screenshot.data, "base64"));
  console.log(`war-battles-art-gallery:${output}`);
} finally {
  await page.close();
}
