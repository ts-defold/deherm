import { getSelectedText, normalizeSelection, ui } from "@rezi-ui/core";

import { basaltRamp, dim, prism } from "./theme.mjs";

const LEVEL_COLOR = {
  trace: dim,
  debug: dim,
  info: prism[4],
  warn: prism[1],
  error: prism[0],
  fatal: prism[0]
};

function clock(value) {
  if (!Number.isFinite(value)) return "--:--:--";
  const date = new Date(value);
  const pad = (part) => String(part).padStart(2, "0");
  return `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
}

/**
 * Flatten log entries into the exact plain-text lines a selection copies. The
 * rendered rows and the clipboard payload come from this one array, so what an
 * operator sees highlighted is byte-for-byte what lands on their clipboard.
 */
export function logLines(entries) {
  return entries.map((entry) => ({
    id: entry.id,
    level: entry.level ?? "info",
    text: `${clock(entry.timestamp)} ${String(entry.level ?? "info").toUpperCase().padEnd(5)} ${String(entry.source ?? "deherm").padEnd(14)} ${entry.message ?? ""}`
  }));
}

export function clampScroll(scrollTop, lineCount, height) {
  const maximum = Math.max(0, lineCount - Math.max(1, height));
  if (!Number.isFinite(scrollTop) || scrollTop <= 0) return 0;
  return Math.min(Math.trunc(scrollTop), maximum);
}

/** Index of the first visible line, matching LogsConsole's tail-following. */
export function firstVisibleLine(lineCount, scrollTop, height, autoScroll) {
  const rows = Math.max(1, Math.trunc(height));
  return autoScroll ? Math.max(0, lineCount - rows) : clampScroll(scrollTop, lineCount, rows);
}

/** Selection range covered on one line, or null when the line is untouched. */
export function lineSelectionRange(selection, lineIndex, lineLength) {
  if (!selection) return null;
  const [start, end] = normalizeSelection(selection);
  if (lineIndex < start.line || lineIndex > end.line) return null;
  const from = lineIndex === start.line ? Math.max(0, Math.min(start.column, lineLength)) : 0;
  const to = lineIndex === end.line ? Math.max(0, Math.min(end.column, lineLength)) : lineLength;
  return to <= from ? null : [from, to];
}

export function selectedLogText(lines, selection) {
  if (!selection) return "";
  return getSelectedText(lines.map((line) => line.text), selection);
}

export function selectAllRange(lines) {
  if (lines.length === 0) return undefined;
  const last = lines.length - 1;
  return { anchor: { line: 0, column: 0 }, active: { line: last, column: lines[last].text.length } };
}

/** Translate a terminal cell inside the log rect into a caret position. */
export function pointToCaret(point, rect, firstLine, lines) {
  const row = Math.max(0, Math.min(Math.max(0, rect.h - 1), point.y - rect.y));
  const line = Math.max(0, Math.min(Math.max(0, lines.length - 1), firstLine + row));
  const length = lines[line]?.text.length ?? 0;
  const column = Math.max(0, Math.min(length, point.x - rect.x));
  return { line, column };
}

export function containsPoint(rect, x, y) {
  return Boolean(rect) && x >= rect.x && x < rect.x + rect.w && y >= rect.y && y < rect.y + rect.h;
}

const selectionStyle = { fg: basaltRamp[0], bg: prism[2] };

/**
 * Render one log row with an inline selection highlight.
 *
 * Selection is the one part of the log view the framework does not own:
 * LogsConsole has no selection model, so an active selection swaps in a
 * VirtualList — the framework still owns windowing, wheel, and keyboard — whose
 * rows are painted here.
 */
export function renderLogRow(line, selection, index) {
  const base = { fg: LEVEL_COLOR[line.level] ?? dim };
  const range = lineSelectionRange(selection, index, line.text.length);
  if (range === null) return ui.text(line.text, { style: base, textOverflow: "ellipsis" });
  return ui.richText([
    ...(range[0] > 0 ? [{ text: line.text.slice(0, range[0]), style: base }] : []),
    { text: line.text.slice(range[0], range[1]), style: selectionStyle },
    ...(range[1] < line.text.length ? [{ text: line.text.slice(range[1]), style: base }] : [])
  ]);
}

export function selectionSummary(lines, selection) {
  if (!selection) return undefined;
  const [start, end] = normalizeSelection(selection);
  const rows = end.line - start.line + 1;
  const text = selectedLogText(lines, selection);
  return `${rows} line${rows === 1 ? "" : "s"} · ${text.length} chars selected · y copies`;
}
