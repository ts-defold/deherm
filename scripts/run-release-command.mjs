#!/usr/bin/env node

import { spawn } from "node:child_process";
import { appendFile } from "node:fs/promises";

const [command, ...arguments_] = process.argv.slice(2);
if (!command) throw new Error("usage: run-release-command.mjs <command> [arguments...]");

const executable = process.platform === "win32" && !command.endsWith(".cmd") ? `${command}.cmd` : command;
const child = spawn(executable, arguments_, {
  env: process.env,
  shell: false,
  stdio: ["inherit", "pipe", "pipe"],
});

const maximumTailBytes = 64 * 1024;
let tail = "";
function observe(stream, destination) {
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    destination.write(chunk);
    tail = `${tail}${chunk}`;
    if (Buffer.byteLength(tail) > maximumTailBytes) {
      tail = Buffer.from(tail).subarray(-maximumTailBytes).toString("utf8");
    }
  });
}

observe(child.stdout, process.stdout);
observe(child.stderr, process.stderr);

const result = await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", (code, signal) => resolve({ code, signal }));
});

if (result.code !== 0) {
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) {
    const invocation = [command, ...arguments_].join(" ");
    const safeTail = tail.replaceAll("```", "` ` `");
    await appendFile(
      summary,
      `\n## Failed release command\n\n\`${invocation}\` exited ${result.code ?? result.signal}.\n\n<details><summary>Last ${maximumTailBytes / 1024} KiB</summary>\n\n\`\`\`text\n${safeTail}\n\`\`\`\n</details>\n`,
    );
  }
  process.exitCode = result.code ?? 1;
}
