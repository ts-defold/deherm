#!/usr/bin/env node

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runRuntimeMeasurement } from "./runtime-measurement-harness.ts";
import {
  assertRuntimeMeasurementEvidence,
  buildRuntimeMeasurementSourceInputs,
  digestRuntimeMeasurementSourceInputs,
  RUNTIME_MEASUREMENT_OWNER,
} from "./runtime-measurement-evidence.mjs";
import {
  defaultChromeBinary,
  freeLoopbackPort,
  openBundlePage,
} from "../../../packages/cli/src/dev/browser-host.mjs";

const exampleRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(exampleRoot, "../..");
const evidencePath = resolve(exampleRoot, "evidence/runtime-measurement.json");
const bundleDirectory = process.env.DEHERM_WAR_BATTLES_WEB_BUNDLE
  ?? resolve(repositoryRoot, "build/bundle/War Battles");
const arguments_ = new Set(process.argv.slice(2));
for (const argument of arguments_) {
  if (!["--record-evidence", "--check-evidence", "--check-sources", "--json", "--browser"].includes(argument)) {
    throw new Error(`unknown argument: ${argument}`);
  }
}

function unavailableBrowser(reason) {
  return {
    observed: false,
    timing: null,
    memory: null,
    unavailable: reason,
  };
}

async function runBrowserMeasurement() {
  if (!existsSync(resolve(bundleDirectory, "index.html"))) {
    return unavailableBrowser(`No browser bundle at ${bundleDirectory}; pass --web-bundle or build wasm-web first.`);
  }
  let port;
  let debuggingPort;
  let page;
  try {
    port = Number.parseInt(process.env.DEHERM_WAR_BATTLES_HTTP_PORT ?? "", 10) || await freeLoopbackPort();
    debuggingPort = Number.parseInt(process.env.DEHERM_WAR_BATTLES_CDP_PORT ?? "", 10) || await freeLoopbackPort();
    page = await openBundlePage({
      bundleDirectory,
      port,
      debuggingPort,
      chromeBinary: process.env.DEHERM_CHROME ?? defaultChromeBinary,
      retain: true,
      deferNavigation: true,
    });
    const started = performance.now();
    const loaded = page.client.waitForEvent("Page.loadEventFired");
    await page.client.send("Page.navigate", { url: page.pageUrl });
    await loaded;
    const navigationWallClockMs = performance.now() - started;
    const state = await page.client.send("Runtime.evaluate", {
      expression: `(() => {
        const navigation = performance.getEntriesByType("navigation")[0] ?? null;
        const memory = performance.memory ?? null;
        return {
          nowMs: performance.now(),
          navigationDurationMs: navigation?.duration ?? null,
          domContentLoadedMs: navigation?.domContentLoadedEventEnd ?? null,
          loadEventEndMs: navigation?.loadEventEnd ?? null,
          memory: memory ? {
            jsHeapUsedBytes: memory.usedJSHeapSize,
            jsHeapSizeBytes: memory.totalJSHeapSize,
            jsHeapLimitBytes: memory.jsHeapSizeLimit
          } : null
        };
      })()`,
      returnByValue: true,
    });
    const observed = state.result?.value ?? {};
    const browserMemory = observed.memory === null
      ? { observed: false, jsHeapUsedBytes: null, jsHeapSizeBytes: null, jsHeapLimitBytes: null, unavailable: "Chrome did not expose performance.memory." }
      : { observed: true, ...observed.memory, unavailable: null };
    return {
      observed: true,
      timing: {
        clock: "performance.now",
        unit: "milliseconds",
        navigationWallClockMs,
        navigationDurationMs: typeof observed.navigationDurationMs === "number"
          ? observed.navigationDurationMs : navigationWallClockMs,
        domContentLoadedMs: observed.domContentLoadedMs,
        loadEventEndMs: observed.loadEventEndMs,
        pageNowMs: observed.nowMs,
      },
      memory: browserMemory,
      unavailable: null,
    };
  } catch (error) {
    return unavailableBrowser(`Browser measurement unavailable: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await page?.close();
  }
}

const sourceInputs = await buildRuntimeMeasurementSourceInputs();
const measured = await runRuntimeMeasurement();
const browser = arguments_.has("--browser")
  ? await runBrowserMeasurement()
  : unavailableBrowser("Browser measurement not run; pass --browser to launch the packaged wasm-web page.");
const generated = {
  ...measured,
  browser,
  owner: RUNTIME_MEASUREMENT_OWNER,
  generator: RUNTIME_MEASUREMENT_OWNER,
  sourceInputs,
  sourceKey: digestRuntimeMeasurementSourceInputs(sourceInputs),
  evidenceBoundary: "Owner-observed host wall-clock and memory snapshots; deterministic work units remain in performance-operability.json; no allocation-free or cross-runtime equivalence claim.",
};
assertRuntimeMeasurementEvidence(generated, { sourceInputs });
const serialized = `${JSON.stringify(generated, null, 2)}\n`;
const mode = arguments_.has("--record-evidence") ? "--record-evidence"
  : arguments_.has("--check-evidence") ? "--check-evidence"
    : arguments_.has("--check-sources") ? "--check-sources" : "--json";
if (mode === "--record-evidence") {
  await writeFile(evidencePath, serialized);
  process.stdout.write(`war-battles-runtime-measurement:recorded:${evidencePath}\n`);
} else if (mode === "--check-evidence") {
  const recorded = JSON.parse(await readFile(evidencePath, "utf8"));
  assertRuntimeMeasurementEvidence(recorded, { sourceInputs });
  process.stdout.write(`war-battles-runtime-measurement-evidence:fresh:${recorded.sourceKey}\n`);
} else if (mode === "--check-sources") {
  const recorded = JSON.parse(await readFile(evidencePath, "utf8"));
  assertRuntimeMeasurementEvidence(recorded, { sourceInputs });
  process.stdout.write(`war-battles-runtime-measurement-sources:fresh:${recorded.sourceKey}\n`);
} else {
  process.stdout.write(serialized);
}
