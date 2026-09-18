import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  assertUniquePublicScriptRoots,
  publicScriptModulePath,
  publicScriptRootName,
  rawScriptRootName
} from "../packages/compiler/src/script-public-api-policy.mjs";

const root = new URL("../", import.meta.url);

test("Defold globals project to one collision-checked public root", () => {
  assert.equal(publicScriptRootName("builtins"), "defold");
  assert.equal(rawScriptRootName("defold"), "builtins");
  assert.deepEqual(publicScriptModulePath(["builtins", "nested"]), ["defold", "nested"]);
  assert.deepEqual(publicScriptModulePath(["vmath"]), ["vmath"]);
  assert.throws(
    () => assertUniquePublicScriptRoots(["builtins", "defold"]),
    /collides between "builtins" and "defold"/
  );
});

test("generated SDK exposes defold while preserving the raw Lua route identity", async () => {
  const [index, modules, types, irText] = await Promise.all([
    readFile(new URL("packages/sdk/src/generated/script/index.ts", root), "utf8"),
    readFile(new URL("packages/sdk/src/generated/script/modules.ts", root), "utf8"),
    readFile(new URL("packages/sdk/src/generated/script/types.ts", root), "utf8"),
    readFile(new URL("packages/bindings/generated/defold-script-api-ir.json", root), "utf8")
  ]);
  assert.match(index, /\bdefold\b/);
  assert.doesNotMatch(index, /\bbuiltins\b/);
  assert.match(modules, /export const defold: Types\.DefoldApi/);
  assert.doesNotMatch(modules, /export const builtins/);
  assert.match(types, /export interface DefoldApi/);
  assert.doesNotMatch(types, /export interface BuiltinsApi/);

  const hash = JSON.parse(irText).functions.find(({ id }) => id === "script:hash");
  assert.deepEqual(hash.modulePath, ["builtins"]);
  assert.equal(hash.rawName, "hash");
});
