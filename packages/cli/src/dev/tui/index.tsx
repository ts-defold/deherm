import { BACKEND_RAW_WRITE_MARKER, computeSelection, selectAll as selectAllRows, ui as uiFactory } from "@rezi-ui/core";
import { Box, Button, Callout, Column, Input, Layers, Page, Panel, RadioGroup, Row, Select, StatusBar, Text } from "@rezi-ui/jsx";
import { createNodeApp } from "@rezi-ui/node";

import { copyToClipboard, decodePaste } from "./clipboard.mjs";
import {
  PANEL_IDS,
  VIEWS,
  bindingMapFrom,
  devKeymapEntries,
  footerText,
  helpBindings,
  paletteItems,
  scopeForFocusedId
} from "./keymap.mjs";
import {
  containsPoint,
  firstVisibleLine,
  logLines,
  pointToCaret,
  selectAllRange,
  selectedLogText
} from "./logViewport.mjs";
import { renderCompactLogo, renderLogo } from "./logo.mjs";
import { closeOverlay, closeTopOverlay, createUiState, normalizeState, openOverlay, topOverlay } from "./state.mjs";
import { dim, good, layoutMode, prism } from "./theme.mjs";
import {
  DetailOverlay,
  FilterOverlay,
  GenerationsView,
  HelpOverlay,
  InstancesView,
  LogsPanel,
  OverviewView,
  PaletteOverlay,
  SessionPlate,
  TargetsView,
  detailClipboardText,
  filteredLogEntries,
  generationRows,
  targetRows
} from "./views.tsx";

// Rendering is a pure projection of state, so a dashboard rendered without a
// live session still needs a keymap to project the footer from.
const INERT_KEYMAP = devKeymapEntries({});

/** Rows each region of the console gets, derived once so nothing overflows. */
export function layoutPlan(mode, viewport) {
  const rows = viewport?.rows ?? 30;
  const header = mode === "compact" ? 1 : mode === "wide" ? 8 : 7;
  const tabs = 1;
  const logs = mode === "wide" ? 11 : mode === "medium" ? 7 : 5;
  const body = Math.max(6, rows - header - tabs - logs - 1);
  return { header, tabs, logs, view: body };
}

function viewContent(key, props) {
  if (key === "targets") return <TargetsView {...props} />;
  if (key === "generations") return <GenerationsView {...props} />;
  if (key === "instances") return <InstancesView {...props} />;
  return <OverviewView {...props} />;
}

function Overlay({ ui, snapshot, actions, bindings, items }) {
  const top = topOverlay(ui);
  if (top === "palette") return <PaletteOverlay ui={ui} actions={actions} items={items} />;
  if (top === "help") return <HelpOverlay bindings={bindings} actions={actions} />;
  if (top === "filter") return <FilterOverlay ui={ui} actions={actions} />;
  if (top === "detail") return <DetailOverlay ui={ui} snapshot={snapshot} actions={actions} />;
  return undefined;
}

export function renderDevDashboard(rawState) {
  const state = normalizeState(rawState);
  const { snapshot, ui, actions } = state;
  const mode = layoutMode(state.viewport);
  const plan = layoutPlan(mode, state.viewport);
  const focusedScope = scopeForFocusedId(ui.focusedId);
  const entries = state.entries.length > 0 ? state.entries : INERT_KEYMAP;
  const viewProps = { snapshot, focusedScope, ui, actions, mode, height: plan.view };

  const page = (
    <Page
      p={0}
      gap={0}
      header={
        <Box border="none" px={1} py={0}>
          {mode === "compact"
            ? renderCompactLogo()
            : (
              <Row justify="between" align="start" width="full">
                {renderLogo(state.tick, state.reducedMotion, mode === "wide")}
                <SessionPlate snapshot={snapshot} />
              </Row>
            )}
        </Box>
      }
      body={
        <Column px={1} gap={0} height="full" overflow="hidden">
          <RadioGroup
            id={PANEL_IDS.views}
            accessibleLabel="Console view"
            direction="horizontal"
            value={ui.view}
            options={VIEWS.map((view) => ({ value: view.key, label: `${view.hotkey} ${view.label}` }))}
            onChange={(key) => actions.selectView?.(key)}
          />
          {viewContent(ui.view, viewProps)}
          <LogsPanel
            snapshot={snapshot}
            ui={ui}
            actions={actions}
            focusedScope={focusedScope}
            height={plan.logs}
          />
        </Column>
      }
      footer={
        <StatusBar
          left={[uiFactory.text(footerText(entries, mode), { textOverflow: "ellipsis" })]}
          right={[uiFactory.text(ui.notice ?? "q quit", { style: { fg: ui.notice ? good : prism[0], bold: true } })]}
          style={{ fg: dim }}
        />
      }
    />
  );

  const overlay = <Overlay ui={ui} snapshot={snapshot} actions={actions} bindings={state.bindings} items={state.paletteItems ?? []} />;
  return overlay ? <Layers>{page}{overlay}</Layers> : page;
}

function tableClipboardText(rows, selection, columns) {
  const chosen = selection?.length ? rows.filter((row) => selection.includes(row.key)) : rows;
  return chosen.map((row) => columns.map((column) => row[column]).join("\t")).join("\n");
}

const TARGET_COLUMNS = ["name", "status", "applied", "signalled", "fingerprint", "runtime", "resource", "frame", "url"];
const GENERATION_COLUMNS = ["generation", "fingerprint", "bytes", "moduleDelta", "duration", "outcome", "resources"];

export async function runDevTui(options) {
  const reducedMotion = options.reducedMotion ?? process.env.DEHERM_REDUCED_MOTION === "1";
  const ui = createUiState();
  // `stopping` halts polling the moment the operator asks to quit; `teardown`
  // is only set once the app is actually being stopped, so a state change made
  // by that same keystroke still reaches the final frame.
  let stopping = false;
  let teardown = false;
  let started = false;
  let interval;
  let syncQueued = false;

  const viewport = () => options.viewport?.() ?? { cols: process.stdout.columns ?? 120, rows: process.stdout.rows ?? 30 };
  const snapshotOf = () => options.snapshot();

  const app = (options.createApp ?? createNodeApp)({
    initialState: {
      snapshot: snapshotOf(),
      tick: 0,
      reducedMotion,
      viewport: viewport(),
      logScroll: ui.logScroll,
      logAutoScroll: ui.logAutoScroll,
      ui: { ...ui },
      actions: {},
      bindings: [],
      paletteItems: [],
      entries: [],
      setLogScroll: () => {}
    },
    config: { fpsCap: options.fpsCap ?? 20, executionMode: "worker" }
  });

  const writeRaw = typeof app.backend?.[BACKEND_RAW_WRITE_MARKER] === "function"
    ? app.backend[BACKEND_RAW_WRITE_MARKER].bind(app.backend)
    : undefined;

  const currentLines = () => logLines(filteredLogEntries(snapshotOf(), ui));

  const commit = () => {
    if (teardown || !started) return;
    try {
      app.update((previous) => ({
        ...previous,
        snapshot: snapshotOf(),
        viewport: viewport(),
        logScroll: ui.logScroll,
        logAutoScroll: ui.logAutoScroll,
        ui: { ...ui },
        actions,
        bindings: helpBindings(entries, app.getBindings?.()),
        paletteItems: palette,
        entries,
        setLogScroll: actions.setLogScroll
      }));
    } catch (error) {
      if (!stopping) options.onError?.(error);
    }
  };

  // Rezi rejects lifecycle and state mutation from inside its own key dispatch,
  // so every handler mutates plain state and defers the commit by a microtask.
  const sync = () => {
    if (syncQueued || teardown) return;
    syncQueued = true;
    queueMicrotask(() => {
      syncQueued = false;
      commit();
    });
  };

  const notify = (message) => {
    ui.notice = message;
    sync();
  };

  const requestStop = () => {
    if (stopping) return;
    stopping = true;
    clearInterval(interval);
    interval = undefined;
    setTimeout(() => {
      teardown = true;
      Promise.resolve(app.stop()).catch((error) => {
        options.onError?.(error);
        app.dispose();
      });
    }, 0);
  };

  const intent = (type, payload) => options.onIntent?.({ type, ...payload });

  const clipboardPayload = () => {
    const snapshot = snapshotOf();
    if (topOverlay(ui) === "detail") return detailClipboardText(ui, snapshot);
    const scope = scopeForFocusedId(ui.focusedId);
    if (scope === "targets") return tableClipboardText(targetRows(snapshot), ui.targetSelection, TARGET_COLUMNS);
    if (scope === "generations") return tableClipboardText(generationRows(snapshot), ui.generationSelection, GENERATION_COLUMNS);
    const lines = currentLines();
    return ui.logSelection ? selectedLogText(lines, ui.logSelection) : lines.map((line) => line.text).join("\n");
  };

  const actions = {
    play: () => intent("play"),
    reload: () => intent("reload"),
    rebuild: () => intent("rebuild"),
    quit: requestStop,
    selectView(view) {
      ui.view = view;
      sync();
    },
    openPalette() {
      ui.palette = { query: "", selectedIndex: 0 };
      Object.assign(ui, openOverlay(ui, "palette"));
      sync();
    },
    openHelp() {
      Object.assign(ui, openOverlay(ui, "help"));
      sync();
    },
    openFilter() {
      Object.assign(ui, openOverlay(ui, "filter"));
      sync();
    },
    openDetail(kind, id) {
      ui.detail = { kind, id };
      Object.assign(ui, openOverlay(ui, "detail"));
      sync();
    },
    closeOverlay(id) {
      Object.assign(ui, closeOverlay(ui, id));
      sync();
    },
    closeLayer() {
      const result = closeTopOverlay(ui);
      Object.assign(ui, result.ui);
      if (!result.closed && ui.logSelection) ui.logSelection = undefined;
      sync();
    },
    setPaletteQuery(query) {
      ui.palette = { ...ui.palette, query, selectedIndex: 0 };
      sync();
    },
    setPaletteIndex(selectedIndex) {
      ui.palette = { ...ui.palette, selectedIndex };
      sync();
    },
    runPaletteItem(item) {
      Object.assign(ui, closeOverlay(ui, "palette"));
      sync();
      item?.data?.run?.();
    },
    setFilterQuery(query) {
      ui.filter = { query };
      ui.logAutoScroll = true;
      sync();
    },
    setLogScroll(value) {
      ui.logScroll = Math.max(0, Math.trunc(value));
      ui.logAutoScroll = false;
      sync();
    },
    setLogSelectionScroll(value) {
      ui.logSelectionScroll = Math.max(0, Math.trunc(value));
      sync();
    },
    scrollLogs(delta) {
      ui.logAutoScroll = false;
      ui.logScroll = Math.max(0, ui.logScroll + delta);
      sync();
    },
    scrollLogsHome() {
      ui.logAutoScroll = false;
      ui.logScroll = 0;
      sync();
    },
    followLogs() {
      ui.logAutoScroll = true;
      sync();
    },
    selectTargets(keys) {
      ui.targetSelection = [...keys];
      sync();
    },
    selectGenerations(keys) {
      ui.generationSelection = [...keys];
      sync();
    },
    selectBundle(keys) {
      ui.bundleSelection = [...keys];
      sync();
    },
    selectRuntime(keys) {
      ui.runtimeSelection = [...keys];
      sync();
    },
    setOverviewSizes(sizes) {
      ui.overviewSizes = [...sizes];
      sync();
    },
    selectAll() {
      const snapshot = snapshotOf();
      const scope = scopeForFocusedId(ui.focusedId);
      if (scope === "targets") {
        ui.targetSelection = [...selectAllRows(targetRows(snapshot).map((row) => row.key), ui.targetSelection).selection];
      } else if (scope === "generations") {
        ui.generationSelection = [...selectAllRows(generationRows(snapshot).map((row) => row.key), ui.generationSelection).selection];
      } else {
        ui.logSelection = selectAllRange(currentLines());
      }
      sync();
    },
    clearSelection() {
      ui.logSelection = undefined;
      ui.targetSelection = [];
      ui.generationSelection = [];
      ui.notice = undefined;
      sync();
    },
    copySelection() {
      const text = clipboardPayload();
      const result = copyToClipboard(text, { writeRaw });
      notify(result.copied
        ? `copied ${result.bytes} bytes via ${result.transports.join(" + ")}`
        : `copy failed: ${result.reason}`);
    },
    toggleTargetSelection(rowKey, modifiers) {
      const snapshot = snapshotOf();
      const keys = targetRows(snapshot).map((row) => row.key);
      ui.targetSelection = [...computeSelection(ui.targetSelection, rowKey, "multi", modifiers, keys, ui.lastTargetKey ?? null).selection];
      ui.lastTargetKey = rowKey;
      sync();
    }
  };

  const entries = devKeymapEntries(actions);
  const palette = paletteItems(entries);

  app.view(renderDevDashboard);
  app.keys(bindingMapFrom(entries, () => scopeForFocusedId(ui.focusedId)));

  app.onFocusChange?.((info) => {
    ui.focusedId = info.focusedId ?? null;
    sync();
  });

  // Pointer selection and paste are the two input paths no widget owns for a
  // log console, so they are handled from the raw engine event stream.
  app.onEvent?.((event) => {
    if (event.kind !== "engine") return;
    const raw = event.event;
    if (raw.kind === "paste") {
      const text = decodePaste(raw.bytes).replace(/[\r\n]+/g, " ");
      const top = topOverlay(ui);
      if (top === "palette") actions.setPaletteQuery(`${ui.palette.query}${text}`);
      else if (top === "filter") actions.setFilterQuery(`${ui.filter.query}${text}`);
      return;
    }
    if (raw.kind !== "mouse" || topOverlay(ui)) return;
    const lines = currentLines();
    const rect = app.measureElement?.(ui.logSelection ? PANEL_IDS.logsSelection : PANEL_IDS.logs);
    if (!containsPoint(rect, raw.x, raw.y)) return;
    const first = ui.logSelection
      ? (ui.logSelectionScroll ?? 0)
      : firstVisibleLine(lines.length, ui.logScroll, rect.h, ui.logAutoScroll);
    const caret = pointToCaret({ x: raw.x, y: raw.y }, rect, first, lines);
    if (raw.mouseKind === 3) {
      ui.logDrag = true;
      ui.logSelectionScroll = first;
      ui.logSelection = { anchor: caret, active: caret };
      sync();
      return;
    }
    if (raw.mouseKind === 2 && ui.logDrag && ui.logSelection) {
      ui.logSelection = { anchor: ui.logSelection.anchor, active: caret };
      sync();
      return;
    }
    if (raw.mouseKind === 4 && ui.logDrag) {
      ui.logDrag = false;
      const text = selectedLogText(lines, ui.logSelection);
      if (text.length === 0) ui.logSelection = undefined;
      sync();
    }
  });

  const runPromise = app.run();
  void runPromise.catch(() => {});
  try {
    await app.ready();
    started = true;
    if (!stopping) {
      commit();
      interval = setInterval(() => {
        if (stopping) return;
        try {
          app.update((previous) => ({
            ...previous,
            snapshot: snapshotOf(),
            tick: reducedMotion ? previous.tick : previous.tick + 1,
            viewport: viewport(),
            logScroll: ui.logScroll,
            logAutoScroll: ui.logAutoScroll,
            ui: { ...ui },
            actions,
            bindings: helpBindings(entries, app.getBindings?.()),
            paletteItems: palette,
            entries,
            setLogScroll: actions.setLogScroll
          }));
        } catch (error) {
          if (!stopping) options.onError?.(error);
        }
      }, options.refreshMs ?? (reducedMotion ? 250 : 80));
    }
    await runPromise;
  } finally {
    stopping = true;
    teardown = true;
    clearInterval(interval);
    app.dispose();
  }
}

function projectOptions(projects, cwd) {
  return projects.map((project) => ({
    value: project,
    label: (project.startsWith(cwd) ? project.slice(cwd.length + 1) : project) || "."
  }));
}

export function renderLauncher(state, actions) {
  const options = projectOptions(state.projects, state.cwd);
  const selected = state.selectedProject;
  return (
    <Page
      p={0}
      gap={0}
      header={<Box border="none" px={1} py={0}>{renderLogo(state.tick, state.reducedMotion, true)}</Box>}
      body={
        <Column px={2} py={1} gap={1} height="full" overflow="hidden">
          <Panel title="PROJECT CONTROL" variant="heavy" p={1} gap={1}>
            <Text style={{ fg: options.length ? good : prism[2], bold: true }}>
              {options.length
                ? `${options.length} Defold project${options.length === 1 ? "" : "s"} discovered`
                : "No game.project discovered yet"}
            </Text>
            <Select
              id="project"
              value={selected}
              options={options}
              disabled={options.length === 0}
              placeholder="Select a Defold project"
              onChange={actions.selectProject}
            />
            <Row gap={1}>
              <Button id="start" label="Start dev" disabled={!selected} intent="primary" onPress={() => actions.finish({ type: "dev", project: selected })} />
              <Button id="doctor" label="Doctor" disabled={!selected} onPress={() => actions.finish({ type: "doctor", project: selected })} />
              <Button id="quit" label="Quit" onPress={() => actions.finish({ type: "quit" })} />
            </Row>
          </Panel>
          <Panel title="CREATE" variant="heavy" p={1} gap={1}>
            <Text style={{ fg: dim }}>
              Scaffold a Defold + TypeScript project, generate its SDK, and create its .script proxy.
            </Text>
            <Input
              id="create-path"
              value={state.createPath}
              accessibleLabel="New project directory"
              onInput={actions.setCreatePath}
            />
            <Button
              id="create"
              label="Create project"
              disabled={!state.createPath.trim()}
              intent="success"
              onPress={() => actions.finish({ type: "create", directory: state.createPath.trim() })}
            />
          </Panel>
          <Callout
            message="Start dev opens the operator console; press p there to launch/stop the built game. deherm dev --project <path> starts directly."
            variant="info"
            title="PLAY"
          />
        </Column>
      }
      footer={
        <StatusBar
          left={[uiFactory.text("tab navigate  enter activate")]}
          right={[uiFactory.text("q quit", { style: { fg: prism[0], bold: true } })]}
        />
      }
    />
  );
}

export async function runLauncherTui(options = {}) {
  let result = { type: "quit" };
  let interval;
  let stopping = false;
  const reducedMotion = options.reducedMotion ?? process.env.DEHERM_REDUCED_MOTION === "1";
  const initialProjects = [...(options.projects ?? [])];
  const app = (options.createApp ?? createNodeApp)({
    initialState: {
      cwd: options.cwd ?? process.cwd(),
      projects: initialProjects,
      selectedProject: options.selectedProject ?? initialProjects[0] ?? "",
      createPath: options.createPath ?? "deherm-game",
      reducedMotion,
      tick: 0
    },
    config: { fpsCap: options.fpsCap ?? 20, executionMode: "worker" }
  });
  const finish = (next) => {
    if (stopping) return;
    result = next;
    stopping = true;
    clearInterval(interval);
    interval = undefined;
    setTimeout(() => {
      Promise.resolve(app.stop()).catch((error) => {
        options.onError?.(error);
        app.dispose();
      });
    }, 0);
  };
  const actions = {
    finish,
    selectProject(value) {
      app.update((state) => ({ ...state, selectedProject: value }));
    },
    setCreatePath(value) {
      app.update((state) => ({ ...state, createPath: value }));
    }
  };
  app.view((state) => renderLauncher(state, actions));
  app.keys({ q: { description: "Quit", handler: () => finish({ type: "quit" }) } });
  const runPromise = app.run();
  void runPromise.catch(() => {});
  try {
    await app.ready();
    if (!reducedMotion) {
      interval = setInterval(() => {
        if (!stopping) app.update((state) => ({ ...state, tick: state.tick + 1 }));
      }, options.refreshMs ?? 80);
    }
    await runPromise;
  } finally {
    stopping = true;
    clearInterval(interval);
    app.dispose();
  }
  return result;
}

export { devKeymapEntries, footerText, helpBindings, paletteItems } from "./keymap.mjs";
