import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { materializeDmSdkUsages } from "../packages/compiler/src/dmsdk-universal-materializer.mjs";
import { buildDmSdkCallSymbolIndex } from "../packages/compiler/src/dmsdk-call-symbol-index.mjs";
import {
  dmSdkUniversalReadyCorpusArtifacts,
  dmSdkUniversalReadyUsages,
  materializeDmSdkUniversalReadyCorpus,
} from "../packages/compiler/src/dmsdk-universal-ready-corpus.mjs";
import {
  DMSDK_UNIVERSAL_STATIC_FRAME_CAPACITY,
  emitDmSdkUniversalStaticFrame,
} from "../packages/compiler/src/dmsdk-universal-static-frame.mjs";
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
    preferredSpecialized: 146,
    usageMaterializedFallback: 1215,
    universalReadyExactVectors: 486,
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
  const opaqueHandle = recipe(report, "ConfigFileGetFloat");
  assert.ok(!opaqueHandle.abi.parameters[0].requirements.includes("record-layout"));
  assert.ok(!opaqueHandle.fallback.requirements.includes("record-layout"));
  assert.ok(opaqueHandle.abi.parameters[0].requirements.includes("pointer-lifetime"));
  const copiedRecord = recipe(report, "dmSocket::Connect");
  assert.ok(copiedRecord.abi.parameters[1].requirements.includes("record-layout"));
  assert.ok(copiedRecord.fallback.requirements.includes("record-layout"));
  const enumInput = recipe(report, "dmBuffer::GetSizeForValueType");
  assert.equal(enumInput.abi.parameters[0].enumeration.nativeName, "dmBuffer::ValueType");
  assert.equal(enumInput.abi.parameters[0].enumeration.members.length, 10);
  const enumResult = recipe(report, "dmBuffer::Copy");
  assert.equal(enumResult.abi.resultEnumeration.nativeName, "dmBuffer::Result");
  assert.equal(enumResult.abi.resultEnumeration.members[0].value, 0);
  const receiverDefault = recipe(report, "dmTransform::Transform::SetIdentity");
  assert.equal(receiverDefault.invocation.receiver.nativeType, "dmTransform::Transform");
  assert.equal(receiverDefault.invocation.receiver.source, "source-derived-nontemplate-owner");
  const templateReceiver = recipe(report, "dmArray::dmArray::Capacity");
  assert.equal(templateReceiver.invocation.receiver.nativeType, null);
  assert.equal(templateReceiver.invocation.receiver.source, "usage-substitution-required");
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

test("Static Hermes dmSDK frame artifacts come from the stable compiler capability", async () => {
  const emitted = emitDmSdkUniversalStaticFrame();
  assert.equal(emitted.argumentCapacity, 32);
  assert.equal(DMSDK_UNIVERSAL_STATIC_FRAME_CAPACITY, 32);
  assert.match(emitted.header, /DEHERM_DMSDK_STATIC_FRAME_ARGUMENT_CAPACITY UINT32_C\(32\)/);
  assert.match(emitted.source, /DEHERM_DMSDK_STATIC_FRAME_ARGUMENT_CAPACITY/);
  assert.match(emitted.staticHermes, /DMSDK_UNIVERSAL_MAX_ARGUMENTS=32/);
  const [header, source, staticHermes] = await Promise.all([
    readFile(path.join(root, "defold/defold_hermes/include/defold_hermes/generated_dmsdk_universal_static_frame.h"), "utf8"),
    readFile(path.join(root, "defold/defold_hermes/src/generated_dmsdk_universal_static_frame.cpp"), "utf8"),
    readFile(path.join(root, "packages/static-hermes/src/generated/dmsdk-universal.ts"), "utf8"),
  ]);
  assert.deepEqual({ header, source, staticHermes }, {
    header: emitted.header,
    source: emitted.source,
    staticHermes: emitted.staticHermes,
  });
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

test("every declaration-only universal-ready recipe compiles and executes its exact-call twin", async () => {
  const sdkIr = JSON.parse(await readFile(sdkIrPath, "utf8"));
  const index = buildDmSdkCallSymbolIndex(sdkIr, policyCatalog);
  const usages = dmSdkUniversalReadyUsages(index, policyCatalog);
  assert.equal(usages.length, 486);
  const corpus = materializeDmSdkUniversalReadyCorpus(index, policyCatalog);
  const { generated } = corpus;
  assert.equal(generated.verification.vectorCount, usages.length);
  assert.equal(corpus.report.universalReadyCount, usages.length);
  assert.equal(corpus.report.ordering, "numeric-id-ascending");
  assert.equal(corpus.report.symbolIndexSha256, index.indexSha256);
  assert.deepEqual(
    generated.verification.vectors.map(({ declarationId }) => declarationId),
    usages.map(({ declarationId }) => declarationId),
  );
  assert.deepEqual(
    corpus.report.production.manifest.map(({ declarationId, numericId, verificationVectorSha256 }) =>
      ({ declarationId, numericId, vectorSha256: verificationVectorSha256 })),
    corpus.report.verification.vectors.map(({ declarationId, numericId, vectorSha256 }) =>
      ({ declarationId, numericId, vectorSha256 })),
  );
  assert.deepEqual(
    generated.verification.vectors.map(({ numericId }) => numericId),
    generated.verification.vectors.map(({ numericId }) => numericId).toSorted((left, right) => left - right),
  );
  assert.ok(generated.verification.vectors.every(({ vectorSha256 }) => /^[0-9a-f]{64}$/.test(vectorSha256)));
  assert.equal(new Set(generated.verification.vectors.map(({ vectorSha256 }) => vectorSha256)).size, usages.length);
  const tamperedIndex = structuredClone(index);
  tamperedIndex.universalReadyCount += 1;
  assert.throws(
    () => materializeDmSdkUniversalReadyCorpus(tamperedIndex, policyCatalog),
    /indexSha256 does not authenticate the canonical index body/,
  );
  const tamperedCatalog = structuredClone(policyCatalog);
  tamperedCatalog.recipes[0].symbol += "_tampered";
  assert.throws(
    () => materializeDmSdkUniversalReadyCorpus(index, tamperedCatalog),
    /catalog identity does not match its recipes and symbol index/,
  );
  const [committedPlan, committedProduction, committedVerification, helperSource] = await Promise.all([
    readFile(path.join(root, dmSdkUniversalReadyCorpusArtifacts.plan), "utf8"),
    readFile(path.join(root, dmSdkUniversalReadyCorpusArtifacts.productionSource), "utf8"),
    readFile(path.join(root, dmSdkUniversalReadyCorpusArtifacts.verificationSource), "utf8"),
    readFile(path.join(root, "packages/compiler/src/dmsdk-universal-ready-corpus.mjs"), "utf8"),
  ]);
  assert.deepEqual(JSON.parse(committedPlan), corpus.report);
  assert.equal(committedProduction, generated.source);
  assert.equal(committedVerification, generated.verificationSource);
  for (const source of [generated.source, generated.verificationSource]) {
    assert.match(source,
      /#if defined\(__linux__\) && !defined\(ANDROID\)\n#define Font DehermX11Font\n#include <GL\/glx\.h>\n#undef Font\n#endif/u,
      "a native-graphics materialization must isolate Xlib's global Font typedef");
  }
  assert.doesNotMatch(helperSource, /dmsdk:[^"'\s]+@/, "the corpus helper must not own declaration IDs");
  const output = await mkdtemp(path.join(tmpdir(), "deherm-dmsdk-ready-census-"));
  try {
    const harness = path.join(output, "ready-harness.cpp");
    const executable = path.join(output, "ready-census");
    await writeFile(harness, `extern "C" int ${generated.verification.driver.function}(void);\nint main(){return ${generated.verification.driver.function}();}\n`);
    const sdkRoot = path.join(root,
      "upstream/extender/server/app/sdk/7f0f554f41f9dce1e0ddff99bf08200657d1ee05/defoldsdk");
    const includeArgs = [
      `-I${path.join(root, "defold/defold_hermes/include")}`,
      "-isystem", path.join(sdkRoot, "sdk/include"),
      "-isystem", path.join(sdkRoot, "include"),
      "-isystem", path.join(sdkRoot, "ext/include"),
      "-DDLIB_LOG_DOMAIN=\"deherm\"",
    ];
    run(compiler, ["-std=c++17", "-Wall", "-Wextra", "-Werror", "-pedantic",
      ...includeArgs, "-c", path.join(root, dmSdkUniversalReadyCorpusArtifacts.productionSource),
      "-o", path.join(output, "ready.o")]);
    run(compiler, ["-std=c++17", "-Wall", "-Wextra", "-Werror", "-pedantic",
      ...includeArgs, "defold/defold_hermes/src/generated_dmsdk_universal.cpp",
      path.join(root, dmSdkUniversalReadyCorpusArtifacts.verificationSource), harness,
      "-o", executable]);
    run(executable, []);
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});

test("Static Hermes dmSDK transport owns a bounded reentrant frame", async () => {
  const output = await mkdtemp(path.join(tmpdir(), "deherm-dmsdk-static-frame-"));
  try {
    const harness = path.join(output, "static-frame.cpp");
    const executable = path.join(output, "static-frame");
    await writeFile(harness, `
#include <defold_hermes/generated_dmsdk_universal_static_frame.h>
#include <stdint.h>
extern "C" DehermDmSdkUniversalStatus deherm_dmsdk_universal_dispatch(uint32_t id,const DehermDmSdkUniversalValue* arguments,uint32_t count,DehermDmSdkUniversalValue* result){
  if(id!=UINT32_C(17)||count!=UINT32_C(1)||!arguments||!result)return DEHERM_DMSDK_UNIVERSAL_PROVIDER_ERROR;
  *result=arguments[0];return DEHERM_DMSDK_UNIVERSAL_OK;
}
int main(){
  DehermDmSdkUniversalStaticFrame* frames[DEHERM_DMSDK_STATIC_FRAME_REENTRANCY]{};
  for(uint32_t index=0;index<DEHERM_DMSDK_STATIC_FRAME_REENTRANCY;++index)if(!(frames[index]=deherm_dmsdk_static_frame_acquire()))return 1;
  if(deherm_dmsdk_static_frame_acquire()!=nullptr)return 2;
  if(!deherm_dmsdk_static_frame_set(frames[0],0,UINT32_C(0x89abcdef),UINT32_C(0x01234567),UINT32_C(3),UINT32_C(4),DEHERM_DMSDK_UNIVERSAL_U64,UINT32_C(9)))return 3;
  if(deherm_dmsdk_static_frame_dispatch(frames[0],UINT32_C(17),UINT32_C(1))!=DEHERM_DMSDK_UNIVERSAL_OK)return 4;
  if(deherm_dmsdk_static_frame_result_payload_low(frames[0])!=UINT32_C(0x89abcdef)||deherm_dmsdk_static_frame_result_payload_high(frames[0])!=UINT32_C(0x01234567)||deherm_dmsdk_static_frame_result_auxiliary_low(frames[0])!=UINT32_C(3)||deherm_dmsdk_static_frame_result_auxiliary_high(frames[0])!=UINT32_C(4)||deherm_dmsdk_static_frame_result_tag(frames[0])!=DEHERM_DMSDK_UNIVERSAL_U64||deherm_dmsdk_static_frame_result_type_id(frames[0])!=UINT32_C(9))return 5;
  for(auto* frame:frames)deherm_dmsdk_static_frame_release(frame);
  return deherm_dmsdk_static_frame_acquire()?0:6;
}
`);
    run(compiler, ["-std=c++17", "-Wall", "-Wextra", "-Werror", "-pedantic",
      `-I${path.join(root, "defold/defold_hermes/include")}`,
      "defold/defold_hermes/src/generated_dmsdk_universal_static_frame.cpp", harness, "-o", executable]);
    run(executable, []);
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});

test("universal dmSDK runtime bridge is generated, catalog-authenticated, and direct-memory linked", async () => {
  const [header, source, web, typescript, installer, staticHermes] = await Promise.all([
    readFile(path.join(root, "defold/defold_hermes/include/defold_hermes/generated_dmsdk_universal_jsi.hpp"), "utf8"),
    readFile(path.join(root, "defold/defold_hermes/src/generated_dmsdk_universal_jsi.cpp"), "utf8"),
    readFile(path.join(root, "defold/defold_hermes/lib/web/generated_dmsdk_universal.js"), "utf8"),
    readFile(path.join(root, "packages/sdk/src/generated/dmsdk/universal.ts"), "utf8"),
    readFile(path.join(root, "defold/defold_hermes/src/generated_jsi.cpp"), "utf8"),
    readFile(path.join(root, "packages/static-hermes/src/generated/dmsdk-universal.ts"), "utf8"),
  ]);
  assert.match(header, /installDmSdkUniversalModule/);
  assert.match(source, /deherm_dmsdk_universal_catalog_sha256/);
  assert.match(source, /isInt64/);
  assert.match(source, /memory\.byteLength/);
  assert.match(web, /DMSDK_UNIVERSAL__deps:\["deherm_dmsdk_universal_dispatch","deherm_dmsdk_universal_catalog_sha256"\]/);
  assert.match(typescript, /catalog identity mismatch/);
  assert.match(installer, /installDmSdkUniversalModule\(runtime, modules\)/);
  assert.match(staticHermes, /deherm_dmsdk_static_frame_dispatch/);
  assert.doesNotMatch(staticHermes, /function deherm_dmsdk_universal_dispatch/);
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
  assert.doesNotMatch(generated.source, /GL\/glx\.h/u,
    "materializations without the native-graphics header must not acquire a GLX dependency");
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

  if (deherm_dmsdk_generated_provider_install_run_exact_verification() != 0) return 20;
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

test("generated exact-call fixtures stay within the declared narrow integer width", async () => {
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  const base = structuredClone(recipe(report, "dmEndian::ByteSwap", (item) => item.abi.parameters[0]?.nativeType === "uint16_t"));
  const numericId = 531;
  const declarationId = "dmsdk:fixture::NarrowU8@tests/fixtures/narrow_u8.h:1:1";
  const narrow = {
    ...base,
    numericId,
    declarationId,
    projectionId: "dmsdk-projection:narrow-u8-fixture",
    symbol: "deherm_narrow_u8_fixture",
    include: "stdint.h",
    preferredLowering: { state: "universal-fallback", family: "universal-recipe" },
    fallback: { ...base.fallback, requirements: [] },
    abi: {
      ...base.abi,
      resultNativeType: "uint8_t",
      resultShape: { kind: "scalar", name: "u8" },
      parameters: [{
        ...base.abi.parameters[0],
        nativeType: "uint8_t",
        shape: { kind: "scalar", name: "u8" },
      }],
    },
  };
  const recipes = structuredClone(policyCatalog.recipes);
  recipes[numericId] = narrow;
  const catalogSha256 = "f".repeat(64);
  const generated = materializeDmSdkUsages([{ declarationId }], {
    catalog: { sourceHashes: { catalog: catalogSha256 }, recipes },
    catalogSha256,
  });
  const vector = generated.verification.vectors[0];
  assert.ok(vector.wireArguments[0].value >= 0 && vector.wireArguments[0].value <= 0xff);
  assert.ok(vector.result.fakeReturn.value >= 0 && vector.result.fakeReturn.value <= 0xff);
  const output = await mkdtemp(path.join(tmpdir(), "deherm-dmsdk-narrow-width-"));
  try {
    const verification = path.join(output, "materialized.verify.cpp");
    const harness = path.join(output, "harness.cpp");
    const executable = path.join(output, "narrow-width");
    await writeFile(verification, generated.verificationSource);
    await writeFile(harness, `#include "materialized.verify.cpp"
static DehermDmSdkUniversalProvider provider=nullptr;
static void* provider_context=nullptr;
extern "C" void deherm_dmsdk_universal_install_provider(DehermDmSdkUniversalProvider value,void* context){provider=value;provider_context=context;}
extern "C" DehermDmSdkUniversalStatus deherm_dmsdk_universal_dispatch(uint32_t id,const DehermDmSdkUniversalValue* arguments,uint32_t argument_count,DehermDmSdkUniversalValue* result){
  if(!provider)return DEHERM_DMSDK_UNIVERSAL_NO_PROVIDER;
  const DehermDmSdkUniversalDescriptor descriptor={id,UINT16_C(1),0,0};
  return provider(provider_context,&descriptor,arguments,argument_count,result);
}
int main(){return deherm_dmsdk_generated_provider_install_run_exact_verification();}
`);
    run(compiler, [
      "-std=c++17", "-Wall", "-Wextra", "-Werror", "-pedantic",
      `-I${path.join(root, "defold/defold_hermes/include")}`, harness,
      "-o", executable,
    ]);
    run(executable, []);
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});

test("generated exact-call driver owns deterministic scalar, pointer-like, callback, and reference fixtures", async () => {
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  const boolean = recipe(report, "dmUtf8::IsWhiteSpace");
  const floating = recipe(report, "dmTrigLookup::Cos");
  const enumeration = recipe(report, "dmBuffer::GetSizeForValueType");
  const cstring = recipe(report, "dmHashString32");
  const handle = recipe(report, "dmBuffer::IsBufferValid");
  const pointerHandle = recipe(report, "ConfigFileGetFloat");
  const reference = recipe(report, "dmArray::dmArray::Push");
  const callback = recipe(report, "dmLog::RegisterLogListener");
  const bypass = { generatedAdapterBypass: { reason: "exercise exact universal decoding", evidence: "generated native driver records the native call and result" } };
  const generated = materializeDmSdkUsages([
    { declarationId: boolean.declarationId, wrapper: "verify_bool", acknowledgements: bypass },
    {
      declarationId: floating.declarationId,
      wrapper: "verify_float",
      acknowledgements: { generatedAdapterBypass: { reason: "exercise exact universal decoding", evidence: "generated native driver records the f32 call and result" } },
    },
    { declarationId: enumeration.declarationId, wrapper: "verify_enum", acknowledgements: bypass },
    { declarationId: cstring.declarationId, wrapper: "verify_cstring", acknowledgements: bypass },
    {
      declarationId: handle.declarationId,
      wrapper: "verify_handle",
      typeSubstitutions: { HBuffer: "dmBuffer::HBuffer" },
      acknowledgements: bypass,
    },
    {
      declarationId: pointerHandle.declarationId,
      wrapper: "verify_pointer_handle",
    },
    {
      declarationId: reference.declarationId,
      wrapper: "verify_reference",
      receiverCppType: "dmArray<uint32_t>",
      typeSubstitutions: { T: "uint32_t" },
      acknowledgements: bypass,
    },
    {
      declarationId: callback.declarationId,
      wrapper: "verify_callback",
      callbackTrampolines: { 0: "native_log_listener" },
      acknowledgements: {
        callbackTrampoline: { reason: "exercise exact callback transport", evidence: "generated typed trampoline identity is recorded by the native driver" },
      },
    },
  ], { catalog: policyCatalog, catalogSha256: dmSdkUniversalCatalogSha256 });
  assert.deepEqual(
    generated.verification.vectors.map((vector) => ({
      arguments: vector.wireArguments.map(({ tag, fixture }) => fixture ?? tag),
      result: vector.result.fakeReturn.tag,
    })),
    [
      { arguments: ["u64"], result: "bool" },
      { arguments: ["f64"], result: "f64" },
      { arguments: ["i64"], result: "u64" },
      { arguments: ["cstring"], result: "u64" },
      { arguments: ["u64"], result: "bool" },
      { arguments: ["address", "cstring", "f64"], result: "f64" },
      { arguments: ["aligned-receiver-storage", "value-object"], result: "void" },
      { arguments: ["fixed-trampoline"], result: "void" },
    ],
  );
  assert.match(generated.verification.evidenceBoundary, /does not execute Defold implementation semantics/);
  assert.doesNotMatch(generated.verification.evidenceBoundary, /consumer harness defines/);
  assert.deepEqual({ ...generated.verification.observations, sourceSha256: undefined }, {
    reset: "deherm_dmsdk_generated_provider_install_reset_exact_observations",
    calls: "deherm_dmsdk_generated_provider_install_exact_call_count",
    failures: "deherm_dmsdk_generated_provider_install_exact_failure_count",
    sourceSha256: undefined,
  });
  assert.match(generated.verification.observations.sourceSha256, /^[0-9a-f]{64}$/);
  assert.match(generated.verification.driver.sourceSha256, /^[0-9a-f]{64}$/);
  assert.match(generated.source, /extern std::remove_pointer_t<DehermCallback_verify_callback_Arg0> native_log_listener/);
  assert.match(generated.verificationSource, /#define native_log_listener \(&DehermExactCallbackFixture<DehermCallback_verify_callback_Arg0>::call\)/);
  const output = await mkdtemp(path.join(tmpdir(), "deherm-dmsdk-exact-shapes-"));
  try {
    const production = path.join(output, "materialized.cpp");
    const verification = path.join(output, "materialized.verify.cpp");
    const harness = path.join(output, "harness.cpp");
    const executable = path.join(output, "exact-shapes");
    await writeFile(production, generated.source);
    await writeFile(verification, generated.verificationSource);
    await writeFile(harness, `
#include "materialized.verify.cpp"
int main() {
  const int status = deherm_dmsdk_generated_provider_install_run_exact_verification();
  if (status) return status;
  if (deherm_dmsdk_generated_provider_install_exact_call_count(UINT32_C(${boolean.numericId})) != 1) return 90;
  if (deherm_dmsdk_generated_provider_install_exact_failure_count(UINT32_C(${boolean.numericId})) != 0) return 91;
  deherm_dmsdk_generated_provider_install_reset_exact_observations();
  return deherm_dmsdk_generated_provider_install_exact_call_count(UINT32_C(${boolean.numericId})) == 0 ? 0 : 92;
}
`);
    run(compiler, [
      "-std=c++17", "-Wall", "-Wextra", "-Werror", "-pedantic",
      "-DDLIB_LOG_DOMAIN=\"deherm\"",
      `-I${path.join(root, "defold/defold_hermes/include")}`,
      "-isystem", path.join(root, "upstream/defold/engine/dlib/src"),
      "-c", production, "-o", path.join(output, "materialized.o"),
    ]);
    run(compiler, [
      "-std=c++17", "-Wall", "-Wextra", "-Werror", "-pedantic",
      "-DDLIB_LOG_DOMAIN=\"deherm\"",
      `-I${path.join(root, "defold/defold_hermes/include")}`,
      "-isystem", path.join(root, "upstream/defold/engine/dlib/src"),
      "defold/defold_hermes/src/generated_dmsdk_universal.cpp", harness,
      "-o", executable,
    ]);
    run(executable, []);
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});

test("usage materializer fails closed on catalog drift, unsafe bypass, arity overrides, and scalar narrowing", async () => {
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  const toNetwork = recipe(report, "dmEndian::ToNetwork", (item) => item.abi.parameters[0]?.nativeType === "uint32_t");
  const configFloat = recipe(report, "ConfigFileGetFloat");
  const enumResult = recipe(report, "dmBuffer::Copy");
  const recordArgument = recipe(report, "dmSocket::Connect");
  const oversizedCatalog = structuredClone(policyCatalog);
  oversizedCatalog.abi = { maxArguments: DMSDK_UNIVERSAL_STATIC_FRAME_CAPACITY + 1 };
  oversizedCatalog.recipes[0].abi.argumentCount = DMSDK_UNIVERSAL_STATIC_FRAME_CAPACITY + 1;
  assert.throws(() => materializeDmSdkUsages([], {
    catalog: oversizedCatalog,
    catalogSha256: dmSdkUniversalCatalogSha256,
  }), /requires 33 arguments.*supports 32/);
  const inconsistentCatalog = structuredClone(policyCatalog);
  inconsistentCatalog.abi = { maxArguments: 14 };
  assert.throws(() => materializeDmSdkUsages([], {
    catalog: inconsistentCatalog,
    catalogSha256: dmSdkUniversalCatalogSha256,
  }), /abi\.maxArguments 14 does not match recipe maximum 15/);
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
  const generatedEnumResult = materializeDmSdkUsages([{
    declarationId: enumResult.declarationId,
    typeSubstitutions: { HBuffer: "dmBuffer::HBuffer", Result: "dmBuffer::Result" },
  }], { catalog: policyCatalog, catalogSha256: dmSdkUniversalCatalogSha256 });
  assert.equal(generatedEnumResult.verification.vectors[0].result.fakeReturn.value, 0);
  const missingEnumFactCatalog = structuredClone(policyCatalog);
  delete missingEnumFactCatalog.recipes[enumResult.numericId].abi.resultEnumeration;
  missingEnumFactCatalog.sourceHashes.catalog = "f".repeat(64);
  assert.throws(() => materializeDmSdkUsages([{
    declarationId: enumResult.declarationId,
    typeSubstitutions: { HBuffer: "dmBuffer::HBuffer", Result: "dmBuffer::Result" },
  }], { catalog: missingEnumFactCatalog, catalogSha256: "f".repeat(64) }), /resultEnumValue/);
  assert.throws(() => materializeDmSdkUsages([{
    declarationId: recordArgument.declarationId,
    typeSubstitutions: { Socket: "dmSocket::Socket", Address: "dmSocket::Address", Result: "dmSocket::Result" },
    argumentExpressions: { 1: "dmSocket::Address{}" },
    resultEnumValue: 0,
    acknowledgements: {
      recordLayout: { reason: "exercise unsupported exact record boundary", evidence: "materializer must fail before claiming a wire representation" },
    },
  }], { catalog: policyCatalog, catalogSha256: dmSdkUniversalCatalogSha256 }), /wire fixture.*record/);

  const configUsage = { declarationId: configFloat.declarationId };
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
