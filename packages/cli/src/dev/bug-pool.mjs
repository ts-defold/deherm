// Runtime bug pool.
//
// Engine, Bob, and dev-loop output already lands on disk during normal
// development. This module turns that output into a deduplicated,
// machine-readable pool of defects observed in OUR software, grouped by a
// normalized signature so one defect collapses to one entry across many runs.
//
// The pool is behavioural evidence about déherm during runs. It is not
// conformance evidence, it proves nothing about API coverage, and it must never
// be promoted into a completion-matrix row.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  UNCLASSIFIED,
  classifyDiagnosticText,
  diagnosticSignature,
  isStackFrameLine,
  selectSourceLocation,
} from "./runtime-diagnostics.mjs";

export const BUG_POOL_SCHEMA_VERSION = 1;
export const BUG_POOL_KIND = "deherm-runtime-bug-pool";
export const DEFAULT_OCCURRENCE_CAP = 5;
export const DEFAULT_EXCERPT_LINES = 40;
export const DEFAULT_CONTINUATION_WINDOW_MS = 500;

const POOL_NOTE =
  "Observed runtime behaviour of déherm itself during development and packaged runs. " +
  "This is not conformance evidence and must not be promoted into a completion-matrix row.";

// A line that opens a fresh engine/tool record rather than continuing one.
const FRESH_RECORD = /^(?:INFO|WARNING|WARN|ERROR|FATAL|DEBUG)\b\s*:/;
const SESSION_LINE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z) \[([A-Z]+)\] (\S+)(?: ([\s\S]*))?$/;

// Dev events whose payload carries a defect diagnostic rather than a log line.
const FAILURE_EVENTS = Object.freeze({
  "build-failed": "build",
  "defold-build-failed": "bob",
  "engine-failed": "engine",
  "reload-failed": "reload",
  "activation-failed": "reload",
  "runtime-activation-rejected": "runtime",
});

function severityOf(level) {
  const value = String(level ?? "info").toLowerCase();
  return value === "error" || value === "fatal" || value === "err" ? "error" : value;
}

/**
 * Groups raw output records into occurrences: one opening diagnostic plus the
 * stack frames and continuation lines that belong with it.
 */
export function createOccurrenceCollector({
  continuationWindowMs = DEFAULT_CONTINUATION_WINDOW_MS,
  maxExcerptLines = DEFAULT_EXCERPT_LINES,
} = {}) {
  let open;
  const ready = [];
  // Which changed files triggered each build generation. Kept as occurrence
  // metadata rather than excerpt text so it never splits a signature.
  const builds = new Map();
  const close = () => {
    if (open) ready.push(open);
    open = undefined;
  };
  const push = (text) => {
    if (open.lines.length < maxExcerptLines) open.lines.push(text);
    else open.truncatedLines += 1;
  };
  return {
    builds,
    record({ at, level, source = "deherm", text, origin = "unknown", kind = "log", trigger }) {
      const value = String(text ?? "").replaceAll("\r", "");
      if (!value.trim()) return;
      const when = Number.isFinite(at) ? at : Date.now();
      // A multi-line diagnostic payload is one occurrence, not several.
      const [head, ...rest] = value.split("\n");
      const classification = classifyDiagnosticText(head);
      const severe = kind === "event" || severityOf(level) === "error" || classification !== null;
      const continuation = open !== undefined &&
        kind !== "event" &&
        open.source === source &&
        when - open.lastAt <= continuationWindowMs &&
        !FRESH_RECORD.test(head);
      if (continuation) {
        push(head.trimEnd());
        for (const line of rest) if (line.trim()) push(line.trimEnd());
        open.lastAt = when;
        return;
      }
      close();
      if (!severe) return;
      open = {
        at: when,
        lastAt: when,
        origin,
        source,
        level: severityOf(level),
        classification: classification ?? UNCLASSIFIED,
        lines: [head.trimEnd()],
        truncatedLines: 0,
        ...(trigger ? { trigger } : {}),
      };
      for (const line of rest) if (line.trim()) push(line.trimEnd());
    },
    flush() {
      close();
      return ready.splice(0).map(summarizeOccurrence);
    },
  };
}

function summarizeOccurrence(occurrence) {
  const frames = occurrence.lines.slice(1).filter((line) => isStackFrameLine(line)).map((line) => line.trim());
  const { signature, normalizedText, normalizedFrames } = diagnosticSignature({
    classification: occurrence.classification,
    text: occurrence.lines[0],
    frames,
  });
  const sourceLocation = selectSourceLocation(occurrence.lines);
  return {
    signature,
    classification: occurrence.classification,
    source: occurrence.source,
    origin: occurrence.origin,
    level: occurrence.level,
    at: occurrence.at,
    summary: occurrence.lines[0].trim(),
    normalizedText,
    normalizedFrames,
    frames,
    ...(sourceLocation ? { sourceLocation } : {}),
    ...(occurrence.trigger ? { trigger: occurrence.trigger } : {}),
    excerpt: occurrence.lines,
    truncatedLines: occurrence.truncatedLines,
  };
}

/** Feed one dev-session event into a collector; returns nothing. */
export function recordDevEvent(collector, event, origin = "dev-session") {
  const at = event.at ?? Date.now();
  if (event.type === "log") {
    collector.record({ at, level: event.level, source: event.source ?? "deherm", text: event.message, origin });
    return;
  }
  if (event.type === "build-started") {
    if (Number.isSafeInteger(event.generation)) {
      collector.builds?.set(event.generation, [...(event.changedSources ?? [])]);
    }
    return;
  }
  const source = FAILURE_EVENTS[event.type];
  if (!source) return;
  const diagnostic = event.diagnostic ??
    (event.type === "runtime-activation-rejected"
      ? `runtime rejected bundle ${event.fingerprint ?? "unknown"}`
      : `${event.type}`);
  const changedSources = collector.builds?.get(event.generation);
  const trigger = changedSources?.length || event.reason
    ? { ...(event.reason ? { reason: event.reason } : {}), ...(changedSources?.length ? { changedSources } : {}) }
    : undefined;
  collector.record({
    at,
    level: "error",
    source,
    text: String(diagnostic),
    origin,
    kind: "event",
    ...(trigger ? { trigger } : {}),
  });
}

/**
 * Harvest occurrences from a `deherm dev` session log.
 * Format: `<ISO> [LEVEL] <source> <text>`; EVENT lines carry JSON.
 */
export function harvestSessionLog(contents, { origin = "dev-session", ...options } = {}) {
  const collector = createOccurrenceCollector(options);
  for (const raw of String(contents).replaceAll("\r", "").split("\n")) {
    if (!raw.trim()) continue;
    const match = SESSION_LINE.exec(raw);
    if (!match) {
      // Fail open: an unparseable line is still evidence if it reads as a defect.
      collector.record({ at: Date.now(), level: "info", source: "unparsed", text: raw, origin });
      continue;
    }
    const [, timestamp, level, source, text = ""] = match;
    const at = Date.parse(timestamp);
    if (level === "EVENT") {
      // `<ISO> [EVENT] <type> <json>`: the matched source is the event type.
      const brace = text.indexOf("{");
      let event;
      if (brace >= 0) {
        try {
          event = JSON.parse(text.slice(brace));
        } catch {
          event = undefined;
        }
      }
      recordDevEvent(collector, { type: source, ...event, at }, origin);
      continue;
    }
    collector.record({ at, level: level.toLowerCase(), source, text, origin });
  }
  return collector.flush();
}

/** Harvest occurrences from a raw engine transcript (no timestamps or levels). */
export function harvestTranscript(transcript, { origin = "packaged-run", at = Date.now(), source = "engine", ...options } = {}) {
  const collector = createOccurrenceCollector({ continuationWindowMs: Number.MAX_SAFE_INTEGER, ...options });
  for (const line of String(transcript).replaceAll("\r", "").split("\n")) {
    if (!line.trim()) continue;
    collector.record({ at, level: "info", source, text: line, origin });
  }
  return collector.flush();
}

export function createBugPool() {
  return { entries: new Map() };
}

function toIso(value) {
  return new Date(Number.isFinite(value) ? value : Date.now()).toISOString();
}

/**
 * Merge occurrences into a pool, deduplicating by normalized signature.
 *
 * Re-harvesting the same log must not inflate counts, so an occurrence whose
 * timestamp already falls inside a signature's observed window is treated as a
 * re-read of output already in the pool. Occurrences arrive in time order, so
 * the only thing this collapses is two sightings of one defect inside the same
 * millisecond - which is the same defect anyway.
 */
export function mergeOccurrences(pool, occurrences, { occurrenceCap = DEFAULT_OCCURRENCE_CAP, deduplicate = true } = {}) {
  const cap = Math.max(1, occurrenceCap);
  let added = 0;
  let created = 0;
  let skipped = 0;
  for (const occurrence of occurrences) {
    const at = toIso(occurrence.at);
    const known = pool.entries.get(occurrence.signature);
    if (deduplicate && known && at >= known.firstSeen && at <= known.lastSeen) {
      skipped += 1;
      continue;
    }
    const sample = {
      at,
      origin: occurrence.origin,
      excerpt: occurrence.excerpt,
      ...(occurrence.truncatedLines ? { truncatedLines: occurrence.truncatedLines } : {}),
      ...(occurrence.sourceLocation ? { sourceLocation: occurrence.sourceLocation } : {}),
      ...(occurrence.trigger ? { trigger: occurrence.trigger } : {}),
    };
    const existing = known;
    added += 1;
    if (!existing) {
      created += 1;
      pool.entries.set(occurrence.signature, {
        signature: occurrence.signature,
        classification: occurrence.classification,
        source: occurrence.source,
        level: occurrence.level,
        summary: occurrence.summary,
        normalizedText: occurrence.normalizedText,
        origins: [occurrence.origin],
        firstSeen: at,
        lastSeen: at,
        occurrenceCount: 1,
        ...(occurrence.sourceLocation ? { sourceLocation: occurrence.sourceLocation } : {}),
        frames: occurrence.frames,
        occurrences: [sample],
      });
      continue;
    }
    existing.occurrenceCount += 1;
    if (at < existing.firstSeen) existing.firstSeen = at;
    if (at > existing.lastSeen) existing.lastSeen = at;
    if (!existing.origins.includes(occurrence.origin)) existing.origins = [...existing.origins, occurrence.origin].sort();
    if (!existing.sourceLocation && occurrence.sourceLocation) existing.sourceLocation = occurrence.sourceLocation;
    if (!existing.frames?.length && occurrence.frames.length) existing.frames = occurrence.frames;
    // Bounded storage with an accurate count: keep the first sighting plus the
    // most recent ones, and never let one noisy defect grow the pool forever.
    existing.occurrences.push(sample);
    while (existing.occurrences.length > cap) existing.occurrences.splice(1, 1);
  }
  return { added, created, skipped };
}

/** Deterministic, machine-readable pool document. */
export function bugPoolDocument(pool, { generatedAt } = {}) {
  const entries = [...pool.entries.values()].sort((left, right) =>
    left.signature < right.signature ? -1 : left.signature > right.signature ? 1 : 0);
  const byClassification = {};
  for (const entry of entries) {
    byClassification[entry.classification] = (byClassification[entry.classification] ?? 0) + entry.occurrenceCount;
  }
  return {
    schemaVersion: BUG_POOL_SCHEMA_VERSION,
    kind: BUG_POOL_KIND,
    note: POOL_NOTE,
    generatedAt: toIso(generatedAt ?? Date.now()),
    entryCount: entries.length,
    occurrenceCount: entries.reduce((total, entry) => total + entry.occurrenceCount, 0),
    byClassification,
    entries,
  };
}

export function bugPoolFromDocument(document) {
  const pool = createBugPool();
  for (const entry of document?.entries ?? []) {
    if (!entry?.signature) continue;
    pool.entries.set(entry.signature, {
      ...entry,
      origins: [...(entry.origins ?? [])],
      frames: [...(entry.frames ?? [])],
      occurrences: [...(entry.occurrences ?? [])],
    });
  }
  return pool;
}

export function defaultBugPoolFile(projectRoot) {
  return path.join(path.resolve(projectRoot), ".deherm", "dev", "bug-pool.json");
}

export function defaultSessionLogFile(projectRoot) {
  return path.join(path.resolve(projectRoot), ".deherm", "dev", "session.log");
}

export async function readBugPool(file) {
  try {
    return bugPoolFromDocument(JSON.parse(await readFile(file, "utf8")));
  } catch (error) {
    if (error?.code === "ENOENT") return createBugPool();
    // A corrupt pool must not stop a development session; start a fresh one.
    return createBugPool();
  }
}

export async function writeBugPool(file, pool, options = {}) {
  const target = path.resolve(file);
  await mkdir(path.dirname(target), { recursive: true });
  const document = bugPoolDocument(pool, options);
  const temporary = `${target}.deherm-tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`);
  await rename(temporary, target);
  return document;
}

/**
 * Read a session log and any packaged-run transcripts, merge everything into the
 * pool on disk, and return the resulting document.
 */
export async function harvestBugPool({
  projectRoot = process.cwd(),
  sessionLogs,
  transcripts = [],
  poolFile,
  occurrenceCap = DEFAULT_OCCURRENCE_CAP,
  write = true,
  generatedAt,
} = {}) {
  const root = path.resolve(projectRoot);
  const target = path.resolve(poolFile ?? defaultBugPoolFile(root));
  const logs = sessionLogs ?? [defaultSessionLogFile(root)];
  const pool = await readBugPool(target);
  const sources = [];
  for (const log of logs) {
    const absolute = path.resolve(root, log);
    let contents;
    try {
      contents = await readFile(absolute, "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      continue;
    }
    const occurrences = harvestSessionLog(contents, { origin: "dev-session" });
    const merged = mergeOccurrences(pool, occurrences, { occurrenceCap });
    sources.push({ path: absolute, kind: "session-log", ...merged });
  }
  for (const transcript of transcripts) {
    const absolute = path.resolve(root, transcript);
    let contents;
    try {
      contents = await readFile(absolute, "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      continue;
    }
    const occurrences = harvestTranscript(contents, { origin: "packaged-run" });
    const merged = mergeOccurrences(pool, occurrences, { occurrenceCap });
    sources.push({ path: absolute, kind: "transcript", ...merged });
  }
  const document = write
    ? await writeBugPool(target, pool, { generatedAt })
    : bugPoolDocument(pool, { generatedAt });
  return { poolFile: target, sources, document };
}

/**
 * Live recorder for a running dev session. Every emitted event is classified as
 * it happens and flushed to the pool file, so the pool accumulates during normal
 * development instead of only on demand.
 */
export function createBugPoolRecorder({
  file,
  occurrenceCap = DEFAULT_OCCURRENCE_CAP,
  flushIntervalMs = 2_000,
  origin = "dev-session",
  onError,
} = {}) {
  const target = path.resolve(file);
  const collector = createOccurrenceCollector();
  let pending = Promise.resolve();
  let timer;
  let closed = false;
  let pooled = 0;
  const drain = () => {
    const occurrences = collector.flush();
    if (!occurrences.length) return pending;
    pooled += occurrences.length;
    pending = pending.then(async () => {
      const pool = await readBugPool(target);
      mergeOccurrences(pool, occurrences, { occurrenceCap });
      await writeBugPool(target, pool);
    }).catch((error) => { onError?.(error); });
    return pending;
  };
  return {
    file: target,
    recorded: () => pooled,
    record(event) {
      if (closed) return;
      recordDevEvent(collector, event, origin);
      if (timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        drain();
      }, flushIntervalMs);
      timer.unref?.();
    },
    async close() {
      if (closed) return pending;
      closed = true;
      clearTimeout(timer);
      timer = undefined;
      drain();
      return pending;
    },
  };
}

export function formatBugPool(document, { cwd = process.cwd(), poolFile } = {}) {
  const lines = [];
  const where = poolFile ? path.relative(cwd, poolFile) || poolFile : undefined;
  lines.push(`runtime bug pool: ${document.entryCount} signature(s), ${document.occurrenceCount} occurrence(s)${where ? ` in ${where}` : ""}`);
  lines.push("evidence about déherm's own runtime behaviour; not conformance evidence");
  if (!document.entryCount) {
    lines.push("-- no classified or unclassified defects observed yet");
    return lines.join("\n");
  }
  const ordered = [...document.entries].sort((left, right) =>
    right.occurrenceCount - left.occurrenceCount ||
    (left.lastSeen < right.lastSeen ? 1 : left.lastSeen > right.lastSeen ? -1 : 0) ||
    (left.signature < right.signature ? -1 : 1));
  for (const entry of ordered) {
    const location = entry.sourceLocation
      ? `  ${entry.sourceLocation.file}:${entry.sourceLocation.line}${entry.sourceLocation.column === undefined ? "" : `:${entry.sourceLocation.column}`}`
      : "";
    lines.push("");
    lines.push(`${entry.signature}  ${entry.classification}  x${entry.occurrenceCount}  ${entry.source}${location}`);
    lines.push(`  ${entry.summary}`);
    lines.push(`  first ${entry.firstSeen}  last ${entry.lastSeen}  origin ${entry.origins.join(",")}`);
    const trigger = entry.occurrences.at(-1)?.trigger;
    if (trigger) {
      const detail = [trigger.reason, trigger.changedSources?.join(", ")].filter(Boolean).join("; ");
      if (detail) lines.push(`  triggered by ${detail}`);
    }
    for (const frame of entry.frames.slice(0, 6)) lines.push(`    ${frame}`);
  }
  return lines.join("\n");
}
