import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { transform } from "esbuild";

const moduleSource = await readFile(new URL("../packages/sdk/src/hmr-state.ts", import.meta.url), "utf8");
const transformed = await transform(moduleSource, { loader: "ts", format: "esm", target: "es2020" });
const moduleUrl = `data:text/javascript,${encodeURIComponent(transformed.code)}`;

test("hmrPersistentState preserves a keyed cell across module evaluation", async () => {
  delete globalThis.__dehermHmrPersistentStateV1;
  const first = await import(`${moduleUrl}#generation=1`);
  const original = first.hmrPersistentState("test/cell", () => ({ count: 1 }));
  original.value.count = 4;
  const second = await import(`${moduleUrl}#generation=2`);
  const retained = second.hmrPersistentState("test/cell", () => ({ count: 99 }));
  assert.strictEqual(retained, original);
  assert.equal(retained.value.count, 4);
});

test("hmrPersistentState creates independent cells and rejects empty keys", async () => {
  const { hmrPersistentState } = await import(`${moduleUrl}#generation=3`);
  const left = hmrPersistentState("test/left", () => 1);
  const right = hmrPersistentState("test/right", () => 2);
  assert.notStrictEqual(left, right);
  assert.throws(() => hmrPersistentState("", () => 0), /non-empty string/);
});
