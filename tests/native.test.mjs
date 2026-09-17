import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("embedded Hermes executes the TypeScript bundle end to end", () => {
  const result = spawnSync(
    "build/native/defold-hermes-runner",
    ["dist/sample.js"],
    { cwd: process.cwd(), encoding: "utf8" }
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /host\.ready:hermes/);
  assert.match(result.stdout, /host\.log:info:init:hermes/);
  assert.match(result.stdout, /host\.log:info:module:42/);
  assert.match(result.stdout, /host\.log:info:final:ok/);
  assert.match(result.stdout, /defold-hermes:ok/);
});
