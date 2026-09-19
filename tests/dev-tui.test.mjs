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

test("TUI w key requests the HTML5 target without leaving the dashboard", async () => {
  // The browser target is a peer of the native engine, reachable by one key,
  // and the console stays a view: it asks the session for the target and owns
  // no server, browser or profile of its own.
  const harness = lifecycleHarness(["w", "q"]);
  const intents = [];
  await runDevTui({
    createApp: harness.createApp,
    snapshot,
    onIntent: (intent) => intents.push(intent.type),
    viewport: () => ({ cols: 120, rows: 30 }),
    refreshMs: 1,
    reducedMotion: true
  });
  assert.deepEqual(intents, ["web"]);
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


// ---------------------------------------------------------------------------
// Declarative console: focus scopes, layers, selection, and the keymap
// projections that keep the footer, the palette, and help from drifting apart.
// ---------------------------------------------------------------------------

const { fuzzyScore, sortByScore } = await import("@rezi-ui/core");
const { PANEL_IDS, bindingMapFrom, scopeForFocusedId } = await import("../packages/cli/src/dev/tui/keymap.mjs");
const { copyToClipboard, osc52Sequence } = await import("../packages/cli/src/dev/tui/clipboard.mjs");
const { lineSelectionRange, logLines, pointToCaret, selectAllRange, selectedLogText } =
  await import("../packages/cli/src/dev/tui/logViewport.mjs");
const { closeTopOverlay, createUiState, openOverlay, topOverlay } = await import("../packages/cli/src/dev/tui/state.mjs");
const { devKeymapEntries, footerText, helpBindings, paletteItems } = await import("../packages/cli/src/dev/tui.mjs");

function renderConsole(viewport, uiState, snapshotValue = snapshot()) {
  const entries = devKeymapEntries({});
  return createTestRenderer({ viewport }).render(renderDevDashboard({
    tick: 0,
    reducedMotion: true,
    viewport,
    snapshot: snapshotValue,
    ui: uiState,
    entries,
    bindings: helpBindings(entries, []),
    paletteItems: paletteItems(entries)
  }));
}

test("every key the footer advertises is a key the console registers or the runtime routes", () => {
  const entries = devKeymapEntries({ play() {}, reload() {}, rebuild() {} });
  const bindings = bindingMapFrom(entries, () => "global");
  const advertised = footerText(entries, "wide").split("  ").map((part) => part.split(" ")[0]);
  assert.ok(advertised.length > 0);
  for (const label of advertised) {
    const entry = entries.find((candidate) => (candidate.label ?? candidate.sequence) === label);
    assert.ok(entry, `footer advertises ${label} but the keymap does not declare it`);
    if (entry.sequence) assert.ok(bindings[entry.sequence], `${label} is advertised but never registered`);
    else assert.ok(entry.routedBy, `${label} has no handler and no runtime router`);
  }
});

test("help is generated from the keymap and names the panel a scoped key belongs to", () => {
  const entries = devKeymapEntries({});
  const rows = helpBindings(entries, [{ sequence: "p", description: "Launch or stop the built Defold game", mode: "default" }]);
  for (const entry of entries) {
    assert.ok(
      rows.some((row) => row.sequence === (entry.label ?? entry.sequence)),
      `help omits ${entry.label ?? entry.sequence}`
    );
  }
  assert.equal(rows.find((row) => row.sequence === "up")?.mode, "logs");
  assert.equal(rows.filter((row) => row.sequence === "p").length, 1, "a registered key must not be listed twice");
});

test("panel-scoped keys stand down so the focused widget's own router receives them", () => {
  let scrolled = 0;
  let focusedId = PANEL_IDS.logs;
  const entries = devKeymapEntries({ scrollLogs: (delta) => { scrolled += delta; } });
  const bindings = bindingMapFrom(entries, () => scopeForFocusedId(focusedId));
  assert.equal(bindings.up.when(), true);
  focusedId = PANEL_IDS.targets;
  assert.equal(bindings.up.when(), false, "table row navigation must not be shadowed by the log scroller");
  focusedId = PANEL_IDS.logsSelection;
  assert.equal(bindings.up.when(), true, "the selection viewport is still the logs panel");
  bindings.up.handler();
  assert.equal(scrolled, -1);
});

test("the command palette fuzzy-matches every intent the keymap declares", () => {
  const items = paletteItems(devKeymapEntries({ reload() {}, play() {} }));
  const ranked = sortByScore(items, "reload");
  assert.ok(fuzzyScore(ranked[0], "reload") > 0);
  assert.match(ranked[0].label, /reload/i);
  assert.ok(items.every((item) => item.shortcut), "a palette row without its key teaches the operator nothing");
});

test("Escape unwinds one overlay at a time instead of collapsing the console", () => {
  let ui = createUiState();
  ui = openOverlay(ui, "help");
  ui = openOverlay(ui, "detail");
  assert.equal(topOverlay(ui), "detail");
  const first = closeTopOverlay(ui);
  assert.equal(first.closed, true);
  assert.equal(topOverlay(first.ui), "help");
  const second = closeTopOverlay(first.ui);
  assert.equal(topOverlay(second.ui), null);
  assert.equal(closeTopOverlay(second.ui).closed, false);
});

test("a pointer drag over the log viewport selects exactly the characters under it", () => {
  const lines = logLines([
    { id: "a", timestamp: 0, level: "info", source: "engine", message: "first" },
    { id: "b", timestamp: 0, level: "warn", source: "reload", message: "second" }
  ]);
  const rect = { x: 2, y: 5, w: 80, h: 2 };
  const anchor = pointToCaret({ x: 2, y: 5 }, rect, 0, lines);
  const active = pointToCaret({ x: 12, y: 6 }, rect, 0, lines);
  assert.deepEqual(anchor, { line: 0, column: 0 });
  assert.deepEqual(active, { line: 1, column: 10 });
  const selection = { anchor, active };
  assert.equal(selectedLogText(lines, selection), `${lines[0].text}\n${lines[1].text.slice(0, 10)}`);
  assert.deepEqual(lineSelectionRange(selection, 0, lines[0].text.length), [0, lines[0].text.length]);
  assert.equal(lineSelectionRange(selection, 5, 10), null);
  assert.equal(selectedLogText(lines, selectAllRange(lines)), `${lines[0].text}\n${lines[1].text}`);
});

test("copying a selection reaches the operator's terminal over OSC 52 and a local helper", () => {
  const written = [];
  const spawned = [];
  const result = copyToClipboard("candidate generation 4 staged", {
    writeRaw: (text) => written.push(text),
    localCommand: () => ["pbcopy", []],
    spawn: (command) => {
      spawned.push(command);
      return { on() {}, stdin: { on() {}, end() {} } };
    }
  });
  assert.deepEqual(result.transports, ["osc52", "local"]);
  assert.equal(written[0], osc52Sequence("candidate generation 4 staged"));
  assert.match(written[0], /^\u001b\]52;c;[A-Za-z0-9+/=]+\u0007$/);
  assert.deepEqual(spawned, ["pbcopy"]);
  assert.equal(copyToClipboard("", {}).copied, false);
  assert.equal(copyToClipboard("x", { local: false }).copied, false, "no transport must not be reported as a copy");
});

test("the targets view reports generation, bundle fingerprint, phase, and telemetry", () => {
  const fingerprint = "ab".repeat(32);
  const text = renderConsole({ cols: 150, rows: 48 }, createUiState({ view: "targets" }), snapshot({
    targets: [{
      id: "local",
      name: "War Battles",
      url: "http://127.0.0.1:8001",
      status: "connected",
      appliedGeneration: 4,
      telemetry: { bundleFingerprint: fingerprint, runtimeId: 17, resourceGeneration: 6, frameDtMs: 8.2 }
    }]
  })).toText();
  assert.match(text, /War Battles/);
  assert.match(text, /abababababab/);
  assert.match(text, /connected/);
  assert.match(text, /8\.20 ms/);
});

test("the targets view lists the HTML5 target beside the native one and names its gaps", () => {
  // Two projections of one session. They do not measure the same things, so
  // the view says which runtime each target is and how many capability gaps it
  // declared; a missing counter is never shown as a blank the reader must
  // interpret.
  const text = renderConsole({ cols: 150, rows: 48 }, createUiState({ view: "targets" }), snapshot({
    targets: [
      {
        id: "local-engine",
        name: "local:8001",
        url: "http://127.0.0.1:8001",
        status: "connected",
        runtime: "hermes",
        appliedGeneration: 4,
        telemetry: { bundleFingerprint: "ab".repeat(32), runtimeId: 17, resourceGeneration: 6, frameDtMs: 8.2 }
      },
      {
        id: "browser-host",
        name: "chrome:51234",
        url: "http://127.0.0.1:51234/index.html",
        status: "connected",
        runtime: "browser",
        appliedGeneration: 4,
        telemetry: { bundleFingerprint: "cd".repeat(32), runtimeId: 1, resourceGeneration: 2, hermesHeapAvailable: false },
        capabilities: [
          { name: "hermes-heap", available: false, reason: "The browser runtime embeds no Hermes." },
          { name: "lua-handles", available: false, reason: "The Lua value registry lives inside the Wasm engine." }
        ]
      }
    ]
  })).toText();
  assert.match(text, /local:8001/);
  assert.match(text, /chrome:51234/);
  assert.match(text, /hermes/);
  assert.match(text, /browser/);
  assert.match(text, /capability gap/);
  assert.match(text, /hermes-heap/);
});

test("the generations view is a build timeline with its activation outcome", () => {
  const text = renderConsole({ cols: 150, rows: 48 }, createUiState({ view: "generations" }), snapshot({
    lastSuccessfulGeneration: 6,
    lastBuildMetrics: { bytes: 48_000, byteDelta: -1_024, durationMs: 9, moduleCount: 12, modules: [] },
    history: [
      { generation: 5, status: "rejected", durationMs: 12, fingerprint: "ef".repeat(32), resources: [] },
      { generation: 6, status: "activated", durationMs: 9, fingerprint: "ab".repeat(32), resources: ["/deherm/app.dehermc"] }
    ]
  })).toText();
  assert.match(text, /activated/);
  assert.match(text, /rejected/);
  assert.match(text, /46\.9 KiB/);
  assert.match(text, /12 \(-1\.0 KiB\)/);
});

test("the instances view states its missing channel rather than inventing identities", () => {
  const text = renderConsole({ cols: 150, rows: 48 }, createUiState({ view: "instances" })).toText();
  assert.match(text, /requires runtime instance channel/);
  assert.match(text, /counts, never identities/);
  assert.match(text, /component instances\s+1/);
});

test("only the focused panel wears the focus ring", () => {
  const viewport = { cols: 150, rows: 48 };
  const unfocused = renderConsole(viewport, createUiState()).toText();
  const focused = renderConsole(viewport, createUiState({ focusedId: PANEL_IDS.logs })).toText();
  assert.doesNotMatch(unfocused, /[╔╚╗╝]/, "nothing is focused, so no panel should be ringed");
  assert.match(focused, /[╔╚╗╝]/);
  assert.equal(
    focused.split("\n").filter((line) => /[╔╗]/.test(line)).length,
    1,
    "exactly one panel owns the keyboard"
  );
});

test("view keys switch views locally without asking the session to do anything", async () => {
  const harness = lifecycleHarness(["t", "q"]);
  const intents = [];
  await runDevTui({
    createApp: harness.createApp,
    snapshot,
    onIntent: (intent) => intents.push(intent.type),
    viewport: () => ({ cols: 120, rows: 30 }),
    refreshMs: 1,
    reducedMotion: true
  });
  assert.deepEqual(intents, []);
  assert.equal(harness.state().ui.view, "targets");
});

test("the palette opens on : and Escape unwinds it", async () => {
  const harness = lifecycleHarness([":", "escape", "q"]);
  await runDevTui({
    createApp: harness.createApp,
    snapshot,
    viewport: () => ({ cols: 120, rows: 30 }),
    refreshMs: 1,
    reducedMotion: true
  });
  assert.equal(harness.state().ui.layers.stack.length, 0);
  assert.equal(harness.evidence.invalidUpdates, 0);
});

const { createRng, randomInt } = await import("@rezi-ui/testkit");
test("pointer selection stays inside the log buffer for arbitrary drags", () => {
  const rng = createRng(0x5eed);
  const lines = logLines(Array.from({ length: 40 }, (_, index) => ({
    id: `entry-${index}`,
    timestamp: index,
    level: "info",
    source: "engine",
    message: "x".repeat(index % 17)
  })));
  const rect = { x: 3, y: 7, w: 100, h: 12 };
  for (let iteration = 0; iteration < 400; iteration += 1) {
    const first = randomInt(rng, 0, lines.length - 1);
    const caret = pointToCaret(
      { x: randomInt(rng, -40, 200), y: randomInt(rng, -40, 60) },
      rect,
      first,
      lines
    );
    assert.ok(caret.line >= 0 && caret.line < lines.length, `line ${caret.line} escaped the buffer`);
    assert.ok(caret.column >= 0 && caret.column <= lines[caret.line].text.length, `column ${caret.column} escaped its line`);
    const other = pointToCaret({ x: randomInt(rng, -40, 200), y: randomInt(rng, -40, 60) }, rect, first, lines);
    // Whatever order the drag happened in, the copied text is a real substring
    // of the buffer rather than a slice of out-of-range coordinates.
    const text = selectedLogText(lines, { anchor: caret, active: other });
    assert.ok(lines.map((line) => line.text).join("\n").includes(text.split("\n")[0]));
  }
});
