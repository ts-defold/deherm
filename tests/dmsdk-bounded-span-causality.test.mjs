import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { extractAstcProbeSemantics } from "../scripts/generate-dmsdk-astc-probe-bindings.mjs";
import { extractBase64SpanSemantics } from "../scripts/generate-dmsdk-base64-span-bindings.mjs";
import { extractXteaSpanSemantics } from "../scripts/generate-dmsdk-xtea-span-bindings.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function fixture() {
  const load = (relative) => readFile(path.join(root, relative), "utf8").then(JSON.parse);
  const [ir, shapes, sourceFacts, base64, astc, xtea] = await Promise.all([
    load("packages/bindings/generated/defold-sdk-ir.json"),
    load("packages/bindings/generated/defold-dmsdk-abi-shapes.json"),
    load("packages/bindings/generated/defold-dmsdk-source-semantic-facts.json"),
    load("packages/bindings/overrides/dmsdk-base64-span-bindings.json"),
    load("packages/bindings/overrides/dmsdk-astc-probe-bindings.json"),
    load("packages/bindings/overrides/dmsdk-xtea-span-bindings.json"),
  ]);
  const declarations = new Map(ir.declarations.map((declaration) => [declaration.name, declaration]));
  const candidates = new Map(shapes.rows.map((candidate) => [candidate.id, candidate]));
  const facts = new Map(sourceFacts.declarations.map((entry) => [entry.name, entry]));
  return { ir, declarations, candidates, facts, recipes: { base64: base64.recipe, astc: astc.recipe, xtea: xtea.recipe } };
}

function inputs(state, name) {
  const declaration = state.declarations.get(name);
  assert.ok(declaration, name);
  const candidate = state.candidates.get(declaration.id);
  const facts = structuredClone(state.facts.get(name));
  assert.ok(candidate && facts, name);
  return { declaration, candidate, facts };
}

test("Base64 selection ignores unrelated codec-looking calls and requires a controlled capacity query", async () => {
  const state = await fixture();
  const { declaration, candidate, facts } = inputs(state, "dmCrypt::Base64Encode");
  const baseline = extractBase64SpanSemantics(declaration, candidate, state.recipes.base64, facts);
  assert.ok(baseline);

  const definition = facts.definitions.find(({ variables = [] }) =>
    variables.some(({ initializer }) => initializer?.kind === "call"),
  );
  definition.calls.push({
    callee: "telemetry_base64_decode",
    arguments: [
      { kind: "parameter", index: 2 },
      { kind: "unary", operator: "*", operand: { kind: "parameter", index: 3 } },
      { kind: "variable", name: "noise" },
      { kind: "parameter", index: 0 },
      { kind: "parameter", index: 1 },
    ],
    conditions: [],
  });
  definition.variables.push({
    name: "unrelated",
    type: "int",
    initializer: {
      kind: "call",
      callee: "telemetry_base64_decode",
      arguments: definition.calls.at(-1).arguments,
    },
    conditions: [],
  });
  const noisy = extractBase64SpanSemantics(declaration, candidate, state.recipes.base64, facts);
  assert.equal(noisy?.mode, baseline.mode);
  assert.equal(noisy?.requirePaddedInput, baseline.requirePaddedInput);

  for (const current of facts.definitions) {
    for (const operation of current.operations ?? []) operation.conditions = [];
  }
  assert.equal(extractBase64SpanSemantics(declaration, candidate, state.recipes.base64, facts), null);
});

test("ASTC selection relates the input guard and three outputs to the called parser helper", async () => {
  const state = await fixture();
  const { declaration, candidate, facts } = inputs(state, "dmImage::GetAstcDimensions");
  const baseline = extractAstcProbeSemantics(declaration, candidate, state.recipes.astc, facts);
  assert.ok(baseline);

  facts.definitions[0].reachableDefinitions.push({
    name: "dmImage::Noise",
    declarationId: "noise",
    calls: [],
    fixedArrays: [],
    variables: [],
    operations: [],
    returns: [{
      kind: "boolean",
      value: false,
      conditions: [{
        branch: true,
        expression: {
          kind: "binary",
          operator: "<",
          left: { kind: "parameter", index: 1 },
          right: { kind: "integer", value: 999 },
        },
      }],
    }],
  });
  for (const index of [2, 3, 4]) {
    facts.definitions[0].operations.push({
      operator: "=",
      left: { kind: "unary", operator: "*", operand: { kind: "parameter", index } },
      right: { kind: "binary", operator: "<<", left: { kind: "integer", value: 1 }, right: { kind: "integer", value: 31 } },
      conditions: [],
    });
  }
  const noisy = extractAstcProbeSemantics(declaration, candidate, state.recipes.astc, facts);
  assert.equal(noisy?.mode, baseline.mode);
  assert.equal(noisy?.minimumHeaderBytes, baseline.minimumHeaderBytes);

  facts.definitions[0].calls = [];
  assert.equal(extractAstcProbeSemantics(declaration, candidate, state.recipes.astc, facts), null);
});

test("XTEA selection accepts only the called helper's key-copy capacity and in-place mutation", async () => {
  const state = await fixture();
  const { declaration, candidate, facts } = inputs(state, "dmCrypt::Encrypt");
  const enums = new Map(state.ir.declarations.filter(({ kind }) => kind === "enum").map((item) => [item.name, item]));
  const baseline = extractXteaSpanSemantics(declaration, candidate, enums, state.recipes.xtea, facts);
  assert.ok(baseline);

  const helper = facts.definitions[0].reachableDefinitions.find(({ fixedArrays = [] }) =>
    fixedArrays.some(({ byteExtent }) => byteExtent === baseline.maximumKeyBytes),
  );
  helper.fixedArrays.push({ name: "scratch", type: "uint8_t[999]", elementType: "uint8_t", extent: 999, byteExtent: 999 });
  helper.operations.push(
    { operator: "<=", left: { kind: "parameter", index: 3 }, right: { kind: "integer", value: 999 }, conditions: [] },
    { operator: "^=", left: { kind: "subscript", base: { kind: "parameter", index: 0 }, index: { kind: "integer", value: 0 } }, right: { kind: "integer", value: 1 }, conditions: [] },
  );
  const noisy = extractXteaSpanSemantics(declaration, candidate, enums, state.recipes.xtea, facts);
  assert.equal(noisy?.maximumKeyBytes, baseline.maximumKeyBytes);

  helper.calls = helper.calls.filter(({ callee }) => callee !== "memcpy");
  assert.equal(extractXteaSpanSemantics(declaration, candidate, enums, state.recipes.xtea, facts), null);
});
