#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";

const checks = [];

function command(name, args = ["--version"]) {
  const result = spawnSync(name, args, { encoding: "utf8" });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim().split("\n")[0];
  checks.push({ ok: result.status === 0, name, detail: output || "not found" });
  return result;
}

command(process.execPath, ["--version"]);
command("cmake");
command("ninja");
command("c++");

const java = process.env.JAVA_HOME
  ? `${process.env.JAVA_HOME}/bin/java`
  : "/opt/homebrew/opt/openjdk@25/bin/java";
const javaResult = command(java, ["-version"]);
if (javaResult.status === 0 && !`${javaResult.stderr}${javaResult.stdout}`.includes('version "25')) {
  checks.at(-1).ok = false;
  checks.at(-1).detail += " (JDK 25 required)";
}

const lock = await readFile(new URL("../upstream.lock", import.meta.url), "utf8");
const expectedBob = lock.match(/^DEFOLD_BOB_SHA256=(.+)$/m)?.[1];
const pinnedCheckouts = [
  ["Defold", "defold", lock.match(/^DEFOLD_REV=(.+)$/m)?.[1]],
  ["Hermes", "hermes", lock.match(/^HERMES_REV=(.+)$/m)?.[1]],
  ["Extender", "extender", lock.match(/^EXTENDER_REV=(.+)$/m)?.[1]]
];

for (const [name, directory, expected] of pinnedCheckouts) {
  const result = spawnSync("git", ["-C", new URL(`../upstream/${directory}`, import.meta.url).pathname, "rev-parse", "HEAD"], { encoding: "utf8" });
  const actual = result.stdout?.trim();
  checks.push({
    ok: result.status === 0 && actual === expected,
    name: `${name} checkout`,
    detail: result.status !== 0 ? "missing; run npm run bootstrap:upstreams" : actual === expected ? `pinned ${actual.slice(0, 12)}` : `expected ${expected}, got ${actual}`
  });
}

try {
  const bytes = await readFile(new URL("../build/tooling/bob.jar", import.meta.url));
  const actual = createHash("sha256").update(bytes).digest("hex");
  checks.push({
    ok: actual === expectedBob,
    name: "bob.jar",
    detail: actual === expectedBob ? "pinned checksum verified" : "checksum mismatch"
  });
} catch {
  checks.push({ ok: false, name: "bob.jar", detail: "missing; run npm run bootstrap:bob" });
}

// The repository doctor reports what this checkout can build; `deherm doctor`
// reports the same two matrices from a user's installed package. Summarising
// them here keeps "which platforms am I still missing" answerable without
// reading two JSON manifests.
for (const [name, script, key] of [
  ["target archives", "manage-native-artifacts.mjs", "targets"],
  // Host tools are reported per tool, not per host: hermesc and shermes are
  // built per architecture and dehermc cross-compiles to every host from one
  // job, so "3/15 available" is the honest count and "which tool" is the
  // actionable half of it.
  ["host tools", "manage-host-compilers.mjs", "hosts"]
]) {
  const result = spawnSync(process.execPath, [new URL(script, import.meta.url).pathname, "report"], { encoding: "utf8" });
  if (result.status !== 0) {
    checks.push({ ok: false, name, detail: (result.stderr ?? "").trim().split("\n").at(-1) || "report failed" });
    continue;
  }
  const reported = JSON.parse(result.stdout)[key];
  const rows = key === "hosts" ? reported.flatMap((host) => host.tools) : reported;
  const label = (row) => row.target ?? `${row.host} ${row.tool}`;
  const ready = rows.filter((row) => (row.status === "vendored" || row.status === "vendored-source") && !row.invalid);
  const blocked = rows.filter((row) => row.status === "blocked" || row.status === "retired-upstream");
  const pending = rows.filter((row) => row.status === "required-missing" || row.invalid);
  checks.push({
    ok: pending.length === 0,
    name,
    detail: `${ready.length}/${rows.length} available${pending.length ? `; missing ${pending.map(label).join(", ")}` : ""}${blocked.length ? `; blocked ${blocked.map((row) => `${label(row)} (${row.blocker?.code})`).join(", ")}` : ""}`
  });
}

if (process.platform === "darwin") {
  const sdk = spawnSync("xcrun", ["--sdk", "macosx", "--show-sdk-version"], { encoding: "utf8" });
  checks.push({
    ok: sdk.status === 0,
    name: "Xcode macOS SDK",
    detail: sdk.status === 0 ? sdk.stdout.trim() : "missing; install/select Xcode"
  });
}

for (const check of checks) {
  console.log(`${check.ok ? "ok" : "!!"} ${check.name}: ${check.detail}`);
}
if (checks.some((check) => !check.ok)) process.exitCode = 1;
