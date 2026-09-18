#!/usr/bin/env node

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildWarBattlesRuntimeGate,
  renderWarBattlesRuntimeGate
} from "./lib/war-battles-runtime-gate.mjs";

const repositoryRoot = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const reportPath = path.join(repositoryRoot, "knowledge/data/war-battles-runtime-gate.json");

function parseArguments(argv) {
  const options = { check: false, requireReady: false };
  for (const argument of argv) {
    if (argument === "--check") options.check = true;
    else if (argument === "--require-ready") options.requireReady = true;
    else throw new Error(`unknown argument: ${argument}`);
  }
  return options;
}

async function atomicWrite(file, content) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}`;
  await writeFile(temporary, content, "utf8");
  try {
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  const report = await buildWarBattlesRuntimeGate(repositoryRoot);
  const rendered = renderWarBattlesRuntimeGate(report);
  if (options.check) {
    let existing;
    try {
      existing = await readFile(reportPath, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (existing !== rendered) throw new Error(`${path.relative(repositoryRoot, reportPath)} is missing or stale`);
  } else {
    await atomicWrite(reportPath, rendered);
  }
  console.log(`War Battles API gate: ${report.status} (${report.counts.missingExecutableCount} missing executable binding(s))`);
  if (options.requireReady && report.status !== "ready") {
    throw new Error(`War Battles is blocked by: ${report.missingExecutableIds.join(", ")}`);
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.stack ?? String(error));
    process.exitCode = 1;
  });
}
