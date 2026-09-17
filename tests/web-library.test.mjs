import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

async function loadLibrary() {
  const source = await readFile(
    new URL("../defold/defold_hermes/lib/web/library_defold_hermes.js", import.meta.url),
    "utf8"
  );
  const context = vm.createContext({
    console,
    performance: { now: () => 0 },
    UTF8ToString: () => "void 0",
    autoAddDeps() {},
    addToLibrary() {}
  });
  vm.runInContext(source, context, { filename: "library_defold_hermes.js" });
  const library = context.LibraryDefoldHermes;
  context.DEFOLD_HERMES_WEB_CALLBACKS = library.$DEFOLD_HERMES_WEB_CALLBACKS;
  context.DEFOLD_HERMES_BRIDGE = library.$DEFOLD_HERMES_BRIDGE;
  context.DEFOLD_HERMES_GENERATED_MODULES = { install: () => ({}) };
  return { context, library };
}

test("web callback reset invalidates handles across runtime reloads", async () => {
  const { context } = await loadLibrary();
  const callbacks = context.DEFOLD_HERMES_WEB_CALLBACKS;
  const stale = callbacks.acquire(() => {});
  callbacks.reset();
  const current = callbacks.acquire(() => {});

  assert.equal(stale.slot, current.slot);
  assert.notEqual(stale.runtime, current.runtime);
  assert.equal(callbacks.resolve(stale), null);
  assert.equal(typeof callbacks.resolve(current), "function");
});

test("web finalization cleans roots and callbacks when the app hook throws", async () => {
  const { context } = await loadLibrary();
  const callbacks = context.DEFOLD_HERMES_WEB_CALLBACKS;
  const bridge = context.DEFOLD_HERMES_BRIDGE;
  const callback = callbacks.acquire(() => {});
  const error = new Error("final failed");

  bridge.app = { final() { throw error; } };
  context.__defoldAppV1 = bridge.app;
  context.__defoldHostV1 = {};
  context.__defoldModulesV1 = {};

  assert.throws(() => bridge.finalize(), /final failed/);
  assert.equal(bridge.app, null);
  assert.equal(context.__defoldAppV1, undefined);
  assert.equal(context.__defoldHostV1, undefined);
  assert.equal(context.__defoldModulesV1, undefined);
  assert.equal(callbacks.resolve(callback), null);
});

test("web callback storage enforces the same fixed capacity as native", async () => {
  const { context } = await loadLibrary();
  const callbacks = context.DEFOLD_HERMES_WEB_CALLBACKS;
  callbacks.capacity = 2;
  callbacks.acquire(() => {});
  callbacks.acquire(() => {});
  assert.throws(() => callbacks.acquire(() => {}), /pool is exhausted/);
});
