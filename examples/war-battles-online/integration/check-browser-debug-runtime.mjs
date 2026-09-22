#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { createBrowserTarget } from "../../../packages/cli/src/dev/browser-target.mjs";
import { waitFor } from "../../../packages/cli/src/dev/browser-host.mjs";
import { readInspectorSession } from "../../../packages/cli/src/dev/inspector-session.mjs";
import { runDebugSession } from "./check-debug-runtime.mjs";

const exampleRoot = path.resolve(import.meta.dirname, "..");
const repositoryRoot = path.resolve(exampleRoot, "../..");
const projectRoot = path.join(exampleRoot, "defold");
const bundleFile = path.join(projectRoot, ".deherm", "dev", "app.dehermc");
const sourceMapFile = `${bundleFile}.map`;
const sessionFile = path.join(projectRoot, ".deherm", "dev", "browser-inspector.json");
const bundleDirectory = process.env.DEHERM_WAR_BATTLES_WEB_BUNDLE
  ?? path.join(repositoryRoot, "build", "bundle", "War Battles");

await Promise.all([readFile(bundleFile), readFile(sourceMapFile)]);

const failures = [];
const target = createBrowserTarget({
  projectRoot,
  bundleFile,
  sourceMapFile,
  sessionFile,
  bundleDirectory,
  headless: true,
  telemetryIntervalMs: 60_000,
  emit(event) {
    if (event.type === "log" && event.level === "error") failures.push(event.message);
  }
});

try {
  assert.equal(await target.launch(), true);
  const activated = await waitFor(async () => {
    const result = await target.activate();
    if (result.status === "activated") return result;
    if (result.diagnostic === "browser host is not loaded") return false;
    const error = new Error(`browser rejected the development bundle: ${result.diagnostic ?? "unknown reason"}`);
    error.fatal = true;
    throw error;
  }, {
    timeoutMs: 45_000,
    intervalMs: 100,
    what: "the Defold browser host to accept the development bundle"
  });
  const session = await readInspectorSession(sessionFile);
  assert.equal(session.runtime, "browser");
  assert.equal(session.bundleUrl, "defold-hermes://app.js");
  assert.deepEqual(failures, [], `Browser target errors: ${JSON.stringify(failures)}`);

  const proof = await runDebugSession(1, { inspectorSession: sessionFile });
  assert.deepEqual(failures, [], `Browser target errors: ${JSON.stringify(failures)}`);
  console.log(JSON.stringify({
    schemaVersion: 1,
    project: projectRoot,
    runtime: "browser",
    bundleDirectory,
    activated,
    session: proof
  }, null, 2));
} finally {
  await target.stop();
}
