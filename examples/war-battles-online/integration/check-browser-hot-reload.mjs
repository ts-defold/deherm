#!/usr/bin/env node
//
// The HTML5 edit loop, end to end, through the real `deherm dev` session.
//
// `check-browser-runtime.mjs` proves that a packaged wasm-web bundle executes.
// This proves the other half: that the development session can *launch* that
// bundle as a target, observe what the browser genuinely reports, change a
// TypeScript source, and have the page acknowledge the exact fingerprint of
// the bundle the compiler produced from that change.
//
// It runs the shipped CLI in its JSON event mode, so what is exercised is the
// session wiring - watcher, compiler, browser target, activation join - and not
// a private arrangement of the parts.
//
// The evidence is the event stream and the page's own acknowledgement. Nothing
// here inspects the canvas, and no claim about what is drawn is made.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const exampleRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(exampleRoot, "../..");
const projectRoot = resolve(exampleRoot, "defold");
const entryPoint = resolve(projectRoot, "main/player.script.ts");
const evidencePath = resolve(exampleRoot, "evidence/browser-hot-reload-wasm-web.json");
const argumentSet = new Set(process.argv.slice(2));

const timeoutMs = Number.parseInt(process.env.DEHERM_BROWSER_HOT_RELOAD_TIMEOUT_MS ?? "180000", 10);

function startSession() {
  const child = spawn(
    process.execPath,
    [
      resolve(repositoryRoot, "bin/deherm.mjs"),
      "dev",
      "--project",
      projectRoot,
      "--entry",
      entryPoint,
      "--watch",
      projectRoot,
      "--headless",
      "--json",
      // The native engine is not part of this gate; the browser target is.
      "--no-launch",
      "--web",
    ],
    { cwd: repositoryRoot, stdio: ["ignore", "pipe", "pipe"] },
  );

  const events = [];
  const waiters = new Set();
  const stderr = [];
  let pending = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    pending += chunk;
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (!parsed?.event) continue;
      events.push(parsed.event);
      for (const waiter of waiters) waiter(parsed.event);
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => stderr.push(chunk));

  const waitForEvent = (predicate, what) =>
    new Promise((resolve_, reject) => {
      const existing = events.find(predicate);
      if (existing) {
        resolve_(existing);
        return;
      }
      const timer = setTimeout(() => {
        waiters.delete(observe);
        reject(new Error(`Timed out waiting for ${what}\nstderr:\n${stderr.join("")}`));
      }, timeoutMs);
      const observe = (event) => {
        if (!predicate(event)) return;
        clearTimeout(timer);
        waiters.delete(observe);
        resolve_(event);
      };
      waiters.add(observe);
    });

  return { child, events, waitForEvent, stderr };
}

async function run() {
  const original = await readFile(entryPoint, "utf8");
  const marker = `browser-hot-reload:${Date.now()}`;
  const session = startSession();
  let restored = false;
  let written = null;
  // Other work may touch this file while the gate runs. The source is only put
  // back when it still holds exactly what this gate wrote; anything else is
  // someone else's edit and is left alone rather than clobbered.
  const restore = async () => {
    if (restored) return;
    restored = true;
    if (written === null) return;
    const current = await readFile(entryPoint, "utf8");
    if (current !== written) {
      console.error(`war-battles-browser-hot-reload:source-not-restored:${entryPoint}`);
      return;
    }
    await writeFile(entryPoint, original);
  };

  try {
    // 1. The HTML5 target comes up: a scoped loopback server, a dedicated
    //    Chrome profile, and a page the session is attached to.
    const connected = await session.waitForEvent(
      (event) => event.type === "target-connected" && event.id === "browser-host",
      "the browser target to connect",
    );
    assert.match(
      connected.url,
      /^http:\/\/127\.0\.0\.1:\d+\//,
      "the browser target must be served from a scoped loopback port",
    );

    // 2. It declares what it cannot do rather than leaving a blank column.
    const capabilities = await session.waitForEvent(
      (event) => event.type === "target-capabilities" && event.id === "browser-host",
      "the browser target's declared capability gaps",
    );
    const gaps = capabilities.capabilities.filter((capability) => capability.available === false);
    assert.ok(gaps.length > 0, "the browser target must declare its gaps");
    for (const gap of gaps) assert.ok(gap.reason?.length > 20, `gap ${gap.name} must carry a reason`);

    // 3. Telemetry is what the page measures, and the counters it cannot
    //    measure are named rather than filled in.
    const telemetry = await session.waitForEvent(
      (event) => event.type === "telemetry" && event.id === "browser-host" && event.values?.componentInstances > 0,
      "browser telemetry with live component attachments",
    );
    assert.equal(telemetry.values.hermesHeapAvailable, false, "the browser host must not claim a Hermes heap");
    assert.ok(telemetry.values.componentInstances >= 1, "the port attaches components; the pool must report them");
    assert.ok(
      Number.isFinite(telemetry.values.jsHeapBytes),
      "Chrome reports a page heap and it must be passed through",
    );
    const named = (telemetry.capabilities ?? []).map(({ name }) => name);
    for (const counter of ["hermesHeapBytes", "luaHandles", "arenaHighWaterBytes"]) {
      assert.ok(named.includes(counter), `${counter} must be reported as unavailable, not omitted`);
    }
    // The frame delta is either measured or named as unmeasurable, never both
    // and never neither. This port is component-only, so the engine never calls
    // the browser host's application update and the honest answer is a reason.
    const frameMeasured = Number.isFinite(telemetry.values.frameDtMs);
    assert.notEqual(
      frameMeasured,
      named.includes("frameDtMs"),
      "frame delta must be exactly one of measured or explicitly unavailable",
    );

    // 4. The fingerprint the page is running before the edit. A rebuild that
    //    changes nothing produces this same fingerprint, so it is what the
    //    acknowledgement below has to differ from.
    const initial = await session.waitForEvent(
      (event) => event.type === "runtime-activation-observed" && event.id === "browser-host",
      "the browser host's first activation",
    );
    const runningFingerprint = initial.fingerprint;

    // 5. One ordinary TypeScript edit.
    const edited = original.replace(
      "  init(self: PlayerSelf): void {",
      `  init(self: PlayerSelf): void {\n    defold.log("info", "${marker}");`,
    );
    assert.notEqual(edited, original, "the gate's source edit no longer matches the port");
    written = edited;
    await writeFile(entryPoint, edited);

    // 6. The compiler produces a bundle that is genuinely different, and the
    //    page acknowledges that exact fingerprint as a non-initial activation.
    //    Both halves matter: a fingerprint equal to the running one would mean
    //    nothing changed, and `initial=true` would mean the page had merely
    //    loaded rather than swapped a generation.
    const built = await session.waitForEvent(
      (event) => event.type === "build-succeeded" && event.fingerprint !== runningFingerprint,
      "a rebuild whose bundle differs from the running one",
    );
    const activated = await session.waitForEvent(
      (event) =>
        event.type === "runtime-activation-observed" &&
        event.id === "browser-host" &&
        event.fingerprint === built.fingerprint,
      `the browser to acknowledge fingerprint ${built.fingerprint}`,
    );
    assert.equal(activated.initial, false, "a hot reload is not an initial load");
    assert.notEqual(
      activated.fingerprint,
      runningFingerprint,
      "the acknowledged bundle must differ from the one the page was already running",
    );
    assert.ok(
      activated.resourceGeneration > initial.resourceGeneration,
      "the browser host's bundle generation must advance",
    );

    const evidence = {
      schemaVersion: 1,
      scope:
        "Development-session HTML5 target: launch, declared capability gaps, browser-measured telemetry, and one fingerprint-acknowledged hot reload. Event and page evidence only; no visual claim.",
      platform: "wasm-web",
      pageUrl: connected.url.replace(/:\d+\//, ":<scoped-loopback-port>/"),
      loadedFingerprint: runningFingerprint,
      activatedFingerprint: activated.fingerprint,
      browserBundleGeneration: activated.resourceGeneration,
      buildGeneration: built.generation,
      telemetry: {
        measured: Object.fromEntries(
          Object.entries(telemetry.values).filter(
            ([key]) =>
              key !== "frameDtMs" &&
              key !== "frames" &&
              key !== "jsHeapBytes" &&
              key !== "jsHeapSizeBytes" &&
              key !== "jsHeapLimitBytes",
          ),
        ),
        measuredFrameDelta: frameMeasured,
        measuredPageHeap: Number.isFinite(telemetry.values.jsHeapBytes),
        unavailable: telemetry.capabilities,
      },
      capabilityGaps: gaps,
    };
    console.log(`war-battles-browser-hot-reload:ok:${activated.fingerprint}`);
    console.log(
      `war-battles-browser-hot-reload:generation:${built.generation}:browser-generation:${activated.resourceGeneration}`,
    );
    for (const gap of gaps) console.log(`war-battles-browser-hot-reload:gap:${gap.name}`);
    if (argumentSet.has("--record-evidence")) {
      await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
      console.log(`war-battles-browser-hot-reload:evidence:${evidencePath}`);
    }
    return evidence;
  } finally {
    // The source is restored before the session stops, so the last build the
    // session performs leaves the working tree as it found it.
    await restore();
    await new Promise((done) => setTimeout(done, 1_500));
    session.child.kill("SIGINT");
    await new Promise((done) => {
      const timer = setTimeout(() => {
        session.child.kill("SIGKILL");
        done();
      }, 15_000);
      session.child.once("exit", () => {
        clearTimeout(timer);
        done();
      });
    });
  }
}

run().catch(async (error) => {
  console.error(error.stack ?? error.message);
  process.exitCode = 1;
});
