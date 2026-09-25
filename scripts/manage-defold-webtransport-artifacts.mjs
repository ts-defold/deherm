#!/usr/bin/env node

import { appendFile, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  auditNativeArtifactDirectory,
  assembleNativeArtifacts,
  nativeArtifactRelease,
  packageNativeArtifact,
  planNativeArtifactBuilds,
  readNativeArtifactRows,
  stageNativeArtifactOverlay,
  writeNativeArtifactIndex,
  verifyNativeArtifact
} from "./lib/defold-webtransport-artifacts.mjs";

function parse(args) {
  const command = args.shift();
  const values = {};
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (!key.startsWith("--") || !args[index + 1] || args[index + 1].startsWith("--")) throw new Error(`${key} requires a value`);
    values[key.slice(2)] = args[++index];
  }
  return { command, values };
}

function required(values, name) {
  if (!values[name]) throw new Error(`--${name} is required`);
  return path.resolve(values[name]);
}

function githubRecords(plan) {
  const records = {};
  for (const lane of ["linux", "windows", "android", "apple"]) {
    records[`${lane}_rows`] = JSON.stringify(plan.lanes[lane].map((row) => row.slot));
    records[`${lane}_any`] = String(plan.lanes[lane].length > 0);
  }
  records.build_any = String(plan.missing.length > 0);
  records.expected_assets = JSON.stringify(plan.expectedAssets);
  return records;
}

export async function run(args = process.argv.slice(2)) {
  const { command, values } = parse([...args]);
  if (command === "release-metadata") return nativeArtifactRelease();
  if (command === "write-index") return writeNativeArtifactIndex();
  if (command === "check-index") return writeNativeArtifactIndex({ check: true });
  if (command === "rows") return readNativeArtifactRows();
  if (command === "plan") {
    const present = values.present ? (await readFile(path.resolve(values.present), "utf8")).split(/\r?\n/u).filter(Boolean) : [];
    const plan = await planNativeArtifactBuilds(present);
    if (values["describe-row"]) {
      const [lane, slotText] = values["describe-row"].split("=");
      const row = plan.lanes[lane]?.find((candidate) => candidate.slot === Number(slotText));
      if (!row) throw new Error(`No ${values["describe-row"]} build row`);
      if (values["github-env"]) {
        await appendFile(path.resolve(values["github-env"]), Object.entries(row).filter(([, value]) => !Array.isArray(value)).map(([key, value]) => `${key.toUpperCase()}=${value}`).join("\n") + "\n");
        return row;
      }
      return row;
    }
    if (values["github-output"]) {
      await appendFile(path.resolve(values["github-output"]), Object.entries(githubRecords(plan)).map(([key, value]) => `${key}=${value}`).join("\n") + "\n");
    }
    return plan;
  }
  if (command === "package") return packageNativeArtifact({ target: values.target, inputRoot: required(values, "input"), outputRoot: required(values, "output") });
  if (command === "verify") {
    const { archive: _archive, ...result } = await verifyNativeArtifact({ target: values.target, archivePath: required(values, "archive") });
    return result;
  }
  if (command === "assemble") return assembleNativeArtifacts({ sourceRoot: values.source ? path.resolve(values.source) : undefined, archiveRoot: required(values, "archives"), outputRoot: required(values, "output") });
  if (command === "stage") return stageNativeArtifactOverlay({ target: values.target, archivePath: required(values, "archive"), outputRoot: required(values, "output") });
  if (command === "audit") return auditNativeArtifactDirectory({ archiveRoot: required(values, "archives") });
  if (command === "audit-present") return auditNativeArtifactDirectory({ archiveRoot: required(values, "archives"), partial: true });
  throw new Error("Usage: manage-defold-webtransport-artifacts.mjs <release-metadata|write-index|check-index|rows|plan|package|verify|stage|assemble|audit|audit-present> [options]");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.stdout.write(`${JSON.stringify(await run(), null, 2)}\n`);
}
