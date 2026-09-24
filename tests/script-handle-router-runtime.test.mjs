import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("all generated native handle routes cross the pinned Lua 5.1 router", { timeout: 120_000 }, () => {
  execFileSync("cmake", ["-S", ".", "-B", "build/native", "-G", "Ninja", "-DCMAKE_BUILD_TYPE=Release"], {
    cwd: root,
    stdio: "pipe"
  });
  execFileSync("cmake", ["--build", "build/native", "--target", "defold-hermes-script-handle-router-test", "--parallel"], {
    cwd: root,
    stdio: "pipe"
  });
  const output = execFileSync("build/native/defold-hermes-script-handle-router-test", [], {
    cwd: root,
    encoding: "utf8"
  });
  assert.match(output, /script-handle-router:routes:405:ok/);
  assert.match(output, /script-handle-router:profiles:6:ok/);
  assert.match(output, /script-handle-router:profile:default-legacy-bullet:routes:313:ok/);
  assert.match(output, /script-handle-router:profile:v3-bullet:routes:380:ok/);
  assert.match(output, /script-handle-router:profile:legacy-no-bullet:routes:182:ok/);
  assert.match(output, /script-handle-router:profile:v3-no-bullet:routes:249:ok/);
  assert.match(output, /script-handle-router:profile:bullet-only:routes:201:ok/);
  assert.match(output, /script-handle-router:profile:no-physics:routes:70:ok/);
  assert.match(output, /script-handle-router:protected-errors:7:ok/);
  assert.match(output, /script-handle-router:profile-detection-negatives:6:ok/);
  assert.match(output, /script-handle-router:profile-detection-allocations:0/);
  assert.match(output, /script-handle-router:allocation-failure-retry:ok/);
  assert.match(output, /script-handle-router:attachment-lifecycle:roots-stale-reuse:ok/);
  assert.match(output, /script-handle-router:attachment-lifecycle-allocations:0/);
  assert.match(output, /script-handle-router:gui-producer-consumer:optional-stale-kind:ok/);
  assert.match(output, /script-handle-router:gui-bridge-allocations:0/);
  assert.match(output, /script-handle-router:reentrant-blocked:ok/);
  assert.match(output, /script-handle-router:allocations:0/);
});
