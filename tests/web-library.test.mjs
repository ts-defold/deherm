import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const extensionBootstrapSource = await readFile(
  new URL("../defold/defold_hermes/lib/web/library_defold_hermes.js", import.meta.url),
  "utf8"
);

test("browser bootstrap installs the generated universal script provider", () => {
  assert.match(extensionBootstrapSource, /'\$DEFOLD_HERMES_SCRIPT_UNIVERSAL'/);
  assert.match(extensionBootstrapSource, /__defoldScriptBridgeV1 = DEFOLD_HERMES_SCRIPT_UNIVERSAL\.install\(\)/);
  assert.doesNotMatch(extensionBootstrapSource, /__defoldScriptBridgeV1 = DEFOLD_HERMES_SCRIPT_BRIDGE\.install\(\)/);
});

async function loadLibrary(options = {}) {
  const source = await readFile(
    new URL("../defold/defold_hermes/lib/web/library_defold_hermes.js", import.meta.url),
    "utf8"
  );
  const componentSource = await readFile(
    new URL("../defold/defold_hermes/lib/web/component_bridge.js", import.meta.url),
    "utf8"
  );
  const logs = [];
  const record = (level) => (...parts) => logs.push({ level, text: parts.join(" ") });
  const context = vm.createContext({
    console: options.captureConsole
      ? { log: record("log"), warn: record("warn"), error: record("error") }
      : console,
    performance: { now: () => 0, memory: options.memory },
    UTF8ToString: () => options.bundleSource ?? "void 0",
    stringToUTF8: () => {},
    autoAddDeps() {},
    addToLibrary() {}
  });
  vm.runInContext(source, context, { filename: "library_defold_hermes.js" });
  vm.runInContext(componentSource, context, { filename: "component_bridge.js" });
  const library = context.LibraryDefoldHermes;
  context.DEFOLD_HERMES_WEB_CALLBACKS = library.$DEFOLD_HERMES_WEB_CALLBACKS;
  context.DEFOLD_HERMES_BRIDGE = library.$DEFOLD_HERMES_BRIDGE;
  // The component pool is a peer library in the same Emscripten link, so the
  // bridge reaches it as a bare global exactly as it does in a real build.
  context.DEFOLD_HERMES_COMPONENTS = context.LibraryDefoldHermesComponents.$DEFOLD_HERMES_COMPONENTS;
  context.DEFOLD_HERMES_SCRIPT_UNIVERSAL = { install: () => ({ call() {} }) };
  context.DEFOLD_HERMES_GENERATED_MODULES = { install: () => ({}) };
  return { context, library, logs };
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

test("web reset disposes the generated universal scratch pool", async () => {
  const { context } = await loadLibrary();
  let disposals = 0;
  context.DEFOLD_HERMES_SCRIPT_UNIVERSAL = { dispose() { ++disposals; } };
  context.DEFOLD_HERMES_BRIDGE.reset();
  assert.equal(disposals, 1);
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

test("generated web bindings execute the timer lifecycle through real callback hooks", async () => {
  const { context, library } = await loadLibrary();
  const source = await readFile(
    new URL("../defold/defold_hermes/lib/web/generated_modules.js", import.meta.url),
    "utf8"
  );
  const verification = JSON.parse(await readFile(
    new URL("../packages/bindings/generated/defold-script-special-call-verification.json", import.meta.url),
    "utf8"
  ));
  const vectors = new Map(verification.separateModules.map((vector) => [vector.function, vector]));
  const scenario = verification.scenarios.find(({ module }) => module === "Timer");
  const calls = [];
  const timers = new Map();
  let nextHandle = scenario.firstHandle;
  context._defold_hermes_lua_timer_delay = (...args) => {
    calls.push({ function: "delay", args });
    const handle = nextHandle++;
    timers.set(handle, {
      repeating: args[1] !== 0,
      callback: { runtime: args[2], slot: args[3], generation: args[4], type: args[5] }
    });
    return handle;
  };
  context._defold_hermes_lua_timer_cancel = (handle) => {
    calls.push({ function: "cancel", args: [handle] });
    const timer = timers.get(handle);
    if (!timer) return 0;
    library.defoldHermesWebReleaseCallback(
      timer.callback.runtime,
      timer.callback.slot,
      timer.callback.generation,
      timer.callback.type
    );
    timers.delete(handle);
    return 1;
  };
  context._defold_hermes_lua_timer_trigger = (handle) => {
    calls.push({ function: "trigger", args: [handle] });
    const timer = timers.get(handle);
    if (!timer) return 0;
    const invoked = library.defoldHermesWebInvokeCallback(
      timer.callback.runtime,
      timer.callback.slot,
      timer.callback.generation,
      timer.callback.type,
      handle,
      scenario.elapsed
    );
    if (!timer.repeating) {
      library.defoldHermesWebReleaseCallback(
        timer.callback.runtime,
        timer.callback.slot,
        timer.callback.generation,
        timer.callback.type
      );
      timers.delete(handle);
    }
    return invoked;
  };
  context.DEFOLD_HERMES_DMSDK_SCALAR = { install: () => ({ call() {} }) };
  const universal = { catalogSha256: "0".repeat(64), abi: {}, recipes: [], call() {} };
  context.DEFOLD_HERMES_DMSDK_UNIVERSAL = universal;
  vm.runInContext(source, context, { filename: "generated_modules.js" });

  const modules = context.LibraryDefoldHermesGeneratedModules.$DEFOLD_HERMES_GENERATED_MODULES.install();
  const callbackEvents = [];
  const callback = (handle, elapsed) => callbackEvents.push({ handle, elapsed });
  const oneShot = modules.Timer.delay(scenario.delay, false, callback);
  assert.equal(oneShot, scenario.firstHandle);
  assert.equal(calls[0].args[0], scenario.delay);
  assert.equal(calls[0].args[1], 0);
  assert.equal(calls[0].args.length, vectors.get("delay").cAbiArguments.length);
  const callbackHandle = {
    runtime: calls[0].args[2],
    slot: calls[0].args[3],
    generation: calls[0].args[4],
    type: calls[0].args[5]
  };
  assert.equal(context.DEFOLD_HERMES_WEB_CALLBACKS.resolve(callbackHandle), callback);
  assert.equal(modules.Timer.trigger(oneShot), true);
  assert.deepEqual(callbackEvents, [{ handle: scenario.firstHandle, elapsed: scenario.elapsed }]);
  assert.equal(context.DEFOLD_HERMES_WEB_CALLBACKS.resolve(callbackHandle), null);

  const repeating = modules.Timer.delay(scenario.delay, true, callback);
  assert.equal(repeating, scenario.secondHandle);
  const repeatingCallback = timers.get(repeating).callback;
  assert.equal(modules.Timer.trigger(repeating), true);
  assert.equal(context.DEFOLD_HERMES_WEB_CALLBACKS.resolve(repeatingCallback), callback);
  assert.equal(modules.Timer.cancel(repeating), true);
  assert.equal(context.DEFOLD_HERMES_WEB_CALLBACKS.resolve(repeatingCallback), null);
  assert.equal(modules.Timer.trigger(repeating), false);
  assert.equal(typeof modules.Timer.cancel(7), "boolean");
  assert.deepEqual(calls.map(({ function: name, args }) => [name, args[0]]), [
    ["delay", scenario.delay],
    ["trigger", scenario.firstHandle],
    ["delay", scenario.delay],
    ["trigger", scenario.secondHandle],
    ["cancel", scenario.secondHandle],
    ["trigger", scenario.secondHandle],
    ["cancel", 7]
  ]);

  let failedHandle;
  context._defold_hermes_lua_timer_delay = (...args) => {
    failedHandle = { runtime: args[2], slot: args[3], generation: args[4], type: args[5] };
    return vectors.get("delay").callbackFailureValue;
  };
  assert.throws(() => modules.Timer.delay(scenario.delay, false, () => {}), /Timer\.delay failed/);
  assert.equal(context.DEFOLD_HERMES_WEB_CALLBACKS.resolve(failedHandle), null);
  assert.equal(modules.DmSdkUniversalRaw, universal);
});

test("generated browser dmSDK scalar adapter exposes only the 16 semantically valid bindings", async () => {
  const report = JSON.parse(await readFile(
    new URL("../packages/bindings/generated/defold-dmsdk-scalar-thunks.json", import.meta.url),
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

// The browser host's hot-reload transaction. HTML5 has no engine service, so a
// reload arrives through `__defoldHermesDevV1.activate` from the development
// control plane rather than as a Defold resource recreate. What is asserted
// here is the transaction, not the transport: ordering, rollback, component
// rebinding, and the fingerprint acknowledgement the CLI joins back to a build.

function bundle({ fingerprint, init = "", final = "", update = "", components = null }) {
  return `
    globalThis.__DEFOLD_HERMES_BUILD_FINGERPRINT__ = ${JSON.stringify(fingerprint)};
    globalThis.__defoldAppV1 = {
      init() { ${init} },
      update(dt) { ${update} },
      final() { ${final} }
    };
    ${components ? `globalThis.__defoldComponentsV1 = ${components};` : ""}
  `;
}

const fingerprintA = "a".repeat(64);
const fingerprintB = "b".repeat(64);

async function loadedBridge(options = {}) {
  const loaded = await loadLibrary({ captureConsole: true, ...options });
  loaded.context.DEFOLD_HERMES_BRIDGE.load(0, 0);
  return loaded;
}

test("browser activation commits a candidate and acknowledges its exact fingerprint", async () => {
  const marks = [];
  const { context, logs } = await loadedBridge({
    bundleSource: bundle({ fingerprint: fingerprintA, init: "globalThis.mark('a:init')", final: "globalThis.mark('a:final')" })
  });
  context.mark = (value) => marks.push(value);
  const bridge = context.DEFOLD_HERMES_BRIDGE;
  bridge.init();

  const result = bridge.activate(bundle({
    fingerprint: fingerprintB,
    init: "globalThis.mark('b:init')"
  }));

  assert.equal(result.status, "activated");
  assert.equal(result.fingerprint, fingerprintB);
  assert.equal(result.generation, 2);
  assert.equal(bridge.generation, 2);
  // The candidate initializes before the outgoing generation finalizes, which
  // is what makes a rejected candidate survivable. Native orders it the same way.
  assert.deepEqual(marks, ["a:init", "b:init", "a:final"]);
  assert.ok(logs.some(({ text }) => text.includes(
    `DEHERM_EVENT bundle-activated fingerprint=${fingerprintB} resource_generation=2 runtime_id=0 initial=false`)));
});

test("a browser candidate that throws leaves the running generation active", async () => {
  const marks = [];
  const { context, logs } = await loadedBridge({
    bundleSource: bundle({ fingerprint: fingerprintA, update: "globalThis.mark('a:update')" })
  });
  context.mark = (value) => marks.push(value);
  const bridge = context.DEFOLD_HERMES_BRIDGE;
  bridge.init();
  const running = bridge.app;

  const result = bridge.activate(bundle({
    fingerprint: fingerprintB,
    init: "throw new Error('candidate init failed')"
  }));

  assert.equal(result.status, "rejected");
  assert.match(result.diagnostic, /candidate init failed/);
  assert.equal(bridge.app, running, "the previous generation must still be the active one");
  assert.equal(bridge.generation, 1);
  assert.equal(context.__DEFOLD_HERMES_BUILD_FINGERPRINT__, fingerprintA);
  assert.equal(context.__defoldAppV1, running);
  bridge.update(0.016);
  assert.deepEqual(marks, ["a:update"]);
  // A rejection names the candidate's own fingerprint, so the control plane
  // can tell which pending build was refused rather than only that one was.
  assert.ok(logs.some(({ text }) => text.includes(
    `DEHERM_EVENT bundle-rejected fingerprint=${fingerprintB} resource_generation=2`)));
});

test("a browser candidate without a fingerprint cannot be acknowledged", async () => {
  const { context } = await loadedBridge({ bundleSource: bundle({ fingerprint: fingerprintA }) });
  const bridge = context.DEFOLD_HERMES_BRIDGE;
  const result = bridge.activate("globalThis.__defoldAppV1 = { init() {} };");
  assert.equal(result.status, "rejected");
  assert.match(result.diagnostic, /no build fingerprint/);
  assert.equal(bridge.generation, 1);
});

test("browser activation rebinds live component attachments under their existing identities", async () => {
  const registry = `{
    "player": {
      schemaFingerprint: "schema-1",
      contextKind: "game-object",
      definition: { onReload(self) { self.reloaded = (self.reloaded || 0) + 1; } }
    }
  }`;
  const { context } = await loadedBridge({ bundleSource: bundle({ fingerprint: fingerprintA, components: registry }) });
  const components = context.DEFOLD_HERMES_COMPONENTS;
  const handle = components.attach("player", "schema-1", "game-object");
  components.setProperty(handle.slot, handle.generation, "speed", 4);

  const result = context.DEFOLD_HERMES_BRIDGE.activate(bundle({ fingerprint: fingerprintB, components: registry }));

  assert.equal(result.status, "activated");
  assert.equal(result.reboundComponents, 1);
  const entry = components.resolve(handle.slot, handle.generation);
  assert.equal(entry.self.speed, 4, "the attachment's self table survives the swap");
  assert.equal(entry.self.reloaded, 1, "the new definition's onReload runs once");
});

test("a component schema change is refused rather than rebound", async () => {
  const registryOf = (schema) => `{
    "player": { schemaFingerprint: ${JSON.stringify(schema)}, contextKind: "game-object", definition: {} }
  }`;
  const { context } = await loadedBridge({
    bundleSource: bundle({ fingerprint: fingerprintA, components: registryOf("schema-1") })
  });
  const components = context.DEFOLD_HERMES_COMPONENTS;
  const handle = components.attach("player", "schema-1", "game-object");

  const result = context.DEFOLD_HERMES_BRIDGE.activate(
    bundle({ fingerprint: fingerprintB, components: registryOf("schema-2") }));

  assert.equal(result.status, "rejected");
  assert.match(result.diagnostic, /schema fingerprint changed/);
  assert.equal(context.DEFOLD_HERMES_BRIDGE.generation, 1);
  assert.equal(components.resolve(handle.slot, handle.generation).schema, "schema-1");
});

test("browser telemetry reports measured counters and names every gap", async () => {
  const { context } = await loadedBridge({
    bundleSource: bundle({ fingerprint: fingerprintA }),
    memory: { usedJSHeapSize: 4096, totalJSHeapSize: 8192, jsHeapSizeLimit: 65536 }
  });
  context.DEFOLD_HERMES_WEB_CALLBACKS.acquire(() => {});
  context.DEFOLD_HERMES_BRIDGE.update(0.02);

  const telemetry = context.DEFOLD_HERMES_BRIDGE.telemetry();
  assert.equal(telemetry.runtime, "browser");
  assert.equal(telemetry.available.callbackRoots, 1);
  assert.equal(telemetry.available.frameDtMs, 20);
  assert.equal(telemetry.available.jsHeapBytes, 4096);
  assert.equal(telemetry.frames, 1);
  // Every native counter with no browser equivalent is named with its reason;
  // none of them is filled in with a number that means something else.
  for (const counter of ["hermesHeapBytes", "hermesHeapPeakBytes", "luaHandles", "arenaHighWaterBytes"]) {
    assert.equal(typeof telemetry.unavailable[counter], "string", `${counter} must carry a reason`);
  }
});

test("the development entry point is installed by load and removed by reset", async () => {
  const { context } = await loadedBridge({ bundleSource: bundle({ fingerprint: fingerprintA }) });
  assert.equal(typeof context.__defoldHermesDevV1.activate, "function");
  assert.equal(typeof context.__defoldHermesDevV1.telemetry, "function");
  context.DEFOLD_HERMES_BRIDGE.finalize();
  assert.equal(context.__defoldHermesDevV1, undefined);
});
