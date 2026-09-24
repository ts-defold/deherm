#!/usr/bin/env node

import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const exampleRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const engine = resolve(exampleRoot, "defold/build/arm64-osx/dmengine");
const runtimeRoot = resolve(exampleRoot, "defold/build/default");
const project = resolve(runtimeRoot, "game.projectc");

try {
  await Promise.all([access(engine), access(project)]);
} catch {
  throw new Error(
    [
      "War Battles has not been built for arm64-macOS.",
      "Build the custom engine and resources first with the pinned Bob/local Extender flow documented in defold/README.md.",
    ].join(" "),
  );
}

const child = spawn(engine, process.argv.slice(2), {
  cwd: runtimeRoot,
  stdio: "inherit",
});

const result = await new Promise((resolveExit, reject) => {
  child.once("error", reject);
  child.once("exit", (code, signal) => resolveExit({ code, signal }));
});

if (result.code !== null) process.exitCode = result.code;
else if (result.signal === "SIGINT") process.exitCode = 130;
else if (result.signal === "SIGTERM") process.exitCode = 143;
else throw new Error(`War Battles engine stopped by ${result.signal ?? "an unknown signal"}`);
