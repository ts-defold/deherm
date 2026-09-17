import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

test("the browser host provides the generated timer contract without Hermes Wasm", async () => {
  const bundle = await readFile(new URL("../dist/web-host.js", import.meta.url), "utf8");
  const cleared = [];
  let nextBrowserTimer = 100;
  let now = 1_000;
  const context = {
    console,
    document: { querySelector() { return null; } },
    performance: { now() { return now; } },
    window: {
      setTimeout() { return nextBrowserTimer++; },
      setInterval() { return nextBrowserTimer++; },
      clearTimeout(handle) { cleared.push(["timeout", handle]); },
      clearInterval(handle) { cleared.push(["interval", handle]); }
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
  assert.equal(timer.trigger(oneShot), false);

  const repeating = timer.delay(1, true, () => {});
  assert.equal(timer.cancel(repeating), true);
  assert.deepEqual(cleared, [["interval", 101]]);
  assert.equal(timer.cancel(repeating), false);
});
