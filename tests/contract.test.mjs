import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

test("the bundled TypeScript app obeys the v1 host contract", async () => {
  const bundle = await readFile(new URL("../dist/sample.js", import.meta.url), "utf8");
  const transcript = [];
  const context = {
    __defoldModulesV1: {
      ExampleMath: { add(a, b) { return a + b; } }
    },
    __defoldHostV1: {
      version: 1,
      runtime: "test",
      log(level, message) { transcript.push(`log:${level}:${message}`); },
      now() { return 42; },
      request(channel, payload) {
        transcript.push(`request:${channel}:${payload}`);
        return `test:${channel}:${payload}`;
      }
    }
  };

  vm.runInNewContext(bundle, context, { filename: "sample.js" });
  const app = context.__defoldAppV1;
  assert.ok(app, "bundle registered an application");

  app.init?.();
  for (let index = 0; index < 3; index += 1) app.update?.(1 / 60);
  app.onMessage?.("hello-from-contract-test");
  app.final?.();

  assert.deepEqual(transcript, [
    "log:info:init:test",
    "log:info:module:42",
    "request:ready:typescript",
    "log:debug:clock-ready:true",
    "log:debug:update:1:0.016667",
    "log:debug:update:2:0.016667",
    "log:debug:update:3:0.016667",
    "log:info:message:hello-from-contract-test",
    "log:info:final:ok"
  ]);
});
