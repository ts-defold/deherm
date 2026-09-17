import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function json(path) {
  return JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));
}

test("dmSDK inventory accounts for every parsed declaration", async () => {
  const inventory = await json("../bindings/generated/defold-sdk-inventory.json");
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
  const inventory = await json("../bindings/generated/defold-script-api-inventory.json");
  assert.equal(inventory.declarations.length, inventory.declarationCount);
  assert.equal(
    Object.values(inventory.countsByKind).reduce((sum, count) => sum + count, 0),
    inventory.declarationCount,
  );
  const functions = inventory.declarations.filter(({ kind }) => kind === "function");
  assert.equal(functions.length, inventory.countsByKind.function);
  assert.ok(functions.every(({ status }) => status === "needs-native-mapping"));
});
