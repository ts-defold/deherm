// The keymap is the single source of truth for the operator console's input
// surface. The footer strip, the `?` help overlay, the `:` command palette, and
// the bindings actually registered with Rezi are all projections of this one
// table, so an advertised key cannot drift away from a key that works.

export const VIEWS = [
  { key: "overview", label: "Overview", hotkey: "o" },
  { key: "targets", label: "Targets", hotkey: "t" },
  { key: "generations", label: "Generations", hotkey: "g" },
  { key: "instances", label: "Instances", hotkey: "i" }
];

// Focus scope for every panel that owns keys. Rezi routes Tab/Shift-Tab across
// these widgets; a binding declared for a scope only fires while that scope
// holds focus, and otherwise falls through to the focused widget's own router.
export const PANEL_IDS = {
  views: "deherm-views",
  pipeline: "deherm-pipeline",
  bundle: "deherm-bundle",
  targets: "deherm-targets",
  runtime: "deherm-runtime",
  generations: "deherm-generations",
  instances: "deherm-instances",
  logs: "deherm-logs",
  logsSelection: "deherm-logs-selection"
};

const SCOPE_BY_ID = new Map(Object.entries(PANEL_IDS).map(([scope, id]) => [id, scope]));
// The selection viewport replaces the log console in place; both belong to the
// logs panel so scoped log keys keep working while a selection is live.
SCOPE_BY_ID.set(PANEL_IDS.logsSelection, "logs");

export function scopeForFocusedId(focusedId) {
  return SCOPE_BY_ID.get(focusedId ?? "") ?? "none";
}

export const PANEL_TITLES = {
  pipeline: "EDIT LOOP",
  bundle: "BUNDLE / CACHE",
  targets: "TARGETS / GENERATIONS",
  runtime: "RUNTIME HEALTH",
  generations: "GENERATIONS",
  instances: "RUNTIME INSTANCES",
  logs: "LIVE LOGS"
};

// A table row rather than a flat map: order is meaningful for the footer and
// for help, and every column is consumed somewhere.
//   sequence  key string registered with Rezi (null = routed by the runtime)
//   scope     "global", or the panel that must hold focus
//   group     help section
//   footer    "always" | "wide" | "never"
export function devKeymapEntries(actions = {}) {
  const call = (name, ...args) => () => actions[name]?.(...args);
  const entries = [
    { sequence: "p", scope: "global", group: "Session", description: "Launch or stop the built Defold game", hint: "play/stop", footer: "always", run: call("play") },
    { sequence: "r", scope: "global", group: "Session", description: "Signal a hot reload to every target", hint: "reload", footer: "always", run: call("reload") },
    { sequence: "b", scope: "global", group: "Session", description: "Full rebuild and relaunch", hint: "rebuild", footer: "wide", run: call("rebuild") },
    { sequence: "q", scope: "global", group: "Session", description: "Quit the dev session and stop the engine", hint: "quit", footer: "never", run: call("quit") },

    { sequence: "o", scope: "global", group: "Views", description: "Overview", hint: "overview", footer: "never", run: call("selectView", "overview") },
    { sequence: "t", scope: "global", group: "Views", description: "Targets: generation, fingerprint, phase, telemetry", hint: "targets", footer: "always", run: call("selectView", "targets") },
    { sequence: "g", scope: "global", group: "Views", description: "Generations: build timeline and activation outcome", hint: "generations", footer: "always", run: call("selectView", "generations") },
    { sequence: "i", scope: "global", group: "Views", description: "Runtime instances", hint: "instances", footer: "wide", run: call("selectView", "instances") },

    { sequence: null, scope: "global", group: "Focus", description: "Focus the next panel", routedBy: "focus runtime", hint: "focus", footer: "wide", sequenceLabel: "tab" },
    { sequence: null, scope: "global", group: "Focus", description: "Focus the previous panel", routedBy: "focus runtime", footer: "never", sequenceLabel: "shift+tab" },
    { sequence: "escape", scope: "global", group: "Focus", description: "Close the topmost overlay", hint: "close", footer: "never", run: call("closeLayer") },

    { sequence: ":", scope: "global", group: "Commands", description: "Command palette over every action", hint: "commands", footer: "always", run: call("openPalette") },
    { sequence: "?", scope: "global", group: "Commands", description: "Keybinding help", hint: "help", footer: "always", run: call("openHelp") },

    { sequence: "y", scope: "global", group: "Selection", description: "Copy the focused panel's selection to the clipboard", hint: "copy", footer: "wide", run: call("copySelection") },
    { sequence: "ctrl+a", scope: "global", group: "Selection", description: "Select everything in the focused panel", footer: "never", run: call("selectAll") },
    { sequence: "ctrl+c", scope: "global", group: "Selection", description: "Clear the current selection", footer: "never", run: call("clearSelection") },

    { sequence: "/", scope: "global", group: "Logs", description: "Filter the log stream", hint: "filter", footer: "wide", run: call("openFilter") },
    { sequence: "f", scope: "global", group: "Logs", description: "Follow the newest log entries", hint: "follow", footer: "always", run: call("followLogs") },
    { sequence: "up", scope: "logs", group: "Logs", description: "Scroll logs up one line", hint: "scroll", footer: "always", run: call("scrollLogs", -1) },
    { sequence: "down", scope: "logs", group: "Logs", description: "Scroll logs down one line", footer: "never", run: call("scrollLogs", 1) },
    { sequence: "ctrl+u", scope: "logs", group: "Logs", description: "Scroll logs up one page", footer: "never", run: call("scrollLogs", -10) },
    { sequence: "ctrl+d", scope: "logs", group: "Logs", description: "Scroll logs down one page", footer: "never", run: call("scrollLogs", 10) },
    { sequence: "pageup", scope: "logs", group: "Logs", description: "Scroll logs up one page", footer: "never", run: call("scrollLogs", -10) },
    { sequence: "pagedown", scope: "logs", group: "Logs", description: "Scroll logs down one page", footer: "never", run: call("scrollLogs", 10) },
    { sequence: "home", scope: "logs", group: "Logs", description: "Jump to the oldest retained log entry", footer: "never", run: call("scrollLogsHome") },
    { sequence: "end", scope: "logs", group: "Logs", description: "Follow the newest log entries", footer: "never", run: call("followLogs") },

    { sequence: null, scope: "targets", group: "Targets", description: "Open the focused target", routedBy: "table runtime", sequenceLabel: "enter", footer: "never" },
    { sequence: null, scope: "generations", group: "Generations", description: "Open the focused generation", routedBy: "table runtime", sequenceLabel: "enter", footer: "never" }
  ];
  return entries.map((entry) => Object.freeze({ ...entry, label: entry.sequenceLabel ?? entry.sequence }));
}

// Rezi's chord trie holds one binding per sequence, so a sequence shared by two
// panels is registered once and guarded by `when`. A guard that rejects leaves
// the event unconsumed, and the focused widget's own router receives it.
export function bindingMapFrom(entries, scopeOf) {
  const map = {};
  for (const entry of entries) {
    if (!entry.sequence || typeof entry.run !== "function") continue;
    if (map[entry.sequence]) continue;
    map[entry.sequence] = entry.scope === "global"
      ? { description: entry.description, handler: entry.run }
      : { description: entry.description, handler: entry.run, when: () => scopeOf() === entry.scope };
  }
  return map;
}

export function footerText(entries, mode) {
  const wanted = mode === "compact" ? ["always"] : ["always", "wide"];
  const parts = [];
  for (const entry of entries) {
    if (!entry.hint || !wanted.includes(entry.footer)) continue;
    const label = entry.label ?? entry.sequence;
    const text = `${label} ${entry.hint}`;
    if (!parts.includes(text)) parts.push(text);
  }
  return parts.join("  ");
}

// Help renders from the bindings the app actually registered when the runtime
// can report them; the keymap supplies the rows the runtime does not own
// (Tab traversal, table Enter) so the overlay stays complete.
export function helpBindings(entries, registered) {
  const rows = [];
  const seen = new Set();
  const push = (sequence, description, mode) => {
    const identity = `${mode}\u0000${sequence}`;
    if (!sequence || seen.has(identity)) return;
    seen.add(identity);
    rows.push({ sequence, description, mode });
  };
  for (const binding of registered ?? []) push(binding.sequence, binding.description ?? "", binding.mode ?? "default");
  for (const entry of entries) {
    push(entry.label ?? entry.sequence, entry.description, entry.scope === "global" ? "default" : entry.scope);
  }
  return rows;
}

export function paletteItems(entries) {
  return entries
    .filter((entry) => typeof entry.run === "function")
    .map((entry) => ({
      id: `keymap:${entry.scope}:${entry.label}`,
      label: entry.description,
      description: entry.scope === "global" ? entry.group : `${entry.group} · needs ${entry.scope} focus`,
      shortcut: entry.label,
      sourceId: "actions",
      data: entry
    }));
}
