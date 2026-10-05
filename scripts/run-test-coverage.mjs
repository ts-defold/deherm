#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const partitions = JSON.parse(await readFile(path.join(root, "tests", "coverage-partitions.json"), "utf8"));
const [partitionName] = process.argv.slice(2);

if (!partitionName) throw new Error("usage: run-test-coverage.mjs <coverage-partition>");

const partition = partitions[partitionName];
if (!partition) throw new Error(`unknown coverage partition ${partitionName}`);
const { script: scriptName, include, thresholds } = partition;
if (!Array.isArray(include) || include.length === 0) throw new Error(`${partitionName} has no included sources`);

const command = manifest.scripts?.[scriptName];
if (typeof command !== "string") throw new Error(`unknown package script ${scriptName}`);

const commandArguments = command.trim().split(/\s+/u);
if (commandArguments[0] !== "node" || commandArguments[1] !== "--test") {
  throw new Error(`${scriptName} must be a leaf 'node --test ...' script`);
}
if (commandArguments.some((argument) => /^(?:&&|\|\||;|\||>|<)$/u.test(argument))) {
  throw new Error(`${scriptName} must not contain shell operators`);
}

const result = spawnSync(
  process.execPath,
  [
    "--experimental-test-coverage",
    ...include.map((file) => `--test-coverage-include=${file}`),
    `--test-coverage-lines=${thresholds.lines}`,
    `--test-coverage-branches=${thresholds.branches}`,
    `--test-coverage-functions=${thresholds.functions}`,
    ...commandArguments.slice(1),
  ],
  { cwd: root, env: process.env, stdio: "inherit" },
);

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
