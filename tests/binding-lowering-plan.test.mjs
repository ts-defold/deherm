import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  generateBindingLoweringPlan,
  inputPaths,
  loadBindingLoweringInputs
} from "../scripts/generate-binding-lowering-plan.mjs";

const repositoryRoot = resolve(new URL("..", import.meta.url).pathname);
const reportPath = join(repositoryRoot, "bindings/generated/defold-binding-lowering-plan.json");
const inputs = await loadBindingLoweringInputs(repositoryRoot);
const generated = generateBindingLoweringPlan(inputs);

function replaceJson(text, mutate) {
  const value = JSON.parse(text);
  mutate(value);
  return `${JSON.stringify(value, null, 2)}\n`;
}

test("the canonical plan contains every API unit and all five backend dispositions", async () => {
  assert.deepEqual(generated.coverage, {
    units: 2287,
    scriptUnits: 926,
    dmsdkUnits: 1361,
    backendRecords: 11435,
    identitySelectedPolicyRules: 0
  });
  assert.deepEqual(generated.targetOrder, [
    "typescriptSdk",
    "dynamicHermesJsi",
    "staticHermesCAbi",
    "luaStack",
    "browserWasmHost"
  ]);
  assert.equal(new Set(generated.units.map(({ identity }) => `${identity.surface}:${identity.id}`)).size, 2287);
  assert.ok(generated.units.every(({ backends }) => Object.keys(backends).join(",") === generated.targetOrder.join(",")));
  assert.equal(generated.selectionSummary.typescriptSdk.emit, 2287);
  assert.equal(generated.evidenceBoundary.compilation, "not-claimed");
  assert.equal(generated.evidenceBoundary.runtime, "not-claimed");
  assert.match(generated.planSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(JSON.parse(await readFile(reportPath, "utf8")), generated);
});

test("runtime emit selections never escape unresolved semantics or target capability checks", () => {
  for (const unit of generated.units) {
    for (const target of generated.targetOrder.filter((name) => generated.targetCapabilities[name].runtime)) {
      const backend = unit.backends[target];
      assert.ok(backend.marshallingProgram >= 0 && backend.marshallingProgram < generated.tables.marshallingPrograms.length, `${unit.identity.id}/${target}`);
      assert.ok(backend.blockerSet >= 0 && backend.blockerSet < generated.tables.blockerSets.length, `${unit.identity.id}/${target}`);
      assert.ok(backend.unresolvedTokenSet >= 0 && backend.unresolvedTokenSet < generated.tables.unresolvedTokenSets.length, `${unit.identity.id}/${target}`);
      if (backend.selection === "emit") {
        assert.deepEqual(generated.tables.unresolvedTokenSets[backend.unresolvedTokenSet], [], `${unit.identity.id}/${target}`);
        assert.deepEqual(generated.tables.blockerSets[backend.blockerSet], [], `${unit.identity.id}/${target}`);
        assert.ok(unit.abi.symbol || unit.abi.plannedSymbol, `${unit.identity.id}/${target}`);
      }
    }
  }
});

test("marshalling is an interned data-oriented opcode algebra rather than route code", () => {
  assert.ok(generated.tables.marshallingPrograms.length < generated.coverage.units);
  assert.ok(generated.tables.blockerSets.length < 200);
  assert.ok(generated.tables.unresolvedTokenSets.length < 200);
  const allowed = new Set([
    "validate-scalar", "pass-dynamic", "validate-named", "validate-enum", "decode-defold-value",
    "resolve-handle", "decode-record-ref", "decode-record", "decode-sequence", "decode-map", "select-union",
    "check-optional", "register-callback", "decode-variadic", "reject-unknown", "no-value", "copy-utf8",
    "borrow-fixed-array", "borrow-pointer", "borrow-reference", "decode-template-record", "instantiate-template",
    "resolve-type-parameter", "resolve-opaque", "call-cached-lua", "call-native-symbol", "restore-scratch"
  ]);
  for (const program of generated.tables.marshallingPrograms) {
    for (const instruction of program) {
      const opcode = instruction.op.startsWith("encode-") ? instruction.op.slice("encode-".length) : instruction.op;
      assert.ok(allowed.has(opcode), instruction.op);
    }
  }

  const route = generated.units.find(({ identity }) => identity.id === "script:b2d.body.apply_force");
  const program = generated.tables.marshallingPrograms[route.backends.dynamicHermesJsi.marshallingProgram];
  assert.deepEqual(program.map(({ op }) => op), [
    "resolve-handle",
    "decode-defold-value",
    "decode-defold-value",
    "call-cached-lua",
    "restore-scratch"
  ]);
  assert.equal(route.backends.dynamicHermesJsi.selection, "blocked-semantic");
});

test("semantic policies are algebraic, reject identity selectors, overlap, and absent tokens", () => {
  const identity = structuredClone(inputs);
  identity.semanticPolicies = replaceJson(identity.semanticPolicies, (value) => value.rules.push({
    id: "forbidden-route-rule",
    selector: { id: "script:b2d.body.apply_force" },
    resolves: { "lowering:borrowed-handle": "generated-handle-codec" }
  }));
  assert.throws(() => generateBindingLoweringPlan(identity), /identity selector 'id'/);

  const zero = structuredClone(inputs);
  zero.semanticPolicies = replaceJson(zero.semanticPolicies, (value) => value.rules.push({
    id: "zero-match",
    selector: { surface: "script", semanticTokensAll: ["not-a-real-token"] },
    resolves: { "not-a-real-token": "impossible" }
  }));
  assert.throws(() => generateBindingLoweringPlan(zero), /matches zero units/);

  const overlap = structuredClone(inputs);
  overlap.semanticPolicies = replaceJson(overlap.semanticPolicies, (value) => value.rules.push(
    {
      id: "first-context",
      selector: { surface: "script", semanticTokensAll: ["context-policy"] },
      resolves: { "context-policy": "global-script-context" }
    },
    {
      id: "second-context",
      selector: { surface: "script", semanticTokensAll: ["context-policy"] },
      resolves: { "context-policy": "different-context" }
    }
  ));
  assert.throws(() => generateBindingLoweringPlan(overlap), /semantic policies overlap/);
});

test("the plan regenerates byte-identically and rejects projection census drift", async () => {
  const directory = await mkdtemp(join(tmpdir(), "deherm-lowering-plan-"));
  try {
    const output = join(directory, "plan.json");
    execFileSync(process.execPath, ["scripts/generate-binding-lowering-plan.mjs", "--output", output], { cwd: repositoryRoot, stdio: "pipe" });
    assert.equal(await readFile(output, "utf8"), await readFile(reportPath, "utf8"));
    execFileSync(process.execPath, ["scripts/generate-binding-lowering-plan.mjs", "--output", output, "--check"], { cwd: repositoryRoot, stdio: "pipe" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }

  const drift = structuredClone(inputs);
  drift.scriptProjection = replaceJson(drift.scriptProjection, (value) => value.rows.pop());
  assert.throws(() => generateBindingLoweringPlan(drift), /Script projection census drifted/);
  assert.deepEqual(Object.keys(generated.inputHashes), Object.keys(inputPaths));
});
