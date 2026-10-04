import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

async function source(path) {
  return readFile(new URL(path, root), "utf8");
}

test("counted Lua byte buffers stay byte-exact through Dynamic JSI and Static Hermes carriers", async () => {
  const [
    policyText,
    generatedTypes,
    jsi,
    dynamicFixture,
    dynamicExactCall,
    staticBridge,
    staticSupport,
    browserBridge,
  ] = await Promise.all([
    source("packages/bindings/overrides/script-defold-value-tail-bindings.json"),
    source("packages/sdk/src/generated/script/types.ts"),
    source("defold/defold_hermes/src/script_jsi_bridge.cpp"),
    source("tests/fixtures/script-api-e2e.ts"),
    source("native/script_api_hermes_e2e.cpp"),
    source("packages/static-hermes/src/generated/script-typed-native-bridge.ts"),
    source("packages/sdk/src/generated/script/value-tail-target-support.ts"),
    source("defold/defold_hermes/lib/web/generated_script_universal_value.js"),
  ]);

  const policy = JSON.parse(policyText);
  const textureRoute = policy.families.find(({ id }) => id === "image-type-string-codec");
  assert.deepEqual(textureRoute.codecEvidence.binaryParameters[0], {
    index: 4,
    name: "buffer",
    sourceSignatures: ["luaL_checktype(L, 5, LUA_TSTRING)", "const char* buffer = lua_tolstring(L, 5, &buffer_size)"],
    carrier: "Uint8Array | ArrayBuffer",
    note: "Lua strings are counted byte arrays here; the TypeScript surface must not UTF-8 transcode texture payloads.",
  });
  assert.match(generatedTypes, /buffer: Uint8Array \| ArrayBuffer/u);
  assert.match(generatedTypes, /must not UTF-8 transcode texture payloads/u);

  // The JSI lane reads the view's byte offset and length and points directly
  // into the Uint8Array backing store; ArrayBuffer uses its full byte extent.
  assert.match(
    jsi,
    /const size_t offset = array\.byteOffset\(runtime\);[\s\S]*?const size_t length = array\.byteLength\(runtime\);/u,
  );
  assert.match(jsi, /output\.data = buffer\.data\(runtime\) \+ offset;/u);
  assert.match(jsi, /output\.tag = ScriptValueTag::kBytes;/u);

  // The existing native end-to-end harness compares the complete carrier
  // payload, including NUL and both high-bit values, for Uint8Array and its
  // ArrayBuffer. Keep the byte vector independent of UTF-8 text semantics.
  assert.match(dynamicFixture, /new Uint8Array\(\[0x00, 0x80, 0xff, 0x41\]\)/u);
  assert.match(dynamicFixture, /textureBytes\.buffer/u);
  assert.match(dynamicExactCall, /expected\[\] = \{0x00, 0x80, 0xff, 0x41\};/u);
  assert.match(dynamicExactCall, /ScriptValueTag::kBytes/u);
  assert.match(dynamicExactCall, /std::memcmp\(frame->arguments\[4\]\.data, expected, sizeof\(expected\)\)/u);

  // Static Hermes recognizes the same public byte carriers and copies each
  // unsigned byte into its private byte value. Value-tail execution remains
  // explicitly unavailable on Static and browser targets until those
  // providers are integrated.
  assert.match(staticBridge, /value instanceof __dehermUint8Array \|\| value instanceof __dehermArrayBuffer/u);
  assert.match(staticBridge, /bytes\.push\(source\[index\]\)/u);
  assert.match(staticBridge, /new DehermStaticBytes\(bytes\)/u);
  assert.match(staticSupport, /"nativeStaticHermes": "not-integrated-fail-closed"/u);
  assert.match(staticSupport, /"html5BrowserHost": "not-executable-no-provider"/u);

  // The web universal callback serializer has a separate counted-byte tag;
  // it copies a Uint8Array view (or an ArrayBuffer view) as bytes rather than
  // passing through its UTF-8 string branch. This does not claim a browser
  // value-tail provider exists.
  assert.match(browserBridge, /value instanceof Uint8Array \|\| value instanceof ArrayBuffer/u);
  assert.match(browserBridge, /HEAPU8\.set\(byteView, strings \+ state\.string\)/u);
  assert.match(browserBridge, /HEAPU8\[pointer\] = 9;/u);
});
