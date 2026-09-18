#!/usr/bin/env node

import { spawn } from "node:child_process";
import { readFile, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { validateNativeValueProbeReport } from "./lib/native-runtime-probe-report.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bundleRoot = resolve(root, "build/bundle/Defold Hermes Spike.app/Contents");
const executable = resolve(bundleRoot, "MacOS/DefoldHermesSpike");
const resources = resolve(bundleRoot, "Resources");
const sourceBundle = resolve(root, "defold/deherm/app.dehermc");
const probeReportPath = resolve(root, "bindings/generated/defold-script-real-engine-probes.json");
const valueProbeReportPath = resolve(root, "bindings/generated/defold-script-value-real-engine-probes.json");
const valueBindingReportPath = resolve(root, "bindings/generated/defold-script-value-bindings.json");
const evidencePath = resolve(root, ".agents/docs/data/native-defold-runtime.log");
const timeoutMs = Number.parseInt(process.env.DEFOLD_HERMES_RUNTIME_TIMEOUT_MS ?? "15000", 10);
const arguments_ = new Set(process.argv.slice(2));
for (const argument of arguments_) {
  if (argument !== "--record-evidence") throw new Error(`Unknown argument: ${argument}`);
}

const source = await readFile(sourceBundle, "utf8");
const fingerprintMatch = source.match(/bundle:\$\{"([0-9a-f]{64})"\}/);
if (!fingerprintMatch) {
  throw new Error(`Built Defold application has no content fingerprint: ${sourceBundle}`);
}
const fingerprint = fingerprintMatch[1];
const probeReport = JSON.parse(await readFile(probeReportPath, "utf8"));
const valueProbeReport = JSON.parse(await readFile(valueProbeReportPath, "utf8"));
const valueBindingReport = JSON.parse(await readFile(valueBindingReportPath, "utf8"));
if (probeReport.target !== "arm64-macos" || !Array.isArray(probeReport.probes) || probeReport.probes.length === 0) {
  throw new Error(`Invalid native script probe report: ${probeReportPath}`);
}
let instrumentedValueProbes;
try {
  instrumentedValueProbes = validateNativeValueProbeReport(valueProbeReport, valueBindingReport);
} catch (error) {
  throw new Error(`Invalid native value probe report: ${valueProbeReportPath}`);
}

const exact = (marker) => ({ marker, kind: "exact-line" });
const prefix = (marker) => ({ marker, kind: "line-prefix" });
const expected = [
  exact("INFO:ENGINE: Defold Engine 1.14.0 (7f0f554)"),
  exact("INFO:DEFOLD_HERMES: Loaded TypeScript bundle generation 1 from '/deherm/app.dehermc'"),
  exact("INFO:DEFOLD_HERMES: init:hermes"),
  exact(`INFO:DEFOLD_HERMES: bundle:${fingerprint}`),
  exact("INFO:DEFOLD_HERMES: module:42"),
  exact(probeReport.expectedInputMarker),
  ...probeReport.probes.map((probe) => probe.expectedMarker ? exact(probe.expectedMarker) : prefix(probe.expectedMarkerPrefix)),
  exact(valueProbeReport.expectedInputMarker),
  ...instrumentedValueProbes.map((probe) => exact(probe.expectedMarker)),
  exact("INFO:DEFOLD_HERMES: Extension update entered (application initialized: true)"),
  exact("INFO:DEFOLD_HERMES: lifecycle:update:1"),
  exact("INFO:DEFOLD_HERMES: final:ok")
];

if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
  throw new Error("DEFOLD_HERMES_RUNTIME_TIMEOUT_MS must be a positive integer");
}

const executableStat = await stat(executable);
if (!executableStat.isFile()) throw new Error(`Native bundle executable is missing: ${executable}`);

const child = spawn(executable, ["--config=deherm.test_exit=1"], {
  cwd: resources,
  env: process.env,
  stdio: ["ignore", "pipe", "pipe"]
});

let transcript = "";
let settled = false;

function observedLines() {
  return transcript.split("\n");
}

function hasMarker(lines, expectation) {
  return expectation.kind === "exact-line"
    ? lines.includes(expectation.marker)
    : lines.some((line) => line.startsWith(expectation.marker));
}

function firstRuntimeError(lines) {
  return lines.find((line) => /(^|:)ERROR:|uncaught|unhandled|exception/i.test(line));
}

function append(chunk) {
  transcript += chunk.toString("utf8").replaceAll("\r", "");
}

child.stdout.on("data", append);
child.stderr.on("data", append);

const result = await new Promise((resolveResult, rejectResult) => {
  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    child.kill("SIGTERM");
    rejectResult(new Error(`Native Defold runtime evidence timed out after ${timeoutMs} ms:\n${transcript}`));
  }, timeoutMs);

  const poll = setInterval(() => {
    const lines = observedLines();
    const runtimeError = firstRuntimeError(lines);
    if (runtimeError) {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      clearTimeout(timer);
      child.kill("SIGTERM");
      rejectResult(new Error(`Native Defold runtime emitted an error: ${runtimeError}\n${transcript}`));
      return;
    }
  }, 25);

  child.once("error", (error) => {
    if (settled) return;
    settled = true;
    clearInterval(poll);
    clearTimeout(timer);
    rejectResult(error);
  });

  child.once("exit", (code, signal) => {
    if (settled) return;
    settled = true;
    clearInterval(poll);
    clearTimeout(timer);
    const lines = observedLines();
    const runtimeError = firstRuntimeError(lines);
    if (runtimeError || code !== 0 || signal || !expected.every((expectation) => hasMarker(lines, expectation))) {
      rejectResult(new Error(
        `Native Defold runtime did not complete clean evidence (code=${code}, signal=${signal}, error=${runtimeError ?? "none"}):\n${transcript}`
      ));
      return;
    }
    resolveResult(expected.map((expectation) =>
      lines.find((line) => expectation.kind === "exact-line"
        ? line === expectation.marker
        : line.startsWith(expectation.marker)) ?? expectation.marker));
  });
});

console.log("native-defold-runtime:ok");
for (const marker of result) console.log(marker);
if (arguments_.has("--record-evidence")) {
  await writeFile(evidencePath, `${result.join("\n")}\n`);
  console.log(`native-defold-runtime:evidence:${evidencePath}`);
}
