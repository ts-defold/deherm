import { closeTopmostLayer, createLayerStackState, getTopmostLayerId, popLayer, pushLayer } from "@rezi-ui/core";

/**
 * Every overlay the console can raise. The stack is the core layer stack, so
 * Escape unwinds one overlay at a time in the order they were opened rather
 * than dismissing the whole console.
 */
export const OVERLAYS = { palette: "palette", help: "help", filter: "filter", detail: "detail" };

export function createUiState(overrides = {}) {
  return {
    view: "overview",
    focusedId: null,
    layers: createLayerStackState(),
    palette: { query: "", selectedIndex: 0 },
    filter: { query: "" },
    detail: undefined,
    logScroll: 0,
    logAutoScroll: true,
    logSelection: undefined,
    logDrag: undefined,
    targetSelection: [],
    generationSelection: [],
    overviewSizes: [50, 50],
    notice: undefined,
    ...overrides
  };
}

export function topOverlay(ui) {
  return getTopmostLayerId(ui.layers);
}

export function openOverlay(ui, id) {
  if (topOverlay(ui) === id) return ui;
  const base = ui.layers.stack.includes(id) ? popLayer(ui.layers, id).state : ui.layers;
  return { ...ui, layers: pushLayer(base, id) };
}

export function closeOverlay(ui, id) {
  const { state } = popLayer(ui.layers, id);
  return { ...ui, layers: state };
}

export function closeTopOverlay(ui) {
  const { state, closed } = closeTopmostLayer(ui.layers);
  return { ui: { ...ui, layers: state }, closed };
}

/**
 * Fill in anything a caller left out. The dashboard renderer is a pure function
 * of state and is exercised directly by tests with a minimal state object, so
 * it must never assume the full interactive shell is wired up.
 */
export function normalizeState(state) {
  const ui = state.ui ?? createUiState({
    logScroll: state.logScroll ?? 0,
    logAutoScroll: state.logAutoScroll ?? true
  });
  return {
    tick: state.tick ?? 0,
    reducedMotion: state.reducedMotion ?? false,
    viewport: state.viewport ?? { cols: 120, rows: 30 },
    snapshot: state.snapshot ?? {},
    bindings: state.bindings ?? [],
    entries: state.entries ?? [],
    paletteItems: state.paletteItems ?? [],
    actions: state.actions ?? {},
    setLogScroll: state.setLogScroll,
    ui
  };
}
