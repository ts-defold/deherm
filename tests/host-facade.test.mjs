import assert from "node:assert/strict";
import test from "node:test";

import { hostLog, hostNow, hostRequest, hostRuntime } from "../packages/sdk/src/host.ts";

test("the public defold facade is the only authored route to the injected host", () => {
  const calls = [];
  globalThis.__defoldHostV1 = {
    version: 1,
    runtime: "test",
    log(level, message) {
      calls.push(["log", level, message]);
    },
    now() {
      calls.push(["now"]);
      return 42;
    },
    request(channel, payload) {
      calls.push(["request", channel, payload]);
      return `${channel}:${payload}`;
    },
  };

  try {
    hostLog("info", "ready");
    assert.equal(hostNow(), 42);
    assert.equal(hostRequest("match", "join"), "match:join");
    assert.equal(hostRuntime(), "test");
    assert.deepEqual(calls, [["log", "info", "ready"], ["now"], ["request", "match", "join"]]);
  } finally {
    globalThis.__defoldHostV1 = undefined;
  }
});

test("the public defold facade fails closed before a host is installed", () => {
  globalThis.__defoldHostV1 = undefined;
  assert.throws(() => hostLog("info", "no host"), /host v1 is not installed/);
});
