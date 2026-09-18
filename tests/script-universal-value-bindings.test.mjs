import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

const root = path.resolve(import.meta.dirname, "..");
const reportPath = path.join(root, "bindings/generated/defold-script-universal-value-bindings.json");

function run(command, args, options = {}) {
  return execFileSync(command, args, { cwd: root, stdio: "pipe", encoding: "utf8", ...options });
}

test("universal-value generation is mechanical, complete for its selected families, and deterministic", async () => {
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  const projection = JSON.parse(await readFile(path.join(root, "bindings/generated/defold-script-projection-ir.json"), "utf8"));
  const accounting = JSON.parse(await readFile(path.join(root, "bindings/generated/defold-script-api-accounting.json"), "utf8"));
  const tableRecords = JSON.parse(await readFile(path.join(root, "bindings/generated/defold-script-table-record-bindings.json"), "utf8"));
  const accountingById = new Map(accounting.rows.map((row) => [row.id, row]));
  const optimized = new Set(tableRecords.bindings.map(({ id }) => id));
  const expected = projection.rows.filter((row) =>
    accountingById.get(row.id)?.category === report.selection.accountingCategory &&
    report.selection.loweringFamilies.includes(row.loweringFamily) &&
    !optimized.has(row.id) &&
    !report.selection.excludedLoweringFamilies.includes(row.loweringFamily) &&
    !report.selection.excludedContexts.includes(row.context.token) &&
    row.effects.callback.token === "none");
  assert.equal(report.candidateCount, expected.length);
  assert.deepEqual(new Set(report.bindings.map(({ id }) => id)), new Set(expected.map(({ id }) => id)));
  assert.ok(report.bindings.every(({ shapeKinds }) => Array.isArray(shapeKinds)));
  assert.match(report.evidenceBoundary, /remain unverified/);
  const temporary = await mkdtemp(path.join(tmpdir(), "deherm-universal-value-"));
  try {
    run(process.execPath, ["scripts/generate-script-universal-value-bindings.mjs", "--output-root", temporary]);
    for (const relative of [...report.artifacts, "bindings/generated/defold-script-universal-value-bindings.json"]) {
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
      "defold/defold_hermes/src/script_bridge_capi.cpp",
      "native/script_universal_value_capi_test.cpp", "-o", executable
    ]);
    assert.match(run(executable, []), /recursive-reentrant-cycle-exhaustion-idempotence:ok allocations:0/);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("Static Hermes provider type-checks and compiles through the pinned Static Hermes frontend", () => {
  run("npx", [
    "tsc", "--ignoreConfig", "--noEmit", "--strict", "--skipLibCheck", "--target", "ES2022",
    "--module", "NodeNext", "--moduleResolution", "NodeNext",
    "packages/static-hermes/src/globals.d.ts",
    "packages/static-hermes/src/generated/script-universal-value.ts"
  ]);
  const shermes = path.join(root, "build/native/bin/shermes");
  const output = path.join(tmpdir(), `deherm-script-universal-static-${process.pid}.c`);
  run(shermes, [
    "-fno-std-globals", "-parse-ts", "-typed", "-strict", "-O", "-emit-c",
    "-exported-unit=deherm_script_universal",
    "packages/static-hermes/src/generated/script-universal-value.ts", "-o", output
  ]);
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
  vm.runInNewContext(source, context, { filename: "generated_script_universal_value.js" });
  host = library.$DEFOLD_HERMES_SCRIPT_UNIVERSAL.install();
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
  const cycle = {}; cycle.self = cycle;
  assert.throws(() => host.call(101, [cycle]), /cycle/);
  const retained = host.call(102, [{ __dehermHandleV1: true, kind: 5, semanticKind: 7, runtime: 3, payload: 12n }]);
  retained.dispose();
  retained.dispose();
  assert.equal(releases, 1);
});
