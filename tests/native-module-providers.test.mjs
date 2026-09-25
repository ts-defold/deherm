import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { transform } from "esbuild";
import {
  WEBTRANSPORT_SCHEMA,
  generateNativeModuleProviderArtifacts,
  repositoryNativeModuleArtifactPath,
} from "../scripts/generate-native-module-providers.mjs";
import { parseNativeModuleDescriptorJson } from "../packages/compiler/src/native-module-provider-generator.mjs";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const schema = JSON.parse(await readFile(path.join(root, WEBTRANSPORT_SCHEMA), "utf8"));

test("extension schema owns the generic provider and WebTransport artifacts", async () => {
  const artifacts = generateNativeModuleProviderArtifacts(schema, { artifactPath: repositoryNativeModuleArtifactPath });
  assert.deepEqual([...artifacts.keys()], [
    "defold/defold_hermes/include/defold_hermes/native_module_provider.h",
    "defold/defold_hermes/include/defold_hermes/generated_native_module_jsi.hpp",
    "defold/defold_hermes/src/generated_native_module_registry.cpp",
    "defold/defold_hermes/src/generated_native_module_jsi.cpp",
    "extensions/defold-webtransport/defold_webtransport/include/defold_webtransport/deherm_provider.h",
    "extensions/defold-webtransport/defold_webtransport/webtransport/typescript/NativeWebTransport.ts",
    "extensions/defold-webtransport/defold_webtransport/webtransport/static/deherm_static_native_web_transport.h",
    "extensions/defold-webtransport/defold_webtransport/webtransport/static/deherm_static_native_web_transport.cpp",
    "extensions/defold-webtransport/defold_webtransport/webtransport/static/NativeWebTransport.ts",
    "tests/fixtures/generated_native_webtransport_provider_adapter.cpp",
  ]);
  for (const [relative, expected] of artifacts) {
    assert.equal(await readFile(path.join(root, relative), "utf8"), expected, `${relative} is stale`);
  }
});

test("every extension descriptor method reaches generated C metadata, JSI dispatch, and TypeScript", () => {
  const artifacts = generateNativeModuleProviderArtifacts(schema, { artifactPath: repositoryNativeModuleArtifactPath });
  const generic = artifacts.get("defold/defold_hermes/include/defold_hermes/native_module_provider.h");
  const provider = artifacts.get("extensions/defold-webtransport/defold_webtransport/include/defold_webtransport/deherm_provider.h");
  const jsi = artifacts.get("defold/defold_hermes/src/generated_native_module_jsi.cpp");
  const typescript = artifacts.get("extensions/defold-webtransport/defold_webtransport/webtransport/typescript/NativeWebTransport.ts");
  const staticHeader = artifacts.get("extensions/defold-webtransport/defold_webtransport/webtransport/static/deherm_static_native_web_transport.h");
  const staticSource = artifacts.get("extensions/defold-webtransport/defold_webtransport/webtransport/static/deherm_static_native_web_transport.cpp");
  const staticTypescript = artifacts.get("extensions/defold-webtransport/defold_webtransport/webtransport/static/NativeWebTransport.ts");
  const adapter = artifacts.get("tests/fixtures/generated_native_webtransport_provider_adapter.cpp");
  assert.match(generic, /PROVIDER_ABI_VERSION UINT32_C\(1\)/);
  assert.match(generic, /bounded core storage/);
  assert.match(generic, /never marshals packet data through Lua/);
  assert.match(jsi, /isUint8Array/);
  assert.match(jsi, /byteOffset\(r\)/);
  assert.match(jsi, /byteLength\(r\)/);
  assert.match(jsi, /DEHERM_NATIVE_MODULE_ARGUMENT_BOOL/);
  assert.match(jsi, /native module collides with an installed module/);
  assert.match(jsi, /module_abi_version/);
  assert.match(typescript, /requireDefoldModule<NativeWebTransportSpec>\("NativeWebTransport", 1\)/);
  assert.doesNotMatch(generic + provider + jsi + typescript + staticHeader + staticSource + staticTypescript,
    /lua_State|lua_pcall|LuaBridge/);
  for (const method of schema.nativeModules[0].methods) {
    assert.match(provider, new RegExp(`\\{${method.id}, "${method.name}"`));
    assert.match(typescript, new RegExp(`\\b${method.name}\\(`));
    assert.match(staticHeader, new RegExp(`deherm_static_native_web_transport_${method.name.replace(/([a-z0-9])([A-Z])/gu, "$1_$2").toLowerCase()}\\(`));
    assert.match(staticTypescript, new RegExp(`\\b${method.name}:\\(`));
    assert.match(adapter, new RegExp(`defold_webtransport_native_v1_${method.name.replace(/([a-z0-9])([A-Z])/gu, "$1_$2").toLowerCase()}\\(`));
  }
  assert.match(staticHeader, /FRAME_BYTES UINT32_C\(1048608\)/);
  assert.match(staticSource, /constexpr uint32_t kFrameDepth = 1/);
  assert.match(staticSource, /return INT32_C\(-7\)/);
  assert.match(staticTypescript, /NativeWebTransportSpec/);
  assert.match(staticTypescript, /output:Array<number>/);
  assert.match(staticTypescript, /status===0&&copyLength_1>=32/);
  assert.match(staticTypescript, /else if\(copyLength_1>32\)copyLength_1=32/);
  assert.match(staticTypescript, /__readByte\(frame,1,20\)/);
  assert.match(adapter, /deherm_register_native_web_transport_provider_v1/);
  assert.match(adapter, /deherm_unregister_native_web_transport_provider_v1/);
  assert.match(typescript, /streamOpened/);
  assert.match(typescript, /streamBidirectional/);
  assert.match(typescript, /streamIncoming/);
  assert.match(provider, /EVENT_KIND_STREAM_OPENED = 2/);
  assert.match(provider, /EVENT_FLAG_STREAM_FIN = 1/);
});

test("late providers resolve on first lookup and extension frames own the hidden pump", async () => {
  const artifacts = generateNativeModuleProviderArtifacts(schema, { artifactPath: repositoryNativeModuleArtifactPath });
  const jsi = artifacts.get("defold/defold_hermes/src/generated_native_module_jsi.cpp");
  assert.match(jsi, /"__resolve"/);
  assert.match(jsi, /installGeneratedNativeModuleProviders\(runtime, refreshed\)/);
  const runtime = await readFile(path.join(root, "defold/defold_hermes/src/runtime.cpp"), "utf8");
  assert.match(runtime, /void Runtime::pumpNativeModules\(double dt\)/);
  const extension = await readFile(path.join(root, "defold/defold_hermes/src/extension.cpp"), "utf8");
  const extensionUpdate = extension.indexOf("dmExtension::Result UpdateExtension");
  assert.ok(extension.indexOf("gRuntime->pumpNativeModules(0.0)", extensionUpdate) > extensionUpdate);
  const runtimeUpdate = runtime.indexOf("void Runtime::update(double dt)");
  assert.equal(runtime.indexOf("pumpNativeModules", runtimeUpdate), -1, "bootstrap update must not double-pump");
  const moduleRuntime = await readFile(path.join(root, "packages/sdk/src/module-runtime.ts"), "utf8");
  assert.match(moduleRuntime, /export function registerNativeModulePump/);
  assert.match(moduleRuntime, /modules\.__resolve/);
});

test("generic provider recipe rejects duplicate IDs and unsupported argument shapes", () => {
  const duplicate = structuredClone(schema);
  duplicate.nativeModules[0].methods[1].id = duplicate.nativeModules[0].methods[0].id;
  assert.throws(() => generateNativeModuleProviderArtifacts(duplicate));
  const invalid = structuredClone(schema);
  invalid.nativeModules[0].methods[0].args[0].type = "object";
  assert.throws(() => generateNativeModuleProviderArtifacts(invalid));
  const invalidName = structuredClone(schema);
  invalidName.nativeModules[0].methods[0].args[0].name = "not-an-identifier";
  assert.throws(() => generateNativeModuleProviderArtifacts(invalidName));
  const duplicateName = structuredClone(schema);
  duplicateName.nativeModules[0].methods[0].args.push({ ...duplicateName.nativeModules[0].methods[0].args[0] });
  assert.throws(() => generateNativeModuleProviderArtifacts(duplicateName));
});

test("binding descriptor JSON rejects duplicate object keys before JSON.parse can last-win", () => {
  assert.throws(() => parseNativeModuleDescriptorJson('{"schemaVersion":1,"schemaVersion":2}'),
    /duplicate JSON object key: schemaVersion/u);
  assert.throws(() => parseNativeModuleDescriptorJson('{"nativeModules":[{"name":"A","name":"B"}]}'),
    /duplicate JSON object key: name/u);
});

test("native module pump registry is bounded and reuses released slots", async () => {
  delete globalThis.__dehermNativeModulePumpStateV1;
  delete globalThis.__dehermNativeModulesTickV1;
  const source = await readFile(path.join(root, "packages/sdk/src/module-runtime.ts"), "utf8");
  const compiled = await transform(source, { loader: "ts", format: "esm", target: "es2022" });
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(compiled.code).toString("base64")}`;
  const runtime = await import(`${moduleUrl}#initial`);
  const hmrRuntime = await import(`${moduleUrl}#hmr-copy`);
  globalThis.__defoldModulesV1 = {
    Compatible: { __dehermNativeModuleAbiVersionV1: 3 },
    BuiltInCollision: {},
    __resolve(name, abiVersion) {
      resolveCalls += 1;
      if (name === "LateProvider" && abiVersion === 2) {
        return { __dehermNativeModuleAbiVersionV1: 2 };
      }
    },
  };
  let resolveCalls = 0;
  assert.equal(runtime.requireDefoldModule("Compatible", 3), globalThis.__defoldModulesV1.Compatible);
  assert.throws(() => runtime.requireDefoldModule("Compatible", 4), /ABI mismatch/);
  assert.throws(() => runtime.requireDefoldModule("BuiltInCollision", 1), /ABI mismatch/);
  assert.throws(() => runtime.requireDefoldModule("MissingVersionless"), /not registered/);
  assert.equal(resolveCalls, 0, "versionless lookup must not invoke the versioned native resolver");
  assert.equal(runtime.requireDefoldModule("LateProvider", 2), globalThis.__defoldModulesV1.LateProvider);
  assert.equal(resolveCalls, 1);
  delete globalThis.__defoldModulesV1;
  assert.equal(globalThis.__dehermNativeModulePumpStateV1, undefined, "pump state stays lazy until registration");
  const calls = new Array(32).fill(0);
  const unregister = calls.map((_, index) => (index === 31 ? hmrRuntime : runtime).registerNativeModulePump(() => { calls[index] += 1; }));
  const sharedTick = globalThis.__dehermNativeModulesTickV1;
  assert.throws(() => runtime.registerNativeModulePump(() => {}), /capacity exceeded \(32\)/);
  globalThis.__dehermNativeModulesTickV1(0.25);
  assert.ok(calls.every((count) => count === 1));
  assert.equal(globalThis.__dehermNativeModulesTickV1, sharedTick, "HMR module copies must not clobber the shared tick");
  unregister[7]();
  let replacementCalls = 0;
  const removeReplacement = runtime.registerNativeModulePump(() => { replacementCalls += 1; });
  globalThis.__dehermNativeModulesTickV1(0.25);
  assert.equal(calls[7], 1);
  assert.equal(replacementCalls, 1);
  for (const remove of unregister) remove();
  removeReplacement();
  delete globalThis.__dehermNativeModulePumpStateV1;
  delete globalThis.__dehermNativeModulesTickV1;
});

test("a second arbitrary extension module uses the same emitter without WebTransport assumptions", () => {
  const synthetic = {
    schemaVersion: 1,
    nativeModules: [{
      name: "NativeClipboard",
      abiVersion: 3,
      cProvider: { header: "clipboard/native_v3.h", symbolPrefix: "clipboard_native_v3_", argumentExpansion: "pointer-length-v1" },
      methods: [
        { id: 7, name: "write", args: [{ name: "arguments", type: "utf8" }], returns: "status" },
        { id: 9, name: "available", args: [], returns: "u32" },
        { id: 11, name: "read", args: [{ name: "status", type: "mutableBytes" }], returns: "status" },
      ],
    }],
  };
  const artifacts = generateNativeModuleProviderArtifacts(synthetic);
  const header = artifacts.get("generated/native-modules/NativeClipboard/provider.h");
  const typescript = artifacts.get("generated/native-modules/NativeClipboard/NativeClipboard.ts");
  const staticTypescript = artifacts.get("generated/native-modules/NativeClipboard/NativeClipboard.static.ts");
  const staticSource = artifacts.get("generated/native-modules/NativeClipboard/deherm_static_NativeClipboard.cpp");
  const adapter = artifacts.get("generated/native-modules/NativeClipboard/provider_adapter.cpp");
  assert.match(header, /DEHERM_NATIVE_CLIPBOARD_METHOD_WRITE = 7/);
  assert.match(header, /deherm_native_clipboard_provider_v1/);
  assert.match(typescript, /interface NativeClipboardSpec/);
  assert.match(typescript, /write\(deherm_argument_0: string\)/);
  assert.doesNotMatch(typescript + staticTypescript, /\b(?:arguments|status):(?: string|Array<number>)/u);
  assert.match(staticTypescript, /NativeClipboardSpec/);
  assert.match(staticTypescript, /deherm_static_native_clipboard_write/);
  assert.match(staticTypescript, /__copyMutable\(frame,0,deherm_argument_0,deherm_argument_0\.length\)/);
  assert.doesNotMatch(staticTypescript, /payloadLength|copyLength_0|__readByte\(frame,0,20\)/);
  assert.match(staticSource, /"NativeClipboard"/);
  assert.match(adapter, /#include <clipboard\/native_v3\.h>/);
  assert.match(adapter, /clipboard_native_v3_write\(/);
  assert.match(adapter, /clipboard_native_v3_available\(/);
  assert.match(adapter, /clipboard_native_v3_read\(/);
  assert.doesNotMatch(header + typescript + staticTypescript + staticSource + adapter, /WebTransport/);
});
