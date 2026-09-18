// Shared runtime diagnostic classification.
//
// One definition of "this engine line is a defect" is used by the development
// loop, the packaged-runtime evidence harness, and the runtime bug-pool
// harvester. These are observations of OUR software misbehaving during a run;
// they are never conformance evidence and must not be promoted into a
// completion-matrix row.

import { createHash } from "node:crypto";

export const REJECTED_DIAGNOSTICS = Object.freeze([
  { id: "error-severity", pattern: /(?:^|\n)[^\n]*\bERROR:/i },
  { id: "fatal-severity", pattern: /(?:^|\n)[^\n]*\bFATAL:/i },
  { id: "script-error", pattern: /RESULT_SCRIPT_ERROR|SCRIPT ERROR/i },
  { id: "lua-traceback", pattern: /stack traceback:/i },
  { id: "javascript-failure", pattern: /\b(?:uncaught|unhandled)\b|\bexception\b/i },
  { id: "bundle-rejected", pattern: /TypeScript bundle generation \d+ was rejected/i },
  { id: "missing-lua-provider", pattern: /global '_deherm_' \(a nil value\)|Lua module is not registered/i },
  { id: "component-runtime-unavailable", pattern: /component (?:backend )?runtime is unavailable/i },
]);

// The rejection gate scans a whole transcript and reports the first matching
// family in declaration order. Classifying a single line instead wants the most
// specific family first, because `error-severity` matches almost everything the
// engine prints once something has already gone wrong.
const CLASSIFICATION_ORDER = Object.freeze([
  "bundle-rejected",
  "missing-lua-provider",
  "component-runtime-unavailable",
  "script-error",
  "lua-traceback",
  "fatal-severity",
  "error-severity",
  "javascript-failure",
]);

export const UNCLASSIFIED = "unclassified";

const byId = new Map(REJECTED_DIAGNOSTICS.map((diagnostic) => [diagnostic.id, diagnostic]));
const orderedForClassification = CLASSIFICATION_ORDER.map((id) => {
  const diagnostic = byId.get(id);
  if (!diagnostic) throw new Error(`unknown rejected diagnostic id: ${id}`);
  return diagnostic;
});
if (orderedForClassification.length !== REJECTED_DIAGNOSTICS.length) {
  throw new Error("every rejected diagnostic must have a classification rank");
}

export const DIAGNOSTIC_IDS = Object.freeze([...REJECTED_DIAGNOSTICS.map(({ id }) => id), UNCLASSIFIED]);

/** First rejected family in a whole transcript, in declaration order. */
export function firstRejectedDiagnostic(transcript) {
  for (const diagnostic of REJECTED_DIAGNOSTICS) {
    const match = transcript.match(diagnostic.pattern);
    if (match) return { id: diagnostic.id, text: match[0].trim() };
  }
  return null;
}

/**
 * Classify one line of engine/tool output. Returns null when no family matches;
 * callers that must fail open substitute `UNCLASSIFIED`.
 */
export function classifyDiagnosticText(text) {
  for (const diagnostic of orderedForClassification) {
    if (diagnostic.pattern.test(text)) return diagnostic.id;
  }
  return null;
}

// Run-to-run noise that must not split one defect into many pool entries.
const NORMALIZERS = Object.freeze([
  [/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, "<timestamp>"],
  [/\b\d{2}:\d{2}:\d{2}(?:[.,]\d+)?\b/g, "<time>"],
  [/\b0x[0-9a-fA-F]+\b/g, "<address>"],
  [/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "<ip>"],
  [/\b(pid|PID|port|generation|runtime_id|runtimeId|frame_dt_us)\s*[:=]\s*-?\d+/g, "$1=<n>"],
  [/\b(pid|port|generation)\s+-?\d+\b/gi, "$1 <n>"],
  [/\.(deherm-)?tmp[-.][0-9A-Za-z.-]*/g, ".<tmp>"],
  [/\b[0-9a-fA-F]{8,}\b/g, "<hex>"],
  [/(?:\/[\w.@+~-]+){2,}/g, (match) => `<path>/${match.slice(match.lastIndexOf("/") + 1)}`],
  [/:\d+:\d+\b/g, ":<line>:<col>"],
  [/([A-Za-z0-9_.\-\]])(:)(-?\d+)\b/g, "$1:<line>"],
  [/\b\d{3,}\b/g, "<n>"],
  [/[ \t]+/g, " "],
]);

/** Collapse a diagnostic to a form that is stable across runs and machines. */
export function normalizeDiagnosticText(text) {
  let value = String(text).replaceAll("\r", "");
  for (const [pattern, replacement] of NORMALIZERS) value = value.replace(pattern, replacement);
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
}

/**
 * Stable identity for a defect. Built from the classification plus the
 * normalized diagnostic and, when present, its normalized stack frames, so the
 * same defect collapses to one entry across many runs.
 */
export function diagnosticSignature({ classification = UNCLASSIFIED, text, frames = [] } = {}) {
  const normalized = normalizeDiagnosticText(text ?? "");
  const normalizedFrames = frames.map((frame) => normalizeDiagnosticText(frame));
  const digest = createHash("sha256")
    .update(JSON.stringify([classification, normalized, normalizedFrames]))
    .digest("hex");
  return { signature: digest.slice(0, 16), normalizedText: normalized, normalizedFrames };
}

const FRAME_PATTERN = /^(?:\s+|\[C\]|at\s|\tat\s)|^\s*[\w./\\@+-]+:-?\d+:|^\s*at\s/;
const LOCATION_PATTERN = /(?:^|[\s("'<[])((?:[A-Za-z0-9_@+~-]|[./\\](?![/\\]))*[A-Za-z0-9_](?:\.[A-Za-z0-9_]+)*):(\d+)(?::(\d+))?/g;

/** True when the line looks like a stack frame rather than a fresh message. */
export function isStackFrameLine(line) {
  return FRAME_PATTERN.test(line);
}

/** Every `file:line[:column]` named by a line of output. */
export function extractSourceLocations(line) {
  const found = [];
  for (const match of String(line).matchAll(LOCATION_PATTERN)) {
    const [, file, lineNumber, column] = match;
    if (!file || file === "http" || file === "https") continue;
    found.push({
      file,
      line: Number.parseInt(lineNumber, 10),
      ...(column === undefined ? {} : { column: Number.parseInt(column, 10) }),
    });
  }
  return found;
}

// A frame inside the compiled bundle names a generated offset, not a place an
// author can edit. Prefer the first frame that names authored project source.
function isGeneratedLocation({ file }) {
  return file.endsWith(".dehermc") || file.includes("app.dehermc") || file === "[C]" || file.startsWith("<");
}

/** The most actionable `file:line` a diagnostic and its frames name, if any. */
export function selectSourceLocation(lines) {
  const locations = lines.flatMap((line) => extractSourceLocations(line));
  return locations.find((location) => !isGeneratedLocation(location)) ?? locations[0];
}
