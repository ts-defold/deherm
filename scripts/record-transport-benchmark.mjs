#!/usr/bin/env node

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const benchmark = path.join(repositoryRoot, "build/native/defold-hermes-transport-profile-benchmark");
const output = path.join(repositoryRoot, "docs/site/evidence/transport-overhead.json");
const args = new Set(process.argv.slice(2));

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function parseNumber(line, name) {
  const match = new RegExp(`(?:^|:)${name}=([0-9.]+)(?::|$)`, "u").exec(line);
  return match === null ? null : Number(match[1]);
}

function findLine(lines, prefix) {
  const line = lines.find((candidate) => candidate.startsWith(prefix));
  if (line === undefined) throw new Error(`benchmark did not emit ${prefix}`);
  return line;
}

function range(lines, prefix) {
  const line = findLine(lines, prefix);
  return { bestNanoseconds: parseNumber(line, "best_ns"), worstNanoseconds: parseNumber(line, "worst_ns") };
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

async function record() {
  const cache = await readFile(path.join(repositoryRoot, "build/native/CMakeCache.txt"), "utf8");
  if (!/^CMAKE_BUILD_TYPE:STRING=Release$/mu.test(cache) || !/^DEHERM_PROFILE:BOOL=OFF$/mu.test(cache)) {
    throw new Error("transport benchmark must be a Release build with DEHERM_PROFILE=OFF");
  }
  const { stdout } = await execFileAsync(benchmark, [], { cwd: repositoryRoot, maxBuffer: 4 * 1024 * 1024 });
  const lines = stdout.trim().split(/\r?\n/u);
  findLine(lines, "transport-profile:ok");
  const typedNativeRows = lines
    .filter((line) => line.startsWith("transport-profile:typed-native:"))
    .map((line) => ({
      bestNanoseconds: parseNumber(line, "best_ns"),
      worstNanoseconds: parseNumber(line, "worst_ns"),
    }));
  const ownedBridge = lines
    .filter((line) => line.startsWith("transport-profile:delta:"))
    .map((line) => parseNumber(line, "bridge_over_protected_ns"));
  const luaStackRows = lines
    .filter((line) => line.startsWith("transport-profile:lua-stack:"))
    .map((line) => parseNumber(line, "best_ns"));
  const protectedLuaRows = lines
    .filter((line) => line.startsWith("transport-profile:raw-lua-protected:"))
    .map((line) => parseNumber(line, "best_ns"));
  const document = {
    schemaVersion: 1,
    kind: "deherm.release-transport-overhead",
    observedOn: new Date().toISOString(),
    host: { platform: os.platform(), architecture: os.arch(), cpu: os.cpus()[0]?.model ?? "unknown" },
    build: { cmakeBuildType: "Release", profiling: false, warmupCalls: 20000, callsPerRepeat: 100000, repeats: 9 },
    results: {
      directCAbi: range(lines, "transport-profile:c-abi-native:1arg-1res:"),
      luaStackMedianNanoseconds: median(luaStackRows),
      protectedLuaMedianNanoseconds: median(protectedLuaRows),
      luaBridgeOwnedMedianNanoseconds: median(ownedBridge),
      luaBridgeOwnedRangeNanoseconds: { minimum: Math.min(...ownedBridge), maximum: Math.max(...ownedBridge) },
      typedNativeMedianNanoseconds: median(typedNativeRows.map((row) => row.bestNanoseconds)),
      typedNativeMinimumNanoseconds: Math.min(...typedNativeRows.map((row) => row.bestNanoseconds)),
      typedNativeMaximumNanoseconds: Math.max(...typedNativeRows.map((row) => row.bestNanoseconds)),
      typedNativeShapes: typedNativeRows.length,
    },
    source: {
      executable: "build/native/defold-hermes-transport-profile-benchmark",
      stdoutSha256: digest(stdout),
      harness: "native/transport_profile_benchmark.cpp",
    },
    evidenceBoundary:
      "Release host harness over stub providers. This measures generated crossing/framing cost, not the Defold call behind it; the Lua harness uses pinned PUC Lua 5.1 rather than Defold's shipping LuaJIT.",
  };
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(document, null, 2)}\n`);
  console.log(`recorded ${path.relative(repositoryRoot, output)}`);
}

async function check() {
  const document = JSON.parse(await readFile(output, "utf8"));
  if (document.schemaVersion !== 1 || document.kind !== "deherm.release-transport-overhead")
    throw new Error("invalid transport benchmark evidence");
  if (document.build?.cmakeBuildType !== "Release" || document.build?.profiling !== false)
    throw new Error("transport evidence is not an unprofiled release build");
  for (const value of [
    document.results?.directCAbi?.bestNanoseconds,
    document.results?.luaBridgeOwnedMedianNanoseconds,
    document.results?.typedNativeMedianNanoseconds,
  ]) {
    if (!(value > 0)) throw new Error("transport evidence has a missing or invalid measured value");
  }
  if (!/^[0-9a-f]{64}$/u.test(document.source?.stdoutSha256 ?? ""))
    throw new Error("transport evidence has no output digest");
  console.log("transport benchmark evidence is structurally current");
}

if (args.has("--record")) await record();
else if (args.has("--check")) await check();
else throw new Error("Usage: record-transport-benchmark.mjs {--record|--check}");
