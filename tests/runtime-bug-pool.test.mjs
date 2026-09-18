import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  BUG_POOL_KIND,
  bugPoolDocument,
  createBugPool,
  createBugPoolRecorder,
  harvestBugPool,
  harvestSessionLog,
  harvestTranscript,
  mergeOccurrences,
} from "../packages/cli/src/dev/bug-pool.mjs";
import {
  REJECTED_DIAGNOSTICS,
  UNCLASSIFIED,
  classifyDiagnosticText,
  firstRejectedDiagnostic,
  normalizeDiagnosticText,
} from "../packages/cli/src/dev/runtime-diagnostics.mjs";
import { buildRelevantChanges, isDocumentationOnlyChange } from "../packages/cli/src/dev/session.mjs";
import { createWatchPathFilter, isTemporaryArtifact } from "../packages/cli/src/dev/watcher.mjs";

// A live `<project>/.deherm/dev/session.log` is truncated at the start of every
// session, so the two defects this harvester was built for are pinned here as a
// verbatim excerpt of the recorded 2026-09-18 War Battles development session.
const recordedSessionLog = path.join(import.meta.dirname, "fixtures", "dev-session-war-battles.log");

function poolOf(occurrences, options) {
  const pool = createBugPool();
  mergeOccurrences(pool, occurrences, options);
  return bugPoolDocument(pool);
}

test("one classifier serves the rejection gate and per-line classification", () => {
  // The packaged gate keeps its declaration-order scan over a whole transcript.
  assert.equal(firstRejectedDiagnostic("INFO: fine\nERROR: broken\n").id, "error-severity");
  assert.equal(firstRejectedDiagnostic("INFO: fine\n"), null);
  // A single line resolves to its most specific family instead.
  assert.equal(classifyDiagnosticText("ERROR:SCRIPT: RESULT_SCRIPT_ERROR while calling"), "script-error");
  assert.equal(classifyDiagnosticText("stack traceback:"), "lua-traceback");
  assert.equal(classifyDiagnosticText("ERROR:DLIB: something generic"), "error-severity");
  assert.equal(classifyDiagnosticText("component backend runtime is unavailable"), "component-runtime-unavailable");
  // Fail open: an unanticipated line is unclassified, never dropped.
  assert.equal(classifyDiagnosticText("java exited 1"), null);
  assert.equal(new Set(REJECTED_DIAGNOSTICS.map(({ id }) => id)).size, REJECTED_DIAGNOSTICS.length);
});

test("signatures drop timestamps, pids, digests, generations, paths, and offsets", () => {
  const first = normalizeDiagnosticText(
    "2026-09-18T22:38:28.605Z generation=27 failed: /Users/a/project/main/battle.gui.ts:2:7 pid=60268 8c6c1202fcc7");
  const second = normalizeDiagnosticText(
    "2026-01-02T03:04:05.000Z generation=91 failed: /home/b/other/main/battle.gui.ts:9:4 pid=12 f900246b9998");
  assert.equal(first, second);
  assert.match(first, /battle\.gui\.ts/);
});

test("an unclassified error line still lands in the pool", () => {
  const occurrences = harvestSessionLog("2026-09-18T22:40:00.193Z [ERROR] watcher java exited 1\n");
  assert.equal(occurrences.length, 1);
  assert.equal(occurrences[0].classification, UNCLASSIFIED);
  assert.equal(occurrences[0].summary, "java exited 1");
});

test("the recorded war-battles session log yields both known defects as distinct entries", async () => {
  const document = poolOf(harvestSessionLog(await readFile(recordedSessionLog, "utf8")));
  assert.equal(document.kind, BUG_POOL_KIND);
  assert.match(document.note, /not conformance evidence/);

  const detachedInstance = document.entries.find(({ summary }) =>
    summary.includes("Structured Lua call has no captured Defold instance"));
  assert.ok(detachedInstance, "the detached-instance defect must be pooled");
  assert.equal(detachedInstance.classification, "error-severity");
  assert.equal(detachedInstance.source, "engine");
  // The trace names the authored script, not the generated bundle offset.
  assert.deepEqual(detachedInstance.sourceLocation, { file: "main/player.script", line: 32 });
  assert.ok(detachedInstance.frames.some((frame) => frame.startsWith("at post (")));
  assert.ok(detachedInstance.frames.some((frame) => frame.includes("at final")));
  assert.ok(detachedInstance.occurrences[0].excerpt.join("\n").includes("stack traceback:"));

  const selfInflictedBuild = document.entries.find(({ source, summary }) =>
    source === "build" && summary.startsWith("Build failed"));
  assert.ok(selfInflictedBuild, "the self-inflicted build failure must be pooled");
  assert.notEqual(selfInflictedBuild.signature, detachedInstance.signature);
  assert.ok(selfInflictedBuild.occurrenceCount >= 2, "the same build defect repeats across generations");
  // The trigger records what the watcher fed the compiler: prose plus an atomic
  // write scratch file that had already been renamed away.
  const triggers = selfInflictedBuild.occurrences.flatMap(({ trigger }) => trigger?.changedSources ?? []);
  assert.ok(triggers.some((file) => file.endsWith(".md")));
  assert.ok(triggers.some((file) => /\.tmp\.\d+\./.test(file)));
});

test("repeated harvests of the same output do not inflate occurrence counts", async () => {
  const contents = await readFile(recordedSessionLog, "utf8");
  const pool = createBugPool();
  const first = mergeOccurrences(pool, harvestSessionLog(contents));
  const before = bugPoolDocument(pool);
  const second = mergeOccurrences(pool, harvestSessionLog(contents));
  const after = bugPoolDocument(pool);
  assert.ok(first.added > 0);
  assert.equal(second.added, 0);
  assert.equal(second.skipped, first.added + first.skipped);
  assert.equal(after.occurrenceCount, before.occurrenceCount);
  assert.equal(after.entryCount, before.entryCount);
});

test("stored occurrences are capped while counts stay accurate", () => {
  const start = Date.parse("2026-09-18T22:40:00.000Z");
  const occurrences = Array.from({ length: 12 }, (_, index) =>
    harvestSessionLog(`${new Date(start + index * 1_000).toISOString()} [ERROR] engine ERROR:SCRIPT: repeated failure\n`)[0]);
  const document = poolOf(occurrences, { occurrenceCap: 3 });
  assert.equal(document.entryCount, 1);
  assert.equal(document.entries[0].occurrenceCount, 12);
  assert.equal(document.entries[0].occurrences.length, 3);
  // The first sighting is always retained alongside the most recent ones.
  assert.equal(document.entries[0].occurrences[0].at, document.entries[0].firstSeen);
  assert.equal(document.entries[0].occurrences.at(-1).at, document.entries[0].lastSeen);
});

test("a packaged-run transcript groups a diagnostic with its stack frames", () => {
  const document = poolOf(harvestTranscript([
    "INFO:DEFOLD_HERMES: war-battles:ui-init",
    "ERROR:SCRIPT: component backend runtime is unavailable",
    "    at init (deherm:///deherm/app.dehermc:12:5)",
    "  main/rocket.script:8: in function <main/rocket.script:4>",
    "INFO:DLIB: Flushing http cache to disk",
  ].join("\n"), { at: Date.parse("2026-09-18T22:00:00.000Z") }));
  assert.equal(document.entryCount, 1);
  const [entry] = document.entries;
  assert.equal(entry.classification, "component-runtime-unavailable");
  assert.equal(entry.origins[0], "packaged-run");
  assert.deepEqual(entry.sourceLocation, { file: "main/rocket.script", line: 8 });
  assert.equal(entry.occurrences[0].excerpt.length, 3);
});

test("the harvester merges a session log into a pool file on disk", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "deherm-bug-pool-"));
  const { mkdir } = await import("node:fs/promises");
  await mkdir(path.join(root, ".deherm", "dev"), { recursive: true });
  await writeFile(path.join(root, ".deherm", "dev", "session.log"), [
    "2026-09-18T22:37:56.169Z [ERROR] engine ERROR:SCRIPT: Structured Lua call has no captured Defold instance",
    "2026-09-18T22:37:56.169Z [INFO] engine     at post (deherm:///deherm/app.dehermc:957:38)",
    "2026-09-18T22:37:56.169Z [INFO] engine   main/player.script:32: in function <main/player.script:29>",
    "",
  ].join("\n"));
  const harvested = await harvestBugPool({ projectRoot: root });
  assert.equal(harvested.document.entryCount, 1);
  assert.equal(harvested.sources[0].kind, "session-log");
  const stored = JSON.parse(await readFile(harvested.poolFile, "utf8"));
  assert.equal(stored.kind, BUG_POOL_KIND);
  assert.deepEqual(stored.entries[0].sourceLocation, { file: "main/player.script", line: 32 });
  // Re-harvesting an unchanged log is a no-op.
  assert.equal((await harvestBugPool({ projectRoot: root })).document.occurrenceCount, 1);
});

test("a live recorder accumulates a running session into the pool file", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "deherm-bug-recorder-"));
  const file = path.join(root, "bug-pool.json");
  const recorder = createBugPoolRecorder({ file, flushIntervalMs: 1 });
  const at = Date.parse("2026-09-18T22:37:56.169Z");
  recorder.record({ type: "build-started", generation: 27, changedSources: ["README.md"], at });
  recorder.record({ type: "build-failed", generation: 27, diagnostic: "Build failed with 1 error:\nmain/app.ts:2:7: ERROR: Could not resolve \"./gone\"", at });
  recorder.record({ type: "log", level: "error", source: "engine", message: "ERROR:SCRIPT: Structured Lua call has no captured Defold instance", at: at + 1_000 });
  recorder.record({ type: "log", level: "info", source: "engine", message: "    at post (deherm:///deherm/app.dehermc:957:38)", at: at + 1_000 });
  await recorder.close();
  const stored = JSON.parse(await readFile(file, "utf8"));
  assert.equal(stored.entryCount, 2);
  const build = stored.entries.find(({ source }) => source === "build");
  assert.deepEqual(build.occurrences[0].trigger, { changedSources: ["README.md"] });
  const engine = stored.entries.find(({ source }) => source === "engine");
  assert.ok(engine.frames.some((frame) => frame.startsWith("at post (")));
});

test("the watcher never schedules work against atomic-write scratch files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "deherm-temp-watch-"));
  const filterPath = createWatchPathFilter(root);
  for (const scratch of [
    "README.md.tmp.60268.8c6c1202fcc7",
    "player.script.ts.tmp-60268",
    "player.script.ts.tmp-60268-8c6c1202",
    "app.dehermc.deherm-tmp-60268",
    "app.dehermc.deherm-tmp-60268-3",
    "bug-pool.json.tmp",
    "main.ts~",
    "main.ts.swp",
    ".#main.ts",
  ]) {
    assert.equal(filterPath(path.join(root, scratch)), undefined, scratch);
    assert.equal(isTemporaryArtifact(scratch), true, scratch);
  }
  // Real sources with tmp-shaped names must still build.
  assert.equal(filterPath(path.join(root, "main", "player.script.ts")), "main/player.script.ts");
  assert.equal(filterPath(path.join(root, "main", "tmp.ts")), "main/tmp.ts");
  assert.equal(filterPath(path.join(root, "main", "temporary.ts")), "main/temporary.ts");
});

test("a documentation-only change triggers no TypeScript or Defold build", () => {
  assert.equal(isDocumentationOnlyChange("README.md"), true);
  assert.equal(isDocumentationOnlyChange("docs/PLAYABLE-BLOCKERS.markdown"), true);
  assert.equal(isDocumentationOnlyChange("LICENSE"), true);
  assert.equal(isDocumentationOnlyChange("main/player.script.ts"), false);
  assert.equal(isDocumentationOnlyChange("game.project"), false);
  assert.deepEqual(buildRelevantChanges(["README.md", "notes.txt"]), []);
  assert.deepEqual(buildRelevantChanges(["README.md", "main/player.script.ts"]), ["main/player.script.ts"]);
});
