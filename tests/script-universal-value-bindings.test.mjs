import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

const root = path.resolve(import.meta.dirname, "..");
const reportPath = path.join(root, "packages/bindings/generated/defold-script-universal-value-bindings.json");

function run(command, args, options = {}) {
  return execFileSync(command, args, { cwd: root, stdio: "pipe", encoding: "utf8", ...options });
}

test("universal-value generation is mechanical, complete for its selected families, and deterministic", async () => {
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  const projection = JSON.parse(await readFile(path.join(root, "packages/bindings/generated/defold-script-projection-ir.json"), "utf8"));
  const expected = projection.rows.filter((row) =>
    report.selection.loweringFamilies.includes(row.loweringFamily) &&
    !report.selection.excludedLoweringFamilies.includes(row.loweringFamily) &&
    !report.selection.excludedContexts.includes(row.context.token));
  assert.equal(report.candidateCount, expected.length);
  assert.deepEqual(new Set(report.bindings.map(({ id }) => id)), new Set(expected.map(({ id }) => id)));
  assert.ok(report.bindings.every(({ shapeKinds }) => Array.isArray(shapeKinds)));
  assert.ok(report.bindings.every(({ minimumResultCount, maximumResultCount, resultCount }) =>
    Number.isInteger(minimumResultCount) && minimumResultCount >= 0 &&
    maximumResultCount === resultCount && minimumResultCount <= maximumResultCount));
  const loadResource = report.bindings.find(({ id }) => id === "script:sys.load_resource");
  assert.deepEqual(
    [loadResource.minimumResultCount, loadResource.maximumResultCount],
    [0, 2],
  );
  assert.match(report.evidenceBoundary, /remain unverified/);
  const temporary = await mkdtemp(path.join(tmpdir(), "deherm-universal-value-"));
  try {
    run(process.execPath, ["scripts/generate-script-universal-value-bindings.mjs", "--output-root", temporary]);
    for (const relative of [...report.artifacts, "packages/bindings/generated/defold-script-universal-value-bindings.json"]) {
      assert.equal(await readFile(path.join(temporary, relative), "utf8"), await readFile(path.join(root, relative), "utf8"), relative);
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("universal-value descriptor runtime compiles, links, and rejects invalid frames", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "deherm-universal-value-native-"));
  try {
    const executable = path.join(temporary, "test");
    run(process.env.CXX ?? "clang++", [
      "-std=c++17", "-Wall", "-Wextra", "-Werror", "-pedantic",
      `-I${path.join(root, "defold/defold_hermes/include")}`,
      "defold/defold_hermes/src/generated_script_universal_value_bindings.cpp",
      "native/script_universal_value_binding_test.cpp",
      "-o", executable
    ]);
    run(executable, []);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("portable C ABI compiles as C, runs recursive/reentrant native behavior, and stays allocation-free when warm", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "deherm-universal-value-capi-"));
  try {
    const cProbe = path.join(temporary, "probe.c");
    await writeFile(cProbe, [
      "#include <defold_hermes/generated_script_universal_value_capi.h>",
      "int main(void) { DehermScriptUniversalValue value = {0}; return (int)value.tag; }"
    ].join("\n"));
    run(process.env.CC ?? "clang", [
      "-std=c11", "-Wall", "-Wextra", "-Werror", "-pedantic",
      `-I${path.join(root, "defold/defold_hermes/include")}`, cProbe, "-o", path.join(temporary, "c-probe")
    ]);
    run(path.join(temporary, "c-probe"), []);
    const executable = path.join(temporary, "runtime");
    run(process.env.CXX ?? "clang++", [
      "-std=c++17", "-Wall", "-Wextra", "-Werror", "-Wno-zero-length-array", "-pedantic",
      `-I${path.join(root, "defold/defold_hermes/include")}`,
      "defold/defold_hermes/src/generated_script_universal_value_bindings.cpp",
      "defold/defold_hermes/src/generated_script_universal_value_capi.cpp",
      "defold/defold_hermes/src/generated_script_universal_static_frame.cpp",
      "defold/defold_hermes/src/script_bridge_capi.cpp",
      "native/script_universal_value_capi_test.cpp", "-o", executable
    ]);
    assert.match(run(executable, []), /recursive-reentrant-cycle-exhaustion-idempotence:ok allocations:0/);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("browser callback C ABI uses caller handle arenas, fixed slots, bounded reentrancy, and no warm C++ allocations", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "deherm-browser-callback-capi-"));
  try {
    const executable = path.join(temporary, "runtime");
    run(process.env.CXX ?? "clang++", [
      "-std=c++17", "-Wall", "-Wextra", "-Werror", "-Wno-zero-length-array", "-pedantic",
      "-DDM_PLATFORM_HTML5",
      `-I${path.join(root, "defold/defold_hermes/include")}`,
      "defold/defold_hermes/src/generated_script_universal_value_bindings.cpp",
      "defold/defold_hermes/src/generated_script_universal_value_capi.cpp",
      "defold/defold_hermes/src/script_bridge_capi.cpp",
      "native/script_browser_callback_capi_test.cpp", "-o", executable
    ]);
    assert.match(run(executable, []), /direct-memory-reentrant-error-lifetime-exhaustion:ok allocations:0/);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("Static Hermes provider type-checks and compiles through the pinned Static Hermes frontend", async () => {
  run("npx", [
    "tsc", "--ignoreConfig", "--noEmit", "--strict", "--skipLibCheck", "--target", "ES2022",
    "--module", "NodeNext", "--moduleResolution", "NodeNext",
    "packages/static-hermes/src/globals.d.ts",
    "packages/static-hermes/src/generated/script-universal-value.ts",
    "tests/fixtures/static-hermes-universal-types.ts"
  ]);
  const shermes = path.join(root, "build/native/bin/shermes");
  const output = path.join(tmpdir(), `deherm-script-universal-static-${process.pid}.c`);
  const staticSource = await readFile(path.join(root, "packages/static-hermes/src/generated/script-universal-value.ts"), "utf8");
  const staticInput = path.join(tmpdir(), `deherm-script-universal-static-${process.pid}.ts`);
  await writeFile(staticInput, staticSource.replace(/^export \{.*\};$/m, ""));
  try {
    run(shermes, [
      "-typed", "-strict", "-O", "-emit-c",
      "-exported-unit=deherm_script_universal",
      staticInput, "-o", output
    ]);
  } finally {
    await rm(staticInput, { force: true });
  }
});

test("browser provider round-trips recursive direct-memory values and rejects cycles", async () => {
  const source = await readFile(path.join(root, "defold/defold_hermes/lib/web/generated_script_universal_value.js"), "utf8");
  assert.doesNotMatch(source, /embind|Embind|ccall|cwrap/);
  const memory = new ArrayBuffer(16 * 1024 * 1024);
  const HEAPU8 = new Uint8Array(memory);
  const HEAPU32 = new Uint32Array(memory);
  const HEAPF32 = new Float32Array(memory);
  const HEAPF64 = new Float64Array(memory);
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let stack = 4096;
  let library;
  let releases = 0;
  let nested = false;
  let host;
  let callbackToken;
  const align = (value) => (value + 15) & ~15;
  const context = {
    HEAPU8, HEAPU32, HEAPF32, HEAPF64, BigInt, Map, Object, Array,
    FinalizationRegistry: undefined,
    stackSave: () => stack,
    stackAlloc: (size) => { const pointer = align(stack); stack = align(pointer + size); return pointer; },
    stackRestore: (checkpoint) => { stack = checkpoint; },
    lengthBytesUTF8: (value) => encoder.encode(value).length,
    stringToUTF8: (value, pointer, capacity) => {
      const bytes = encoder.encode(value);
      HEAPU8.set(bytes.subarray(0, Math.max(0, capacity - 1)), pointer);
      if (capacity) HEAPU8[pointer + Math.min(bytes.length, capacity - 1)] = 0;
    },
    UTF8ToString: (pointer, length) => {
      if (length === undefined) { length = 0; while (HEAPU8[pointer + length]) ++length; }
      return decoder.decode(HEAPU8.subarray(pointer, pointer + length));
    },
    autoAddDeps: () => {},
    addToLibrary: (value) => { library = value; },
    _deherm_script_universal_release: (pointer) => {
      if (HEAPU8[pointer] === 5 && HEAPU8[pointer + 1] >= 3) ++releases;
      HEAPU8.fill(0, pointer, pointer + 48);
    },
    _deherm_script_universal_dispatch: (...parameters) => {
      const [stableId, values, valueCount, entries, entryCount, strings, stringCount,
        floats, floatCount, urls, urlCount, roots, argumentCount,
        outValues, , outValueCount, outEntries, , outEntryCount,
        outStrings, , outStringCount, outFloats, , outFloatCount,
        outUrls, , outUrlCount, resultRoots, , resultCount] = parameters;
      if (stableId === 99 && !nested) { nested = true; host.call(100, []); nested = false; }
      if (stableId === 200) {
        assert.equal(argumentCount, 1);
        const callbackPointer = values + HEAPU32[roots >> 2] * 48;
        assert.equal(HEAPU8[callbackPointer], 6);
        callbackToken = {
          runtime: HEAPU32[(callbackPointer + 28) >> 2],
          slot: HEAPU32[(callbackPointer + 16) >> 2],
          generation: HEAPU32[(callbackPointer + 20) >> 2],
          type: HEAPU8[callbackPointer + 3]
        };
        HEAPU32[outValueCount >> 2] = HEAPU32[outEntryCount >> 2] = HEAPU32[outStringCount >> 2] = 0;
        HEAPU32[outFloatCount >> 2] = HEAPU32[outUrlCount >> 2] = HEAPU32[resultCount >> 2] = 0;
        return 0;
      }
      HEAPU8.copyWithin(outValues, values, values + valueCount * 48);
      HEAPU8.copyWithin(outEntries, entries, entries + entryCount * 8);
      HEAPU8.copyWithin(outStrings, strings, strings + stringCount);
      HEAPU8.copyWithin(outFloats, floats, floats + floatCount * 4);
      HEAPU8.copyWithin(outUrls, urls, urls + urlCount * 32);
      HEAPU32[outValueCount >> 2] = valueCount;
      HEAPU32[outEntryCount >> 2] = entryCount;
      HEAPU32[outStringCount >> 2] = stringCount;
      HEAPU32[outFloatCount >> 2] = floatCount;
      HEAPU32[outUrlCount >> 2] = urlCount;
      HEAPU32[resultCount >> 2] = argumentCount ? 1 : 0;
      if (argumentCount) HEAPU32[resultRoots >> 2] = HEAPU32[roots >> 2];
      return 0;
    }
  };
  const callbackRegistry = {
    runtime: 1, type: 1, functions: [], generations: [], free: [],
    acquire(callback) {
      const slot = this.free.length ? this.free.pop() : this.functions.length;
      if (this.generations[slot] === undefined) this.generations[slot] = 1;
      this.functions[slot] = callback;
      return { runtime: this.runtime, slot, generation: this.generations[slot], type: this.type };
    },
    resolveParts(runtime, slot, generation, type) {
      runtime >>>= 0; slot >>>= 0; generation >>>= 0; type >>>= 0;
      return runtime === this.runtime && type === this.type && this.generations[slot] === generation
        ? this.functions[slot] || null : null;
    },
    release(handle) { return this.releaseParts(handle.runtime, handle.slot, handle.generation, handle.type); },
    releaseParts(runtime, slot, generation, type) {
      if (!this.resolveParts(runtime, slot, generation, type)) return false;
      this.functions[slot] = null;
      this.generations[slot] = (this.generations[slot] + 1) >>> 0 || 1;
      this.free.push(slot);
      return true;
    }
  };
  context.DEFOLD_HERMES_WEB_CALLBACKS = callbackRegistry;
  vm.runInNewContext(source, context, { filename: "generated_script_universal_value.js" });
  context.DEFOLD_HERMES_SCRIPT_UNIVERSAL = library.$DEFOLD_HERMES_SCRIPT_UNIVERSAL;
  host = library.$DEFOLD_HERMES_SCRIPT_UNIVERSAL.install();
  const boundaryCheckpoint = stack;
  const boundaryValues = context.stackAlloc(48);
  const boundaryStrings = context.stackAlloc(5);
  const boundaryRoots = context.stackAlloc(4);
  HEAPU8[boundaryStrings + 4] = 0xa5;
  assert.throws(() => context.DEFOLD_HERMES_SCRIPT_UNIVERSAL.encodeWireRoots(
    ["1234"], boundaryValues, 1, 0, 0, boundaryStrings, 4,
    0, 0, 0, 0, boundaryRoots, 1), /reserved for UTF-8 termination/);
  assert.equal(HEAPU8[boundaryStrings + 4], 0xa5,
    "exact-capacity UTF-8 rejection must preserve the byte after declared scratch");
  context.stackRestore(boundaryCheckpoint);
  const input = Object.assign(Object.create(null), {
    name: "volcano",
    values: [1, true, 9n],
    nested: new Map([["x", { __dehermValueKind: "vector3", x: 1, y: 2, z: 3 }]]),
    url: { __dehermUrlV1: true, socket: 1n, reserved: 2n, path: 3n, fragment: 4n }
  });
  const output = host.call(99, [input]);
  assert.equal(output.name, "volcano");
  assert.deepEqual(Array.from(output.values), [1, true, 9n]);
  assert.equal(output.nested.get("x").z, 3);
  assert.equal(output.url.fragment, 4n);
  assert.equal(stack, 4096, "browser stack arena was not restored after reentrant dispatch");
  const variableTuple = host.call(0x8993930a, ["resource-data"]);
  assert.deepEqual(Array.from(variableTuple), ["resource-data", undefined],
    "browser SDK bridge must pad an omitted trailing optional Lua result");
  const cycle = {}; cycle.self = cycle;
  assert.throws(() => host.call(101, [cycle]), /cycle/);
  const retained = host.call(102, [{ __dehermHandleV1: true, kind: 5, semanticKind: 7, runtime: 3, payload: 12n }]);
  retained.dispose();
  retained.dispose();
  assert.equal(releases, 1);

  let callbackCalls = 0;
  callbackRegistry.runtime = 0x80000001;
  assert.equal(host.call(200, [(number, label, borrowed) => {
    callbackCalls += 1;
    assert.equal(number, 9.25);
    assert.equal(label, "hot");
    assert.equal(borrowed.borrowed, true);
    assert.equal(borrowed.kind, 3);
    borrowed.dispose();
    assert.equal(releases, 1, "borrowed callback handles must not release their Lua-owned token from JS");
    return 42.5;
  }]), undefined);
  assert.equal(typeof callbackRegistry.resolveParts(
    callbackToken.runtime, callbackToken.slot, callbackToken.generation, callbackToken.type), "function");
  const callbackCheckpoint = stack;
  const inputValues = context.stackAlloc(3 * 48);
  const inputStrings = context.stackAlloc(4);
  const inputRoots = context.stackAlloc(3 * 4);
  const outputValues = context.stackAlloc(4 * 48);
  const outputCounts = context.stackAlloc(6 * 4);
  const outputRoots = context.stackAlloc(4 * 4);
  const callbackError = context.stackAlloc(128);
  HEAPU8.fill(0, inputValues, inputValues + 3 * 48);
  HEAPU8[inputValues] = 3;
  HEAPF64[(inputValues + 8) >> 3] = 9.25;
  HEAPU8[inputValues + 48] = 4;
  HEAPU32[(inputValues + 48 + 4) >> 2] = 3;
  HEAPU32[(inputValues + 48 + 24) >> 2] = 0;
  HEAPU8[inputValues + 96] = 5;
  HEAPU8[inputValues + 97] = 3;
  HEAPU32[(inputValues + 96 + 28) >> 2] = 77;
  HEAPU32[(inputValues + 96 + 16) >> 2] = 9;
  HEAPU32[(inputValues + 96 + 20) >> 2] = 4;
  context.stringToUTF8("hot", inputStrings, 4);
  HEAPU32[inputRoots >> 2] = 0;
  HEAPU32[(inputRoots >> 2) + 1] = 1;
  HEAPU32[(inputRoots >> 2) + 2] = 2;
  const invoked = library.defoldHermesWebInvokeUniversalCallback(
    callbackToken.runtime | 0, callbackToken.slot | 0,
    callbackToken.generation | 0, callbackToken.type | 0,
    inputValues, 3, 0, 0, inputStrings, 3, 0, 0, 0, 0, inputRoots, 3,
    outputValues, 4, outputCounts, 0, 0, outputCounts + 4,
    0, 0, outputCounts + 8, 0, 0, outputCounts + 12,
    0, 0, outputCounts + 16, outputRoots, 4, outputCounts + 20,
    callbackError, 128);
  assert.equal(invoked, 1, context.UTF8ToString(callbackError));
  assert.equal(callbackCalls, 1);
  assert.equal(HEAPU32[outputCounts >> 2], 1);
  assert.equal(HEAPU8[outputValues], 3);
  assert.equal(HEAPF64[(outputValues + 8) >> 3], 42.5);
  callbackRegistry.releaseParts(callbackToken.runtime, callbackToken.slot, callbackToken.generation, callbackToken.type);
  assert.equal(library.defoldHermesWebInvokeUniversalCallback(
    callbackToken.runtime, callbackToken.slot, callbackToken.generation, callbackToken.type,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    outputValues, 4, outputCounts, 0, 0, outputCounts + 4,
    0, 0, outputCounts + 8, 0, 0, outputCounts + 12,
    0, 0, outputCounts + 16, outputRoots, 4, outputCounts + 20,
    callbackError, 128), 0);
  assert.match(context.UTF8ToString(callbackError), /stale/);
  context.stackRestore(callbackCheckpoint);

  const leakedBefore = callbackRegistry.functions.filter(Boolean).length;
  const callbackCycle = {}; callbackCycle.self = callbackCycle;
  assert.throws(() => host.call(201, [() => {}, callbackCycle]), /cycle/);
  assert.equal(callbackRegistry.functions.filter(Boolean).length, leakedBefore,
    "failed pre-dispatch encoding must release callback registry slots");
});
