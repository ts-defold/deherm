#!/usr/bin/env node

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { REFINERY_THEME_MARKER, runArenaThemeRuntimeGate } from "./arena-theme-runtime.mjs";

const exampleRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const projectRoot = resolve(exampleRoot, "defold");

function emit(event) {
  if (event?.type === "log" && event.message) console.log(`[${event.source ?? "build"}] ${event.message}`);
}

try {
  const result = await runArenaThemeRuntimeGate({ projectRoot, emit });
  console.log(`war-battles-arena-theme-runtime:ok:${result.platform}`);
  console.log(REFINERY_THEME_MARKER);
  console.log(
    `war-battles-arena-theme-runtime:graceful-exit:port=${result.termination.port}:code=${result.termination.exitCode}`,
  );
} catch (error) {
  console.error(`war-battles-arena-theme-runtime:failed:${error instanceof Error ? error.stack : String(error)}`);
  process.exitCode = 1;
}
