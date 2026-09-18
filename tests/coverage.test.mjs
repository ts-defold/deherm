import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function json(path) {
  return JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));
}

test("dmSDK inventory accounts for every parsed declaration", async () => {
  const inventory = await json("../packages/bindings/generated/defold-sdk-inventory.json");
  assert.equal(inventory.parsedHeaderCount + inventory.failedHeaderCount, inventory.headerCount);
  assert.equal(inventory.failedHeaderCount, 0);
  assert.equal(inventory.declarations.length, inventory.declarationCount);
  assert.equal(
    Object.values(inventory.countsByKind).reduce((sum, count) => sum + count, 0),
    inventory.declarationCount,
  );
  assert.equal(
    Object.values(inventory.countsByStatus).reduce((sum, count) => sum + count, 0),
    inventory.declarationCount,
  );
  assert.ok(inventory.declarations.every((declaration) => declaration.status));
});

test("script inventory accounts for every public annotation declaration", async () => {
  const inventory = await json("../packages/bindings/generated/defold-script-api-inventory.json");
  assert.equal(inventory.declarations.length, inventory.declarationCount);
  assert.equal(
    Object.values(inventory.countsByKind).reduce((sum, count) => sum + count, 0),
    inventory.declarationCount,
  );
  const functions = inventory.declarations.filter(({ kind }) => kind === "function");
  assert.equal(functions.length, inventory.countsByKind.function);
  assert.ok(functions.every(({ status }) => status === "needs-native-mapping"));
});

test("generated script SDK resolves every discovered function and type", async () => {
  const inventory = await json("../packages/bindings/generated/defold-script-api-inventory.json");
  const ir = await json("../packages/bindings/generated/defold-script-api-ir.json");
  assert.equal(ir.sourceFileCount, inventory.fileCount);
  assert.equal(ir.counts.functions, inventory.countsByKind.function);
  assert.equal(ir.typeSurfaceUnresolvedCount, 0);
  assert.equal(ir.functions.length, inventory.countsByKind.function);
  assert.ok(ir.functions.every(({ disposition }) => disposition === "generated-lua-bridge"));
  assert.ok(ir.functions.every(({ description }) => typeof description === "string"));
  assert.equal(ir.runtimeImplementedCount + ir.runtimeUnimplementedCount, ir.counts.functions);
});

test("generated dmSDK resolves every Clang declaration", async () => {
  const inventory = await json("../packages/bindings/generated/defold-sdk-inventory.json");
  const ir = await json("../packages/bindings/generated/defold-sdk-ir.json");
  assert.equal(ir.headerCount, inventory.headerCount);
  assert.equal(ir.declarationCount, inventory.declarationCount);
  assert.equal(ir.declarations.length, inventory.declarationCount);
  assert.equal(ir.typeSurfaceUnresolvedCount, 0);
  const publicCalls = ir.declarations.filter(({ kind, disposition }) => ["function", "method", "constructor", "destructor", "function-template"].includes(kind) && disposition === "generated-raw-call");
  assert.equal(ir.runtimeImplementedCount + ir.runtimeUnimplementedCount, publicCalls.length);
  assert.ok(ir.declarations.every(({ disposition, abiStrategies }) => disposition && abiStrategies.length));
  const enums = ir.declarations.filter(({ kind }) => kind === "enum");
  assert.ok(enums.length > 0);
  assert.ok(enums.every(({ members }) => members.length > 0 && members.every(({ value }) => Number.isSafeInteger(value))));
  const types = await readFile(new URL("../packages/sdk/src/generated/dmsdk/types.ts", import.meta.url), "utf8");
  assert.match(types, /export const DmBufferResult = \{/);
  assert.match(types, /RESULT_METADATA_MISSING: 11/);
  assert.match(types, /export type DmBufferResult = \(typeof DmBufferResult\)\[keyof typeof DmBufferResult\]/);
  assert.match(types, /readonly "dmBuffer::Result": DmBufferResult;/);
  assert.match(types, /export const DmSocketResult = \{[\s\S]*RESULT_ACCES: -1/);
  assert.doesNotMatch(types, /readonly "dmBuffer::Result": DmNativeType/);
});
