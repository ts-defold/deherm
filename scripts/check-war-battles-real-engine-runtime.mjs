#!/usr/bin/env node

import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const reportPath = resolve(root, "examples/war-battles-online/verification/generated/script-real-engine-probes.json");
const executable = resolve(root, "build/bundle/Defold Hermes Spike.app/Contents/MacOS/DefoldHermesSpike");
const resources = resolve(root, "build/bundle/Defold Hermes Spike.app/Contents/Resources");

export function validateWarBattlesRuntimeReadiness(report) {
  if (!report || report.target !== "arm64-macos-dynamic-hermes" || report.scenarioCount !== 5 || !Array.isArray(report.probes)) {
    throw new Error("Invalid War Battles real-engine probe report");
  }
  const awaiting = report.probes.filter(({ routeStatus }) => routeStatus !== "generated-executable-route").map(({ routeId }) => routeId);
  if (awaiting.length) throw new Error(`War Battles packaged-engine run is blocked on generated routes: ${awaiting.join(", ")}`);
  const incompleteHarness = report.probes.filter(({ assertionHarnessState }) => assertionHarnessState !== "implemented-not-run").map(({ routeId }) => routeId);
  if (incompleteHarness.length) throw new Error(`War Battles packaged-engine run is blocked on assertion harnesses: ${incompleteHarness.join(", ")}`);
  const promoted = report.probes.filter(({ evidence }) => Object.values(evidence).some(({ status }) => status !== "unverified"));
  if (promoted.length || report.verifiedCompileCount || report.verifiedLinkCount || report.verifiedRuntimeCount) {
    throw new Error("War Battles generated report must not contain pre-promoted evidence");
  }
  const markers = report.probes.flatMap(({ expectedMarkers }) => expectedMarkers);
  if (new Set(markers).size !== 16 || markers.some((marker) => typeof marker !== "string" || !marker.startsWith("DEBUG:SCRIPT: war-battles-api:"))) {
    throw new Error("War Battles runtime markers are invalid or duplicated");
  }
  return markers;
}

export function markersObserved(transcript, markers) {
  return markers.every((marker) => transcript.includes(marker));
}

async function main() {
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  const markers = validateWarBattlesRuntimeReadiness(report);
  if (!(await stat(executable)).isFile()) throw new Error(`Native bundle executable is missing: ${executable}`);
  const timeoutMs = Number.parseInt(process.env.DEFOLD_HERMES_RUNTIME_TIMEOUT_MS ?? "15000", 10);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error("DEFOLD_HERMES_RUNTIME_TIMEOUT_MS must be a positive integer");
  const child = spawn(executable, [], { cwd: resources, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  let transcript = "";
  let settled = false;
  const append = (chunk) => { transcript += chunk.toString("utf8").replaceAll("\r", ""); };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  const observed = await new Promise((resolveObserved, rejectObserved) => {
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      rejectObserved(new Error(`War Battles runtime evidence timed out before all markers were observed:\n${transcript}`));
    }, timeoutMs);
    const poll = setInterval(() => {
      if (!markersObserved(transcript, markers) || settled) return;
      settled = true;
      clearInterval(poll);
      clearTimeout(timer);
      child.kill("SIGTERM");
      resolveObserved(markers.map((marker) => transcript.split("\n").find((line) => line.includes(marker)) ?? marker));
    }, 25);
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      clearTimeout(timer);
      rejectObserved(error);
    });
    child.once("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      clearTimeout(timer);
      rejectObserved(new Error(`War Battles runtime exited before all markers (code=${code}, signal=${signal}):\n${transcript}`));
    });
  });
  console.log("war-battles-real-engine-runtime:ok");
  for (const line of observed) console.log(line);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await main();
