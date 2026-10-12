#!/usr/bin/env node
// Reuse owner generators/checks; never hand-edit derived world resources.
import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const exampleRoot = resolve(repositoryRoot, "examples/war-battles-online");
const options = new Set(process.argv.slice(2));
if (options.has("--help")) {
  console.log("Usage: node verify-world.mjs [--write] [--preview]");
  console.log(
    "Default is read-only checks. --write regenerates through owners; --preview writes build/evidence images.",
  );
  process.exit(0);
}
for (const option of options) {
  if (option !== "--write" && option !== "--preview") throw new Error(`unknown option ${option}`);
}

function run(command, args) {
  console.log(`world-verify: ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, { cwd: exampleRoot, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (options.has("--write")) {
  for (const task of ["hex-terrain", "coast", "tilemap", "sync"]) run("pnpm", [task]);
}
for (const task of ["hex-terrain:check", "coast:check", "tilemap:check", "sync:check"]) run("pnpm", [task]);
run("node", [
  "--test",
  "test/world-plan.test.mjs",
  "test/hex-cliffs.test.mjs",
  "test/hex-decor.test.mjs",
  "test/hex-terrain.test.mjs",
  "test/core.test.mjs",
]);
const auditWorld = fileURLToPath(new URL("./audit-world.mjs", import.meta.url));
run("node", [auditWorld, "--seed", "default", "--count", "1"]);
run("node", [auditWorld, "--count", "512"]);
if (options.has("--preview")) {
  run("node", ["tools/preview-world-plan.mjs"]);
  run("node", ["tools/preview-world-plan-art.mjs"]);
}
console.log("world-verify: checks passed; inspect packaged gameplay before visual signoff");
