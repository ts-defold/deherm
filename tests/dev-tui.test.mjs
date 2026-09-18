import assert from "node:assert/strict";
import test from "node:test";

import { createTestRenderer } from "@rezi-ui/core";

import { renderDevDashboard, runDevTui } from "../packages/cli/src/dev/tui.mjs";

function snapshot(overrides = {}) {
  return {
    phase: "awaiting-activation",
    generation: 4,
    lastSuccessfulGeneration: 4,
    activeBuild: undefined,
    lastBuildMetrics: {
      bytes: 48_000,
      byteDelta: -1_024,
      durationMs: 18.4,
      moduleCount: 12,
      modules: [{ file: "game/player.script.ts", bytes: 8_192 }]
    },
    history: [{ generation: 4, status: "built", resources: ["/deherm/app.dehermc"] }],
    targets: [{
      id: "local",
      name: "War Battles",
      url: "http://127.0.0.1:8001",
      status: "awaiting-activation",
      pendingGeneration: 4,
      appliedGeneration: 3,
      signalledGeneration: 4,
      telemetry: {
        frameDtMs: 8.2,
        frameSamples: [8.1, 7.9, 8.4, 8.2],
        hermesHeapAvailable: true,
        hermesHeapBytes: 2_000_000,
        hermesHeapSizeBytes: 4_000_000,
        hermesPeakBytes: 2_500_000,
        callbackRoots: 41,
        componentInstances: 1,
        arenaHighWaterBytes: 8_192,
        luaRegistryUsed: 8,
        luaRegistryCapacity: 256,
        droppedEvents: 0
      }
    }],
    logs: [{ id: "candidate-4", at: 1, level: "info", source: "engine", message: "candidate generation 4 staged" }],
    ...overrides
  };
}

function state(viewport, snapshotValue = snapshot(), overrides = {}) {
  return {
    tick: 3,
    reducedMotion: false,
    viewport,
    logScroll: 0,
    logAutoScroll: true,
    setLogScroll() {},
    snapshot: snapshotValue,
    ...overrides
  };
}

function render(viewport, snapshotValue = snapshot(), overrides = {}) {
  return createTestRenderer({ viewport }).render(renderDevDashboard(state(viewport, snapshotValue, overrides)));
}

function assertInsideViewport(result) {
  for (const operation of result.ops) {
    if (operation.kind === "drawText") {
      assert.ok(operation.x >= 0 && operation.x < result.viewport.cols, `drawText x=${operation.x} outside ${result.viewport.cols}`);
      assert.ok(operation.y >= 0 && operation.y < result.viewport.rows, `drawText y=${operation.y} outside ${result.viewport.rows}`);
    }
    if (operation.kind === "fillRect") {
      assert.ok(operation.x >= 0 && operation.x + operation.w <= result.viewport.cols, `fillRect x=${operation.x} w=${operation.w}`);
      assert.ok(operation.y >= 0 && operation.y + operation.h <= result.viewport.rows, `fillRect y=${operation.y} h=${operation.h}`);
    }
  }
}

for (const viewport of [{ cols: 80, rows: 24 }, { cols: 120, rows: 30 }, { cols: 150, rows: 48 }]) {
  test(`Rezi dashboard fits ${viewport.cols}x${viewport.rows}`, (context) => {
    const result = render(viewport);
    const text = result.toText();
    assertInsideViewport(result);
    for (const expected of ["déherm", "EDIT LOOP", "TARGETS / GENERATIONS", "LIVE LOGS", "awaiting-activation", "War Battles"]) {
      assert.match(text, new RegExp(expected));
    }
    if (viewport.cols >= 140 && viewport.rows >= 42) {
      assert.match(text, /BUNDLE \/ CACHE/);
      assert.match(text, /RUNTIME HEALTH/);
      assert.match(text, /[▀▄█]/, "wide logo should use terminal half/full block raster cells");
      assert.match(text, /[⣿⣷⣯⣟⡿]/, "wide logo should use dense Braille cells for deterministic basalt grain");
    }
    context.assert.snapshot(text);
  });
}

test("dashboard never infers activation from a ready phase or successful build", () => {
  const result = render({ cols: 150, rows: 48 }, snapshot({
    phase: "ready",
    targets: [{
      id: "local",
      name: "War Battles",
      status: "connected",
      appliedGeneration: 3,
      telemetry: {}
    }]
  }));
  const text = result.toText();
  assert.match(text, /built 4 · applied 0\/1/);
  assert.doesNotMatch(text, /built 4 · applied 1\/1/);
});

test("dashboard shows the exact runtime acknowledgement identity", () => {
  const fingerprint = "ab".repeat(32);
  const result = render({ cols: 150, rows: 48 }, snapshot({
    phase: "ready",
    targets: [{
      id: "local",
      name: "War Battles",
      url: "http://127.0.0.1:8001",
      status: "connected",
      appliedGeneration: 4,
      telemetry: { bundleFingerprint: fingerprint, runtimeId: 17, resourceGeneration: 6 }
    }]
  }));
  const text = result.toText();
  assert.match(text, /built 4 · applied 1\/1/);
  assert.match(text, /runtime 17  resource 6  abababababab/);
});

test("log row ids remain stable when the bounded log window shifts", () => {
  const viewport = { cols: 150, rows: 48 };
  const shared = { at: 2, level: "info", source: "engine", message: "shared" };
  const first = render(viewport, snapshot({ logs: [{ at: 1, source: "watch", message: "old" }, shared] }));
  const second = render(viewport, snapshot({ logs: [shared, { at: 3, source: "watch", message: "new" }] }));
  const firstEntries = first.findById("deherm-logs").props.entries;
  const secondEntries = second.findById("deherm-logs").props.entries;
  assert.equal(firstEntries[1].id, secondEntries[0].id);
});

test("reduced motion freezes the logo raster", () => {
  const viewport = { cols: 150, rows: 48 };
  const first = render(viewport, snapshot(), { tick: 0, reducedMotion: true });
  const later = render(viewport, snapshot(), { tick: 500, reducedMotion: true });
  assert.deepEqual(first.ops, later.ops);
});

test("logo glint advances only when motion is enabled", () => {
  const viewport = { cols: 150, rows: 48 };
  const first = render(viewport, snapshot(), { tick: 0, reducedMotion: false });
  const later = render(viewport, snapshot(), { tick: 8, reducedMotion: false });
  assert.notDeepEqual(first.ops, later.ops);
});

test("wordmark exposes every selected xterm-256 basalt, prism, and heart color", () => {
  const result = render({ cols: 150, rows: 48 });
  const observed = new Set(result.ops.flatMap((operation) => [operation.style?.fg, operation.style?.bg]).filter(Number.isInteger));
  const selected = [
    0x262626, 0x303030, 0x3a3a3a, 0x444444, 0x585858,
    0xd75f00, 0xd78700, 0xd7af5f, 0x5f5f87, 0x00afd7,
    0xaf0000, 0xd70000, 0xff0000
  ];
  for (const color of selected) assert.ok(observed.has(color), `expected xterm color #${color.toString(16).padStart(6, "0")}`);
});

function lifecycleHarness(keys = ["q"]) {
  let status = "created";
  let stateValue;
  let bindings;
  let resolveReady;
  let resolveRun;
  const readyPromise = new Promise((resolve) => { resolveReady = resolve; });
  const runPromise = new Promise((resolve) => { resolveRun = resolve; });
  const evidence = { invalidUpdates: 0, updates: 0, stopDuringKeyDispatch: false, disposed: false };
  const createApp = ({ initialState }) => {
    stateValue = initialState;
    const app = {
      view() {},
      keys(value) { bindings = value; },
      run() {
        status = "starting";
        setTimeout(() => {
          status = "running";
          resolveReady();
          setTimeout(() => {
            for (const key of keys) app.press(key);
          }, 15);
        }, 5);
        return runPromise;
      },
      ready() { return readyPromise; },
      update(updater) {
        if (status !== "running") {
          evidence.invalidUpdates += 1;
          throw new Error(`update while ${status}`);
        }
        evidence.updates += 1;
        stateValue = updater(stateValue);
      },
      stop() {
        if (status === "dispatching-key") evidence.stopDuringKeyDispatch = true;
        status = "stopping";
        return new Promise((resolve) => setTimeout(() => {
          status = "stopped";
          resolve();
          resolveRun();
        }, 5));
      },
      dispose() { status = "disposed"; evidence.disposed = true; },
      press(key) {
        status = "dispatching-key";
        bindings[key].handler();
        if (status === "dispatching-key") status = "running";
      }
    };
    return app;
  };
  return { createApp, evidence, state: () => stateValue };
}

test("TUI refresh starts after ready, stops before teardown, and defers q lifecycle work", async () => {
  const harness = lifecycleHarness();
  await runDevTui({
    createApp: harness.createApp,
    snapshot,
    viewport: () => ({ cols: 120, rows: 30 }),
    refreshMs: 1,
    reducedMotion: true
  });
  assert.equal(harness.evidence.invalidUpdates, 0);
  assert.equal(harness.evidence.stopDuringKeyDispatch, false);
  assert.ok(harness.evidence.updates > 0);
  assert.equal(harness.state().tick, 0, "reduced-motion polling must not advance the animation frame");
  assert.equal(harness.evidence.disposed, true);
});

test("TUI p key requests an engine play/stop toggle without leaving the dashboard", async () => {
  const harness = lifecycleHarness(["p", "q"]);
  const intents = [];
  await runDevTui({
    createApp: harness.createApp,
    snapshot,
    onIntent: (intent) => intents.push(intent.type),
    viewport: () => ({ cols: 120, rows: 30 }),
    refreshMs: 1,
    reducedMotion: true
  });
  assert.deepEqual(intents, ["play"]);
  assert.equal(harness.evidence.disposed, true);
});

test("TUI log navigation suspends and resumes tail following", async () => {
  const harness = lifecycleHarness(["pageup", "end", "q"]);
  await runDevTui({
    createApp: harness.createApp,
    snapshot,
    viewport: () => ({ cols: 120, rows: 30 }),
    refreshMs: 1,
    reducedMotion: true
  });
  assert.equal(harness.state().logAutoScroll, true);
  assert.equal(harness.evidence.disposed, true);
});
