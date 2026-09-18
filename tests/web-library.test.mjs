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

test("generated web bindings normalize C ABI booleans to JavaScript booleans", async () => {
  const { context } = await loadLibrary();
  const source = await readFile(
    new URL("../defold/defold_hermes/lib/web/generated_modules.js", import.meta.url),
    "utf8"
  );
  context._defold_hermes_lua_timer_cancel = () => 1;
  context._defold_hermes_lua_timer_trigger = () => 0;
  context.DEFOLD_HERMES_DMSDK_SCALAR = { install: () => ({ call() {} }) };
  vm.runInContext(source, context, { filename: "generated_modules.js" });

  const modules = context.LibraryDefoldHermesGeneratedModules.$DEFOLD_HERMES_GENERATED_MODULES.install();
  assert.equal(modules.Timer.cancel(7), true);
  assert.equal(modules.Timer.trigger(7), false);
  assert.equal(typeof modules.Timer.cancel(7), "boolean");
});

test("generated browser dmSDK scalar adapter exposes only the 16 semantically valid bindings", async () => {
  const report = JSON.parse(await readFile(
    new URL("../bindings/generated/defold-dmsdk-scalar-thunks.json", import.meta.url),
    "utf8"
  ));
  const source = await readFile(
    new URL("../defold/defold_hermes/lib/web/generated_dmsdk_scalar.js", import.meta.url),
    "utf8"
  );
  const context = vm.createContext({ autoAddDeps() {}, addToLibrary() {} });
  let nativeCalls = 0;
  for (const declaration of report.declarations.filter(({ emitted }) => emitted)) {
    context[`_${declaration.wrapper}`] = () => {
      nativeCalls += 1;
      return declaration.nativeSignature.startsWith("bool ") ? 1 : 7;
    };
  }
  vm.runInContext(source, context, { filename: "generated_dmsdk_scalar.js" });
  const bridge = context.LibraryDefoldHermesDmSdkScalar.$DEFOLD_HERMES_DMSDK_SCALAR.install();
  const browser = report.declarations.filter(({ policy }) => policy?.browserJsCallable);
  const blocked = report.declarations.filter(({ emitted, policy }) => emitted && !policy?.browserJsCallable);
  assert.equal(browser.length, 16);
  for (const declaration of browser) bridge.call(declaration.bindingId, 0.375);
  assert.equal(nativeCalls, 16);
  for (const declaration of blocked) {
    assert.throws(() => bridge.call(declaration.bindingId, 0), /not available in the browser host/);
  }
});

test("browser script bridge declares helpers, supports bounded stack reentrancy, and restores its Emscripten stack", async () => {
  const source = await readFile(
    new URL("../defold/defold_hermes/lib/web/script_bridge.js", import.meta.url),
    "utf8"
  );
  const memory = new ArrayBuffer(256 * 1024);
  const HEAPU8 = new Uint8Array(memory);
  const HEAPU32 = new Uint32Array(memory);
  const HEAPF64 = new Float64Array(memory);
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let stack = 8;
  let nativeCalls = 0;
  let attemptReentry = false;
  let expectedInputString = "hello";
  let bridge;
  const context = vm.createContext({
    HEAPU8,
    HEAPU32,
    HEAPF64,
    autoAddDeps() {},
    addToLibrary() {},
    stackSave: () => stack,
    stackAlloc(size) {
      const result = stack;
      stack = (stack + size + 7) & ~7;
      return result;
    },
    stackRestore(value) { stack = value; },
    lengthBytesUTF8(value) { return encoder.encode(value).length; },
    stringToUTF8(value, pointer, capacity) {
      const bytes = encoder.encode(value).subarray(0, capacity - 1);
      HEAPU8.set(bytes, pointer);
      HEAPU8[pointer + bytes.length] = 0;
    },
    UTF8ToString(pointer, length) {
      const end = length === undefined ? HEAPU8.indexOf(0, pointer) : pointer + length;
      return decoder.decode(HEAPU8.subarray(pointer, end));
    },
    _defoldHermesScriptLastError: () => 0,
    _defoldHermesScriptCall(stableId, count, tags, handleKinds, numbers, payloads, offsets, lengths, strings, stringDataLength, outTag, outHandleKind, outNumber, outPayload) {
      nativeCalls += 1;
      if (attemptReentry) {
        attemptReentry = false;
        assert.equal(bridge.call(stableId, [12.5, true, "hello"]), 77);
        attemptReentry = true;
      }
      if (stableId === 0xa994c4c0) {
        assert.equal(count, 1);
        assert.equal(HEAPU8[tags], 5);
        assert.equal(HEAPU8[handleKinds], 1);
        assert.equal(HEAPU32[payloads >> 2], 0x89abcdef);
        assert.equal(HEAPU32[(payloads >> 2) + 1], 0x01234567);
        HEAPU8[outTag] = 5;
        HEAPU8[outHandleKind] = 1;
        HEAPU32[outPayload >> 2] = 0x7f580aab;
        HEAPU32[(outPayload >> 2) + 1] = 0xa2bc06d9;
        return 1;
      }
      assert.equal(stableId, 0x12345678);
      assert.equal(count, 3);
      assert.equal(stringDataLength, encoder.encode(expectedInputString).length);
      assert.deepEqual([...HEAPU8.subarray(tags, tags + count)], [3, 2, 4]);
      assert.equal(HEAPF64[numbers >> 3], 12.5);
      assert.equal(HEAPF64[(numbers >> 3) + 1], 1);
      const stringOffset = HEAPU32[(offsets >> 2) + 2];
      const stringLength = HEAPU32[(lengths >> 2) + 2];
      assert.equal(decoder.decode(HEAPU8.subarray(strings + stringOffset, strings + stringOffset + stringLength)), expectedInputString);
      HEAPU8[outTag] = 3;
      HEAPF64[outNumber >> 3] = 77;
      return 1;
    }
  });
  vm.runInContext(source, context, { filename: "script_bridge.js" });
  assert.deepEqual(
    [...context.LibraryDefoldHermesScriptBridge.$DEFOLD_HERMES_SCRIPT_BRIDGE__deps],
    [
      "defoldHermesScriptCall",
      "defoldHermesScriptLastError",
      "$stackSave",
      "$stackAlloc",
      "$stackRestore",
      "$UTF8ToString",
      "$stringToUTF8",
      "$lengthBytesUTF8"
    ]
  );
  context.DEFOLD_HERMES_SCRIPT_BRIDGE = context.LibraryDefoldHermesScriptBridge.$DEFOLD_HERMES_SCRIPT_BRIDGE;
  bridge = context.DEFOLD_HERMES_SCRIPT_BRIDGE.install();
  assert.equal(bridge.call(0x12345678, [12.5, true, "hello"]), 77);
  assert.equal(nativeCalls, 1);
  assert.equal(stack, 8);
  assert.equal(bridge.call(0xa994c4c0, [0x0123456789abcdefn]), 0xa2bc06d97f580aabn);
  assert.equal(nativeCalls, 2);
  assert.equal(stack, 8);
  attemptReentry = true;
  assert.equal(bridge.call(0x12345678, [12.5, true, "hello"]), 77);
  assert.equal(nativeCalls, 4);
  assert.equal(stack, 8);
  attemptReentry = false;
  expectedInputString = "\ufffdA";
  assert.equal(bridge.call(0x12345678, [12.5, true, "\ud800A"]), 77);
  assert.equal(nativeCalls, 5);
  assert.equal(stack, 8);
  assert.throws(() => bridge.call(1, [{}]), /does not yet support tables/);
  assert.equal(stack, 8);
});
