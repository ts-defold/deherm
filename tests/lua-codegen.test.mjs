import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  generateLuaArtifacts,
  validateLuaSchema
} from "../scripts/generate-lua-bridge.mjs";

const schema = JSON.parse(
  await readFile(new URL("../bindings/lua-compat.json", import.meta.url), "utf8")
);

test("Lua compatibility schema emits specialized stack thunks", () => {
  const artifacts = generateLuaArtifacts(validateLuaSchema(schema));
  const source = artifacts.get("defold/defold_hermes/src/generated_lua_bridge.cpp");
  assert.match(source, /LuaCall call = bridge\.beginCall/);
  assert.match(source, /call\.pushU32\(handle\)/);
  assert.match(source, /call\.pushTimerCallback\(callback, repeating\)/);
  assert.match(source, /bridge\.trackTimerCallback\(\*out, callback, repeating\)/);
  assert.match(source, /bridge\.releaseTimerCallback\(handle\)/);
  assert.match(source, /call\.readBoolean\(0, out\)/);
  assert.doesNotMatch(source, /std::vector|std::unordered_map|variant|JSON/);
});

test("Lua compatibility generator rejects ambiguous ABI types", () => {
  const invalid = structuredClone(schema);
  invalid.modules[0].functions[0].parameters[0].type = "number";
  assert.throws(() => validateLuaSchema(invalid), /unsupported type number/);
});
