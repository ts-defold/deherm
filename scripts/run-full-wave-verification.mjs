#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repositoryRootDefault = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultPlanPath = "verification/full-wave-matrix.json";
const defaultOutputRoot = "build/evidence/full-wave";
const allowedModes = new Set(["focused", "full"]);
const declaredStatuses = new Set(["blocked", "unavailable", "unobserved"]);
export const evidenceStages = Object.freeze([
  "generation",
  "compile",
  "link",
  "runtime",
  "packaged-engine",
  "sanitizer",
  "allocation",
  "clean-room",
  "target",
]);

let atomicSequence = 0;

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function safeId(value, label) {
  invariant(typeof value === "string" && /^[a-z0-9][a-z0-9-]*$/.test(value),
    `${label} must match [a-z0-9][a-z0-9-]*`);
  return value;
}

function repositoryRelative(value, label) {
  invariant(typeof value === "string" && value.length > 0, `${label} must be a non-empty path`);
  invariant(!path.isAbsolute(value), `${label} must be repository-relative`);
  const normalized = value.replaceAll("\\", "/");
  invariant(!normalized.split("/").includes(".."), `${label} must not escape the repository`);
  return normalized;
}

function validateCommand(command, label) {
  invariant(command && typeof command === "object" && !Array.isArray(command), `${label} must be an object`);
  safeId(command.id, `${label}.id`);
  invariant(typeof command.executable === "string" && command.executable.length > 0,
    `${label}.executable must be a non-empty string`);
  invariant(Array.isArray(command.arguments) && command.arguments.every((entry) => typeof entry === "string"),
    `${label}.arguments must be a string array`);
  if (command.cwd !== undefined) repositoryRelative(command.cwd, `${label}.cwd`);
  if (command.timeoutMs !== undefined) {
    invariant(Number.isInteger(command.timeoutMs) && command.timeoutMs >= 1 && command.timeoutMs <= 3_600_000,
      `${label}.timeoutMs must be an integer from 1 to 3600000`);
  }
}

export function validateVerificationPlan(plan) {
  invariant(plan && typeof plan === "object" && !Array.isArray(plan), "verification plan must be an object");
  invariant(plan.schemaVersion === 1, "verification plan schemaVersion must be 1");
  safeId(plan.matrixId, "matrixId");
  invariant(typeof plan.description === "string" && plan.description.length > 0,
    "verification plan description must be non-empty");
  invariant(Array.isArray(plan.rows) && plan.rows.length > 0, "verification plan rows must be non-empty");
  const rowIds = new Set();
  for (const [rowIndex, row] of plan.rows.entries()) {
    const rowLabel = `rows[${rowIndex}]`;
    invariant(row && typeof row === "object" && !Array.isArray(row), `${rowLabel} must be an object`);
    safeId(row.id, `${rowLabel}.id`);
    invariant(!rowIds.has(row.id), `duplicate verification row: ${row.id}`);
    rowIds.add(row.id);
    invariant(typeof row.title === "string" && row.title.length > 0, `${rowLabel}.title must be non-empty`);
    invariant(typeof row.scope === "string" && row.scope.length > 0, `${rowLabel}.scope must be non-empty`);
    invariant(row.cells && typeof row.cells === "object" && !Array.isArray(row.cells), `${rowLabel}.cells must be an object`);
    assertExactKeys(row.cells, evidenceStages, `${rowLabel}.cells`);
    for (const stage of evidenceStages) {
      const cell = row.cells[stage];
      const label = `${rowLabel}.cells.${stage}`;
      invariant(cell && typeof cell === "object" && !Array.isArray(cell), `${label} must be an object`);
      invariant(typeof cell.claim === "string" && cell.claim.length > 0, `${label}.claim must be non-empty`);
      if (cell.kind === "declared") {
        invariant(declaredStatuses.has(cell.status), `${label}.status must be blocked, unavailable, or unobserved`);
        invariant(typeof cell.reason === "string" && cell.reason.length > 0, `${label}.reason must be non-empty`);
        invariant(cell.commands === undefined, `${label} declared evidence must not contain commands`);
        if (cell.sources !== undefined) {
          invariant(Array.isArray(cell.sources) && cell.sources.length > 0, `${label}.sources must be non-empty`);
          for (const [sourceIndex, source] of cell.sources.entries()) {
            repositoryRelative(source, `${label}.sources[${sourceIndex}]`);
          }
        }
      } else if (cell.kind === "command") {
        invariant(cell.status === undefined && cell.reason === undefined,
          `${label} command evidence must not predeclare a status or reason`);
        invariant(Array.isArray(cell.modes) && cell.modes.length > 0, `${label}.modes must be non-empty`);
        invariant(cell.modes.every((mode) => allowedModes.has(mode)), `${label}.modes contains an unknown mode`);
        invariant(new Set(cell.modes).size === cell.modes.length, `${label}.modes contains duplicates`);
        invariant(Array.isArray(cell.commands) && cell.commands.length > 0, `${label}.commands must be non-empty`);
        const commandIds = new Set();
        for (const [commandIndex, command] of cell.commands.entries()) {
          validateCommand(command, `${label}.commands[${commandIndex}]`);
          invariant(!commandIds.has(command.id), `${label} has duplicate command id ${command.id}`);
          commandIds.add(command.id);
        }
      } else {
        throw new Error(`${label}.kind must be command or declared`);
      }
    }
  }
  return plan;
}

function assertExactKeys(value, expected, label) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  invariant(actual.length === wanted.length && actual.every((entry, index) => entry === wanted[index]),
    `${label} must contain exactly: ${wanted.join(", ")}`);
}

export async function loadVerificationPlan(planPath, repositoryRoot = repositoryRootDefault) {
  const absolute = path.resolve(repositoryRoot, planPath);
  const source = await readFile(absolute, "utf8");
  const plan = validateVerificationPlan(JSON.parse(source));
  return { absolute, plan, source };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function isoNow(now) {
  return now().toISOString();
}

function defaultRunId(now) {
  return `${isoNow(now).replace(/[^0-9A-Za-z]+/g, "-").replace(/^-|-$/g, "")}-${process.pid}`.toLowerCase();
}

function initialCell(cell) {
  const common = { kind: cell.kind, claim: cell.claim };
  if (cell.kind === "declared") {
    return { ...common, status: cell.status, reason: cell.reason, sources: cell.sources ?? [] };
  }
  return {
    ...common,
    status: "pending",
    modes: cell.modes,
    plannedCommands: cell.commands.map((command) => ({
      id: command.id,
      executable: command.executable,
      arguments: command.arguments,
      cwd: command.cwd ?? ".",
      timeoutMs: command.timeoutMs ?? 120_000,
    })),
    commands: [],
  };
}

function summarize(report) {
  const cellStatuses = {};
  const commandStatuses = {};
  for (const row of report.rows) {
    for (const stage of evidenceStages) {
      const cell = row.cells[stage];
      cellStatuses[cell.status] = (cellStatuses[cell.status] ?? 0) + 1;
      for (const command of cell.commands ?? []) {
        commandStatuses[command.status] = (commandStatuses[command.status] ?? 0) + 1;
      }
    }
  }
  const failed = cellStatuses.failed ?? 0;
  const pending = cellStatuses.pending ?? 0;
  const gaps = ["blocked", "unavailable", "unobserved", "not-run"]
    .reduce((count, status) => count + (cellStatuses[status] ?? 0), 0);
  const outcome = failed > 0
    ? "failed"
    : pending > 0
      ? "incomplete"
      : gaps > 0
        ? `${report.mode}-commands-passed-with-evidence-gaps`
        : "passed";
  return { outcome, failed, pending, evidenceGaps: gaps, cellStatuses, commandStatuses };
}

async function atomicWrite(file, contents) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${++atomicSequence}`;
  await writeFile(temporary, contents);
  await rename(temporary, file);
}

async function atomicJson(file, value) {
  await atomicWrite(file, `${JSON.stringify(value, null, 2)}\n`);
}

function resolvedExecutable(executable) {
  return executable === "$NODE" ? process.execPath : executable;
}

function printableCommand(executable, args) {
  return [executable, ...args].map((value) => JSON.stringify(value)).join(" ");
}

async function runCommand(command, context) {
  const executable = resolvedExecutable(command.executable);
  const args = [...command.arguments];
  const cwd = path.resolve(context.repositoryRoot, command.cwd ?? ".");
  const timeoutMs = command.timeoutMs ?? 120_000;
  const logPath = path.join(context.logRoot, `${String(context.commandIndex + 1).padStart(2, "0")}-${command.id}.log`);
  const startedAt = isoNow(context.now);
  const start = performance.now();
  let stdout = "";
  let stderr = "";
  let exitCode = 0;
  let signal = null;
  let errorMessage = null;
  let timedOut = false;
  try {
    const result = await execFileAsync(executable, args, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
      encoding: "utf8",
    });
    stdout = result.stdout ?? "";
    stderr = result.stderr ?? "";
  } catch (error) {
    stdout = typeof error.stdout === "string" ? error.stdout : "";
    stderr = typeof error.stderr === "string" ? error.stderr : "";
    exitCode = Number.isInteger(error.code) ? error.code : null;
    signal = error.signal ?? null;
    timedOut = error.killed === true && error.signal === "SIGTERM";
    errorMessage = error.message ?? String(error);
  }
  const finishedAt = isoNow(context.now);
  const durationMs = Math.max(0, Math.round((performance.now() - start) * 1000) / 1000);
  const status = exitCode === 0 && errorMessage === null ? "passed" : "failed";
  const record = {
    id: command.id,
    status,
    executable,
    arguments: args,
    commandLine: printableCommand(executable, args),
    cwd,
    timeoutMs,
    startedAt,
    finishedAt,
    durationMs,
    exitCode,
    signal,
    timedOut,
    logPath,
    ...(errorMessage ? { error: errorMessage } : {}),
  };
  await atomicWrite(logPath, [
    `${JSON.stringify(record, null, 2)}\n`,
    "--- stdout ---\n",
    stdout,
    stdout.endsWith("\n") || stdout.length === 0 ? "" : "\n",
    "--- stderr ---\n",
    stderr,
    stderr.endsWith("\n") || stderr.length === 0 ? "" : "\n",
  ].join(""));
  return record;
}

export async function runFullWaveVerification(options = {}) {
  const repositoryRoot = path.resolve(options.repositoryRoot ?? repositoryRootDefault);
  const mode = options.mode ?? "focused";
  invariant(allowedModes.has(mode), `Unknown verification mode: ${mode}`);
  const now = options.now ?? (() => new Date());
  const loaded = options.plan
    ? { plan: validateVerificationPlan(options.plan), source: `${JSON.stringify(options.plan, null, 2)}\n`, absolute: options.planPath ?? "<memory>" }
    : await loadVerificationPlan(options.planPath ?? defaultPlanPath, repositoryRoot);
  const outputRoot = path.resolve(repositoryRoot, options.outputRoot ?? defaultOutputRoot);
  const runId = safeId(options.runId ?? defaultRunId(now), "runId");
  const requestedRows = options.rows ? new Set(options.rows.map((row) => safeId(row, "row filter"))) : null;
  if (requestedRows) {
    const knownRows = new Set(loaded.plan.rows.map(({ id }) => id));
    for (const row of requestedRows) invariant(knownRows.has(row), `Unknown verification row: ${row}`);
  }
  const runDirectory = path.join(outputRoot, "runs", runId);
  try {
    await stat(runDirectory);
    throw new Error(`Verification run already exists: ${runDirectory}`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await mkdir(runDirectory, { recursive: true });
  const reportPath = path.join(runDirectory, "matrix.json");
  const report = {
    schemaVersion: 1,
    matrixId: loaded.plan.matrixId,
    planPath: loaded.absolute,
    planSha256: sha256(loaded.source),
    mode,
    runId,
    repositoryRoot,
    runDirectory,
    startedAt: isoNow(now),
    finishedAt: null,
    rows: loaded.plan.rows.map((row) => ({
      id: row.id,
      title: row.title,
      scope: row.scope,
      cells: Object.fromEntries(evidenceStages.map((stage) => [stage, initialCell(row.cells[stage])])),
    })),
    summary: null,
  };
  report.summary = summarize(report);
  await atomicJson(reportPath, report);

  for (let rowIndex = 0; rowIndex < loaded.plan.rows.length; rowIndex += 1) {
    const planRow = loaded.plan.rows[rowIndex];
    const resultRow = report.rows[rowIndex];
    for (const stage of evidenceStages) {
      const planCell = planRow.cells[stage];
      const resultCell = resultRow.cells[stage];
      if (planCell.kind === "declared") continue;
      if (requestedRows && !requestedRows.has(planRow.id)) {
        resultCell.status = "not-run";
        resultCell.reason = "row excluded by explicit filter";
      } else if (!planCell.modes.includes(mode)) {
        resultCell.status = "not-run";
        resultCell.reason = `cell is not selected in ${mode} mode`;
      } else {
        const logRoot = path.join(runDirectory, "logs", `${String(rowIndex + 1).padStart(2, "0")}-${planRow.id}`, stage);
        let failed = false;
        for (let commandIndex = 0; commandIndex < planCell.commands.length; commandIndex += 1) {
          const command = planCell.commands[commandIndex];
          if (failed) {
            resultCell.commands.push({
              id: command.id,
              status: "not-run-after-cell-failure",
              executable: resolvedExecutable(command.executable),
              arguments: command.arguments,
              cwd: path.resolve(repositoryRoot, command.cwd ?? "."),
              timeoutMs: command.timeoutMs ?? 120_000,
              logPath: null,
            });
            continue;
          }
          const result = await runCommand(command, {
            commandIndex,
            logRoot,
            now,
            repositoryRoot,
          });
          resultCell.commands.push(result);
          failed = result.status === "failed";
        }
        resultCell.status = failed ? "failed" : "passed";
      }
      report.summary = summarize(report);
      await atomicJson(reportPath, report);
    }
  }
  report.finishedAt = isoNow(now);
  report.summary = summarize(report);
  await atomicJson(reportPath, report);
  await atomicJson(path.join(outputRoot, "latest.json"), report);
  return { report, reportPath };
}

function usage() {
  return [
    "Usage: node scripts/run-full-wave-verification.mjs [options]",
    "  --mode focused|full",
    "  --plan PATH",
    "  --output-root PATH",
    "  --run-id ID",
    "  --row ID              repeatable row filter",
  ].join("\n");
}

function parseArguments(argv) {
  const options = { rows: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") return { help: true };
    if (argument === "--mode") options.mode = argv[++index];
    else if (argument === "--plan") options.planPath = argv[++index];
    else if (argument === "--output-root") options.outputRoot = argv[++index];
    else if (argument === "--run-id") options.runId = argv[++index];
    else if (argument === "--row") options.rows.push(argv[++index]);
    else throw new Error(`Unknown argument: ${argument}`);
    invariant(argv[index] !== undefined, `${argument} requires a value`);
  }
  if (options.rows.length === 0) delete options.rows;
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  const { report, reportPath } = await runFullWaveVerification(options);
  console.log(`Full-wave verification: ${report.summary.outcome}`);
  console.log(`Matrix: ${reportPath}`);
  console.log(`Cells: ${JSON.stringify(report.summary.cellStatuses)}`);
  if (report.summary.failed > 0) process.exitCode = 1;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(error.stack ?? error.message);
    process.exitCode = 1;
  });
}
