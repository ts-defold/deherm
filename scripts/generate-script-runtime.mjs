#!/usr/bin/env node

import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { scriptGenerationSteps } from "./lib/script-generator-pipeline.mjs";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseArguments(argv) {
  const check = argv.includes("--check");
  const unknown = argv.filter((argument) => argument !== "--check");
  if (unknown.length) throw new Error(`Unknown argument: ${unknown[0]}`);
  return { check };
}

export async function runScriptGeneration({ check = false, root = repositoryRoot } = {}) {
  const results = [];
  for (const step of scriptGenerationSteps) {
    const command = step.runtime === "node" ? process.execPath : step.runtime;
    const args = [step.script, ...(check ? ["--check"] : [])];
    const result = await execFileAsync(command, args, {
      cwd: root,
      maxBuffer: 16 * 1024 * 1024
    });
    results.push({ ...step, stdout: result.stdout, stderr: result.stderr });
  }
  return results;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const results = await runScriptGeneration(options);
  for (const result of results) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
  }
  console.log(`${options.check ? "Verified" : "Generated"} the complete Defold script runtime pipeline (${results.length} deterministic steps).`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.stack ?? error.message);
    process.exitCode = 1;
  });
}
