import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("the precompiled runtime executes host-produced Hermes bytecode", () => {
  const result = spawnSync(
    "build/native/defold-hermes-runner",
    ["dist/sample.hbc"],
    { cwd: process.cwd(), encoding: "utf8" }
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /host\.ready:hermes/);
  assert.match(result.stdout, /host\.log:info:module:42/);
  assert.match(result.stdout, /host\.log:info:final:ok/);
  assert.match(result.stdout, /defold-hermes:ok/);
});
