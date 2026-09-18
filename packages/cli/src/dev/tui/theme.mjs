import { rgb } from "@rezi-ui/core";

// Exact xterm-256 RGB values. Keeping the palette representable in 256-color
// terminals avoids a different identity in truecolor and indexed modes.
export const prism = [rgb(215, 95, 0), rgb(215, 135, 0), rgb(215, 175, 95), rgb(95, 95, 135), rgb(0, 175, 215)];
export const basaltRamp = [rgb(38, 38, 38), rgb(48, 48, 48), rgb(58, 58, 58), rgb(68, 68, 68), rgb(88, 88, 88)];
export const heartRamp = [rgb(175, 0, 0), rgb(215, 0, 0), rgb(255, 0, 0)];
export const basalt = basaltRamp[3];
export const dim = rgb(95, 95, 95);
export const good = rgb(95, 215, 135);
export const bad = rgb(255, 95, 95);

export function formatBytes(bytes = 0) {
  // Byte deltas are signed, so the unit is chosen from the magnitude; picking it
  // from the signed value would print a megabyte shrink as a raw byte count.
  const magnitude = Math.abs(bytes);
  if (magnitude < 1024) return `${bytes} B`;
  if (magnitude < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 ** 2).toFixed(2)} MiB`;
}

export function delta(value = 0) {
  return `${value > 0 ? "+" : ""}${formatBytes(value)}`;
}

export function statusColor(status) {
  return status === "failed" || status?.includes("failed")
    ? bad
    : status === "ready" || status === "connected"
      ? good
      : prism[4];
}

// Activation is never inferred from a successful build or a "ready" phase: a
// target counts as applied only when its own acknowledged generation catches up
// with the last generation this session actually produced.
export function targetActivation(snapshot) {
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

export function phaseProgress(snapshot, phase) {
  if (phase === "activate") return targetActivation(snapshot).progress;
  const order = ["idle", "building", "built", "reloading", "awaiting-activation", "ready"];
  if (snapshot.phase === "failed") return phase === "build" ? 1 : 0;
  const index = order.indexOf(snapshot.phase);
  const threshold = { watch: 0, build: 2, bundle: 2, signal: 3 }[phase];
  return index >= threshold ? 1 : index === threshold - 1 ? 0.5 : 0;
}

export function stableLogKey(entry) {
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

const logLevels = ["trace", "debug", "info", "warn", "error", "fatal"];

// The engine's bounded log window slides, so a row identity derived from the
// entry itself keeps list state (selection, expansion) attached to the same
// line rather than to an index that shifts under it.
export function logEntries(snapshot) {
  const occurrences = new Map();
  return (snapshot.logs ?? []).map((entry) => {
    const base = stableLogKey(entry);
    const occurrence = occurrences.get(base) ?? 0;
    occurrences.set(base, occurrence + 1);
    return {
      id: occurrence === 0 ? base : `${base}-${occurrence}`,
      timestamp: entry.at,
      level: logLevels.includes(entry.level) ? entry.level : "info",
      source: entry.source ?? "deherm",
      message: entry.message
    };
  });
}

export function shortFingerprint(value) {
  return typeof value === "string" && value.length > 12 ? value.slice(0, 12) : value ?? "—";
}

export function layoutMode(viewport) {
  const { cols = 120, rows = 30 } = viewport ?? {};
  if (cols < 100 || rows < 28) return "compact";
  if (cols < 140 || rows < 42) return "medium";
  return "wide";
}
