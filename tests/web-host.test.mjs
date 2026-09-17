import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

test("the browser host provides the generated timer contract without Hermes Wasm", async () => {
  const bundle = await readFile(new URL("../dist/web-host.js", import.meta.url), "utf8");
  const cleared = [];
  const timeouts = new Map();
  const intervals = new Map();
  let nextBrowserTimer = 100;
  let now = 1_000;
  const context = {
    console,
    document: { querySelector() { return null; } },
    performance: { now() { return now; } },
    window: {
      setTimeout(callback) {
        const handle = nextBrowserTimer++;
        timeouts.set(handle, callback);
        return handle;
      },
      setInterval(callback) {
        const handle = nextBrowserTimer++;
        intervals.set(handle, callback);
        return handle;
      },
      clearTimeout(handle) {
        timeouts.delete(handle);
        cleared.push(["timeout", handle]);
      },
      clearInterval(handle) {
        intervals.delete(handle);
        cleared.push(["interval", handle]);
      }
    }
  };
  vm.runInNewContext(bundle, context, { filename: "web-host.js" });

  const timer = context.__defoldModulesV1.Timer;
  const calls = [];
  const oneShot = timer.delay(0.25, false, (handle, elapsed) => {
    calls.push([handle, elapsed]);
  });
  now = 1_250;
  assert.equal(timer.trigger(oneShot), true);
  assert.deepEqual(calls, [[oneShot, 0.25]]);
  now = 1_500;
  assert.equal(timer.trigger(oneShot), true);
  assert.deepEqual(calls, [[oneShot, 0.25], [oneShot, 0.5]]);

  now = 1_600;
  timeouts.get(100)();
  assert.deepEqual(calls, [[oneShot, 0.25], [oneShot, 0.5], [oneShot, 0.6]]);
  assert.equal(timer.trigger(oneShot), false);

  now = 2_000;
  const repeatingCalls = [];
  const repeating = timer.delay(1, true, (handle, elapsed) => {
    repeatingCalls.push([handle, elapsed]);
  });
  now = 3_000;
  intervals.get(101)();
  now = 4_100;
  intervals.get(101)();
  now = 4_300;
  assert.equal(timer.trigger(repeating), true);
  now = 5_000;
  intervals.get(101)();
  assert.deepEqual(repeatingCalls, [
    [repeating, 1],
    [repeating, 1.1],
    [repeating, 0.2],
    [repeating, 0.9]
  ]);
  assert.equal(timer.cancel(repeating), true);
  assert.deepEqual(cleared, [["interval", 101]]);
  assert.equal(timer.cancel(repeating), false);
});
