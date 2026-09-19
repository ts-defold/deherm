#!/usr/bin/env node

// Turn release contents into the exact CI rows that are still missing.
//
// The artifact fingerprint names a release; the asset name names one build
// row inside it.  Treating only the release as the cache key meant a failed
// run that published fourteen of fifteen rows rebuilt all fourteen good rows
// on the next attempt.  This planner makes the finer identity explicit:
//
//   (family fingerprint, asset name) -> one build row
//
// It is deliberately ordinary data and has unit tests.  The workflow consumes
// its matrices instead of maintaining a second list of "things we probably
// need to build" in YAML.

import { appendFile, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { publishedAssets, repositoryRoot } from "./lib/artifact-releases.mjs";

const targetExecutors = Object.freeze({
  "x86_64-linux": { lane: "linux", runner: "ubuntu-24.04", docker_platform: "linux/amd64" },
  "arm64-linux": { lane: "linux", runner: "ubuntu-24.04-arm", docker_platform: "linux/arm64" },
  "x86_64-win32": { lane: "windows" },
  "armv7-android": { lane: "android", abi: "armeabi-v7a", api_kind: "android_ndk_api" },
  "arm64-android": { lane: "android", abi: "arm64-v8a", api_kind: "android_64_ndk_api" },
  "x86_64-android": { lane: "android", abi: "x86_64", api_kind: "android_64_ndk_api" },
  "arm64-osx": { lane: "apple" },
  "x86_64-osx": { lane: "apple" },
  "arm64-ios": { lane: "apple" },
  "arm64_sim-ios": { lane: "apple" }
});

const hostExecutors = Object.freeze({
  "linux-x64": { runner: "ubuntu-22.04" },
  "linux-arm64": { runner: "ubuntu-22.04-arm" },
  "darwin-arm64": { runner: "macos-15" },
  "darwin-x64": { runner: "macos-15-intel" },
  "win32-x64": { runner: "windows-2022" }
});

function matrix(rows) {
  return { include: rows };
}

function rowWithKey(row, executor, key) {
  return { ...executor, [key]: row[key], asset: row.asset };
}

/**
 * Produce missing-row matrices from already-published asset names.
 *
 * `presentByFamily` values may be Sets or any iterable of asset names.  Every
 * publishable row must have exactly one executor mapping: a new Defold target
 * therefore fails here with its name instead of disappearing from CI.
 */
export async function planNativeArtifactBuilds(presentByFamily = {}, options = {}) {
  const root = options.root ?? repositoryRoot;
  const present = Object.fromEntries(
    ["native-artifacts", "hermes-host", "dehermc"].map((family) => [
      family,
      new Set(presentByFamily[family] ?? [])
    ])
  );

  const targetRows = await publishedAssets("native-artifacts", { root });
  const hermesHostRows = await publishedAssets("hermes-host", { root });
  const dehermcRows = await publishedAssets("dehermc", { root });

  const lanes = { linux: [], windows: [], android: [], apple: [] };
  for (const row of targetRows) {
    const executor = targetExecutors[row.target];
    if (!executor) throw new Error(`No native-artifact executor is declared for ${row.target} (${row.asset})`);
    if (present["native-artifacts"].has(row.asset)) continue;
    const { lane, ...fields } = executor;
    lanes[lane].push(rowWithKey(row, fields, "target"));
  }

  const hermesHosts = [];
  for (const row of hermesHostRows) {
    const executor = hostExecutors[row.host];
    if (!executor) throw new Error(`No Hermes host-compiler executor is declared for ${row.host} (${row.asset})`);
    if (!present["hermes-host"].has(row.asset)) {
      hermesHosts.push(rowWithKey(row, executor, "host"));
    }
  }

  // dehermc is pure Go and cross-compiles from one Linux job, so the host key
  // is the complete executor description.  Still validate the key against the
  // host manifest so a new spelling cannot silently publish an unusable name.
  const dehermcHosts = [];
  for (const row of dehermcRows) {
    if (!hostExecutors[row.host]) {
      throw new Error(`No dehermc host is declared for ${row.host} (${row.asset})`);
    }
    if (!present.dehermc.has(row.asset)) dehermcHosts.push({ host: row.host, asset: row.asset });
  }

  const assets = {
    "native-artifacts": {
      expected: targetRows.map((row) => row.asset),
      missing: targetRows.filter((row) => !present["native-artifacts"].has(row.asset)).map((row) => row.asset)
    },
    "hermes-host": {
      expected: hermesHostRows.map((row) => row.asset),
      missing: hermesHostRows.filter((row) => !present["hermes-host"].has(row.asset)).map((row) => row.asset)
    },
    dehermc: {
      expected: dehermcRows.map((row) => row.asset),
      missing: dehermcRows.filter((row) => !present.dehermc.has(row.asset)).map((row) => row.asset)
    }
  };

  return {
    matrices: {
      linux: matrix(lanes.linux),
      windows: matrix(lanes.windows),
      android: matrix(lanes.android),
      apple: matrix(lanes.apple),
      hermes_host: matrix(hermesHosts),
      dehermc: matrix(dehermcHosts)
    },
    any: {
      linux: lanes.linux.length > 0,
      windows: lanes.windows.length > 0,
      android: lanes.android.length > 0,
      apple: lanes.apple.length > 0,
      hermes_host: hermesHosts.length > 0,
      dehermc: dehermcHosts.length > 0
    },
    assets
  };
}

async function readNames(file) {
  if (!file) return [];
  return (await readFile(file, "utf8")).split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
}

function parseArguments(args) {
  const result = { present: {} };
  for (let index = 0; index < args.length; ++index) {
    const argument = args[index];
    if (argument === "--github-output") result.githubOutput = args[++index];
    else if (argument === "--present") {
      const value = args[++index] ?? "";
      const separator = value.indexOf("=");
      if (separator < 1) throw new Error("--present requires <family>=<newline-delimited-file>");
      result.present[value.slice(0, separator)] = value.slice(separator + 1);
    } else throw new Error(`Unknown argument ${argument}`);
  }
  return result;
}

async function main(args) {
  const options = parseArguments(args);
  const present = {};
  for (const [family, file] of Object.entries(options.present)) present[family] = await readNames(file);
  const plan = await planNativeArtifactBuilds(present);

  if (options.githubOutput) {
    const lines = [];
    for (const [name, value] of Object.entries(plan.matrices)) lines.push(`${name}_matrix=${JSON.stringify(value)}`);
    for (const [name, value] of Object.entries(plan.any)) lines.push(`${name}_any=${value}`);
    for (const [family, value] of Object.entries(plan.assets)) {
      const key = family.replaceAll("-", "_");
      lines.push(`${key}_missing=${JSON.stringify(value.missing)}`);
    }
    await appendFile(options.githubOutput, `${lines.join("\n")}\n`);
  } else {
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main(process.argv.slice(2));
}
