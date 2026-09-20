import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { materializeDmSdkUsages } from "../packages/compiler/src/dmsdk-universal-materializer.mjs";
import { dmSdkUniversalCatalogSha256, dmSdkUniversalRecipes } from "../packages/compiler/src/generated/dmsdk-universal-recipes.mjs";
import { buildUniversalDmSdkBindings } from "../scripts/generate-dmsdk-universal-bindings.mjs";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const reportPath = path.join(root, "packages/bindings/generated/defold-dmsdk-universal-bindings.json");
const sdkIrPath = path.join(root, "packages/bindings/generated/defold-sdk-ir.json");
const compiler = process.env.CXX || "clang++";
const policyCatalog = Object.freeze({
  sourceHashes: Object.freeze({ catalog: dmSdkUniversalCatalogSha256 }),
  recipes: dmSdkUniversalRecipes
});

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function run(command, args) {
  return execFileSync(command, args, { cwd: root, encoding: "utf8", stdio: "pipe" });
}

function recipe(report, symbol, predicate = () => true) {
  const matches = report.recipes.filter((item) => item.symbol === symbol && predicate(item));
  assert.equal(matches.length, 1, `expected one recipe for ${symbol}, got ${matches.length}`);
  return matches[0];
}

test("universal dmSDK recipes cover every declaration and every target", async () => {
  const [report, sdkIr] = await Promise.all([
    readFile(reportPath, "utf8").then(JSON.parse),
    readFile(sdkIrPath, "utf8").then(JSON.parse),
  ]);
  assert.deepEqual(report.coverage, {
    declarations: 1361,
    recipes: 1361,
    cAbiDispatchable: 1361,
    dynamicHermesMetadata: 1361,
    staticHermesDeclarations: 1361,
    browserDirectMemoryMetadata: 1361,
    typescriptStableIds: 1361,
    silentlyOmitted: 0,
    preferredSpecialized: 148,
    usageMaterializedFallback: 1213,
  });
  assert.equal(new Set(report.recipes.map(({ numericId }) => numericId)).size, 1361);
  assert.equal(new Set(report.recipes.map(({ declarationId }) => declarationId)).size, 1361);
  assert.deepEqual(
    report.recipes.map(({ declarationId }) => declarationId).sort(),
    sdkIr.declarations.filter(({ disposition }) => disposition === "generated-raw-call").map(({ id }) => id).sort(),
    "the universal catalog must cover the source-derived public runtime declaration set, not only another generated catalog",
  );
  for (const item of report.recipes) {
    assert.equal(item.fallback.state, "materializable");
    assert.equal(item.fallback.silentOmissionAllowed, false);
    assert.equal(item.targets.browserWasm.embind, false);
    assert.ok(item.targets.cAbi.path && item.targets.dynamicHermes.path && item.targets.staticHermes.path && item.targets.typescript.path);
  }
});

test("universal dmSDK artifacts regenerate byte-for-byte", async () => {
  const output = await mkdtemp(path.join(tmpdir(), "deherm-dmsdk-universal-"));
  try {
    const report = await buildUniversalDmSdkBindings({ root, outRoot: output });
    for (const artifact of report.artifacts) {
      const [expected, actual] = await Promise.all([
        readFile(path.join(root, artifact)),
        readFile(path.join(output, artifact)),
      ]);
      assert.ok(expected.equals(actual), artifact);
    }
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});

test("universal dmSDK ABI header is C11-compatible and linkable", async () => {
  const output = await mkdtemp(path.join(tmpdir(), "deherm-dmsdk-universal-c-"));
  try {
    const caller = path.join(output, "caller.c");
    const object = path.join(output, "caller.o");
    const executable = path.join(output, "caller");
    await writeFile(caller, `
#include <defold_hermes/generated_dmsdk_universal.h>
int main(void) {
  DehermDmSdkUniversalValue result = {0};
  return deherm_dmsdk_universal_count() == 1361 &&
    deherm_dmsdk_universal_dispatch(1361, 0, 0, &result) == DEHERM_DMSDK_UNIVERSAL_UNKNOWN_ID ? 0 : 1;
}
`);
    run(process.env.CC || "clang", ["-std=c11", "-Wall", "-Wextra", "-Werror", "-pedantic",
      `-I${path.join(root, "defold/defold_hermes/include")}`, "-c", caller, "-o", object]);
    run(compiler, ["-std=c++17", `-I${path.join(root, "defold/defold_hermes/include")}`,
      "defold/defold_hermes/src/generated_dmsdk_universal.cpp", object, "-o", executable]);
    run(executable, []);
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});

test("universal dmSDK runtime bridge is generated, catalog-authenticated, and direct-memory linked", async () => {
  const [header, source, web, typescript, installer] = await Promise.all([
    readFile(path.join(root, "defold/defold_hermes/include/defold_hermes/generated_dmsdk_universal_jsi.hpp"), "utf8"),
    readFile(path.join(root, "defold/defold_hermes/src/generated_dmsdk_universal_jsi.cpp"), "utf8"),
    readFile(path.join(root, "defold/defold_hermes/lib/web/generated_dmsdk_universal.js"), "utf8"),
    readFile(path.join(root, "packages/sdk/src/generated/dmsdk/universal.ts"), "utf8"),
    readFile(path.join(root, "defold/defold_hermes/src/generated_jsi.cpp"), "utf8"),
  ]);
  assert.match(header, /installDmSdkUniversalModule/);
  assert.match(source, /deherm_dmsdk_universal_catalog_sha256/);
  assert.match(source, /isInt64/);
  assert.match(source, /memory\.byteLength/);
  assert.match(web, /DMSDK_UNIVERSAL__deps:\["deherm_dmsdk_universal_dispatch","deherm_dmsdk_universal_catalog_sha256"\]/);
  assert.match(typescript, /catalog identity mismatch/);
  assert.match(installer, /installDmSdkUniversalModule\(runtime, modules\)/);
  const output = await mkdtemp(path.join(tmpdir(), "deherm-dmsdk-universal-jsi-"));
  try {
    run(compiler, ["-std=c++17", "-Wall", "-Wextra", "-Werror", "-pedantic",
      `-I${path.join(root, "defold/defold_hermes/include")}`, `-I${path.join(root, "upstream/hermes/API/jsi")}`,
      "-c", "defold/defold_hermes/src/generated_dmsdk_universal_jsi.cpp", "-o", path.join(output, "jsi.o")]);
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});

test("browser arena adapter executes typed direct-memory cells with balanced scratch releases", async () => {
  const { createBrowserDmSdkUniversalBridge } = await import("../packages/sdk/src/generated/dmsdk/browser-arena.ts");
  const memory = new WebAssembly.Memory({ initial: 1 });
  let cursor = 64;
  const released = [];
  const transport = {
    memory,
    catalogSha256: dmSdkUniversalCatalogSha256,
    allocate(size, alignment) { cursor = (cursor + alignment - 1) & ~(alignment - 1); const result = cursor; cursor += size; return result; },
    release(address, size, alignment) { released.push([address, size, alignment]); },
    dispatch(id, args, count, result) {
      const view = new DataView(memory.buffer);
      if (id === 7 && count === 1) {
        assert.equal(view.getUint32(args + 16, true), 3);
        view.setBigUint64(result, view.getBigUint64(args, true) + 1n, true);
        view.setUint32(result + 16, 3, true);
        return 0;
      }
      if (id === 8 && count === 1) {
        assert.equal(view.getUint32(args + 16, true), 5);
        const pointer = Number(view.getBigUint64(args, true));
        const length = Number(view.getBigUint64(args + 8, true));
        assert.equal(new TextDecoder().decode(new Uint8Array(memory.buffer, pointer, length)), "arena");
        view.setBigUint64(result, 1n, true); view.setUint32(result + 16, 1, true);
        return 0;
      }
      return 1;
    },
  };
  const bridge = createBrowserDmSdkUniversalBridge(transport);
  assert.equal(bridge.call(7, [41n]), 42n);
  assert.equal(bridge.call(8, ["arena"]), true);
  assert.ok(released.length >= 5);
  assert.throws(() => createBrowserDmSdkUniversalBridge({ ...transport, catalogSha256: "0".repeat(64) }), /catalog identity mismatch/);
});

test("usage materializer compiles, links, and runs direct, function-template, constructor, method, and destructor recipes", async () => {
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  const toNetwork = recipe(report, "dmEndian::ToNetwork", (item) => item.abi.parameters[0]?.nativeType === "uint32_t");
  const toHost = recipe(report, "dmEndian::ToHost", (item) => item.abi.parameters[0]?.nativeType === "uint32_t");
  const constructor = recipe(report, "dmArray::dmArray::dmArray<T>", (item) => item.line === 101);
  const capacity = recipe(report, "dmArray::dmArray::Capacity");
  const destructor = recipe(report, "dmArray::dmArray::~dmArray<T>");
  const clamp = recipe(report, "dmMath::Clamp");
  const i32 = (name, position) => ({ name, position, nativeType: "int32_t", direction: "value", shape: { kind: "scalar", name: "i32" }, requirements: [] });
  const usages = [
    { declarationId: toNetwork.declarationId, wrapper: "wrap_to_network", acknowledgements: { generatedAdapterBypass: { reason: "exercise universal fallback", evidence: "native harness checks endian round trip" } } },
    { declarationId: toHost.declarationId, wrapper: "wrap_to_host", acknowledgements: { generatedAdapterBypass: { reason: "exercise universal fallback", evidence: "native harness checks endian round trip" } } },
    {
      declarationId: constructor.declarationId,
      wrapper: "wrap_array_construct",
      receiverCppType: "dmArray<uint32_t>",
      typeSubstitutions: { T: "uint32_t" },
      acknowledgements: { outStorageInitializationFailure: { reason: "fixture supplies aligned placement storage", evidence: "native harness constructs and destroys the object" } },
    },
    { declarationId: capacity.declarationId, wrapper: "wrap_array_capacity", receiverCppType: "dmArray<uint32_t>" },
    { declarationId: destructor.declarationId, wrapper: "wrap_array_destroy", receiverCppType: "dmArray<uint32_t>" },
    {
      declarationId: clamp.declarationId,
      wrapper: "wrap_clamp_i32",
      templateArguments: ["int32_t"],
      parameters: [i32("value", 0), i32("minimum", 1), i32("maximum", 2)],
      resultCppType: "int32_t",
      resultShape: { kind: "scalar", name: "i32" },
    },
  ];
  const generated = materializeDmSdkUsages(usages, { catalog: policyCatalog, catalogSha256: dmSdkUniversalCatalogSha256 });
  assert.equal(generated.manifest.length, usages.length);
  assert.equal(generated.verification.vectorCount, usages.length);
  assert.equal(generated.verification.vectors.length, usages.length);
  assert.match(generated.verification.manifestSha256, /^[0-9a-f]{64}$/);
  const { manifestSha256, ...verificationPayload } = generated.verification;
  assert.equal(manifestSha256, sha256(canonicalJson(verificationPayload)));
  assert.deepEqual(
    generated.verification.vectors.map(({ invocation }) => invocation.kind),
    [
      "direct-function",
      "direct-function",
      "placement-constructor",
      "member-function",
      "explicit-destructor",
      "function-template-specialization",
    ],
  );
  for (const [index, vector] of generated.verification.vectors.entries()) {
    assert.equal(vector.declarationId, usages[index].declarationId);
    assert.equal(vector.productionWrapper, generated.manifest[index].wrapper);
    assert.equal(vector.vectorSha256, generated.manifest[index].verificationVectorSha256);
    assert.match(vector.vectorSha256, /^[0-9a-f]{64}$/);
  }
  const output = await mkdtemp(path.join(tmpdir(), "deherm-dmsdk-materialized-"));
  try {
    const materialized = path.join(output, "materialized.cpp");
    const verification = path.join(output, "materialized.verify.cpp");
    const harness = path.join(output, "harness.cpp");
    const executable = path.join(output, "universal-test");
    await writeFile(materialized, generated.source);
    await writeFile(verification, generated.verificationSource);
    await writeFile(harness, `
#include <defold_hermes/generated_dmsdk_universal.h>
#include <dmsdk/dlib/array.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include "materialized.verify.cpp"

static uint64_t allocations = 0;
void* operator new(size_t size) { ++allocations; if (void* value = malloc(size)) return value; abort(); }
void operator delete(void* value) noexcept { free(value); }

extern "C" DehermDmSdkUniversalStatus wrap_to_network(const DehermDmSdkUniversalValue*, uint32_t, DehermDmSdkUniversalValue*);
extern "C" DehermDmSdkUniversalStatus wrap_to_host(const DehermDmSdkUniversalValue*, uint32_t, DehermDmSdkUniversalValue*);
extern "C" DehermDmSdkUniversalStatus wrap_array_construct(const DehermDmSdkUniversalValue*, uint32_t, DehermDmSdkUniversalValue*);
extern "C" DehermDmSdkUniversalStatus wrap_array_capacity(const DehermDmSdkUniversalValue*, uint32_t, DehermDmSdkUniversalValue*);
extern "C" DehermDmSdkUniversalStatus wrap_array_destroy(const DehermDmSdkUniversalValue*, uint32_t, DehermDmSdkUniversalValue*);
extern "C" DehermDmSdkUniversalStatus wrap_clamp_i32(const DehermDmSdkUniversalValue*, uint32_t, DehermDmSdkUniversalValue*);
extern "C" void deherm_dmsdk_generated_provider_install(void);
extern "C" void deherm_dmsdk_generated_provider_install_exact_verification(void);

static uint32_t exact_calls = 0;
static dmArray<uint32_t>* exact_receiver = nullptr;
static uint32_t* exact_backing = nullptr;
static uint32_t exact_size = 0;
static uint32_t exact_capacity = 0;

extern "C" uint32_t wrap_to_network__exact_callee(uint32_t value) {
  ++exact_calls;
  return value ^ UINT32_C(0x55aa55aa);
}
extern "C" uint32_t wrap_to_host__exact_callee(uint32_t value) {
  ++exact_calls;
  return value ^ UINT32_C(0xaa55aa55);
}
extern "C" dmArray<uint32_t>* wrap_array_construct__exact_callee(
    dmArray<uint32_t>* receiver, uint32_t* backing, uint32_t size, uint32_t capacity) {
  ++exact_calls;
  exact_receiver = receiver;
  exact_backing = backing;
  exact_size = size;
  exact_capacity = capacity;
  return receiver;
}
extern "C" uint32_t wrap_array_capacity__exact_callee(dmArray<uint32_t>* receiver) {
  ++exact_calls;
  exact_receiver = receiver;
  return 91;
}
extern "C" void wrap_array_destroy__exact_callee(dmArray<uint32_t>* receiver) {
  ++exact_calls;
  exact_receiver = receiver;
}
extern "C" int32_t wrap_clamp_i32__exact_callee(int32_t value, int32_t minimum, int32_t maximum) {
  ++exact_calls;
  return value + minimum + maximum;
}

int main() {
  if (deherm_dmsdk_universal_count() != 1361) return 1;
  deherm_dmsdk_generated_provider_install();
  DehermDmSdkUniversalValue result = {};
  DehermDmSdkUniversalValue scalar[1] = {{UINT32_C(0x12345678), 0, DEHERM_DMSDK_UNIVERSAL_U64, 0}};
  scalar[0].tag = DEHERM_DMSDK_UNIVERSAL_I64;
  if (deherm_dmsdk_universal_dispatch(${toNetwork.numericId}, scalar, 1, &result) != DEHERM_DMSDK_UNIVERSAL_TYPE_MISMATCH) return 10;
  scalar[0].tag = DEHERM_DMSDK_UNIVERSAL_U64;
  scalar[0].payload = UINT64_C(0x100000000);
  if (deherm_dmsdk_universal_dispatch(${toNetwork.numericId}, scalar, 1, &result) != DEHERM_DMSDK_UNIVERSAL_TYPE_MISMATCH) return 11;
  scalar[0].payload = UINT32_C(0x12345678);
  if (deherm_dmsdk_universal_dispatch(${toNetwork.numericId}, scalar, 1, &result) != DEHERM_DMSDK_UNIVERSAL_OK) return 2;
  scalar[0] = result;
  if (deherm_dmsdk_universal_dispatch(${toHost.numericId}, scalar, 1, &result) != DEHERM_DMSDK_UNIVERSAL_OK || result.payload != UINT32_C(0x12345678)) return 3;
  const uint64_t warmed_allocations = allocations;
  for (uint32_t iteration = 0; iteration < 100000; ++iteration) {
    scalar[0].payload = iteration;
    if (deherm_dmsdk_universal_dispatch(${toNetwork.numericId}, scalar, 1, &result) != DEHERM_DMSDK_UNIVERSAL_OK) return 7;
  }
  if (allocations != warmed_allocations) return 8;

  alignas(dmArray<uint32_t>) unsigned char storage[sizeof(dmArray<uint32_t>)];
  uint32_t backing[4] = {};
  DehermDmSdkUniversalValue ctor[4] = {
    {static_cast<uint64_t>(reinterpret_cast<uintptr_t>(storage)), 0, DEHERM_DMSDK_UNIVERSAL_ADDRESS, 0},
    {static_cast<uint64_t>(reinterpret_cast<uintptr_t>(backing)), 0, DEHERM_DMSDK_UNIVERSAL_ADDRESS, 0},
    {2, 0, DEHERM_DMSDK_UNIVERSAL_U64, 0}, {4, 0, DEHERM_DMSDK_UNIVERSAL_U64, 0}
  };
  const uint64_t valid_receiver = ctor[0].payload;
  ctor[0].payload = 0;
  if (deherm_dmsdk_universal_dispatch(${constructor.numericId}, ctor, 4, &result) != DEHERM_DMSDK_UNIVERSAL_TYPE_MISMATCH) return 12;
  ctor[0].payload = valid_receiver + 1;
  if (deherm_dmsdk_universal_dispatch(${constructor.numericId}, ctor, 4, &result) != DEHERM_DMSDK_UNIVERSAL_TYPE_MISMATCH) return 13;
  ctor[0].payload = valid_receiver;
  if (deherm_dmsdk_universal_dispatch(${constructor.numericId}, ctor, 4, &result) != DEHERM_DMSDK_UNIVERSAL_OK) return 4;
  if (deherm_dmsdk_universal_dispatch(${capacity.numericId}, ctor, 1, &result) != DEHERM_DMSDK_UNIVERSAL_OK || result.payload != 4) return 5;
  if (deherm_dmsdk_universal_dispatch(${destructor.numericId}, ctor, 1, &result) != DEHERM_DMSDK_UNIVERSAL_OK) return 6;
  DehermDmSdkUniversalValue clamp_args[3] = {
    {static_cast<uint64_t>(static_cast<int64_t>(-17)), 0, DEHERM_DMSDK_UNIVERSAL_I64, 0},
    {static_cast<uint64_t>(static_cast<int64_t>(-10)), 0, DEHERM_DMSDK_UNIVERSAL_I64, 0},
    {10, 0, DEHERM_DMSDK_UNIVERSAL_I64, 0}
  };
  if (deherm_dmsdk_universal_dispatch(${clamp.numericId}, clamp_args, 3, &result) != DEHERM_DMSDK_UNIVERSAL_OK ||
      result.tag != DEHERM_DMSDK_UNIVERSAL_I64 || static_cast<int64_t>(result.payload) != -10) return 9;

  // Install the automatically generated exact-call twin. The same stable IDs,
  // checks, native decoders, result encoders and receiver expressions now call
  // ABI-compatible fake callees whose observations are asserted below.
  deherm_dmsdk_generated_provider_install_exact_verification();
  scalar[0].tag = DEHERM_DMSDK_UNIVERSAL_U64;
  scalar[0].payload = UINT32_C(0x12345678);
  if (deherm_dmsdk_universal_dispatch(${toNetwork.numericId}, scalar, 1, &result) != DEHERM_DMSDK_UNIVERSAL_OK ||
      result.payload != (UINT32_C(0x12345678) ^ UINT32_C(0x55aa55aa))) return 20;
  if (deherm_dmsdk_universal_dispatch(${toHost.numericId}, scalar, 1, &result) != DEHERM_DMSDK_UNIVERSAL_OK ||
      result.payload != (UINT32_C(0x12345678) ^ UINT32_C(0xaa55aa55))) return 21;
  if (deherm_dmsdk_universal_dispatch(${constructor.numericId}, ctor, 4, &result) != DEHERM_DMSDK_UNIVERSAL_OK ||
      result.tag != DEHERM_DMSDK_UNIVERSAL_VOID || exact_receiver != reinterpret_cast<dmArray<uint32_t>*>(storage) ||
      exact_backing != backing || exact_size != 2 || exact_capacity != 4) return 22;
  if (deherm_dmsdk_universal_dispatch(${capacity.numericId}, ctor, 1, &result) != DEHERM_DMSDK_UNIVERSAL_OK ||
      result.payload != 91 || exact_receiver != reinterpret_cast<dmArray<uint32_t>*>(storage)) return 23;
  if (deherm_dmsdk_universal_dispatch(${destructor.numericId}, ctor, 1, &result) != DEHERM_DMSDK_UNIVERSAL_OK ||
      result.tag != DEHERM_DMSDK_UNIVERSAL_VOID || exact_receiver != reinterpret_cast<dmArray<uint32_t>*>(storage)) return 24;
  if (deherm_dmsdk_universal_dispatch(${clamp.numericId}, clamp_args, 3, &result) != DEHERM_DMSDK_UNIVERSAL_OK ||
      result.tag != DEHERM_DMSDK_UNIVERSAL_I64 || static_cast<int64_t>(result.payload) != -17) return 25;
  if (exact_calls != 6) return 26;
  puts("dmsdk-universal:ok");
  return 0;
}
`);
    run(compiler, [
      "-std=c++17", "-Wall", "-Wextra", "-Werror", "-pedantic",
      `-I${path.join(root, "defold/defold_hermes/include")}`,
      "-isystem", path.join(root, "upstream/defold/engine/dlib/src"),
      "defold/defold_hermes/src/generated_dmsdk_universal.cpp", materialized, harness,
      "-o", executable,
    ]);
    assert.equal(run(executable, []).trim(), "dmsdk-universal:ok");
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});

test("usage materializer normalizes JavaScript numeric cells for f32 arguments and results", async () => {
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  const cosine = recipe(report, "dmTrigLookup::Cos");
  const generated = materializeDmSdkUsages([{
    declarationId: cosine.declarationId,
    wrapper: "wrap_cosine",
    acknowledgements: { generatedAdapterBypass: { reason: "exercise universal fallback", evidence: "source assertions verify f64 normalization" } },
  }], { catalog: policyCatalog, catalogSha256: dmSdkUniversalCatalogSha256 });
  assert.match(generated.source, /static_cast<float>\(deherm_dmsdk_unpack_f64\(arguments\[0\]\.payload\)\)/);
  assert.match(generated.source, /const double normalized = static_cast<double>\(value\)/);
  assert.doesNotMatch(generated.source, /deherm_dmsdk_unpack_f32/);
});

test("usage materializer fails closed on catalog drift, unsafe bypass, arity overrides, and scalar narrowing", async () => {
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  const toNetwork = recipe(report, "dmEndian::ToNetwork", (item) => item.abi.parameters[0]?.nativeType === "uint32_t");
  const configFloat = recipe(report, "ConfigFileGetFloat");
  assert.throws(() => materializeDmSdkUsages([], {}), /requires a resolved policy catalog/);
  assert.throws(() => materializeDmSdkUsages([{ declarationId: toNetwork.declarationId }], { catalog: policyCatalog, catalogSha256: dmSdkUniversalCatalogSha256 }), /generatedAdapterBypass/);
  assert.throws(() => materializeDmSdkUsages([{ declarationId: toNetwork.declarationId, parameters: [], acknowledgements: { generatedAdapterBypass: { reason: "test", evidence: "test harness" } } }], { catalog: policyCatalog, catalogSha256: dmSdkUniversalCatalogSha256 }), /override parameters only/);
  const generated = materializeDmSdkUsages([{ declarationId: toNetwork.declarationId, acknowledgements: { generatedAdapterBypass: { reason: "test", evidence: "test harness" } } }], { catalog: policyCatalog, catalogSha256: dmSdkUniversalCatalogSha256 });
  assert.match(generated.source, /payload <= UINT32_MAX/);
  assert.equal(generated.catalogSha256, dmSdkUniversalCatalogSha256);
  assert.throws(() => materializeDmSdkUsages([{
    declarationId: toNetwork.declarationId,
    receiverCppType: "uint32_t",
    acknowledgements: { generatedAdapterBypass: { reason: "test", evidence: "test harness" } },
  }], { catalog: policyCatalog, catalogSha256: dmSdkUniversalCatalogSha256 }),
  /may not declare receiverCppType for direct-function/);

  const configUsage = {
    declarationId: configFloat.declarationId,
    acknowledgements: {
      recordLayout: { reason: "opaque handle fixture", evidence: "digest-precondition test" },
    },
  };
  const nonNull = materializeDmSdkUsages([configUsage], {
    catalog: policyCatalog,
    catalogSha256: dmSdkUniversalCatalogSha256,
  });
  const nullable = materializeDmSdkUsages([{ ...configUsage, nullableParameters: [0] }], {
    catalog: policyCatalog,
    catalogSha256: dmSdkUniversalCatalogSha256,
  });
  assert.notEqual(
    nonNull.verification.vectors[0].vectorSha256,
    nullable.verification.vectors[0].vectorSha256,
    "verification vectors must bind emitted precondition behavior",
  );
});
