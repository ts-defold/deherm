#!/usr/bin/env node

// Runs the generated headless conformance harness against the real Defold
// engine and records a deterministic contract -> outcome report.
//
// The pipeline is generate -> bundle -> compile content -> link driver -> run.
// Every stage is keyed to the generated plan, and the report never promotes a
// stage it did not observe: a contract the plan records as unreachable stays
// unreachable, and a contract whose fixture produced no decisive engine result
// is a blocker, never a silent skip.

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build as esbuild } from "esbuild";
import ttsc from "@ttsc/unplugin/esbuild";

import {
  buildHeadlessConformancePlan,
  loadHeadlessConformanceInputs
} from "./lib/headless-conformance-plan.mjs";
import { writeHeadlessConformanceHarness } from "./generate-headless-conformance.mjs";

const root = new URL("../", import.meta.url);
const repoRoot = fileURLToPath(root);
const projectDirectory = path.join(repoRoot, "build/conformance/headless/project");
const manifestPath = path.join(repoRoot, "build/conformance/headless/cases.tsv");
const reportPath = path.join(repoRoot, "packages/bindings/generated/defold-headless-conformance-report.json");
const evidencePath = path.join(repoRoot, ".agents/docs/data/headless-conformance.log");
const driverPath = path.join(repoRoot, "build/native/defold-hermes-headless-conformance-driver");
const bobJar = path.join(repoRoot, "build/tooling/bob.jar");
const MARKER = "deherm-headless-conformance";
// `<name>:<lua type>` emitted once per documented route by the generated
// route-resolution script on the index object.
const RESOLUTION = /deherm-route-resolution:([^\s:]+):(\w+)\s*$/;
const TICK_BUDGET = 8;

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function javaExecutable() {
  const fromEnvironment = process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, "bin/java") : null;
  return fromEnvironment ?? "/opt/homebrew/opt/openjdk@25/bin/java";
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", cwd: repoRoot, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited with ${result.status ?? result.signal}`);
  }
}

async function bundleHarness(entryPoint) {
  await esbuild({
    entryPoints: { "app": entryPoint },
    outdir: path.join(projectDirectory, "deherm"),
    outExtension: { ".js": ".dehermc" },
    bundle: true,
    format: "iife",
    platform: "neutral",
    target: "es2020",
    // The conformance bundle is type-checked as its own program so this
    // runtime-evidence lane depends only on the generated SDK surface it
    // exercises.
    plugins: [ttsc({ project: path.join(repoRoot, "tsconfig.headless-conformance.json") })],
    tsconfig: path.join(repoRoot, "tsconfig.headless-conformance.json"),
    absWorkingDir: repoRoot,
    sourcemap: false,
    legalComments: "none",
    logLevel: "warning"
  });
}

function compileContent() {
  run(javaExecutable(), [
    "-jar", bobJar,
    "--root", projectDirectory,
    "--output", "build/bob",
    "--archive",
    "build"
  ], { stdio: ["ignore", "pipe", "pipe"] });
}

async function writeManifest(fixtures) {
  const lines = fixtures.map((fixture) =>
    `${fixture.id}\t${fixture.collection}\t${TICK_BUDGET}\t${(fixture.engineConfig ?? []).join(" ")}`);
  await mkdir(path.dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, `${lines.join("\n")}\n`);
}

const CRASH_FRAME = /^ERROR:CRASH:\s+\d+\s+\S+\s+0x[0-9a-f]+\s+(.+?)\s+\+\s+\d+$/;
// déherm reports the runtime profile it detected from the registered Lua
// symbols. The plan is built against one profile, so a disagreement means the
// plan is claiming routes the linked engine does not register.
const DETECTED_PROFILE = /Detected Defold runtime profile '([^']+)'/;

export function parseTranscript(transcript) {
  const observations = [];
  const resolutions = new Map();
  const outcomes = new Map();
  const crashFrames = [];
  const detectedProfiles = new Set();
  let inFlight = null;
  for (const raw of transcript.split("\n")) {
    const line = raw.replace(/\r/g, "");
    if (line.startsWith("headless-conformance:case-begin\t")) {
      inFlight = line.split("\t")[1];
      crashFrames.length = 0;
      continue;
    }
    const detected = DETECTED_PROFILE.exec(line);
    if (detected) detectedProfiles.add(detected[1]);
    const frame = CRASH_FRAME.exec(line);
    if (frame) {
      crashFrames.push(frame[1]);
      continue;
    }
    if (line.startsWith("headless-conformance:case-end\t")) {
      const [, id, disposition, exitCode, ticks] = line.split("\t");
      outcomes.set(id, { disposition, exitCode: Number(exitCode), ticks: Number(ticks) });
      inFlight = null;
      continue;
    }
    // The resolution census, when the engine emits one. It cannot come from a
    // Lua `print`: Defold maps that to `dmLogUserDebug` (script.cpp:453), which
    // is compiled out of this release driver, so a generated Lua probe produces
    // nothing here however correct it is. The census belongs in the extension's
    // C init, where `lua_bridge.cpp` already walks `lua_getglobal` +
    // `lua_getfield` + `lua_isfunction` for every bound route and has
    // `dmLogInfo`. This reader is the consumer, waiting for that producer.
    const resolved = RESOLUTION.exec(line);
    if (resolved) {
      if (resolved[1] !== "done") resolutions.set(resolved[1], resolved[2]);
      continue;
    }
    const index = line.indexOf(`${MARKER}\t`);
    if (index >= 0) {
      const fields = line.slice(index).split("\t");
      // stdout and stderr are independent streams. A partial stdout marker
      // used to be concatenated with a simultaneous stderr engine error and
      // became a bogus `undefined:undefined` observation. The runner now
      // frames each stream by line, and this check also makes an incomplete
      // marker non-evidence if an older/corrupt transcript is parsed.
      if (fields.length < 6) continue;
      const [, contract, route, property, disposition, ...rest] = fields;
      if (!contract || !route || !property || !disposition) continue;
      observations.push({ contract, route, property, disposition, detail: rest.join("\t") });
    }
  }
  return { observations, outcomes, inFlight, crashFrames, detectedProfiles, resolutions };
}

async function runDriver(projectFile, remaining) {
  await writeManifest(remaining);
  return new Promise((resolve, reject) => {
    const child = spawn(driverPath, ["--project-file", projectFile, "--manifest", manifestPath], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const completeLines = [];
    const pending = new Map([["stdout", ""], ["stderr", ""]]);
    const append = (stream, chunk) => {
      const lines = `${pending.get(stream)}${chunk.toString("utf8")}`.split("\n");
      pending.set(stream, lines.pop());
      completeLines.push(...lines.map((line) => `${line}\n`));
    };
    child.stdout.on("data", (chunk) => append("stdout", chunk));
    child.stderr.on("data", (chunk) => append("stderr", chunk));
    child.once("error", reject);
    // `close` follows stdio closure; `exit` can race the last data event.
    child.once("close", (code, signal) => {
      for (const value of pending.values()) if (value) completeLines.push(`${value}\n`);
      resolve({ transcript: completeLines.join(""), code, signal });
    });
  });
}

// Ephemeral ports and ASLR addresses are the only run-to-run variation in the
// transcript. Normalising them keeps the recorded evidence reproducible while
// leaving every symbol, marker and verdict intact.
function normalizeEvidence(transcript) {
  return transcript
    .replaceAll(repoRoot, "<repo>/")
    .replace(/(Log server started on port )\d+/g, "$1<ephemeral>")
    .replace(/0x[0-9a-f]{8,16}/g, "0x<address>");
}

function diagnosticLines(transcript) {
  return normalizeEvidence(transcript)
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line && !line.startsWith("headless-conformance:case-"))
    .slice(-32);
}

export async function checkHeadlessConformance({ skipBuild = false } = {}) {
  const documents = await loadHeadlessConformanceInputs(root);
  const plan = buildHeadlessConformancePlan(documents);
  await writeFile(
    new URL("packages/bindings/generated/defold-headless-conformance-plan.json", root),
    `${JSON.stringify(plan, null, 2)}\n`
  );
  const written = await writeHeadlessConformanceHarness(plan);

  await bundleHarness(written.entryPoint);
  compileContent();
  if (!skipBuild) {
    run("cmake", ["--build", "build/native", "--target", "defold-hermes-headless-conformance-driver", "--parallel"]);
  }
  await access(driverPath);

  const projectFile = path.join(projectDirectory, "build/bob/game.projectc");
  const fixtures = plan.contracts.filter((contract) => contract.disposition === "fixture");

  const observations = [];
  const outcomes = new Map();
  const resolutions = new Map();
  const transcripts = [];
  const detectedProfiles = new Set();
  let remaining = fixtures;
  // A contract that faults the process takes the driver down with it. Record
  // that contract as an engine fault and resume with the rest rather than
  // losing every later contract to one crash.
  while (remaining.length > 0) {
    const result = await runDriver(projectFile, remaining);
    const normalizedTranscript = normalizeEvidence(result.transcript);
    transcripts.push(normalizedTranscript);
    const parsed = parseTranscript(result.transcript);
    observations.push(...parsed.observations);
    // The census runs on the index object, which every driver invocation loads,
    // so a later run confirms rather than contradicts an earlier one.
    for (const [name, luaType] of parsed.resolutions) resolutions.set(name, luaType);
    for (const profile of parsed.detectedProfiles) detectedProfiles.add(profile);
    for (const [id, outcome] of parsed.outcomes) outcomes.set(id, outcome);
    const unfinished = remaining.filter((fixture) => !outcomes.has(fixture.id));
    if (unfinished.length === 0) break;
    const faulted = parsed.inFlight ?? unfinished[0].id;
    outcomes.set(faulted, {
      disposition: "engine-fault",
      exitCode: result.code ?? -1,
      ticks: 0,
      signal: result.signal ?? null,
      // Frames above the crash handler name the exact native boundary that
      // faulted. This is the evidence only a real engine can produce.
      crashFrames: parsed.crashFrames
        .filter((name) => !name.startsWith("_ZN7dmCrash") && name !== "_sigtramp")
        .slice(0, 8),
      // A signal without the engine's own preceding diagnostic is not enough
      // to debug CI. Keep only the normalized tail for this process; the full
      // normalized transcript is written as a separate evidence artifact.
      diagnostics: diagnosticLines(result.transcript)
    });
    remaining = unfinished.filter((fixture) => fixture.id !== faulted);
  }

  // Fail closed rather than record evidence planned against the wrong engine.
  const unexpectedProfiles = [...detectedProfiles].filter((profile) => profile !== plan.runtimeProfile);
  if (unexpectedProfiles.length > 0) {
    throw new Error(
      `The linked engine reported Defold runtime profile ${unexpectedProfiles.join(", ")}, ` +
      `but the plan was built for ${plan.runtimeProfile}`
    );
  }

  // A blocked contract explains itself with the dispositions the run actually
  // produced, so an unreached route never disappears into a generic label.
  const blockersFor = (contract, engine, properties, conclusive) => {
    if (conclusive.length === 0 && properties.length > 0) {
      const counts = new Map();
      for (const item of properties) {
        const reason = `runtime-${item.disposition}:${item.detail.split(":")[0]}`;
        counts.set(reason, (counts.get(reason) ?? 0) + 1);
      }
      return [...counts.entries()]
        .sort((left, right) => right[1] - left[1] || (left[0] < right[0] ? -1 : 1))
        .map(([reason, routeCount]) => ({ reason, routeCount }));
    }
    return [{ reason: `engine-disposition:${engine.disposition}`, routeCount: contract.exercises.length }];
  };

  const byContract = new Map();
  for (const observation of observations) {
    if (!byContract.has(observation.contract)) byContract.set(observation.contract, []);
    byContract.get(observation.contract).push(observation);
  }

  const results = plan.contracts.map((contract) => {
    if (contract.disposition !== "fixture") {
      return {
        id: contract.id,
        contractIndex: contract.contractIndex,
        routeCount: contract.routeCount,
        outcome: "unreachable",
        blockers: contract.blockers
      };
    }
    const engine = outcomes.get(contract.id) ?? { disposition: "not-executed", exitCode: -1, ticks: 0 };
    const properties = byContract.get(contract.id) ?? [];
    const mismatched = properties.filter((item) => item.disposition === "mismatched");
    // A `blocked-` disposition is an explicit failure to reach the route, not
    // evidence about it. A contract whose every property is blocked stays
    // blocked and never counts as observed.
    const conclusive = properties.filter((item) => !item.disposition.startsWith("blocked-"));
    const decisive = engine.disposition === "exited";
    let outcome;
    if (engine.disposition === "engine-fault") {
      outcome = "engine-fault";
    } else if (!decisive) {
      outcome = "blocked";
    } else if (engine.exitCode !== 0 || mismatched.length > 0) {
      outcome = "mismatched";
    } else if (conclusive.length === 0) {
      outcome = "blocked";
    } else {
      outcome = "observed";
    }
    return {
      id: contract.id,
      contractIndex: contract.contractIndex,
      routeCount: contract.routeCount,
      exercisedRouteCount: contract.exercises.length,
      outcome,
      engine,
      profile: contract.profile,
      observedPropertyCount: conclusive.length,
      blockedPropertyCount: properties.length - conclusive.length,
      mismatchedPropertyCount: mismatched.length,
      properties,
      ...(outcome === "blocked" || outcome === "engine-fault"
        ? { blockers: blockersFor(contract, engine, properties, conclusive) }
        : {})
    };
  });

  const counts = results.reduce((totals, item) => {
    totals[item.outcome] = (totals[item.outcome] ?? 0) + 1;
    return totals;
  }, {});

  const report = {
    schemaVersion: 1,
    defoldRevision: plan.defoldRevision,
    target: plan.target,
    variant: plan.variant,
    runtimeProfile: plan.runtimeProfile,
    detectedRuntimeProfiles: [...detectedProfiles].sort(),
    evidenceStage: "runtime",
    evidenceBoundary:
      "Observed contracts executed inside a real headless Defold engine driven one tick at a time through " +
      "dmEngineUpdate. This report claims runtime behaviour only; it never promotes generation, compilation " +
      "or linkage evidence, and it claims nothing for contracts recorded as unreachable or blocked.",
    driver: "native/headless_conformance_driver.cpp",
    planSha256: sha256(JSON.stringify(plan)),
    planInputs: plan.inputs,
    contractCount: plan.contractCount,
    summary: {
      observed: counts.observed ?? 0,
      mismatched: counts.mismatched ?? 0,
      engineFault: counts["engine-fault"] ?? 0,
      blocked: counts.blocked ?? 0,
      unreachable: counts.unreachable ?? 0
    },
    propertySummary: observations.reduce((totals, item) => {
      const key = `${item.property}:${item.disposition}`;
      totals[key] = (totals[key] ?? 0) + 1;
      return totals;
    }, {}),
    // Which documented route names resolve in the running engine's Lua state.
    // This is direct observation, and it settles questions no static parse of
    // the registration arrays can: `socket.tcp` is registered through an
    // initialiser loop whose `luaL_Reg` names are never read, so the parser
    // never reaches tcp.c's own array - but the engine either has the function
    // or it does not, and here it says which.
    routeResolution: Object.fromEntries([...resolutions].sort(([a], [b]) => a < b ? -1 : 1)),
    contracts: results
  };

  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  await mkdir(path.dirname(evidencePath), { recursive: true });
  await writeFile(evidencePath, normalizeEvidence(transcripts.join("\n")));
  return report;
}

async function main(argv = process.argv.slice(2)) {
  const skipBuild = argv.includes("--skip-driver-build");
  const unknown = argv.filter((argument) => argument !== "--skip-driver-build");
  if (unknown.length) throw new Error(`Unknown argument: ${unknown[0]}`);
  const report = await checkHeadlessConformance({ skipBuild });
  console.log(`headless-conformance:report:${reportPath}`);
  console.log(
    `headless-conformance:observed=${report.summary.observed} ` +
    `mismatched=${report.summary.mismatched} ` +
    `engine-fault=${report.summary.engineFault} ` +
    `blocked=${report.summary.blocked} ` +
    `unreachable=${report.summary.unreachable} of ${report.contractCount} contracts`
  );
  for (const contract of report.contracts) {
    if (contract.outcome !== "engine-fault") continue;
    console.log(
      `headless-conformance:engine-fault:${contract.id}:${contract.engine.signal ?? "unknown"}:` +
      `${(contract.engine.crashFrames ?? [])[0] ?? "unattributed"}`
    );
    for (const line of contract.engine.diagnostics ?? []) {
      console.log(`headless-conformance:diagnostic:${contract.id}:${line}`);
    }
  }
  for (const [key, value] of Object.entries(report.propertySummary).sort()) {
    console.log(`headless-conformance:property:${key}=${value}`);
  }
  // A mismatch or blocked producer is evidence to publish and issue-track, not
  // an infrastructure failure. Policy generation must continue to expose the
  // route with that evidence attached. Only a crashed/faulted engine means the
  // evidence instrument itself failed to run.
  if (report.summary.engineFault > 0) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await main();
