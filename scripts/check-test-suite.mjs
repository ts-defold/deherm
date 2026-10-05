#!/usr/bin/env node

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const coveragePartitions = JSON.parse(await readFile(path.join(root, "tests", "coverage-partitions.json"), "utf8"));
const testFilePattern = /tests\/[A-Za-z0-9_./-]+\.test\.mjs/gu;
const scriptCallPattern = /pnpm\s+([A-Za-z0-9:_-]+)/gu;
const coverageCallPattern = /node\s+scripts\/run-test-coverage\.mjs\s+([A-Za-z0-9_-]+)/gu;

function expandScript(name, ancestry = [], rows = []) {
  if (ancestry.includes(name)) throw new Error(`package script cycle: ${[...ancestry, name].join(" -> ")}`);
  const command = manifest.scripts?.[name];
  if (typeof command !== "string") throw new Error(`unknown package script ${name}`);
  const pathToScript = [...ancestry, name];
  for (const match of command.matchAll(testFilePattern)) {
    rows.push({ file: match[0], path: pathToScript.join(" -> ") });
  }
  for (const match of command.matchAll(scriptCallPattern)) {
    if (Object.hasOwn(manifest.scripts, match[1])) expandScript(match[1], pathToScript, rows);
  }
  for (const match of command.matchAll(coverageCallPattern)) {
    const partition = coveragePartitions[match[1]];
    if (!partition) throw new Error(`unknown coverage partition ${match[1]}`);
    expandScript(partition.script, pathToScript, rows);
  }
  return rows;
}

function indexRows(rows) {
  const indexed = new Map();
  for (const row of rows) {
    const paths = indexed.get(row.file) ?? [];
    paths.push(row.path);
    indexed.set(row.file, paths);
  }
  return indexed;
}

function assertNoDuplicateExecutions(name, indexed) {
  const duplicates = [...indexed].filter(([, paths]) => paths.length > 1);
  if (duplicates.length === 0) return;
  throw new Error(
    `${name} schedules duplicate test files:\n${duplicates
      .map(([file, paths]) => `- ${file}\n  ${paths.join("\n  ")}`)
      .join("\n")}`,
  );
}

const aggregate = indexRows(expandScript("test"));
const complete = indexRows(expandScript("verify"));
assertNoDuplicateExecutions("pnpm test", aggregate);
assertNoDuplicateExecutions("pnpm verify", complete);

const rootTests = (await readdir(path.join(root, "tests"), { withFileTypes: true }))
  .filter((entry) => entry.isFile() && entry.name.endsWith(".test.mjs"))
  .map((entry) => `tests/${entry.name}`)
  .sort();
const uncovered = rootTests.filter((file) => !complete.has(file));
if (uncovered.length > 0) {
  throw new Error(`pnpm verify does not own these root tests:\n${uncovered.map((file) => `- ${file}`).join("\n")}`);
}

function shingles(source, width = 4) {
  const lines = source
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("import ") && !line.startsWith("//"));
  const values = new Set();
  for (let index = 0; index <= lines.length - width; index += 1) {
    values.add(lines.slice(index, index + width).join("\n"));
  }
  return values;
}

const sources = new Map(
  await Promise.all(rootTests.map(async (file) => [file, shingles(await readFile(path.join(root, file), "utf8"))])),
);
let highestOverlap = null;
for (let leftIndex = 0; leftIndex < rootTests.length; leftIndex += 1) {
  for (let rightIndex = leftIndex + 1; rightIndex < rootTests.length; rightIndex += 1) {
    const left = sources.get(rootTests[leftIndex]);
    const right = sources.get(rootTests[rightIndex]);
    let shared = 0;
    for (const value of left) if (right.has(value)) shared += 1;
    const smaller = Math.min(left.size, right.size);
    const containment = smaller === 0 ? 0 : shared / smaller;
    const row = { left: rootTests[leftIndex], right: rootTests[rightIndex], shared, containment };
    if (shared >= 20 && (!highestOverlap || row.containment > highestOverlap.containment)) highestOverlap = row;
    if (shared >= 20 && containment >= 0.8) {
      throw new Error(
        `near-duplicate tests: ${row.left} and ${row.right} share ${shared} four-line blocks ` +
          `covering ${(containment * 100).toFixed(1)}% of the smaller file`,
      );
    }
  }
}

console.log(
  `test-suite: ${aggregate.size} unique fast tests; ${complete.size}/${rootTests.length} complete tests; ` +
    `0 duplicate executions; highest substantial static overlap ` +
    `${highestOverlap ? `${(highestOverlap.containment * 100).toFixed(1)}%` : "0%"}`,
);
