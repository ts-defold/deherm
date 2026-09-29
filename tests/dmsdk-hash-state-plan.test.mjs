import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { buildDmSdkHashStatePlan, indexDmSdkHashStatePlan } from "../packages/compiler/src/dmsdk-hash-state-plan.mjs";

const root = new URL("../", import.meta.url);
const sources = Object.freeze({
  ir: "packages/bindings/generated/defold-sdk-ir.json",
  shapes: "packages/bindings/generated/defold-dmsdk-abi-shapes.json",
  symbols: "packages/bindings/generated/defold-dmsdk-symbol-evidence.json",
  policy: "packages/bindings/overrides/dmsdk-hash-state-bindings.json",
});
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

async function inputs() {
  const texts = Object.fromEntries(
    await Promise.all(
      Object.entries(sources).map(async ([key, source]) => [key, await readFile(new URL(source, root), "utf8")]),
    ),
  );
  return {
    texts,
    ir: JSON.parse(texts.ir),
    shapes: JSON.parse(texts.shapes),
    symbols: JSON.parse(texts.symbols),
    policy: JSON.parse(texts.policy),
  };
}

function refreshText(input, key) {
  input.texts[key] = `${JSON.stringify(input[key])}\n`;
}

test("one authenticated hash-state plan owns the complete lifecycle selection", async () => {
  const [planText, reportText] = await Promise.all([
    readFile(new URL("packages/bindings/generated/defold-dmsdk-hash-state-plan.json", root), "utf8"),
    readFile(new URL("packages/bindings/generated/defold-dmsdk-hash-state-bindings.json", root), "utf8"),
  ]);
  const plan = JSON.parse(planText);
  const report = JSON.parse(reportText);
  indexDmSdkHashStatePlan(plan, { revision: report.defoldRevision });
  assert.equal(report.sourceHashes.plan, sha256(planText));
  assert.deepEqual(
    report.declarations.map(({ id }) => id).sort(),
    plan.decisions
      .filter(({ fallback }) => !fallback)
      .map(({ declarationId }) => declarationId)
      .sort(),
  );
  assert.equal(plan.coverage.selected, 10);
  assert.equal(plan.coverage.universalFallback, 0);
});

test("hash-state planning is canonical across source ordering", async () => {
  const base = await inputs();
  const expected = buildDmSdkHashStatePlan(base);
  const shuffled = structuredClone(base);
  shuffled.ir.declarations.reverse();
  shuffled.shapes.rows.reverse();
  shuffled.symbols.declarations = Object.fromEntries(Object.entries(shuffled.symbols.declarations).reverse());
  assert.deepEqual(buildDmSdkHashStatePlan(shuffled), expected);
});

test("an incomplete lifecycle falls back atomically for its state type", async () => {
  const input = await inputs();
  const baseline = buildDmSdkHashStatePlan(input);
  const removed = baseline.decisions.find(
    ({ semantics }) => semantics.operation === "Release" && semantics.width === 32,
  );
  input.shapes.rows = input.shapes.rows.filter(({ id }) => id !== removed.declarationId);
  refreshText(input, "shapes");
  const plan = buildDmSdkHashStatePlan(input);
  const width32 = plan.decisions.filter(({ semantics }) => semantics.width === 32);
  assert.equal(width32.length, 4);
  assert.ok(width32.every(({ fallback, blocker }) => fallback && blocker === "hash-state-lifecycle-incomplete"));
  assert.equal(plan.decisions.filter(({ semantics, fallback }) => semantics.width === 64 && !fallback).length, 5);
});

test("one linkage withdrawal falls back the whole state lifecycle", async () => {
  const input = await inputs();
  const baseline = buildDmSdkHashStatePlan(input);
  const member = baseline.decisions.find(({ semantics }) => semantics.width === 32);
  input.symbols.declarations[member.declarationId].availability = "partial";
  refreshText(input, "symbols");
  const plan = buildDmSdkHashStatePlan(input);
  const width32 = plan.decisions.filter(({ semantics }) => semantics.width === 32);
  assert.equal(width32.length, 5);
  assert.ok(width32.every(({ fallback, blocker }) => fallback && blocker === "hash-state-linkage-unverified"));
  assert.equal(plan.coverage.selected, 5);
  assert.equal(plan.coverage.universalFallback, 5);
});

test("a duplicated lifecycle operation rejects the whole ambiguous group", async () => {
  const input = await inputs();
  const baseline = buildDmSdkHashStatePlan(input);
  const original = baseline.decisions.find(({ semantics }) => semantics.operation === "Init" && semantics.width === 32);
  const declaration = structuredClone(input.ir.declarations.find(({ id }) => id === original.declarationId));
  const row = structuredClone(input.shapes.rows.find(({ id }) => id === original.declarationId));
  const symbol = structuredClone(input.symbols.declarations[original.declarationId]);
  declaration.id = `${declaration.id}:duplicate-fixture`;
  row.id = declaration.id;
  symbol.name = row.symbol;
  input.ir.declarations.push(declaration);
  input.shapes.rows.push(row);
  input.symbols.declarations[declaration.id] = symbol;
  refreshText(input, "ir");
  input.shapes.sourceHashes.ir = sha256(input.texts.ir);
  refreshText(input, "shapes");
  refreshText(input, "symbols");
  const plan = buildDmSdkHashStatePlan(input);
  const width32 = plan.decisions.filter(({ semantics }) => semantics.width === 32);
  assert.equal(width32.length, 6);
  assert.ok(width32.every(({ fallback, blocker }) => fallback && blocker === "hash-state-lifecycle-incomplete"));
});

test("a second complete state type with the same width falls both groups back", async () => {
  const input = await inputs();
  const baseline = buildDmSdkHashStatePlan(input);
  const width32 = baseline.decisions.filter(({ semantics }) => semantics.width === 32);
  const originalState = width32[0].semantics.stateType;
  const twinState = `${originalState}TwinFixture`;
  const record = structuredClone(
    input.ir.declarations.find(({ kind, name }) => kind === "record" && name === originalState),
  );
  record.id = `${record.id}:twin-fixture`;
  record.name = twinState;
  input.ir.declarations.push(record);
  for (const decision of width32) {
    const originalDeclaration = input.ir.declarations.find(({ id }) => id === decision.declarationId);
    const originalRow = input.shapes.rows.find(({ id }) => id === decision.declarationId);
    const twinDeclaration = structuredClone(originalDeclaration);
    const twinRow = structuredClone(originalRow);
    const twinId = `${decision.declarationId}:twin-fixture`;
    twinDeclaration.id = twinId;
    twinRow.id = twinId;
    twinRow.parameters = twinRow.parameters.map((parameter) => ({
      ...parameter,
      role: parameter.role === `pointer:record:${originalState}` ? `pointer:record:${twinState}` : parameter.role,
    }));
    input.ir.declarations.push(twinDeclaration);
    input.shapes.rows.push(twinRow);
    input.symbols.declarations[twinId] = structuredClone(input.symbols.declarations[decision.declarationId]);
  }
  refreshText(input, "ir");
  input.shapes.sourceHashes.ir = sha256(input.texts.ir);
  refreshText(input, "shapes");
  refreshText(input, "symbols");
  const plan = buildDmSdkHashStatePlan(input);
  const ambiguous = plan.decisions.filter(({ semantics }) => semantics.width === 32);
  assert.equal(ambiguous.length, 10);
  assert.ok(ambiguous.every(({ fallback, blocker }) => fallback && blocker === "duplicate-hash-state-width"));
  assert.equal(plan.decisions.filter(({ semantics, fallback }) => semantics.width === 64 && !fallback).length, 5);
});

test("hash-state plan verification rejects a forged owner and unsupported runtime policy", async () => {
  const input = await inputs();
  const plan = buildDmSdkHashStatePlan(input);
  const forged = structuredClone(plan);
  forged.decisions[0].emitter = "scripts/forged-emitter.mjs";
  assert.throws(() => indexDmSdkHashStatePlan(forged), /owner differs/u);
  input.policy.registry.generationBits = 30;
  assert.throws(() => buildDmSdkHashStatePlan(input), /semantic policy is unsupported/u);
});

test("the hash-state emitter consumes the plan and cannot select patterns", async () => {
  const source = await readFile(new URL("scripts/generate-dmsdk-hash-state-bindings.mjs", root), "utf8");
  assert.doesNotMatch(source, /selectDmSdkPattern|dmsdk-pattern-catalog|incrementalHashStatePattern/u);
  assert.match(source, /indexDmSdkHashStatePlan/u);
});
