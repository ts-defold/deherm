import { createNodeApp } from "@rezi-ui/node";
import { rgb, ui } from "@rezi-ui/core";

// Exact xterm-256 RGB values. Keeping the palette representable in 256-color
// terminals avoids a different identity in truecolor and indexed modes.
const prism = [rgb(215, 95, 0), rgb(215, 135, 0), rgb(215, 175, 95), rgb(95, 95, 135), rgb(0, 175, 215)];
const basaltRamp = [rgb(38, 38, 38), rgb(48, 48, 48), rgb(58, 58, 58), rgb(68, 68, 68), rgb(88, 88, 88)];
const heartRamp = [rgb(175, 0, 0), rgb(215, 0, 0), rgb(255, 0, 0)];
const basalt = basaltRamp[3];
const dim = rgb(95, 95, 95);
const good = rgb(95, 215, 135);
const bad = rgb(255, 95, 95);

// Fourteen raster rows become seven terminal rows through upper/lower half-blocks.
// The floating acute is part of the bitmap instead of depending on font shaping.
const glyphs = {
  d: [".....##", ".....##", ".....##", ".######", "#######", "##...##", "##...##", "##...##", "##...##", "##...##", "##...##", "##...##", "#######", ".######"],
  é: ["...##..", "..##...", ".......", ".#####.", "#######", "##...##", "#######", "#######", "##.....", "##.....", "##.....", "##.....", "#######", ".#####."],
  h: ["##.....", "##.....", "##.....", "######.", "#######", "##...##", "##...##", "##...##", "##...##", "##...##", "##...##", "##...##", "##...##", "##...##"],
  e: [".......", ".......", ".......", ".#####.", "#######", "##...##", "#######", "#######", "##.....", "##.....", "##.....", "##.....", "#######", ".#####."],
  r: ["......", "......", "......", "##.###", "######", "###...", "##....", "##....", "##....", "##....", "##....", "##....", "##....", "##...."],
  m: [".........", ".........", ".........", "##.##.##.", "########.", "##.##.##.", "##.##.##.", "##.##.##.", "##.##.##.", "##.##.##.", "##.##.##.", "##.##.##.", "##.##.##.", "##.##.##."],
  heart: ["........", "........", "........", ".##..##.", "########", "########", "########", "########", ".######.", ".######.", "..####..", "...##...", "...##...", "........"]
};

function formatBytes(bytes = 0) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 ** 2).toFixed(2)} MiB`;
}

function delta(value = 0) {
  return `${value > 0 ? "+" : ""}${formatBytes(value)}`;
}

function targetActivation(snapshot) {
  const generation = snapshot.lastSuccessfulGeneration ?? 0;
  const targets = snapshot.targets ?? [];
  if (generation <= 0 || targets.length === 0) return { generation, applied: 0, total: targets.length, progress: 0 };
  const applied = targets.filter((target) => (target.appliedGeneration ?? 0) >= generation).length;
  const awaiting = targets.some((target) => target.pendingGeneration === generation || target.signalledGeneration === generation);
  return {
    generation,
    applied,
    total: targets.length,
    progress: applied === targets.length ? 1 : applied > 0 || awaiting ? 0.5 : 0
  };
}

function phaseProgress(snapshot, phase) {
  if (phase === "activate") return targetActivation(snapshot).progress;
  const order = ["idle", "building", "built", "reloading", "awaiting-activation", "ready"];
  if (snapshot.phase === "failed") return phase === "build" ? 1 : 0;
  const index = order.indexOf(snapshot.phase);
  const threshold = { watch: 0, build: 2, bundle: 2, signal: 3 }[phase];
  return index >= threshold ? 1 : index === threshold - 1 ? 0.5 : 0;
}

function statusColor(status) {
  return status === "failed" || status?.includes("failed") ? bad : status === "ready" || status === "connected" ? good : prism[4];
}

function logoPixels() {
  const names = ["d", "é", "h", "e", "r", "m", "heart"];
  return Array.from({ length: 14 }, (_, y) => names.flatMap((name, index) => {
    const pixels = [...glyphs[name][y]].map((pixel) => ({ on: pixel === "#", heart: name === "heart" }));
    const gap = index === names.length - 1 ? [] : [{ on: false, heart: false }];
    return [...pixels, ...gap];
  }));
}

const logoBitmap = logoPixels();

function bitmapColor(pixel, x, y, frame) {
  if (!pixel.on) return undefined;
  if (pixel.heart) return heartRamp[Math.min(heartRamp.length - 1, Math.floor((y - 3) / 3) + ((x + frame) % 19 === 0 ? 1 : 0))];
  if (y >= 9) return prism[Math.min(prism.length - 1, y - 9)];
  const glintDistance = Math.abs((x + frame) % 31 - 15);
  return basaltRamp[glintDistance <= 1 ? 4 : glintDistance <= 3 ? 3 : glintDistance <= 5 ? 2 : 1];
}

const basaltGrain = ["⣿", "⣷", "⣯", "⣟", "⡿"];

function halfBlock(top, bottom, options) {
  if (top === undefined && bottom === undefined) return { text: " ", style: {} };
  if (top !== undefined && bottom !== undefined) {
    if (options.basaltPair) {
      const grain = basaltGrain[(options.x * 7 + options.row * 3) % basaltGrain.length];
      return { text: grain, style: { fg: top, bg: basaltRamp[0] } };
    }
    if (options.heartPair && top === bottom) return { text: "▓", style: { fg: top, bg: heartRamp[0] } };
    if (top === bottom) return { text: "█", style: { fg: top } };
    return { text: "▀", style: { fg: top, bg: bottom } };
  }
  return top !== undefined ? { text: "▀", style: { fg: top } } : { text: "▄", style: { fg: bottom } };
}

function renderBitmapRow(topPixels, bottomPixels, frame, topRow) {
  const spans = [];
  let previous;
  for (let x = 0; x < topPixels.length; x += 1) {
    const cell = halfBlock(
      bitmapColor(topPixels[x], x, topRow, frame),
      bitmapColor(bottomPixels[x], x, topRow + 1, frame),
      {
        x,
        row: topRow,
        basaltPair: topRow + 1 < 9 && topPixels[x].on && bottomPixels[x].on && !topPixels[x].heart && !bottomPixels[x].heart,
        heartPair: topPixels[x].heart && bottomPixels[x].heart
      }
    );
    const styleKey = `${cell.style.fg ?? ""}/${cell.style.bg ?? ""}`;
    if (previous?.styleKey === styleKey) previous.text += cell.text;
    else {
      previous = { styleKey, ...cell };
      spans.push(previous);
    }
  }
  return ui.richText(spans.map(({ text, style }) => ({ text, style })));
}

function renderLogo(tick, reducedMotion, tagline) {
  const frame = reducedMotion ? 0 : Math.floor(tick / 2);
  const rows = [];
  for (let row = 0; row < logoBitmap.length; row += 2) {
    rows.push(renderBitmapRow(logoBitmap[row], logoBitmap[row + 1], frame, row));
  }
  if (tagline) rows.push(ui.text("  déherm · TypeScript at engine speed", { style: { fg: prism[2], bold: true } }));
  return ui.column({ gap: 0 }, rows);
}

function renderSessionPlate(snapshot) {
  const activation = targetActivation(snapshot);
  const applied = activation.total === 0 ? "ACK UNVERIFIED" : `ACK ${activation.applied}/${activation.total}`;
  return ui.box({ border: "heavy", px: 1, py: 0, height: 7, borderStyle: { fg: prism[0] } }, [
    ui.text("déherm dev // operator console", { style: { fg: prism[2], bold: true } }),
    ui.text("DYNAMIC HERMES", { style: { fg: prism[4], bold: true } }),
    ui.text(`BUNDLE ${snapshot.lastSuccessfulGeneration ?? 0}`, { style: { fg: basaltRamp[4] } }),
    ui.text(applied, { style: { fg: activation.progress === 1 ? good : prism[4], bold: true } }),
    ui.text(snapshot.phase ?? "idle", { style: { fg: dim } })
  ]);
}

function renderCompactLogo() {
  return ui.richText([
    { text: "▰ ", style: { fg: prism[4] } },
    { text: "déherm", style: { fg: basaltRamp[4], bold: true } },
    { text: " ♥", style: { fg: heartRamp[2], bold: true } },
    { text: "  TypeScript at engine speed", style: { fg: prism[2] } }
  ]);
}

function renderPipeline(snapshot, compact = false) {
  const stages = [["watch", "watcher"], ["build", "ttsc"], ["bundle", "bundle"], ["signal", "signal"], ["activate", "activate"]];
  const activation = targetActivation(snapshot);
  const activationText = activation.total === 0 ? "applied unverified" : `applied ${activation.applied}/${activation.total}`;
  const content = compact
    ? [
        ui.text("watch › ttsc › bundle › signal › ack", { style: { fg: prism[2], bold: true }, textOverflow: "ellipsis" }),
        ui.progress(activation.progress, { label: "runtime ack", variant: "blocks", showPercent: false, dsTone: "accent" })
      ]
    : stages.map(([key, label]) => ui.progress(phaseProgress(snapshot, key), {
        label: label.padEnd(9),
        variant: "blocks",
        showPercent: false,
        dsTone: snapshot.phase === "failed" ? "danger" : "accent"
      }));
  return ui.panel({ title: "EDIT LOOP", variant: "heavy", p: 1, gap: 0 }, [
    ...content,
    ui.text(`built ${snapshot.lastSuccessfulGeneration ?? 0} · ${activationText}`, { style: { fg: statusColor(snapshot.phase), bold: true } }),
    ui.text(snapshot.phase ?? "idle", { style: { fg: dim } })
  ]);
}

function renderBundle(snapshot) {
  const metrics = snapshot.lastBuildMetrics ?? {};
  const recent = snapshot.activeBuild?.changedSources ?? snapshot.history?.at(-1)?.resources ?? [];
  const modules = metrics.modules?.slice(0, 2) ?? [];
  return ui.panel({ title: "BUNDLE / CACHE", variant: "heavy", p: 1, gap: 0 }, [
    ui.text(`${formatBytes(metrics.bytes)}  ${delta(metrics.byteDelta)}  ${metrics.moduleCount ?? 0} modules`, { style: { fg: prism[2], bold: true } }),
    ui.text(`build ${(metrics.durationMs ?? 0).toFixed(1)} ms`, { style: { fg: dim } }),
    ui.divider({ label: "largest retained" }),
    ...(modules.length ? modules.map((module) => ui.text(`${formatBytes(module.bytes).padStart(10)}  ${module.file}`, { textOverflow: "middle" })) : [ui.text("waiting for first bundle", { style: { fg: dim } })]),
    ui.divider({ label: "recent files" }),
    ...(recent.length ? recent.slice(0, 1).map((file) => ui.text(`› ${file}`, { textOverflow: "middle" })) : [ui.text("no pending edits", { style: { fg: dim } })])
  ]);
}

function renderTargets(snapshot, compact = false) {
  const targets = snapshot.targets ?? [];
  const visible = compact ? targets.slice(0, 2) : targets;
  return ui.panel({ title: "TARGETS / GENERATIONS", variant: "heavy", p: 1, gap: 0 }, [
    ...(visible.length ? visible.map((target) => ui.column({ gap: 0 }, [
      ui.row({ justify: "between" }, [
        ui.text(target.name ?? target.id, { style: { bold: true }, textOverflow: "ellipsis" }),
        ui.text(target.status, { style: { fg: statusColor(target.status) }, textOverflow: "ellipsis" })
      ]),
      ui.text(`applied ${target.appliedGeneration ?? "—"}  signalled ${target.signalledGeneration ?? "—"}${compact ? "" : `  ${target.url ?? ""}`}`, { style: { fg: dim }, textOverflow: "middle" })
    ])) : [ui.text("no target connected · activation unverified", { style: { fg: dim }, textOverflow: "ellipsis" })]),
    ...(compact && targets.length > visible.length ? [ui.text(`+ ${targets.length - visible.length} more targets`, { style: { fg: dim } })] : [])
  ]);
}

function renderRuntime(snapshot) {
  const telemetry = snapshot.targets?.[0]?.telemetry ?? {};
  const frame = telemetry.frameMs ?? 0;
  const heap = telemetry.hermesHeapBytes ?? 0;
  const roots = telemetry.hermesRoots ?? 0;
  const arena = telemetry.arenaHighWaterBytes ?? 0;
  return ui.panel({ title: "RUNTIME HEALTH", variant: "heavy", p: 1, gap: 0 }, [
    ui.row({ justify: "between" }, [ui.text("frame"), ui.text(`${frame.toFixed(2)} ms`, { style: { fg: frame > 16.7 ? bad : good } })]),
    ui.sparkline(telemetry.frameSamples ?? [0], { height: 2, min: 0, max: Math.max(20, ...(telemetry.frameSamples ?? [0])), style: { fg: prism[4] } }),
    ui.text(`Hermes heap ${formatBytes(heap)}  roots ${roots}`),
    ui.text(`arena high-water ${formatBytes(arena)}`),
    ui.text(`Lua registry ${telemetry.luaRegistryUsed ?? 0}/${telemetry.luaRegistryCapacity ?? 0}  dropped ${telemetry.droppedEvents ?? 0}`, { style: { fg: dim } })
  ]);
}

function stableLogKey(entry) {
  if (entry.sequence !== undefined) return `log-${entry.sequence}`;
  if (entry.id !== undefined) return String(entry.id);
  const value = `${entry.at ?? ""}\u0000${entry.level ?? ""}\u0000${entry.source ?? ""}\u0000${entry.message ?? ""}`;
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `log-${(hash >>> 0).toString(36)}`;
}

function renderLogs(state, height) {
  const occurrences = new Map();
  const entries = (state.snapshot.logs ?? []).map((entry) => {
    const base = stableLogKey(entry);
    const occurrence = occurrences.get(base) ?? 0;
    occurrences.set(base, occurrence + 1);
    return {
      id: occurrence === 0 ? base : `${base}-${occurrence}`,
      timestamp: entry.at,
      level: ["trace", "debug", "info", "warn", "error", "fatal"].includes(entry.level) ? entry.level : "info",
      source: entry.source,
      message: entry.message
    };
  });
  return ui.box({ title: "LIVE LOGS", border: "heavy", p: 0, style: { fg: basalt }, width: "full" }, [
    ui.logsConsole({ id: "deherm-logs", entries, scrollTop: state.logScroll, autoScroll: true, showSource: true, showTimestamps: true, onScroll: state.setLogScroll, height })
  ]);
}

function layoutMode(state) {
  const { cols = 120, rows = 30 } = state.viewport ?? {};
  if (cols < 100 || rows < 28) return "compact";
  if (cols < 140 || rows < 42) return "medium";
  return "wide";
}

export function renderDevDashboard(state) {
  const snapshot = state.snapshot;
  const mode = layoutMode(state);
  const compact = mode === "compact";
  const main = mode === "wide"
    ? ui.grid({ columns: "1fr 1fr", rows: "1fr 1fr", gap: 1, width: "full", height: 22 }, renderPipeline(snapshot), renderBundle(snapshot), renderTargets(snapshot), renderRuntime(snapshot))
    : ui.grid({ columns: "1fr 1fr", rows: "1fr", gap: 1, width: "full", height: compact ? 12 : 14 }, renderPipeline(snapshot, compact), renderTargets(snapshot, compact));
  const footer = compact ? "r reload  b build  t targets  : commands" : "r reload  b rebuild  t targets  i instances  g generations  : commands  ? help";
  return ui.page({
    p: 0,
    gap: 0,
    header: ui.box({ border: "none", px: 1, py: 0 }, [compact
      ? renderCompactLogo()
      : ui.row({ justify: "between", align: "start", width: "full" }, [
          renderLogo(state.tick, state.reducedMotion, mode === "wide"),
          renderSessionPlate(snapshot)
        ])]),
    body: ui.column({ px: 1, gap: 1, height: "full", overflow: "hidden" }, [main, renderLogs(state, mode === "wide" ? 10 : 5)]),
    footer: ui.statusBar({
      left: [ui.text(footer, { textOverflow: "ellipsis" })],
      right: [ui.text("q detach", { style: { fg: prism[0], bold: true } })],
      style: { fg: basalt }
    })
  });
}

export async function runDevTui(options) {
  let logScroll = 0;
  let interval;
  let stopping = false;
  const reducedMotion = options.reducedMotion ?? process.env.DEHERM_REDUCED_MOTION === "1";
  const setLogScroll = (value) => { logScroll = value; };
  const viewport = () => options.viewport?.() ?? { cols: process.stdout.columns ?? 120, rows: process.stdout.rows ?? 30 };
  const app = (options.createApp ?? createNodeApp)({
    initialState: { snapshot: options.snapshot(), tick: 0, reducedMotion, viewport: viewport(), logScroll, setLogScroll },
    config: { fpsCap: options.fpsCap ?? 20, executionMode: "worker" }
  });
  app.view(renderDevDashboard);
  const intent = (type) => () => options.onIntent?.({ type });
  const requestStop = () => {
    if (stopping) return;
    stopping = true;
    clearInterval(interval);
    interval = undefined;
    // Rezi rejects lifecycle mutation from inside its key event dispatch.
    setTimeout(() => {
      Promise.resolve(app.stop()).catch((error) => {
        options.onError?.(error);
        app.dispose();
      });
    }, 0);
  };
  app.keys({
    q: { description: "Detach and quit", handler: requestStop },
    r: { description: "Signal hot reload", handler: intent("reload") },
    b: { description: "Full rebuild", handler: intent("rebuild") },
    t: { description: "Open targets", handler: intent("targets") },
    i: { description: "Open instances", handler: intent("instances") },
    g: { description: "Open generations", handler: intent("generations") },
    ":": { description: "Command palette", handler: intent("commands") },
    "?": { description: "Help", handler: intent("help") }
  });
  const runPromise = app.run();
  void runPromise.catch(() => {});
  try {
    await app.ready();
    if (!stopping) {
      interval = setInterval(() => {
        if (stopping) return;
        try {
          app.update((previous) => ({
            ...previous,
            snapshot: options.snapshot(),
            tick: reducedMotion ? previous.tick : previous.tick + 1,
            viewport: viewport(),
            logScroll,
            setLogScroll
          }));
        } catch (error) {
          if (!stopping) options.onError?.(error);
        }
      }, options.refreshMs ?? (reducedMotion ? 250 : 80));
    }
    await runPromise;
  } finally {
    stopping = true;
    clearInterval(interval);
    app.dispose();
  }
}
