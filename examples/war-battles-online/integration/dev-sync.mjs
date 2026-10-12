#!/usr/bin/env node
// The engine consumes project-local generated mirrors, while the authoritative
// shared simulation lives in ../core. Keep them synchronized before compiling
// and on every source edit so HMR cannot silently reload stale gameplay code.
import { execFileSync, spawn } from "node:child_process";
import { watch } from "node:fs";
import { resolve } from "node:path";

const exampleRoot = resolve(import.meta.dirname, "..");
const syncScript = resolve(import.meta.dirname, "sync-defold-sources.mjs");
const compiler = resolve(exampleRoot, "../../bin/deherm.mjs");
const sync = () => execFileSync(process.execPath, [syncScript], { cwd: exampleRoot, stdio: "inherit" });

sync();
const child = spawn(process.execPath, [compiler, "dev", ...process.argv.slice(2)], {
  cwd: exampleRoot,
  stdio: "inherit",
  env: process.env,
});
let closed = false;
let failed = false;
let timer;
const watchers = [];
const closeWatchers = () => {
  closed = true;
  if (timer !== undefined) clearTimeout(timer);
  for (const watcher of watchers) watcher.close();
};
const fail = (error) => {
  if (closed) return;
  failed = true;
  console.error(`war-battles:source-sync-failed:${String(error)}`);
  closeWatchers();
  child.kill("SIGTERM");
};
const scheduleSync = () => {
  if (closed) return;
  if (timer !== undefined) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = undefined;
    try {
      sync();
    } catch (error) {
      fail(error);
    }
  }, 60);
};
try {
  watchers.push(
    watch(resolve(exampleRoot, "core"), (_event, filename) => {
      if (filename === null || String(filename).endsWith(".ts")) scheduleSync();
    }),
    watch(resolve(exampleRoot, "integration"), (_event, filename) => {
      if (filename === null || String(filename) === "transport-selection.ts") scheduleSync();
    }),
  );
  for (const watcher of watchers) watcher.on("error", fail);
} catch (error) {
  fail(error);
}
child.on("error", fail);
child.on("close", (code, signal) => {
  closeWatchers();
  process.exitCode = failed ? 1 : (code ?? (signal === "SIGINT" ? 130 : 1));
});
process.on("SIGINT", () => child.kill("SIGINT"));
process.on("SIGTERM", () => child.kill("SIGTERM"));
